// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("server-only", () => ({}));

const mockSession = vi.fn();
const mockRuntime = vi.fn();
const mockFindThread = vi.fn();
const mockThreadWorkspace = vi.fn();

vi.mock("@/features/auth-page/helpers", () => ({
  userSession: () => mockSession(),
  userHashedId: async () => "user-hash",
}));
vi.mock("@/features/common/services/logger", () => ({ logError: vi.fn(), logInfo: vi.fn(), logWarn: vi.fn() }));
vi.mock("./runtime-selection", () => ({ resolveAgentRuntimeForCurrentUser: () => mockRuntime() }));
vi.mock("../chat-thread-service", () => ({ FindChatThreadForCurrentUser: (id: string) => mockFindThread(id) }));
vi.mock("./workspace-files", () => ({ threadWorkspace: (...a: unknown[]) => mockThreadWorkspace(...a) }));

import { BlobSessionFs } from "./blob-session-fs";
import { FakeBlobStore } from "./fake-blob-store.test-helper";
import { WorkspaceFileAPIEntry } from "./workspace-file-api";

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 1, 2, 3]);
const url = (t: string, p: string) =>
  `http://localhost/api/workspace/file?t=${encodeURIComponent(t)}&p=${encodeURIComponent(p)}`;

let store: FakeBlobStore;

describe("GET /api/workspace/file", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    store = new FakeBlobStore();
    mockSession.mockResolvedValue({ email: "a@example.invalid" });
    mockRuntime.mockResolvedValue("copilot");
    mockFindThread.mockImplementation(async (id: string) =>
      id === "thread1" ? { status: "OK", response: { id } } : { status: "NOT_FOUND", errors: [{ message: "nf" }] },
    );
    mockThreadWorkspace.mockImplementation(async (userKey: string, threadId: string) => ({
      store,
      fs: new BlobSessionFs(store, `${userKey}/${threadId}`, undefined, undefined),
    }));
    const fs = new BlobSessionFs(store, "user-hash/thread1", undefined, undefined);
    await fs.writeFileBytes("/workspace/out/chart.png", PNG);
    await fs.writeFileBytes("/workspace/out/fake.png", Buffer.from("<svg onload=alert(1)>"));
    await fs.writeFileBytes("/workspace/uploads/page.html", Buffer.from("<script>alert(1)</script>"));
    await fs.writeFile("/session-state/events.jsonl", "{\"secret\":1}\n");
  });

  it("401 without a session, before anything else", async () => {
    mockSession.mockResolvedValue(null);
    const res = await WorkspaceFileAPIEntry(new Request(url("thread1", "out/chart.png")));
    expect(res.status).toBe(401);
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(mockFindThread).not.toHaveBeenCalled();
    expect(mockThreadWorkspace).not.toHaveBeenCalled();
  });

  it("404 for a thread of another user (same answer as a missing thread)", async () => {
    const res = await WorkspaceFileAPIEntry(new Request(url("thread-of-someone-else", "out/chart.png")));
    expect(res.status).toBe(404);
    expect(mockThreadWorkspace).not.toHaveBeenCalled();
  });

  it("404 for a user on the AI SDK path", async () => {
    mockRuntime.mockResolvedValue("ai-sdk");
    expect((await WorkspaceFileAPIEntry(new Request(url("thread1", "out/chart.png")))).status).toBe(404);
    expect(mockThreadWorkspace).not.toHaveBeenCalled();
  });

  it("404 for an invalid thread id, a missing file and a folder", async () => {
    expect((await WorkspaceFileAPIEntry(new Request(url("../x", "out/chart.png")))).status).toBe(404);
    expect((await WorkspaceFileAPIEntry(new Request(url("thread1", "out/missing.png")))).status).toBe(404);
    expect((await WorkspaceFileAPIEntry(new Request(url("thread1", "out")))).status).toBe(404);
  });

  it.each([
    "../session-state/events.jsonl",
    "/session-state/events.jsonl",
    "uploads/../../session-state/events.jsonl",
    "..\\session-state\\events.jsonl",
    "/workspace/out/chart.png",
    "",
  ])("400 for the path %j, nothing read", async (p) => {
    store.requests.length = 0;
    const res = await WorkspaceFileAPIEntry(new Request(url("thread1", p)));
    expect(res.status).toBe(400);
    expect(await res.text()).not.toContain("secret");
    expect(store.requests).toEqual([]);
  });

  it("serves a real PNG inline with its type", async () => {
    const res = await WorkspaceFileAPIEntry(new Request(url("thread1", "out/chart.png")));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
    expect(res.headers.get("content-disposition")).toMatch(/^inline; filename="chart.png"/);
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("content-security-policy")).toContain("sandbox");
    expect(Buffer.from(await res.arrayBuffer())).toEqual(PNG);
  });

  it("serves a .png whose bytes are no PNG as an attachment of opaque bytes", async () => {
    const res = await WorkspaceFileAPIEntry(new Request(url("thread1", "out/fake.png")));
    expect(res.headers.get("content-type")).toBe("application/octet-stream");
    expect(res.headers.get("content-disposition")).toMatch(/^attachment; filename="fake.png"/);
  });

  it("serves HTML as an attachment of opaque bytes, never as a page", async () => {
    const res = await WorkspaceFileAPIEntry(new Request(url("thread1", "uploads/page.html")));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/octet-stream");
    expect(res.headers.get("content-disposition")).toMatch(/^attachment; filename="page.html"/);
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(await res.text()).toBe("<script>alert(1)</script>");
  });

  it("streams: only the first chunk is read before the body is consumed", async () => {
    store.chunkSize = 1024;
    const big = Buffer.alloc(256 * 1024, 7);
    const fs = new BlobSessionFs(store, "user-hash/thread1", undefined, undefined);
    await fs.writeFileBytes("/workspace/out/big.bin", big);
    const dataKey = store.blobs.get("user-hash/thread1/f/workspace/out/big.bin")!.metadata.target;
    store.chunksServed.clear();

    const res = await WorkspaceFileAPIEntry(new Request(url("thread1", "out/big.bin")));
    expect(res.headers.get("content-length")).toBe(String(big.length));
    expect(store.chunksServed.get(dataKey) ?? 0).toBeLessThanOrEqual(2);

    const body = Buffer.from(await res.arrayBuffer());
    expect(body.equals(big)).toBe(true);
    expect(store.chunksServed.get(dataKey)).toBe(256);
  });
});
