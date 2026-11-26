// @vitest-environment node
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const logs = vi.hoisted(() => ({
  logInfo: vi.fn(),
  logWarn: vi.fn(),
  logError: vi.fn(),
  logDebug: vi.fn(),
}));
vi.mock("../logger", () => logs);

import {
  CONTENT_CLEANUP_LOCK_KEY,
  contentCleanupDisabledReason,
  contentCleanupIntervalMs,
  runContentCleanupOnce,
  startContentCleanupJob,
  type ContentCleanupDeps,
} from "./cleanup-job";
import { createContentStore, type ContentOpenAiFiles } from "./content-store";
import { createMemoryContentBlobBackend } from "./memory-backend";

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const user = "a".repeat(64);
const prod = { NODE_ENV: "production" };

const setup = async (orphans = 0) => {
  let clock = new Date("2026-01-01T00:00:00Z").getTime();
  const now = () => new Date(clock);
  const blobs = createMemoryContentBlobBackend(now);
  const openAi: ContentOpenAiFiles = { exists: async () => true, upload: async () => "file-x" };
  const store = createContentStore({ blobs, openAiFiles: () => openAi, now });
  for (let i = 0; i < orphans; i++) {
    const { sha256 } = await store.put(user, Buffer.from(`orphan ${i}`));
    await store.markdown(user, sha256, async () => `text ${i}`);
  }
  clock += 8 * DAY;
  const isReferenced = vi.fn(async () => false);
  const deps: ContentCleanupDeps = {
    acquireLock: (key, ttl) => blobs.acquireLock(key, ttl),
    cleanup: (options) => store.cleanup({ ...options, isReferenced }),
    now: () => clock,
  };
  return {
    blobs,
    store,
    deps,
    isReferenced,
    advance: (ms: number) => {
      clock += ms;
    },
  };
};

beforeEach(() => {
  globalThis.__contentCleanupJob?.stop();
});

describe("common.unit.content-cleanup-job — configuration", () => {
  it("interval: default 6 h, CONTENT_CLEANUP_INTERVAL_HOURS sets it, 0 turns it off", () => {
    expect(contentCleanupIntervalMs({})).toBe(6 * HOUR);
    expect(contentCleanupIntervalMs({ CONTENT_CLEANUP_INTERVAL_HOURS: "2" })).toBe(2 * HOUR);
    expect(contentCleanupIntervalMs({ CONTENT_CLEANUP_INTERVAL_HOURS: "0" })).toBeUndefined();
    expect(contentCleanupIntervalMs({ CONTENT_CLEANUP_INTERVAL_HOURS: "abc" })).toBe(6 * HOUR);
    expect(contentCleanupIntervalMs({ CONTENT_CLEANUP_INTERVAL_HOURS: "-1" })).toBe(6 * HOUR);
    // Never shorter than 5 minutes, never past the setTimeout limit.
    expect(contentCleanupIntervalMs({ CONTENT_CLEANUP_INTERVAL_HOURS: "0.001" })).toBe(5 * 60 * 1000);
    expect(contentCleanupIntervalMs({ CONTENT_CLEANUP_INTERVAL_HOURS: "100000" })).toBe(2 ** 31 - 1);
  });

  it("never in tests, the e2e memory backend or next build", () => {
    expect(contentCleanupDisabledReason({ ...prod, NEXT_PHASE: "phase-production-build" })).toBe("build");
    expect(contentCleanupDisabledReason({ ...prod, VITEST: "true" })).toBe("test");
    expect(contentCleanupDisabledReason({ NODE_ENV: "test" })).toBe("test");
    expect(contentCleanupDisabledReason({ ...prod, AZURECHAT_TEST_BACKEND: "memory" })).toBe(
      "e2e-memory-backend"
    );
    // This test process itself.
    expect(contentCleanupDisabledReason()).toBe("test");
  });

  it("off outside production unless the interval is set; 0 turns it off", () => {
    expect(contentCleanupDisabledReason({ NODE_ENV: "development" })).toBe("not-production");
    expect(
      contentCleanupDisabledReason({ NODE_ENV: "development", CONTENT_CLEANUP_INTERVAL_HOURS: "1" })
    ).toBeUndefined();
    expect(contentCleanupDisabledReason(prod)).toBeUndefined();
    expect(contentCleanupDisabledReason({ ...prod, CONTENT_CLEANUP_INTERVAL_HOURS: "0" })).toBe(
      "disabled"
    );
  });
});

describe("common.unit.content-cleanup-job — scheduling", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    globalThis.__contentCleanupJob?.stop();
    vi.useRealTimers();
  });

  it("first run after the start delay, then every interval", async () => {
    const { deps } = await setup();
    const cleanup = vi.spyOn(deps, "cleanup");
    const job = startContentCleanupJob({
      env: { ...prod, CONTENT_CLEANUP_INTERVAL_HOURS: "1" },
      deps: async () => deps,
      firstRunDelayMs: 5 * 60 * 1000,
    });
    expect(job).toBeDefined();
    await vi.advanceTimersByTimeAsync(4 * 60 * 1000);
    expect(cleanup).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(60 * 1000);
    expect(cleanup).toHaveBeenCalledTimes(1);
    // The run itself recorded "last run" at the store clock; move it on too.
    (deps as { now: () => number }).now = () => Date.now() + 365 * DAY;
    await vi.advanceTimersByTimeAsync(HOUR);
    expect(cleanup).toHaveBeenCalledTimes(2);
    job!.stop();
    await vi.advanceTimersByTimeAsync(10 * HOUR);
    expect(cleanup).toHaveBeenCalledTimes(2);
  });

  it("does not start (and never loads its dependencies) when disabled", async () => {
    const loadDeps = vi.fn();
    for (const env of [
      { ...prod, CONTENT_CLEANUP_INTERVAL_HOURS: "0" },
      { ...prod, VITEST: "true" },
      { NODE_ENV: "test" },
      { ...prod, NEXT_PHASE: "phase-production-build" },
      { ...prod, AZURECHAT_TEST_BACKEND: "memory" },
    ]) {
      expect(startContentCleanupJob({ env, deps: loadDeps, firstRunDelayMs: 0 })).toBeUndefined();
    }
    // Default env of this process (a test run).
    expect(startContentCleanupJob({ deps: loadDeps, firstRunDelayMs: 0 })).toBeUndefined();
    await vi.advanceTimersByTimeAsync(30 * DAY);
    expect(loadDeps).not.toHaveBeenCalled();
    expect(globalThis.__contentCleanupJob).toBeUndefined();
  });

  it("starts once per process (register() runs more than once)", async () => {
    const { deps } = await setup();
    const loadDeps = vi.fn(async () => deps);
    const a = startContentCleanupJob({ env: prod, deps: loadDeps, firstRunDelayMs: 1000 });
    const b = startContentCleanupJob({ env: prod, deps: loadDeps, firstRunDelayMs: 1000 });
    expect(b).toBe(a);
    await vi.advanceTimersByTimeAsync(1000);
    expect(loadDeps).toHaveBeenCalledTimes(1);
  });

  it("a failing run is logged and the next one is still scheduled", async () => {
    const loadDeps = vi.fn(async () => {
      throw new Error("storage down");
    });
    startContentCleanupJob({
      env: { ...prod, CONTENT_CLEANUP_INTERVAL_HOURS: "1" },
      deps: loadDeps,
      firstRunDelayMs: 0,
    });
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(HOUR);
    expect(loadDeps).toHaveBeenCalledTimes(2);
    expect(logs.logError).toHaveBeenCalledWith("Content cleanup run failed", {
      error: "storage down",
    });
  });
});

describe("common.unit.content-cleanup-job — one run", () => {
  it("skips when another instance holds the lock (lease taken)", async () => {
    const { deps, blobs } = await setup(2);
    const cleanup = vi.spyOn(deps, "cleanup");
    const other = await blobs.acquireLock(CONTENT_CLEANUP_LOCK_KEY, 60);
    expect(other).toBeDefined();
    expect(await runContentCleanupOnce(deps)).toEqual({ status: "skipped-locked" });
    expect(cleanup).not.toHaveBeenCalled();
    await other!.release();
    expect((await runContentCleanupOnce(deps)).status).toBe("done");
  });

  it("gives the lock up after the run (and after a failed run)", async () => {
    const { deps, blobs } = await setup(1);
    await runContentCleanupOnce(deps);
    expect(await blobs.acquireLock(CONTENT_CLEANUP_LOCK_KEY, 60)).toBeDefined();

    const failing = await setup(1);
    failing.deps.cleanup = async () => {
      throw new Error("cosmos down");
    };
    await expect(runContentCleanupOnce(failing.deps)).rejects.toThrow("cosmos down");
    expect(await failing.blobs.acquireLock(CONTENT_CLEANUP_LOCK_KEY, 60)).toBeDefined();
  });

  it("skips when another instance ran within the gap", async () => {
    const { deps, advance } = await setup(1);
    expect((await runContentCleanupOnce(deps, { minGapMs: HOUR })).status).toBe("done");
    advance(30 * 60 * 1000);
    expect(await runContentCleanupOnce(deps, { minGapMs: HOUR })).toEqual({
      status: "skipped-recent",
    });
    advance(31 * 60 * 1000);
    expect((await runContentCleanupOnce(deps, { minGapMs: HOUR })).status).toBe("done");
  });

  it("is bounded per run and goes on from the stored position next time", async () => {
    const { deps, blobs } = await setup(5); // 10 blobs
    const limits = { pageSize: 2, maxBlobs: 4 };
    const first = await runContentCleanupOnce(deps, { limits });
    expect(first).toMatchObject({ status: "done", deleted: 2, complete: false });
    expect(blobs.keys()).toHaveLength(6);
    const second = await runContentCleanupOnce(deps, { limits });
    expect(second).toMatchObject({ status: "done", deleted: 2, complete: false });
    const third = await runContentCleanupOnce(deps, { limits });
    expect(third).toMatchObject({ status: "done", deleted: 1, complete: true });
    expect(blobs.keys()).toEqual([]);
  });

  it("stops at the time budget", async () => {
    const { deps, isReferenced, advance } = await setup(4);
    // Each reference check takes 4 minutes of the 10 minute budget.
    isReferenced.mockImplementation(async () => {
      advance(4 * 60 * 1000);
      return true;
    });
    const run = await runContentCleanupOnce(deps);
    expect(run).toMatchObject({ status: "done", complete: false, deleted: 0 });
    expect(isReferenced).toHaveBeenCalledTimes(3);
  });

  it("keeps referenced and recent content (the rules of cleanupUnreferencedContent)", async () => {
    const { deps, store, isReferenced } = await setup(2);
    const fresh = await store.put(user, Buffer.from("new upload"));
    isReferenced.mockImplementation(async () => true);
    const run = await runContentCleanupOnce(deps);
    expect(run).toMatchObject({ deleted: 0, keptReferenced: 2, keptRecent: 1 });
    expect(fresh.created).toBe(true);
  });

  it("logs counts only: no user ids, hashes or names", async () => {
    const { deps } = await setup(2);
    logs.logInfo.mockClear();
    await runContentCleanupOnce(deps);
    const [message, context] = logs.logInfo.mock.calls.find(([m]) => m === "Content cleanup run")!;
    expect(message).toBe("Content cleanup run");
    expect(Object.keys(context).sort()).toEqual(
      ["complete", "deleted", "durationMs", "keptRecent", "keptReferenced", "lockLost", "scanned", "status"].sort()
    );
    expect(JSON.stringify(logs.logInfo.mock.calls)).not.toContain(user);
  });
});

describe("common.unit.content-cleanup-job — instrumentation", () => {
  it("register() in a test process does not start the job", async () => {
    vi.stubEnv("NEXT_RUNTIME", "nodejs");
    try {
      const { register } = await import("../../../../instrumentation");
      await register();
      expect(globalThis.__contentCleanupJob).toBeUndefined();
      expect(logs.logInfo).toHaveBeenCalledWith("Content cleanup job not started", {
        reason: "test",
      });
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
