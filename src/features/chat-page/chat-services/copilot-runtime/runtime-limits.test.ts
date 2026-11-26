import { describe, it, expect } from "vitest";
import {
  idleSessionsToEvict,
  isRuntimeGoneError,
  isSessionGoneError,
  processRssMb,
  runtimeIdleBackstopSeconds,
  readRuntimeLimits,
  sessionsOverMemoryBudget,
  sessionsToEvict,
  TurnLimiter,
  TurnLimitError,
} from "./runtime-limits";

describe("runtime limits", () => {
  it("reads the env with defaults", () => {
    expect(readRuntimeLimits({})).toEqual({
      sessionIdleMs: 15 * 60 * 1000,
      memoryBudgetMb: 600,
      maxLiveSessions: 400,
      maxTurnsPerUser: 2,
      maxTurnsPerProcess: 32,
    });
    expect(readRuntimeLimits({ COPILOT_MAX_LIVE_SESSIONS: "5", COPILOT_MAX_TURNS_PER_USER: "0" }).maxLiveSessions).toBe(5);
    expect(readRuntimeLimits({ COPILOT_MAX_TURNS_PER_USER: "0" }).maxTurnsPerUser).toBe(2);
  });

  it("idle minutes and memory budget: 0 turns them off, junk gives the default", () => {
    const off = readRuntimeLimits({ COPILOT_SESSION_IDLE_MINUTES: "0", COPILOT_RUNTIME_MEMORY_BUDGET_MB: "0" });
    expect(off.sessionIdleMs).toBe(0);
    expect(off.memoryBudgetMb).toBe(0);
    const set = readRuntimeLimits({ COPILOT_SESSION_IDLE_MINUTES: "5", COPILOT_RUNTIME_MEMORY_BUDGET_MB: "1200" });
    expect(set.sessionIdleMs).toBe(5 * 60 * 1000);
    expect(set.memoryBudgetMb).toBe(1200);
    const junk = readRuntimeLimits({ COPILOT_SESSION_IDLE_MINUTES: "-1", COPILOT_RUNTIME_MEMORY_BUDGET_MB: "lots" });
    expect(junk.sessionIdleMs).toBe(15 * 60 * 1000);
    expect(junk.memoryBudgetMb).toBe(600);
  });

  it("idle eviction: sessions idle at least the idle time, oldest first, never a busy one", () => {
    const sessions = new Map([
      ["recent", { busy: false, lastUsed: 900 }],
      ["old", { busy: false, lastUsed: 100 }],
      ["older-busy", { busy: true, lastUsed: 0 }],
      ["edge", { busy: false, lastUsed: 500 }],
    ]);
    expect(idleSessionsToEvict(sessions, 1000, 500)).toEqual(["old", "edge"]);
    expect(idleSessionsToEvict(sessions, 1000, 0)).toEqual([]);
  });

  it("memory guard: under budget nothing, over budget the LRU idle sessions that free the excess", () => {
    const sessions = new Map(
      Array.from({ length: 10 }, (_, i) => [`s${i}`, { busy: i === 0, lastUsed: i }] as const),
    );
    expect(sessionsOverMemoryBudget(sessions, 590, 600, 2)).toEqual([]);
    expect(sessionsOverMemoryBudget(sessions, undefined, 600, 2)).toEqual([]);
    expect(sessionsOverMemoryBudget(sessions, 900, 0, 2)).toEqual([]);
    // 5 MB over at 2 MB per session: 3 sessions, the busy s0 is skipped.
    expect(sessionsOverMemoryBudget(sessions, 605, 600, 2)).toEqual(["s1", "s2", "s3"]);
    // Just over: at least one.
    expect(sessionsOverMemoryBudget(sessions, 600.5, 600, 2)).toEqual(["s1"]);
    // Far over: every idle session, never the busy one.
    expect(sessionsOverMemoryBudget(sessions, 5000, 600, 2)).toHaveLength(9);
  });

  it("reads the RSS of a process from /proc (Linux), undefined elsewhere", () => {
    const status = ["Name:\tcopilot-runtime", "VmPeak:\t  900000 kB", "VmRSS:\t  524288 kB", "Threads:\t12", ""].join("\n");
    expect(processRssMb(42, (f) => (f === "/proc/42/status" ? status : ""))).toBe(512);
    expect(processRssMb(undefined)).toBeUndefined();
    expect(
      processRssMb(42, () => {
        throw new Error("ENOENT");
      }),
    ).toBeUndefined();
  });

  it("per user: 2 turns at once, the third is refused until one ends", () => {
    const limiter = new TurnLimiter(() => ({ maxTurnsPerUser: 2, maxTurnsPerProcess: 10 }));
    const a = limiter.acquire("u1");
    limiter.acquire("u1");
    expect(() => limiter.acquire("u1")).toThrow(TurnLimitError);
    // Another user is not affected.
    limiter.acquire("u2");
    a();
    a(); // releasing twice frees one slot only
    expect(() => limiter.acquire("u1")).not.toThrow();
    expect(() => limiter.acquire("u1")).toThrow(/maximum number of replies running/);
    expect(limiter.running).toBe(3);
  });

  it("per process", () => {
    const limiter = new TurnLimiter(() => ({ maxTurnsPerUser: 5, maxTurnsPerProcess: 2 }));
    limiter.acquire("a");
    limiter.acquire("b");
    const err = (() => {
      try {
        limiter.acquire("c");
      } catch (e) {
        return e as TurnLimitError;
      }
    })();
    expect(err?.status).toBe(429);
    expect(err?.message).toMatch(/busy/);
  });

  it("hard cap: least recently used idle sessions go first, busy ones stay", () => {
    const sessions = new Map([
      ["a", { busy: false, lastUsed: 1 }],
      ["b", { busy: true, lastUsed: 0 }],
      ["c", { busy: false, lastUsed: 5 }],
      ["d", { busy: false, lastUsed: 3 }],
    ]);
    expect(sessionsToEvict(sessions, 2)).toEqual(["a", "d"]);
    expect(sessionsToEvict(sessions, 4)).toEqual([]);
  });

  it("recognises a lost runtime connection", () => {
    expect(isRuntimeGoneError(new Error("Connection is closed."))).toBe(true);
    expect(isRuntimeGoneError(Object.assign(new Error("write"), { code: "EPIPE" }))).toBe(true);
    expect(isRuntimeGoneError(new Error("Invalid argument"))).toBe(false);
  });

  it("a session the runtime dropped is not a lost runtime (only that session goes)", () => {
    // The runtime's message after its own idle timeout dropped the session (measured).
    const err = new Error("Request session.send failed with message: Session not found for sessionId: thread-x");
    expect(isRuntimeGoneError(err)).toBe(false);
    expect(isSessionGoneError(err)).toBe(true);
    expect(isSessionGoneError(new Error("Connection is closed. Session not found"))).toBe(false);
    expect(isSessionGoneError(new Error("Invalid argument"))).toBe(false);
  });

  it("the runtime's idle timeout is a backstop at twice our idle time, off when ours is off", () => {
    expect(runtimeIdleBackstopSeconds({ sessionIdleMs: 15 * 60 * 1000 })).toBe(1800);
    expect(runtimeIdleBackstopSeconds({ sessionIdleMs: 0 })).toBe(0);
  });
});
