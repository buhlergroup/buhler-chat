/**
 * The scheduled cleanup of the content store: content (uploads, `.md`
 * extracts) that no row points to any more and that is older than the grace
 * period is deleted (cleanupUnreferencedContent, content-store.ts `cleanup`).
 *
 * It runs inside the app, started from instrumentation.ts:
 *   - CONTENT_CLEANUP_INTERVAL_HOURS sets the interval (default 6; 0 turns
 *     the job off). The first run comes some minutes after the start.
 *   - One instance at a time: a run takes a lease on the lock blob
 *     `locks/content-cleanup` of the content container and is skipped when
 *     another instance holds it. The lease has a ttl and is renewed while the
 *     run goes on, so a stopped instance frees it.
 *   - The lock blob's metadata keeps the time of the last run (other
 *     instances skip until the interval is nearly over) and where the listing
 *     stopped (the next run goes on from there).
 *   - Each run is bounded: page size, number of listed blobs and a time
 *     budget. The log has counts only.
 *   - Never in unit tests, the e2e memory backend or `next build`. Outside
 *     production NODE_ENV only when CONTENT_CLEANUP_INTERVAL_HOURS is set.
 *
 * Not a "use server" module: nothing here is callable from the browser.
 */

import { logError, logInfo, logWarn } from "../logger";
import type { CleanupOptions, CleanupResult, ContentJobLock } from "./content-store";

export const CONTENT_CLEANUP_LOCK_KEY = "locks/content-cleanup";
export const DEFAULT_CONTENT_CLEANUP_INTERVAL_HOURS = 6;

/** Bounds of one run. */
export const CONTENT_CLEANUP_LIMITS = {
  pageSize: 500,
  maxBlobs: 10_000,
  timeBudgetMs: 10 * 60 * 1000,
} as const;

const LOCK_TTL_SECONDS = 60;
const LOCK_RENEW_MS = 20 * 1000;
const FIRST_RUN_DELAY_MS = 5 * 60 * 1000;
const FIRST_RUN_JITTER_MS = 5 * 60 * 1000;
const MIN_INTERVAL_MS = 5 * 60 * 1000;
// setTimeout fires at once for delays over 2^31-1 ms (about 24.8 days).
const MAX_INTERVAL_MS = 2 ** 31 - 1;

const META_LAST_RUN = "lastrun";
const META_CURSOR = "cursor";

type Env = Record<string, string | undefined>;

/** The interval in ms, or undefined when CONTENT_CLEANUP_INTERVAL_HOURS is 0. */
export function contentCleanupIntervalMs(env: Env = process.env): number | undefined {
  const raw = env.CONTENT_CLEANUP_INTERVAL_HOURS?.trim();
  let hours = DEFAULT_CONTENT_CLEANUP_INTERVAL_HOURS;
  if (raw) {
    const parsed = Number(raw);
    if (Number.isFinite(parsed) && parsed >= 0) hours = parsed;
  }
  if (hours === 0) return undefined;
  return Math.min(Math.max(hours * 60 * 60 * 1000, MIN_INTERVAL_MS), MAX_INTERVAL_MS);
}

/** Why the job does not start here, or undefined when it may start. */
export function contentCleanupDisabledReason(env: Env = process.env): string | undefined {
  if (env.NEXT_PHASE === "phase-production-build") return "build";
  if (env.VITEST || env.NODE_ENV === "test") return "test";
  if (env.AZURECHAT_TEST_BACKEND === "memory") return "e2e-memory-backend";
  if (env.NODE_ENV !== "production" && !env.CONTENT_CLEANUP_INTERVAL_HOURS?.trim()) {
    return "not-production";
  }
  if (contentCleanupIntervalMs(env) === undefined) return "disabled";
  return undefined;
}

/** What a run needs; the app binds the content store (defaultDeps). */
export interface ContentCleanupDeps {
  acquireLock: (key: string, ttlSeconds: number) => Promise<ContentJobLock | undefined>;
  cleanup: (options: Omit<CleanupOptions, "isReferenced">) => Promise<CleanupResult>;
  now?: () => number;
}

export type ContentCleanupRun =
  | { status: "skipped-locked" }
  | { status: "skipped-recent" }
  | {
      status: "done";
      scanned: number;
      deleted: number;
      keptReferenced: number;
      keptRecent: number;
      complete: boolean;
      lockLost: boolean;
      durationMs: number;
    };

const decodeCursor = (value: string | undefined): string | undefined => {
  if (!value) return undefined;
  try {
    return decodeURIComponent(value);
  } catch {
    return undefined;
  }
};

/**
 * One run: takes the lock (or skips), skips when another instance ran less
 * than `minGapMs` ago, cleans up from the stored position within the
 * limits, records the run and the new position, and gives the lock up.
 */
export async function runContentCleanupOnce(
  deps: ContentCleanupDeps,
  options: {
    minGapMs?: number;
    limits?: Partial<{ pageSize: number; maxBlobs: number; timeBudgetMs: number }>;
  } = {}
): Promise<ContentCleanupRun> {
  const now = deps.now ?? Date.now;
  const limits = { ...CONTENT_CLEANUP_LIMITS, ...options.limits };

  const lock = await deps.acquireLock(CONTENT_CLEANUP_LOCK_KEY, LOCK_TTL_SECONDS);
  if (!lock) {
    logInfo("Content cleanup skipped: another instance runs it");
    return { status: "skipped-locked" };
  }

  let lockLost = false;
  const renewal = setInterval(() => {
    lock.renew().catch(() => {
      lockLost = true;
    });
  }, LOCK_RENEW_MS);
  renewal.unref?.();

  try {
    const lastRun = Number(lock.metadata[META_LAST_RUN]);
    if (options.minGapMs && Number.isFinite(lastRun) && now() - lastRun < options.minGapMs) {
      logInfo("Content cleanup skipped: it ran recently");
      return { status: "skipped-recent" };
    }

    const started = now();
    const deadline = started + limits.timeBudgetMs;
    const result = await deps.cleanup({
      continuationToken: decodeCursor(lock.metadata[META_CURSOR]),
      pageSize: limits.pageSize,
      maxBlobs: limits.maxBlobs,
      shouldStop: () => lockLost || now() >= deadline,
    });

    if (!lockLost) {
      await lock
        .setMetadata({
          [META_LAST_RUN]: String(now()),
          ...(result.continuationToken
            ? { [META_CURSOR]: encodeURIComponent(result.continuationToken) }
            : {}),
        })
        .catch((error) => {
          logWarn("Content cleanup: the run could not be recorded", {
            error: error instanceof Error ? error.message : String(error),
          });
        });
    }

    const run = {
      status: "done" as const,
      scanned: result.scanned,
      deleted: result.deleted.length,
      keptReferenced: result.keptReferenced,
      keptRecent: result.keptRecent,
      complete: result.complete,
      lockLost,
      durationMs: now() - started,
    };
    // Counts only: no scopes (user ids), hashes or file names.
    logInfo("Content cleanup run", { ...run });
    return run;
  } finally {
    clearInterval(renewal);
    await lock.release();
  }
}

/** The app's bindings, imported when the first run starts. */
const defaultDeps = async (): Promise<ContentCleanupDeps> => {
  const [{ acquireContentJobLock }, { cleanupUnreferencedContent }] = await Promise.all([
    import("./index"),
    import("./content-references"),
  ]);
  return { acquireLock: acquireContentJobLock, cleanup: cleanupUnreferencedContent };
};

export interface ContentCleanupJob {
  stop(): void;
}

declare global {
  var __contentCleanupJob: ContentCleanupJob | undefined;
}

/**
 * Starts the periodic job once per process (Next.js calls register() more
 * than once). Returns undefined when the job is off here
 * (contentCleanupDisabledReason).
 */
export function startContentCleanupJob(
  options: {
    env?: Env;
    deps?: () => Promise<ContentCleanupDeps>;
    firstRunDelayMs?: number;
  } = {}
): ContentCleanupJob | undefined {
  const env = options.env ?? process.env;
  const reason = contentCleanupDisabledReason(env);
  const intervalMs = contentCleanupIntervalMs(env);
  if (reason || intervalMs === undefined) {
    logInfo("Content cleanup job not started", { reason: reason ?? "disabled" });
    return undefined;
  }
  if (globalThis.__contentCleanupJob) return globalThis.__contentCleanupJob;

  const interval: number = intervalMs;
  const loadDeps = options.deps ?? defaultDeps;
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const schedule = (delayMs: number) => {
    timer = setTimeout(tick, delayMs);
    timer.unref?.();
  };

  async function tick() {
    if (stopped) return;
    try {
      // Another instance that ran in the last 90 % of the interval counts.
      await runContentCleanupOnce(await loadDeps(), { minGapMs: interval * 0.9 });
    } catch (error) {
      logError("Content cleanup run failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      if (!stopped) schedule(interval);
    }
  }

  schedule(
    options.firstRunDelayMs ?? FIRST_RUN_DELAY_MS + Math.floor(Math.random() * FIRST_RUN_JITTER_MS)
  );
  const job: ContentCleanupJob = {
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      if (globalThis.__contentCleanupJob === job) globalThis.__contentCleanupJob = undefined;
    },
  };
  globalThis.__contentCleanupJob = job;
  logInfo("Content cleanup job started", { intervalHours: interval / (60 * 60 * 1000) });
  return job;
}
