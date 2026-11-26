import { describe, it, expect } from "vitest";
import { isRuntimeGoneError, readRuntimeLimits, sessionsToEvict, TurnLimiter, TurnLimitError } from "./runtime-limits";

describe("runtime limits", () => {
  it("reads the env with defaults", () => {
    expect(readRuntimeLimits({})).toEqual({ maxLiveSessions: 200, maxTurnsPerUser: 2, maxTurnsPerProcess: 32 });
    expect(readRuntimeLimits({ COPILOT_MAX_LIVE_SESSIONS: "5", COPILOT_MAX_TURNS_PER_USER: "0" }).maxLiveSessions).toBe(5);
    expect(readRuntimeLimits({ COPILOT_MAX_TURNS_PER_USER: "0" }).maxTurnsPerUser).toBe(2);
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
    expect(() => limiter.acquire("u1")).toThrow(/replies running/);
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

  it("LRU cap: least recently used idle sessions go first, busy ones stay", () => {
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
    expect(isRuntimeGoneError(new Error("Session not found: thread-x"))).toBe(true);
    expect(isRuntimeGoneError(new Error("Invalid argument"))).toBe(false);
  });
});
