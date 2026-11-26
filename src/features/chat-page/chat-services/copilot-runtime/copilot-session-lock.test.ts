import { describe, it, expect, vi } from "vitest";

vi.mock("@/features/common/services/logger", () => ({ logDebug: vi.fn(), logInfo: vi.fn(), logWarn: vi.fn(), logError: vi.fn() }));
vi.mock("./azure-blob-store", () => ({ getAgentWorkspaceLeases: vi.fn(), getAgentWorkspaceStore: vi.fn() }));
vi.mock("../chat-image-service", () => ({ GetImageFromStore: vi.fn() }));
vi.mock("../chat-api/persist-assistant", () => ({ friendlyErrorMessage: () => "error" }));

import type { LeaseBackend } from "./thread-lease";

/** Thread lease in memory; `held` names are taken by someone else. */
function memoryLeases(): LeaseBackend & { meta: Map<string, Record<string, string>>; held: Set<string> } {
  const meta = new Map<string, Record<string, string>>();
  const held = new Set<string>();
  return {
    meta,
    held,
    async ensureBlob(name) {
      if (!meta.has(name)) meta.set(name, {});
    },
    async acquire(name) {
      if (held.has(name)) return undefined;
      held.add(name);
      return `lease-${name}`;
    },
    async renew() {},
    async release(name, _id, m) {
      meta.set(name, m);
      held.delete(name);
    },
    async readMetadata(name) {
      return meta.get(name) ?? {};
    },
  };
}

const USER = "c".repeat(64);
const LEASE = `${USER}/t1/lease`;

/** The runtime state copilot-session keeps on globalThis, with one live session of thread t1. */
function seedRuntime() {
  const disconnect = vi.fn(async () => undefined);
  const turn = new AbortController();
  const g = globalThis as unknown as { __copilotRuntime?: unknown };
  g.__copilotRuntime = {
    instanceId: "instance-a",
    sessions: new Map([["thread-t1", { session: { disconnect }, busy: true }]]),
    turnAborts: new Map([["thread-t1", turn]]),
  };
  return { disconnect, turn, sessions: (g.__copilotRuntime as { sessions: Map<string, unknown> }).sessions };
}

describe("lockThreadSessions (reset / rewind during a running turn)", () => {
  it("stops this instance's running turn, waits for its lease, drops the live session; release starts a new generation", async () => {
    const { disconnect, turn, sessions } = seedRuntime();
    vi.resetModules();
    const { lockThreadSessions } = await import("./copilot-session");
    const leases = memoryLeases();
    // The running turn holds the lease and gives it back once it is aborted.
    leases.held.add(LEASE);
    turn.signal.addEventListener("abort", () => setTimeout(() => void leases.release(LEASE, "x", { holder: "instance-a" }), 20));

    const lock = await lockThreadSessions(USER, "t1", leases, { pollMs: 5 });
    expect(turn.signal.aborted).toBe(true);
    expect(disconnect).toHaveBeenCalledTimes(1);
    expect(sessions.has("thread-t1")).toBe(false);
    // Held while the caller deletes: no turn can start meanwhile.
    expect(leases.held.has(LEASE)).toBe(true);
    await lock.release();
    expect(leases.held.has(LEASE)).toBe(false);
    expect(leases.meta.get(LEASE)?.holder).toMatch(/^reset-/);
  });

  it("a turn on another instance (lease held, nothing to stop here) refuses the lock and keeps the live session", async () => {
    const g = globalThis as unknown as { __copilotRuntime?: unknown };
    const disconnect = vi.fn(async () => undefined);
    g.__copilotRuntime = { instanceId: "instance-a", sessions: new Map([["thread-t1", { session: { disconnect }, busy: false }]]), turnAborts: new Map() };
    vi.resetModules();
    const { lockThreadSessions } = await import("./copilot-session");
    const { ThreadBusyError: BusyError } = await import("./thread-lease");
    const leases = memoryLeases();
    leases.held.add(LEASE);
    const err = await lockThreadSessions(USER, "t1", leases, { waitMs: 30, pollMs: 5 }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BusyError);
    expect(disconnect).not.toHaveBeenCalled();
  });
});
