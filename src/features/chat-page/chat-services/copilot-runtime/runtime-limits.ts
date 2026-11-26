/**
 * Resource limits of the Copilot runtime in one server process.
 *
 *   COPILOT_MAX_LIVE_SESSIONS      live sessions kept in memory (LRU), default 200
 *   COPILOT_MAX_TURNS_PER_USER     concurrent turns of one user, default 2
 *   COPILOT_MAX_TURNS_PER_PROCESS  concurrent turns of this process, default 32
 *
 * A live session is only a cache: an evicted one resumes from its Blob state
 * on the next turn. The turn limits refuse a turn up front (HTTP 429) instead
 * of letting one user (or a burst) queue up runtime work without bound.
 */

const positiveInt = (raw: string | undefined, fallback: number): number => {
  const n = Number(raw);
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : fallback;
};

export interface RuntimeLimits {
  maxLiveSessions: number;
  maxTurnsPerUser: number;
  maxTurnsPerProcess: number;
}

export function readRuntimeLimits(env: Record<string, string | undefined> = process.env): RuntimeLimits {
  return {
    maxLiveSessions: positiveInt(env.COPILOT_MAX_LIVE_SESSIONS, 200),
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

/**
 * Picks the sessions to drop so that at most `max` stay: least recently used
 * first, never a busy one. Returns their keys.
 */
export function sessionsToEvict<T extends EvictableSession>(sessions: ReadonlyMap<string, T>, max: number): string[] {
  const excess = sessions.size - max;
  if (excess <= 0) return [];
  return [...sessions.entries()]
    .filter(([, s]) => !s.busy)
    .sort((a, b) => a[1].lastUsed - b[1].lastUsed)
    .slice(0, excess)
    .map(([k]) => k);
}

/** True when an error means the runtime connection (or the session in it) is gone. */
export function isRuntimeGoneError(err: unknown): boolean {
  const text = `${(err as { code?: unknown })?.code ?? ""} ${err instanceof Error ? err.message : String(err)}`;
  return /connection (?:is )?(?:closed|disposed|lost)|disconnected|EPIPE|ECONNRESET|ERR_STREAM_DESTROYED|session not found|unknown session|not connected|process exited/i.test(
    text,
  );
}
