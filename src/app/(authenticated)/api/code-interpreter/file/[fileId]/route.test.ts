import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/features/chat-page/chat-services/code-interpreter-service", () => ({
  DownloadFileFromCodeInterpreter: vi.fn(),
  DeleteFileFromCodeInterpreter: vi.fn(),
}));

const mockFindFile = vi.fn();
const mockCountThreads = vi.fn(async () => 1);
vi.mock("@/features/chat-page/chat-services/code-interpreter-file-access", () => ({
  findCodeInterpreterFileOfCurrentUser: (...a: unknown[]) => mockFindFile(...a),
  countUsesOfCodeInterpreterFile: (...a: unknown[]) => mockCountThreads(...(a as [])),
  mayDeleteCodeInterpreterFile: (file: { source?: string }) => file.source === "upload",
}));

vi.mock("@/features/auth-page/helpers", () => ({
  getCurrentUser: vi.fn(),
}));

vi.mock("@/features/common/services/logger", () => ({
  logError: vi.fn(),
  logInfo: vi.fn(),
  logDebug: vi.fn(),
}));

import { DownloadFileFromCodeInterpreter, DeleteFileFromCodeInterpreter } from "@/features/chat-page/chat-services/code-interpreter-service";
import { getCurrentUser } from "@/features/auth-page/helpers";
import { GET, DELETE } from "./route";

const mockedDownload = DownloadFileFromCodeInterpreter as ReturnType<typeof vi.fn>;
const mockedDelete = DeleteFileFromCodeInterpreter as ReturnType<typeof vi.fn>;
const mockedGetCurrentUser = getCurrentUser as ReturnType<typeof vi.fn>;

const defaultUser = {
  name: "Test User",
  email: "test@example.com",
  isAdmin: false,
  token: "tok",
  image: "",
  isLocalDevUser: false,
};

function makeGetRequest(fileId: string) {
  return new NextRequest(`http://localhost/api/code-interpreter/file/${fileId}`);
}

function makeDeleteRequest(fileId: string) {
  return new NextRequest(`http://localhost/api/code-interpreter/file/${fileId}`, { method: "DELETE" });
}

describe("/api/code-interpreter/file/[fileId] route", () => {
  beforeEach(() => {
    mockedDownload.mockReset();
    mockedDelete.mockReset();
    mockedGetCurrentUser.mockReset();
    mockedGetCurrentUser.mockResolvedValue(defaultUser);
    mockFindFile.mockReset();
    mockFindFile.mockImplementation(async (id: string) => ({
      threadId: "t1",
      file: { id, name: "data.csv", type: "code-interpreter", source: "upload" },
    }));
  });

  // Pinned: GET and DELETE used to act on ANY OpenAI file id for any signed-in
  // user. Now only files on the caller's own threads; DELETE only the
  // caller's uploads. Everything else is a 404 and never reaches OpenAI.
  describe("only files the caller may access", () => {
    it("GET returns 404 for a file that is not on the caller's threads", async () => {
      mockFindFile.mockResolvedValue(undefined);
      const res = await GET(makeGetRequest("file-foreign"), {
        params: Promise.resolve({ fileId: "file-foreign" }),
      });
      expect(res.status).toBe(404);
      expect(mockFindFile).toHaveBeenCalledWith("file-foreign");
      expect(mockedDownload).not.toHaveBeenCalled();
    });

    it("GET serves an agent document of the caller's own agent chat", async () => {
      mockFindFile.mockResolvedValue({
        threadId: "t1",
        file: { id: "file-doc", name: "doc.xlsx", type: "code-interpreter", source: "agent-document" },
      });
      mockedDownload.mockResolvedValue({
        status: "OK",
        response: { data: Buffer.from("x"), name: "doc.xlsx", contentType: "application/octet-stream" },
      });
      const res = await GET(makeGetRequest("file-doc"), { params: Promise.resolve({ fileId: "file-doc" }) });
      expect(res.status).toBe(200);
    });

    it("DELETE returns 404 for a file that is not on the caller's threads", async () => {
      mockFindFile.mockResolvedValue(undefined);
      const res = await DELETE(makeDeleteRequest("file-foreign"), {
        params: Promise.resolve({ fileId: "file-foreign" }),
      });
      expect(res.status).toBe(404);
      expect(mockedDelete).not.toHaveBeenCalled();
    });

    it.each([["agent-document"], ["skill"], [undefined]])(
      "DELETE refuses a file the caller did not upload (source %s)",
      async (source) => {
        mockFindFile.mockResolvedValue({
          threadId: "t1",
          file: { id: "file-x", name: "skill-demo.zip", type: "code-interpreter", source },
        });
        const res = await DELETE(makeDeleteRequest("file-x"), {
          params: Promise.resolve({ fileId: "file-x" }),
        });
        expect(res.status).toBe(404);
        expect(mockedDelete).not.toHaveBeenCalled();
      },
    );
  });

  // api.unit.ci-file.001
  it("GET returns file bytes with content-type", async () => {
    const data = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
    mockedDownload.mockResolvedValue({
      status: "OK",
      response: { data, name: "chart.png", contentType: "image/png" },
    });

    const req = makeGetRequest("file123");
    const res = await GET(req, { params: Promise.resolve({ fileId: "file123" }) });

    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("image/png");
    const bytes = new Uint8Array(await res.arrayBuffer());
    expect(bytes).toEqual(new Uint8Array(data));
  });

  // api.unit.ci-file.002
  it("GET returns 404 when download fails", async () => {
    mockedDownload.mockResolvedValue({
      status: "ERROR",
      errors: [{ message: "file not found" }],
    });

    const req = makeGetRequest("badfile");
    const res = await GET(req, { params: Promise.resolve({ fileId: "badfile" }) });

    expect(res.status).toBe(404);
    const text = await res.text();
    expect(text).toMatch(/file not found/i);
  });

  // api.unit.ci-file.003 — streams large file (5MB buffer)
  it("streams large file with matching byte length", async () => {
    const bigData = Buffer.alloc(5 * 1024 * 1024, 0xaa);
    mockedDownload.mockResolvedValue({
      status: "OK",
      response: { data: bigData, name: "large.bin", contentType: "application/octet-stream" },
    });

    const req = makeGetRequest("largefile");
    const res = await GET(req, { params: Promise.resolve({ fileId: "largefile" }) });

    expect(res.status).toBe(200);
    const bytes = new Uint8Array(await res.arrayBuffer());
    expect(bytes.length).toBe(bigData.length);
  });

  // api.unit.ci-file.004 — GET 401 when no session
  it("GET returns 401 when user is not authenticated", async () => {
    mockedGetCurrentUser.mockResolvedValue(null);
    const req = makeGetRequest("file123");
    const res = await GET(req, { params: Promise.resolve({ fileId: "file123" }) });
    expect(res.status).toBe(401);
    expect(await res.text()).toMatch(/Unauthorized/i);
  });

  // api.unit.ci-file.004b — GET 401 (not 500) when getCurrentUser throws, as
  // it does without a session. The proxy matcher once skipped paths ending in
  // ".png", so /api/code-interpreter/file/x.png reached this handler directly.
  it("GET returns 401 when getCurrentUser throws (no session)", async () => {
    mockedGetCurrentUser.mockRejectedValue(new Error("User not found"));
    const req = makeGetRequest("file.png");
    const res = await GET(req, { params: Promise.resolve({ fileId: "file.png" }) });
    expect(res.status).toBe(401);
    expect(mockFindFile).not.toHaveBeenCalled();
    expect(mockedDownload).not.toHaveBeenCalled();
  });

  // api.unit.ci-file.005 — GET 400 when fileId is empty string
  it("GET returns 400 when fileId is empty", async () => {
    const req = makeGetRequest("");
    const res = await GET(req, { params: Promise.resolve({ fileId: "" }) });
    expect(res.status).toBe(400);
    expect(await res.text()).toMatch(/File ID is required/i);
  });

  // api.unit.ci-file.006 — GET 500 on downstream throw
  it("GET returns 500 when DownloadFileFromCodeInterpreter throws", async () => {
    mockedDownload.mockRejectedValue(new Error("network error"));
    const req = makeGetRequest("file123");
    const res = await GET(req, { params: Promise.resolve({ fileId: "file123" }) });
    expect(res.status).toBe(500);
    expect(await res.text()).toMatch(/Internal Server Error/i);
  });

  // DELETE handler tests

  // api.unit.ci-file.007 — DELETE happy path
  it("DELETE returns 200 with {success:true} on successful deletion", async () => {
    mockedDelete.mockResolvedValue({ status: "OK", response: {} });
    const req = makeDeleteRequest("file123");
    const res = await DELETE(req, { params: Promise.resolve({ fileId: "file123" }) });
    expect(res.status).toBe(200);
    const body = JSON.parse(await res.text());
    expect(body).toEqual({ success: true });
  });

  // The same upload attached to two threads (content store): the OpenAI
  // file stays until the last thread lets go of it.
  it("DELETE keeps a file another thread of the user still lists", async () => {
    mockCountThreads.mockResolvedValueOnce(2);
    mockedDelete.mockResolvedValue({ status: "OK", response: {} });
    const req = makeDeleteRequest("file123");
    const res = await DELETE(req, { params: Promise.resolve({ fileId: "file123" }) });
    expect(res.status).toBe(200);
    expect(JSON.parse(await res.text())).toEqual({ success: true });
    expect(mockedDelete).not.toHaveBeenCalled();
  });

  // api.unit.ci-file.008 — DELETE 401 when no session
  it("DELETE returns 401 when user is not authenticated", async () => {
    mockedGetCurrentUser.mockResolvedValue(null);
    const req = makeDeleteRequest("file123");
    const res = await DELETE(req, { params: Promise.resolve({ fileId: "file123" }) });
    expect(res.status).toBe(401);
    expect(await res.text()).toMatch(/Unauthorized/i);
  });

  // api.unit.ci-file.008b — DELETE 401 (not 500) when getCurrentUser throws.
  it("DELETE returns 401 when getCurrentUser throws (no session)", async () => {
    mockedGetCurrentUser.mockRejectedValue(new Error("User not found"));
    const req = makeDeleteRequest("file.png");
    const res = await DELETE(req, { params: Promise.resolve({ fileId: "file.png" }) });
    expect(res.status).toBe(401);
    expect(mockFindFile).not.toHaveBeenCalled();
    expect(mockedDelete).not.toHaveBeenCalled();
  });

  // api.unit.ci-file.009 — DELETE 400 when fileId is empty
  it("DELETE returns 400 when fileId is empty", async () => {
    const req = makeDeleteRequest("");
    const res = await DELETE(req, { params: Promise.resolve({ fileId: "" }) });
    expect(res.status).toBe(400);
    expect(await res.text()).toMatch(/File ID is required/i);
  });

  // api.unit.ci-file.010 — DELETE service ERROR → 500
  it("DELETE returns 500 when deletion service returns ERROR", async () => {
    mockedDelete.mockResolvedValue({
      status: "ERROR",
      errors: [{ message: "delete failed" }],
    });
    const req = makeDeleteRequest("file123");
    const res = await DELETE(req, { params: Promise.resolve({ fileId: "file123" }) });
    expect(res.status).toBe(500);
    expect(await res.text()).toMatch(/delete failed/i);
  });

  // api.unit.ci-file.011 — DELETE throws → 500
  it("DELETE returns 500 when DeleteFileFromCodeInterpreter throws", async () => {
    mockedDelete.mockRejectedValue(new Error("unexpected error"));
    const req = makeDeleteRequest("file123");
    const res = await DELETE(req, { params: Promise.resolve({ fileId: "file123" }) });
    expect(res.status).toBe(500);
    expect(await res.text()).toMatch(/Internal Server Error/i);
  });

  // api.unit.ci-file.012 — GET non-Error throw → covers String(error) branch
  it("GET returns 500 on non-Error throw (covers String(error) branch)", async () => {
    mockedDownload.mockRejectedValue("raw string error");
    const req = makeGetRequest("file123");
    const res = await GET(req, { params: Promise.resolve({ fileId: "file123" }) });
    expect(res.status).toBe(500);
  });

  // api.unit.ci-file.013 — DELETE non-Error throw → covers String(error) branch
  it("DELETE returns 500 on non-Error throw (covers String(error) branch)", async () => {
    mockedDelete.mockRejectedValue("raw string error");
    const req = makeDeleteRequest("file123");
    const res = await DELETE(req, { params: Promise.resolve({ fileId: "file123" }) });
    expect(res.status).toBe(500);
  });
});

describe("/api/code-interpreter/file/[fileId] route - Content-Disposition", () => {
  beforeEach(() => {
    mockedDownload.mockReset();
    mockedGetCurrentUser.mockReset();
    mockedGetCurrentUser.mockResolvedValue(defaultUser);
    mockFindFile.mockReset();
    mockFindFile.mockImplementation(async (id: string) => ({
      threadId: "t1",
      file: { id, name: "x", type: "code-interpreter", source: "upload" },
    }));
  });

  it("serves a non-Latin-1 file name with an RFC 6266 header instead of a 500", async () => {
    mockedDownload.mockResolvedValue({
      status: "OK",
      response: { data: Buffer.from("a,b"), name: "数据 \"Q3\".csv", contentType: "text/csv" },
    });
    const res = await GET(makeGetRequest("file-1"), { params: Promise.resolve({ fileId: "file-1" }) });
    expect(res.status).toBe(200);
    const value = res.headers.get("content-disposition") ?? "";
    expect(value).toMatch(/^attachment; filename="[\x20-\x7e]*"; filename\*=UTF-8''/);
    expect(value).toContain("filename*=UTF-8''%E6%95%B0%E6%8D%AE%20%22Q3%22.csv");
    expect(value).not.toMatch(/filename="[^"]*"[^;]/);
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
  });
});
