import { readFileSync } from "node:fs";

/**
 * Resource limits of the Copilot runtime in one server process.
 *
 *   COPILOT_SESSION_IDLE_MINUTES      a live session idle this long is evicted, default 15 (0 = never)
 *   COPILOT_RUNTIME_MEMORY_BUDGET_MB  RSS budget of the runtime process; above it the least
 *                                     recently used idle sessions are evicted, default 600 (0 = off)
 *   COPILOT_MAX_LIVE_SESSIONS         last-resort cap on live sessions (LRU), default 400
 *   COPILOT_MAX_TURNS_PER_USER        concurrent turns of one user, default 2
 *   COPILOT_MAX_TURNS_PER_PROCESS     concurrent turns of this process, default 32
 *
 * A live session is only a cache: an evicted one resumes from its Blob state
 * on the next turn. The turn limits refuse a turn up front (HTTP 429) instead
 * of letting one user (or a burst) queue up runtime work without bound.
 *
 * SIZING: basis of the defaults, measured with scripts/copilot-runtime-load.ts
 * (Linux x64, runtime 1.0.116, a fake model so long histories cost nothing):
 *
 *   runtime RSS: 48 MB without a session, ~110 MB after the first one;
 *   then 1.0 MB per live session with a short history (5 turns, 3k tokens)
 *   and 1.8 MB with a long one (20 turns, 60k tokens).
 *     200 sessions: 359 MB short / 524 MB long; 400: 554 / 878 MB.
 *   host (this Node process): +0.1 MB per live session.
 *   32 concurrent streaming turns: +50 MB in the runtime while they run.
 *   Disconnecting sessions frees memory (all 400 gone: back to ~210 MB, the
 *   runtime keeps the rest of its heap). Its own idle timeout frees memory
 *   too, but the next turn of such a session fails ("Session not found"),
 *   so it is only a backstop behind our sweep.
 *   Resume of an evicted session from Blob: +0.4-0.5 s on the turn (p95
 *   0.6-0.7 s, short and long history alike; measured from a workstation,
 *   not from inside the Azure region).
 *
 * Idle 15 min: live sessions are then about the chats active in 15 min;
 * production peak 391 per 15 min over 2 instances, ~200 per instance, i.e.
 * 360-520 MB of runtime (+50 MB while turns run). Budget 600 MB: that peak
 * fits; a skew (one instance takes all chats) is trimmed to the budget, and
 * an evicted chat costs one resume. Keep the budget well above ~250 MB (the
 * runtime's own floor after load), else every sweep empties the cache. Cap
 * 400: about twice the expected peak per instance (878 MB with long
 * histories), for when the guard cannot read the RSS (not Linux) or is off.
 */

/**
 * RSS freed per evicted session (MB) for the size of one memory-guard batch:
 * the short-history value, so a batch frees enough also when sessions are
 * small (long ones free more; one sweep may then evict a few too many).
 */
export const RUNTIME_MB_PER_SESSION = 1;

const positiveInt = (raw: string | undefined, fallback: number): number => {
  const n = Number(raw);
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : fallback;
};

/** 0 is a valid value (it turns the limit off); empty or invalid gives the default. */
const nonNegativeInt = (raw: string | undefined, fallback: number): number => {
  if (raw === undefined || raw.trim() === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback;
};

export interface RuntimeLimits {
  /** Idle time after which a live session is evicted; 0 = never. */
  sessionIdleMs: number;
  /** RSS budget of the runtime process in MB; 0 = no memory guard. */
  memoryBudgetMb: number;
  /** Last-resort cap on live sessions. */
  maxLiveSessions: number;
  maxTurnsPerUser: number;
  maxTurnsPerProcess: number;
}

export function readRuntimeLimits(env: Record<string, string | undefined> = process.env): RuntimeLimits {
  return {
    sessionIdleMs: nonNegativeInt(env.COPILOT_SESSION_IDLE_MINUTES, 15) * 60 * 1000,
    memoryBudgetMb: nonNegativeInt(env.COPILOT_RUNTIME_MEMORY_BUDGET_MB, 600),
    maxLiveSessions: positiveInt(env.COPILOT_MAX_LIVE_SESSIONS, 400),
    maxTurnsPerUser: positiveInt(env.COPILOT_MAX_TURNS_PER_USER, 2),
    maxTurnsPerProcess: positiveInt(env.COPILOT_MAX_TURNS_PER_PROCESS, 32),
  };
}

export class TurnLimitError extends Error {
  readonly status = 429;
  constructor(message: string) {
    super(message);
    this.name = "TurnLimitError";
  }
}

/** Counts running turns per user and per process. */
export class TurnLimiter {
  private readonly perUser = new Map<string, number>();
  private total = 0;

  constructor(private readonly limits: () => Pick<RuntimeLimits, "maxTurnsPerUser" | "maxTurnsPerProcess">) {}

  get running(): number {
    return this.total;
  }

  /** Takes a slot or throws TurnLimitError; the returned function frees it (once). */
  acquire(userKey: string): () => void {
    const { maxTurnsPerUser, maxTurnsPerProcess } = this.limits();
    const mine = this.perUser.get(userKey) ?? 0;
    if (mine >= maxTurnsPerUser) {
      throw new TurnLimitError(
        `You already have ${mine} replies running. Wait for one to finish, then send again.`,
      );
    }
    if (this.total >= maxTurnsPerProcess) {
      throw new TurnLimitError("The server is busy. Please try again in a moment.");
    }
    this.perUser.set(userKey, mine + 1);
    this.total += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.total -= 1;
      const n = (this.perUser.get(userKey) ?? 1) - 1;
      if (n <= 0) this.perUser.delete(userKey);
      else this.perUser.set(userKey, n);
    };
  }
}

export interface EvictableSession {
  busy: boolean;
  lastUsed: number;
}

/** Idle sessions, least recently used first. */
const idleByAge = <T extends EvictableSession>(sessions: ReadonlyMap<string, T>): Array<[string, T]> =>
  [...sessions.entries()].filter(([, s]) => !s.busy).sort((a, b) => a[1].lastUsed - b[1].lastUsed);

/**
 * Picks the sessions to drop so that at most `max` stay: least recently used
 * first, never a busy one. Returns their keys.
 */
export function sessionsToEvict<T extends EvictableSession>(sessions: ReadonlyMap<string, T>, max: number): string[] {
  const excess = sessions.size - max;
  if (excess <= 0) return [];
  return idleByAge(sessions)
    .slice(0, excess)
    .map(([k]) => k);
}

/** Sessions idle for at least `idleMs` (never a busy one); none when idleMs is 0. */
export function idleSessionsToEvict<T extends EvictableSession>(
  sessions: ReadonlyMap<string, T>,
  now: number,
  idleMs: number,
): string[] {
  if (idleMs <= 0) return [];
  return idleByAge(sessions)
    .filter(([, s]) => now - s.lastUsed >= idleMs)
    .map(([k]) => k);
}

/**
 * Memory guard: when the runtime's RSS is over the budget, the least recently
 * used idle sessions that would free the excess (at `mbPerSession` each, at
 * least one). The caller samples the RSS again before the next batch, so a
 * process that returns memory slowly is not emptied in one go.
 */
export function sessionsOverMemoryBudget<T extends EvictableSession>(
  sessions: ReadonlyMap<string, T>,
  rssMb: number | undefined,
  budgetMb: number,
  mbPerSession = RUNTIME_MB_PER_SESSION,
): string[] {
  if (budgetMb <= 0 || rssMb === undefined || rssMb <= budgetMb) return [];
  const count = Math.max(1, Math.ceil((rssMb - budgetMb) / Math.max(mbPerSession, 0.1)));
  return idleByAge(sessions)
    .slice(0, count)
    .map(([k]) => k);
}

/**
 * Resident memory of a process in MB from /proc/<pid>/status (Linux), or
 * undefined where it cannot be read (Windows, macOS, process gone).
 */
export function processRssMb(
  pid: number | undefined,
  read: (file: string) => string = (file) => readFileSync(file, "utf8"),
): number | undefined {
  if (!pid) return undefined;
  try {
    const m = /^VmRSS:\s+(\d+)\s+kB/m.exec(read(`/proc/${pid}/status`));
    return m ? Number(m[1]) / 1024 : undefined;
  } catch {
    return undefined;
  }
}

const errorText = (err: unknown): string =>
  `${(err as { code?: unknown })?.code ?? ""} ${err instanceof Error ? err.message : String(err)}`;

/** True when an error means the runtime connection (the whole process) is gone. */
export function isRuntimeGoneError(err: unknown): boolean {
  return /connection (?:is )?(?:closed|disposed|lost)|disconnected|EPIPE|ECONNRESET|ERR_STREAM_DESTROYED|not connected|process exited/i.test(
    errorText(err),
  );
}

/**
 * True when only one session is gone from a runtime that still runs (e.g. the
 * runtime's own idle timeout dropped it): drop that session, not the runtime.
 */
export function isSessionGoneError(err: unknown): boolean {
  return !isRuntimeGoneError(err) && /session not found|unknown session/i.test(errorText(err));
}

/**
 * The runtime's own idle timeout (runtime.sessionIdleTimeoutSeconds), as a
 * backstop for sessions our sweep lost track of: twice our idle time, so our
 * sweep always drops a session first; off when our idle eviction is off.
 */
export function runtimeIdleBackstopSeconds(limits: Pick<RuntimeLimits, "sessionIdleMs">): number {
  return limits.sessionIdleMs > 0 ? Math.round((2 * limits.sessionIdleMs) / 1000) : 0;
}
