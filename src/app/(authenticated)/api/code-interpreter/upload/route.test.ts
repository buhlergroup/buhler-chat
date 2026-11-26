import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/features/chat-page/chat-services/code-interpreter-service", () => ({
  UploadFileForCodeInterpreterOnce: vi.fn(),
  DeleteFileFromCodeInterpreter: vi.fn(async () => ({ status: "OK", response: true })),
}));

const mockFindThread = vi.fn();
vi.mock("@/features/chat-page/chat-services/chat-thread-service", () => ({
  FindChatThreadForCurrentUser: (...a: unknown[]) => mockFindThread(...a),
}));

const mockRecordUpload = vi.fn();
vi.mock("@/features/chat-page/chat-services/code-interpreter-file-access", () => ({
  recordCodeInterpreterUpload: (...a: unknown[]) => mockRecordUpload(...a),
}));

vi.mock("@/features/auth-page/helpers", () => ({
  getCurrentUser: vi.fn(),
  userHashedId: vi.fn(async () => "user-hash"),
}));

vi.mock("@/features/common/services/logger", () => ({
  logError: vi.fn(),
  logInfo: vi.fn(),
  logDebug: vi.fn(),
}));

import {
  DeleteFileFromCodeInterpreter,
  UploadFileForCodeInterpreterOnce,
} from "@/features/chat-page/chat-services/code-interpreter-service";
import { getCurrentUser } from "@/features/auth-page/helpers";
import { POST } from "./route";

const mockedUpload = UploadFileForCodeInterpreterOnce as ReturnType<typeof vi.fn>;
const mockedGetCurrentUser = getCurrentUser as ReturnType<typeof vi.fn>;

const defaultUser = {
  name: "Test User",
  email: "test@example.com",
  isAdmin: false,
  token: "tok",
  image: "",
  isLocalDevUser: false,
};

/** Build a mock Request whose formData() resolves with the given FormData. */
function makeMockRequest(fd: FormData): Request {
  return {
    formData: vi.fn().mockResolvedValue(fd),
    signal: new AbortController().signal,
  } as unknown as Request;
}

function buildRequest(file: File | null, threadId: string | null = "thread-1"): Request {
  const fd = new FormData();
  if (file) fd.set("file", file);
  if (threadId !== null) fd.set("threadId", threadId);
  return makeMockRequest(fd);
}

describe("/api/code-interpreter/upload route", () => {
  beforeEach(() => {
    mockedUpload.mockReset();
    mockedGetCurrentUser.mockReset();
    mockedGetCurrentUser.mockResolvedValue(defaultUser);
    mockFindThread.mockReset();
    mockFindThread.mockResolvedValue({ status: "OK", response: { id: "thread-1" } });
    mockRecordUpload.mockReset();
    mockRecordUpload.mockResolvedValue(true);
    vi.mocked(DeleteFileFromCodeInterpreter).mockClear();
  });

  // Pinned: the server, not the client, records an upload on the thread.
  // Before, the client attached any file id to a thread through a server
  // action, and the chat then mounted it in the code interpreter.
  describe("records the upload on the caller's thread", () => {
    const csv = () => new File(["a,b;1,2"], "data.csv", { type: "text/csv" });

    it("records the uploaded file on the given thread", async () => {
      mockedUpload.mockResolvedValue({ status: "OK", response: { id: "file_abc", name: "data.csv", sha256: "h".repeat(64), uploaded: true } });
      const res = await POST(buildRequest(csv()));
      expect(res.status).toBe(200);
      expect(mockFindThread).toHaveBeenCalledWith("thread-1");
      expect(mockRecordUpload).toHaveBeenCalledWith("thread-1", {
        id: "file_abc",
        name: "data.csv",
        sha256: "h".repeat(64),
      });
      // Scope of the content store: the caller's hashed id, bytes from the form.
      const [scope, sent] = mockedUpload.mock.calls[0];
      expect(scope).toBe("user-hash");
      expect(sent.name).toBe("data.csv");
      expect(Buffer.isBuffer(sent.bytes)).toBe(true);
    });

    it("refuses an upload without a thread", async () => {
      const res = await POST(buildRequest(csv(), null));
      expect(res.status).toBe(400);
      expect(mockedUpload).not.toHaveBeenCalled();
    });

    it("refuses a thread that is not the caller's, before uploading", async () => {
      mockFindThread.mockResolvedValue({ status: "NOT_FOUND", errors: [{ message: "x" }] });
      const res = await POST(buildRequest(csv(), "someone-elses-thread"));
      expect(res.status).toBe(404);
      expect(mockedUpload).not.toHaveBeenCalled();
      expect(mockRecordUpload).not.toHaveBeenCalled();
    });

    it("removes the uploaded file when it cannot be recorded", async () => {
      mockedUpload.mockResolvedValue({ status: "OK", response: { id: "file_abc", name: "data.csv", sha256: "h".repeat(64), uploaded: true } });
      mockRecordUpload.mockResolvedValue(false);
      const res = await POST(buildRequest(csv()));
      expect(res.status).toBe(500);
      expect(DeleteFileFromCodeInterpreter).toHaveBeenCalledWith("file_abc");
    });

    it("keeps a reused file (other threads may use it) when it cannot be recorded", async () => {
      mockedUpload.mockResolvedValue({
        status: "OK",
        response: { id: "file_abc", name: "data.csv", sha256: "h".repeat(64), uploaded: false },
      });
      mockRecordUpload.mockResolvedValue(false);
      const res = await POST(buildRequest(csv()));
      expect(res.status).toBe(500);
      expect(DeleteFileFromCodeInterpreter).not.toHaveBeenCalled();
    });
  });

  // api.unit.ci-upload.001
  it("returns 400 when no file provided", async () => {
    const req = buildRequest(null);
    const res = await POST(req);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body).toMatchObject({ error: "No file provided" });
  });

  // api.unit.ci-upload.002
  it("returns 400 when file > 512MB", async () => {
    const file = new File(["x"], "big.csv", { type: "text/csv" });
    Object.defineProperty(file, "size", { value: 512 * 1024 * 1024 + 1, configurable: true });
    const req = buildRequest(file);
    const res = await POST(req);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/exceeds maximum/i);
  });

  // api.unit.ci-upload.003
  it("returns 400 when extension unsupported", async () => {
    const file = new File(["evil"], "x.exe", { type: "application/octet-stream" });
    const req = buildRequest(file);
    const res = await POST(req);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/not supported/i);
  });

  // api.unit.ci-upload.004
  it("happy path returns 200 with {id, name}", async () => {
    mockedUpload.mockResolvedValue({
      status: "OK",
      response: { id: "file_abc", name: "data.csv", sha256: "h".repeat(64), uploaded: true },
    });
    const file = new File(["col1,col2\n1,2"], "data.csv", { type: "text/csv" });
    const req = buildRequest(file);
    const res = await POST(req);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ id: "file_abc", name: "data.csv" });
  });

  // api.unit.ci-upload.005
  it("returns 500 on UploadFileForCodeInterpreterOnce ERROR", async () => {
    mockedUpload.mockResolvedValue({
      status: "ERROR",
      errors: [{ message: "upload failed" }],
    });
    const file = new File(["data"], "data.csv", { type: "text/csv" });
    const req = buildRequest(file);
    const res = await POST(req);
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toMatch(/upload failed/);
  });

  // api.unit.ci-upload.006
  // getCurrentUser throwing causes the outer catch → 500
  it("getCurrentUser throwing yields 500", async () => {
    mockedGetCurrentUser.mockRejectedValue(new Error("User not found"));
    const file = new File(["data"], "data.csv", { type: "text/csv" });
    const req = buildRequest(file);
    const res = await POST(req);
    expect(res.status).toBe(500);
  });

  // api.unit.ci-upload.007
  // getCurrentUser returning null → 401 (auth gate in route, before formData is read)
  it("returns 401 when getCurrentUser returns null", async () => {
    mockedGetCurrentUser.mockResolvedValue(null);
    const file = new File(["data"], "data.csv", { type: "text/csv" });
    const req = buildRequest(file);
    const res = await POST(req);
    expect(res.status).toBe(401);
    const text = await res.text();
    expect(text).toMatch(/Unauthorized/i);
  });

  // api.unit.ci-upload.008
  // non-Error throw → covers String(error) branch in catch (line 71)
  it("returns 500 on non-Error throw (covers String(error) branch)", async () => {
    mockedGetCurrentUser.mockRejectedValue("raw string error");
    const file = new File(["data"], "data.csv", { type: "text/csv" });
    const req = buildRequest(file);
    const res = await POST(req);
    expect(res.status).toBe(500);
  });
});
