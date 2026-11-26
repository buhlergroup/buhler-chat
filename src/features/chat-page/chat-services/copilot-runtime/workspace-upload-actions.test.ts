// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("server-only", () => ({}));

const mockSession = vi.fn();
const mockRuntime = vi.fn();
const mockFindThread = vi.fn();
const mockUpload = vi.fn();

vi.mock("@/features/auth-page/helpers", () => ({
  userSession: () => mockSession(),
  userHashedId: async () => "user-hash",
}));
vi.mock("@/features/common/services/logger", () => ({ logError: vi.fn() }));
vi.mock("./runtime-selection", () => ({ resolveAgentRuntimeForCurrentUser: () => mockRuntime() }));
vi.mock("../chat-thread-service", () => ({ FindChatThreadForCurrentUser: (id: string) => mockFindThread(id) }));
vi.mock("./workspace-files", () => ({ uploadToThreadWorkspace: (...a: unknown[]) => mockUpload(...a) }));

import { UploadFileToAgentWorkspace } from "./workspace-upload-actions";

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
    mockUpload.mockResolvedValue({ path: "/workspace/uploads/data.csv" });
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

  it("stores the file for a signed-in user on the Copilot path", async () => {
    mockSession.mockResolvedValue({ email: "a@example.invalid" });
    const res = await UploadFileToAgentWorkspace(form("thread1"));
    expect(res).toEqual({ status: "OK", response: { handled: true, path: "/workspace/uploads/data.csv" } });
    expect(mockUpload).toHaveBeenCalledWith("user-hash", "thread1", "data.csv", expect.any(Buffer));
  });
});
