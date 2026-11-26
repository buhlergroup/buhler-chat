// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("server-only", () => ({}));

const mockSession = vi.fn();
const mockRuntime = vi.fn();
const mockFindThread = vi.fn();
const mockUpload = vi.fn();
const mockRemove = vi.fn();
const mockListing = vi.fn();

vi.mock("@/features/auth-page/helpers", () => ({
  userSession: () => mockSession(),
  userHashedId: async () => "user-hash",
}));
vi.mock("@/features/common/services/logger", () => ({ logError: vi.fn(), logInfo: vi.fn(), logWarn: vi.fn() }));
vi.mock("./runtime-selection", () => ({ resolveAgentRuntimeForCurrentUser: () => mockRuntime() }));
vi.mock("../chat-thread-service", () => ({ FindChatThreadForCurrentUser: (id: string) => mockFindThread(id) }));
vi.mock("./workspace-files", () => ({
  uploadToThreadWorkspace: (...a: unknown[]) => mockUpload(...a),
  removeThreadWorkspaceFile: (...a: unknown[]) => mockRemove(...a),
  threadWorkspaceListing: (...a: unknown[]) => mockListing(...a),
}));

import { BlobSessionFs } from "./blob-session-fs";
import { FakeBlobStore } from "./fake-blob-store.test-helper";
import { listWorkspaceFiles, removeWorkspaceFile } from "./workspace-listing";
import { ListWorkspaceFiles, RemoveWorkspaceFile, UploadFileToAgentWorkspace } from "./workspace-upload-actions";

const form = (id: string) => {
  const fd = new FormData();
  fd.set("file", new File([Buffer.from("a,b")], "data.csv"));
  fd.set("id", id);
  return fd;
};

describe("UploadFileToAgentWorkspace (Server Action)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRuntime.mockResolvedValue("copilot");
    mockFindThread.mockResolvedValue({ status: "OK", response: { id: "thread1" } });
    mockUpload.mockResolvedValue({ path: "/workspace/uploads/data.csv", kind: "text", bytes: 3 });
  });

  it("refuses a call without a session before it does anything", async () => {
    mockSession.mockResolvedValue(null);
    const res = await UploadFileToAgentWorkspace(form("thread1"));
    expect(res.status).toBe("UNAUTHORIZED");
    expect(mockRuntime).not.toHaveBeenCalled();
    expect(mockFindThread).not.toHaveBeenCalled();
    expect(mockUpload).not.toHaveBeenCalled();
  });

  it("refuses a thread id that is not an id of this app", async () => {
    mockSession.mockResolvedValue({ email: "a@example.invalid" });
    const res = await UploadFileToAgentWorkspace(form("../other"));
    expect(res.status).toBe("ERROR");
    expect(mockFindThread).not.toHaveBeenCalled();
    expect(mockUpload).not.toHaveBeenCalled();
  });

  it("stores the file for a signed-in user on the Copilot path, with what the chip needs", async () => {
    mockSession.mockResolvedValue({ email: "a@example.invalid" });
    const res = await UploadFileToAgentWorkspace(form("thread1"));
    expect(res).toMatchObject({
      status: "OK",
      response: { handled: true, path: "/workspace/uploads/data.csv", size: 3 },
    });
    expect(res.status === "OK" && res.response.modified).toMatch(/^\d{4}-\d\d-\d\dT/);
    expect(mockUpload).toHaveBeenCalledWith("user-hash", "thread1", "data.csv", expect.any(Buffer));
  });
});

describe("RemoveWorkspaceFile / ListWorkspaceFiles (Server Actions)", () => {
  let store: FakeBlobStore;
  const fsFor = (userKey: string, threadId: string) =>
    new BlobSessionFs(store, `${userKey}/${threadId}`, undefined, undefined);

  beforeEach(async () => {
    vi.clearAllMocks();
    store = new FakeBlobStore();
    mockSession.mockResolvedValue({ email: "a@example.invalid" });
    mockRuntime.mockResolvedValue("copilot");
    mockFindThread.mockImplementation(async (id: string) =>
      id === "thread1" ? { status: "OK", response: { id } } : { status: "NOT_FOUND", errors: [{ message: "nf" }] },
    );
    // The real removal and listing, on an in-memory Blob store.
    mockRemove.mockImplementation((userKey: string, threadId: string, path: unknown) =>
      removeWorkspaceFile({ fs: fsFor(userKey, threadId) }, path),
    );
    mockListing.mockImplementation((userKey: string, threadId: string) =>
      listWorkspaceFiles({ fs: fsFor(userKey, threadId) }),
    );
    const fs = fsFor("user-hash", "thread1");
    await fs.writeFileBytes("/workspace/uploads/a.pdf", Buffer.from("%PDF"));
    await fs.writeFileBytes("/workspace/uploads/a.pdf.md", Buffer.from("text"));
    await fs.writeFileBytes("/workspace/uploads/x", Buffer.from("x"));
    await fs.writeFileBytes("/workspace/keep.txt", Buffer.from("k"));
    await fs.writeFile("/session-state/events.jsonl", "{}\n");
  });

  const remaining = () => fsFor("user-hash", "thread1").listFiles("/workspace");

  it("refuses a call without a session before it does anything (401 in the auth model)", async () => {
    mockSession.mockResolvedValue(null);
    expect((await RemoveWorkspaceFile("thread1", "uploads/a.pdf")).status).toBe("UNAUTHORIZED");
    expect((await ListWorkspaceFiles("thread1")).status).toBe("UNAUTHORIZED");
    expect(mockRuntime).not.toHaveBeenCalled();
    expect(mockFindThread).not.toHaveBeenCalled();
    expect(mockRemove).not.toHaveBeenCalled();
    expect(mockListing).not.toHaveBeenCalled();
  });

  it("refuses a thread the user does not own, and leaves its files", async () => {
    const res = await RemoveWorkspaceFile("thread-of-someone-else", "uploads/a.pdf");
    expect(res.status).toBe("NOT_FOUND");
    expect(mockRemove).not.toHaveBeenCalled();
    expect((await ListWorkspaceFiles("thread-of-someone-else")).status).toBe("NOT_FOUND");
    expect(mockListing).not.toHaveBeenCalled();
  });

  it("does nothing for a user on the AI SDK path", async () => {
    mockRuntime.mockResolvedValue("ai-sdk");
    expect((await RemoveWorkspaceFile("thread1", "uploads/a.pdf")).status).toBe("NOT_FOUND");
    expect((await ListWorkspaceFiles("thread1")).status).toBe("NOT_FOUND");
    expect(mockFindThread).not.toHaveBeenCalled();
    expect(mockRemove).not.toHaveBeenCalled();
  });

  it("refuses an invalid thread id", async () => {
    expect((await RemoveWorkspaceFile("../thread1", "uploads/a.pdf")).status).toBe("ERROR");
    expect(mockFindThread).not.toHaveBeenCalled();
  });

  it.each(["../x", "uploads/../x", "a\\b", "", "/session-state/events.jsonl", "/workspace/keep.txt"])(
    "refuses the path %j and deletes nothing",
    async (path) => {
      const res = await RemoveWorkspaceFile("thread1", path);
      expect(res).toEqual({ status: "ERROR", errors: [{ message: "Invalid file path" }] });
      expect(await remaining()).toHaveLength(4);
      expect(await fsFor("user-hash", "thread1").exists("/session-state/events.jsonl")).toBe(true);
    },
  );

  it("answers NOT_FOUND for a path that is no file (a/b, a folder) and deletes nothing", async () => {
    expect(await RemoveWorkspaceFile("thread1", "a/b")).toEqual({ status: "NOT_FOUND", errors: [{ message: "File not found" }] });
    expect((await RemoveWorkspaceFile("thread1", "uploads")).status).toBe("NOT_FOUND");
    expect(await remaining()).toHaveLength(4);
  });

  it("deletes an upload with its text extract, never other files", async () => {
    const res = await RemoveWorkspaceFile("thread1", "uploads/a.pdf");
    expect(res.status).toBe("OK");
    expect(res.status === "OK" && res.response.removed.sort()).toEqual(["uploads/a.pdf", "uploads/a.pdf.md"]);
    expect((await remaining()).sort()).toEqual(["/workspace/keep.txt", "/workspace/uploads/x"]);
    expect(await fsFor("user-hash", "thread1").exists("/session-state/events.jsonl")).toBe(true);
  });

  it("keeps the file and says so when its index entries could not be deleted", async () => {
    mockRemove.mockImplementation((userKey: string, threadId: string, path: unknown) =>
      removeWorkspaceFile(
        {
          fs: fsFor(userKey, threadId),
          removeIndexEntries: async () => {
            throw Object.assign(new Error("search down"), { name: "WorkspaceIndexRemovalError" });
          },
        },
        path,
      ),
    );
    const res = await RemoveWorkspaceFile("thread1", "uploads/a.pdf");
    expect(res).toEqual({
      status: "ERROR",
      errors: [{ message: "The search index entries of the file could not be deleted. The file is kept; try again." }],
    });
    expect(await remaining()).toHaveLength(4);
  });

  it("deletes a created file anywhere under /workspace", async () => {
    const res = await RemoveWorkspaceFile("thread1", "keep.txt");
    expect(res).toEqual({ status: "OK", response: { removed: ["keep.txt"] } });
  });

  it("lists the thread's files for the panel", async () => {
    const res = await ListWorkspaceFiles("thread1");
    expect(res.status).toBe("OK");
    if (res.status !== "OK") return;
    expect(res.response.total).toBe(4);
    expect(res.response.files.map((f) => f.path).sort()).toEqual([
      "keep.txt",
      "uploads/a.pdf",
      "uploads/a.pdf.md",
      "uploads/x",
    ]);
    expect(mockListing).toHaveBeenCalledWith("user-hash", "thread1");
  });
});
