import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/features/common/services/logger", () => ({ logInfo: vi.fn(), logWarn: vi.fn(), logError: vi.fn() }));
vi.mock("@/features/common/services/cosmos", () => ({ HistoryContainer: vi.fn() }));
vi.mock("./document-pipeline", () => ({ extractDocumentText: vi.fn(), indexDocument: vi.fn() }));
vi.mock("./azure-blob-store", () => ({ getAgentWorkspaceStore: vi.fn(), getExistingAgentWorkspaceStore: vi.fn() }));
const invalidate = vi.fn(async (_u: string, _t: string) => undefined);
vi.mock("./copilot-session", () => ({ invalidateThreadSessions: (u: string, t: string) => invalidate(u, t) }));

import { BlobSessionFs, WorkspaceQuota, WorkspaceQuotaError } from "./blob-session-fs";
import { FakeBlobStore } from "./fake-blob-store.test-helper";
import { removeThreadWorkspaceFiles, removeThreadWorkspaceFilesQuietly } from "./workspace-files";
import { acquireThreadLease, type LeaseBackend } from "./thread-lease";

const USER = "c".repeat(64);
const ns = (t: string) => `${USER}/${t}`;
const fsFor = (store: FakeBlobStore, thread: string, quota?: WorkspaceQuota) =>
  new BlobSessionFs(store, ns(thread), undefined, quota);

describe("workspace quota", () => {
  it("refuses a write over the byte quota; the journal is not counted", async () => {
    const store = new FakeBlobStore();
    const fs = fsFor(store, "t1", new WorkspaceQuota(100, 10));
    await fs.writeFile("/workspace/a.txt", "x".repeat(60));
    await expect(fs.writeFile("/workspace/b.txt", "y".repeat(50))).rejects.toBeInstanceOf(WorkspaceQuotaError);
    // Overwriting a file counts only the difference.
    await fs.writeFile("/workspace/a.txt", "x".repeat(90));
    // The runtime's own state is outside the quota.
    await fs.writeFile("/session-state/events.jsonl", "z".repeat(500));
    await fs.appendFile("/session-state/events.jsonl", "z".repeat(500));
  });

  it("refuses a new file over the file-count quota", async () => {
    const store = new FakeBlobStore();
    const fs = fsFor(store, "t2", new WorkspaceQuota(1 << 20, 2));
    await fs.writeFile("/workspace/1.txt", "1");
    await fs.writeFile("/workspace/2.txt", "2");
    const err = await fs.writeFile("/workspace/3.txt", "3").catch((e) => e);
    expect(err).toBeInstanceOf(WorkspaceQuotaError);
    expect((err as Error).message).toMatch(/limit 2/);
    // Rewriting an existing file is fine; after a delete there is room again.
    await fs.writeFile("/workspace/2.txt", "22");
    await fs.rm("/workspace/1.txt", false, false);
    await fs.writeFile("/workspace/3.txt", "3");
  });

  it("measures usage written by another instance (one listing)", async () => {
    const store = new FakeBlobStore();
    await fsFor(store, "t3", undefined).writeFile("/workspace/big.bin", "b".repeat(80));
    const fs = fsFor(store, "t3", new WorkspaceQuota(100, 10));
    await expect(fs.writeFile("/workspace/c.txt", "c".repeat(30))).rejects.toThrow(/quota/);
  });
});

/** In-memory lease backend that keeps metadata like the Azure one. */
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

describe("reset / rewind clean-up", () => {
  beforeEach(() => invalidate.mockClear());

  it("session scope removes the journal only; all removes the whole thread", async () => {
    const store = new FakeBlobStore();
    const fs = fsFor(store, "t4");
    await fs.writeFile("/session-state/events.jsonl", "{}" + String.fromCharCode(10));
    await fs.writeFile("/session-state/workspace.yaml", "a: 1");
    await fs.writeFile("/workspace/notes/plan.md", "plan");
    await removeThreadWorkspaceFiles(USER, "t4", "session", store);
    expect(await fs.exists("/session-state/events.jsonl")).toBe(false);
    expect(await fs.exists("/session-state/workspace.yaml")).toBe(false);
    expect(await fs.exists("/workspace/notes/plan.md")).toBe(true);
    await removeThreadWorkspaceFiles(USER, "t4", "all", store);
    expect(await fs.exists("/workspace/notes/plan.md")).toBe(false);
    expect([...store.blobs.keys()].filter((k) => k.startsWith(`${ns("t4")}/`))).toEqual([]);
  });

  it("removing the session state invalidates the live sessions (all instances); removing uploads does not", async () => {
    const env = { ...process.env };
    process.env.AGENT_RUNTIME = "copilot";
    const store = new FakeBlobStore();
    const { getExistingAgentWorkspaceStore } = await import("./azure-blob-store");
    vi.mocked(getExistingAgentWorkspaceStore).mockResolvedValue(store as never);
    await removeThreadWorkspaceFilesQuietly(USER, "t5", "uploads");
    expect(invalidate).not.toHaveBeenCalled();
    await removeThreadWorkspaceFilesQuietly(USER, "t5", "session");
    expect(invalidate).toHaveBeenCalledWith(USER, "t5");
    await removeThreadWorkspaceFilesQuietly(USER, "t5", "all");
    expect(invalidate).toHaveBeenCalledTimes(2);
    process.env = env;
  });

  it("an invalidation (holder reset-…) makes every instance drop its live session on the next turn", async () => {
    const leases = memoryLeases();
    const name = `${ns("t6")}/lease`;
    // Instance A ran the thread last.
    await (await acquireThreadLease(leases, name, { holder: "instance-a" })).release();
    // A reset elsewhere gives the lease blob a new generation.
    await (await acquireThreadLease(leases, name, { holder: "reset-123" })).release();
    const next = await acquireThreadLease(leases, name, { holder: "instance-a" });
    // copilot-session drops its live session when previousHolder is not its own id.
    expect(next.previousHolder).toBe("reset-123");
    expect(next.previousHolder).not.toBe("instance-a");
    await next.release();
  });
});
