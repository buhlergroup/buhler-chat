import { describe, it, expect, vi, beforeEach } from "vitest";

// The one retry rule for etag-checked writes of the persona row.

vi.mock("@/features/common/services/cosmos", () => ({ HistoryContainer: vi.fn() }));
vi.mock("./skills/persona-skill-store", () => ({ readPersonaRow: vi.fn() }));

import {
  ETAG_MAX_ATTEMPTS,
  etagRetryClock,
  etagRetryDelayMs,
  retryOnEtagConflict,
} from "./persona-row";

const conflict = () => Object.assign(new Error("precondition failed"), { code: 412 });

beforeEach(() => {
  vi.spyOn(etagRetryClock, "sleep").mockResolvedValue(undefined);
});

describe("retryOnEtagConflict", () => {
  it("retries a 412 and returns the first success", async () => {
    let n = 0;
    const res = await retryOnEtagConflict(async () => {
      if (++n < 4) throw conflict();
      return "saved";
    });
    expect(res).toBe("saved");
    expect(n).toBe(4);
    expect(etagRetryClock.sleep).toHaveBeenCalledTimes(3);
  });

  it("gives up after 10 attempts", async () => {
    const attempt = vi.fn(async () => {
      throw conflict();
    });
    await expect(retryOnEtagConflict(attempt)).rejects.toThrow(/changed while saving/);
    expect(ETAG_MAX_ATTEMPTS).toBe(10);
    expect(attempt).toHaveBeenCalledTimes(10);
    expect(etagRetryClock.sleep).toHaveBeenCalledTimes(9);
  });

  it("passes any other error through at once", async () => {
    const attempt = vi.fn(async () => {
      throw Object.assign(new Error("down"), { code: 503 });
    });
    await expect(retryOnEtagConflict(attempt)).rejects.toThrow("down");
    expect(attempt).toHaveBeenCalledTimes(1);
  });

  it("waits 20 to 200 ms, at random", () => {
    expect(etagRetryDelayMs(() => 0)).toBe(20);
    expect(etagRetryDelayMs(() => 0.999999)).toBe(200);
    for (let i = 0; i < 50; i++) {
      const ms = etagRetryDelayMs();
      expect(ms).toBeGreaterThanOrEqual(20);
      expect(ms).toBeLessThanOrEqual(200);
    }
  });
});
