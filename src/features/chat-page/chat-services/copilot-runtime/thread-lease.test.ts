import { describe, it, expect, vi, afterEach } from "vitest";

import { acquireThreadLease, ThreadBusyError, type LeaseBackend } from "./thread-lease";

/** In-memory Blob lease semantics: one lease per blob, ids, metadata, expiry by hand. */
class FakeLeases implements LeaseBackend {
  blobs = new Map<string, { leaseId?: string; metadata: Record<string, string> }>();
  calls: string[] = [];
  failRenew = false;
  private n = 0;
  async ensureBlob(name: string) {
    if (!this.blobs.has(name)) this.blobs.set(name, { metadata: {} });
  }
  async acquire(name: string) {
    this.calls.push("acquire");
    const b = this.blobs.get(name)!;
    if (b.leaseId) return undefined;
    b.leaseId = `lease-${++this.n}`;
    return b.leaseId;
  }
  async renew(name: string, leaseId: string) {
    this.calls.push("renew");
    if (this.failRenew || this.blobs.get(name)?.leaseId !== leaseId) throw new Error("LeaseIdMismatch");
  }
  async release(name: string, leaseId: string, metadata: Record<string, string>) {
    this.calls.push("release");
    const b = this.blobs.get(name)!;
    if (b.leaseId !== leaseId) throw new Error("LeaseIdMismatch");
    b.metadata = { ...b.metadata, ...metadata };
    b.leaseId = undefined;
  }
  async readMetadata(name: string) {
    return { ...(this.blobs.get(name)?.metadata ?? {}) };
  }
  /** The lease runs out (its holder crashed). */
  expire(name: string) {
    this.blobs.get(name)!.leaseId = undefined;
  }
}

const instant = { waitMs: 0, sleep: async () => undefined };

describe("acquireThreadLease", () => {
  afterEach(() => vi.useRealTimers());

  it("holds the thread for one turn and records the holder on release", async () => {
    const leases = new FakeLeases();
    const a = await acquireThreadLease(leases, "u/t/lease", { holder: "instance-a", ...instant });
    expect(a.previousHolder).toBeUndefined();
    await a.release();
    expect(leases.blobs.get("u/t/lease")).toEqual({ metadata: { holder: "instance-a" } });
    const b = await acquireThreadLease(leases, "u/t/lease", { holder: "instance-b", ...instant });
    // Instance B learns that A ran the thread last (a live session of B would be stale).
    expect(b.previousHolder).toBe("instance-a");
    await b.release();
  });

  it("a second concurrent turn gets ThreadBusyError after the wait", async () => {
    const leases = new FakeLeases();
    const first = await acquireThreadLease(leases, "u/t/lease", { holder: "a", ...instant });
    const sleeps: number[] = [];
    let clock = 0;
    const now = vi.spyOn(Date, "now").mockImplementation(() => clock);
    await expect(
      acquireThreadLease(leases, "u/t/lease", {
        holder: "b",
        waitMs: 2000,
        pollMs: 500,
        sleep: async (ms) => {
          sleeps.push(ms);
          clock += ms;
        },
      }),
    ).rejects.toBeInstanceOf(ThreadBusyError);
    now.mockRestore();
    expect(sleeps).toEqual([500, 500, 500, 500]);
    await first.release();
  });

  it("a waiting turn gets the lease when the first one releases", async () => {
    const leases = new FakeLeases();
    const first = await acquireThreadLease(leases, "u/t/lease", { holder: "a", ...instant });
    const second = acquireThreadLease(leases, "u/t/lease", {
      holder: "a",
      waitMs: 10_000,
      pollMs: 1,
      sleep: async () => {
        await first.release();
      },
    });
    await expect(second).resolves.toMatchObject({ previousHolder: "a" });
  });

  it("an expired lease (crashed holder) can be taken over", async () => {
    const leases = new FakeLeases();
    await acquireThreadLease(leases, "u/t/lease", { holder: "a", ...instant });
    leases.expire("u/t/lease");
    await expect(acquireThreadLease(leases, "u/t/lease", { holder: "b", ...instant })).resolves.toBeDefined();
  });

  it("renews while the turn runs and reports a lost lease", async () => {
    vi.useFakeTimers();
    const leases = new FakeLeases();
    const onLost = vi.fn();
    const handle = await acquireThreadLease(leases, "u/t/lease", { holder: "a", renewEveryMs: 1000, onLost, ...instant });
    await vi.advanceTimersByTimeAsync(3000);
    expect(leases.calls.filter((c) => c === "renew")).toHaveLength(3);
    leases.failRenew = true;
    await vi.advanceTimersByTimeAsync(1000);
    expect(onLost).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(5000);
    expect(leases.calls.filter((c) => c === "renew")).toHaveLength(4); // renewal stopped
    await handle.release(); // the lease is gone: nothing to release
    expect(leases.calls).not.toContain("release");
  });

  it("release is idempotent and stops renewal", async () => {
    vi.useFakeTimers();
    const leases = new FakeLeases();
    const handle = await acquireThreadLease(leases, "u/t/lease", { holder: "a", renewEveryMs: 1000, ...instant });
    await handle.release();
    await handle.release();
    await vi.advanceTimersByTimeAsync(5000);
    expect(leases.calls).toEqual(["acquire", "release"]);
  });
});
