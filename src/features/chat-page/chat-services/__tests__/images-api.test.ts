// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from "vitest";
import { Readable } from "node:stream";

vi.mock("@/features/common/services/azure-storage", () => ({
  GetBlob: vi.fn(),
  UploadBlob: vi.fn(),
}));

// Fake session: the test sets the caller; the partition key of a user is
// "pk:<email>".
vi.mock("@/features/auth-page/helpers", () => ({
  userSession: vi.fn(),
  hashValue: (value: string) => `pk:${value}`,
}));

vi.mock("@/features/common/services/logger", () => ({
  logWarn: vi.fn(),
  logError: vi.fn(),
  logInfo: vi.fn(),
  logDebug: vi.fn(),
}));

// Fake history container: rows keyed by partition key + id, like a point read.
let rows: Record<string, Record<string, unknown>> = {};
const pointRead = vi.fn(async (id: string, pk: string) => ({
  resource: rows[`${pk}|${id}`],
}));
vi.mock("@/features/common/services/cosmos", () => ({
  HistoryContainer: () => ({
    item: (id: string, pk: string) => ({ read: () => pointRead(id, pk) }),
  }),
}));

// Copilot path of the safety net: the caller's runtime and the thread
// workspace (an in-memory blob store, namespace <user key>/<thread>).
const mockRuntime = vi.fn();
const mockThreadWorkspace = vi.fn();
vi.mock("../copilot-runtime/runtime-selection", () => ({
  resolveAgentRuntimeForCurrentUser: () => mockRuntime(),
}));
vi.mock("../copilot-runtime/workspace-files", () => ({
  threadWorkspace: (...a: unknown[]) => mockThreadWorkspace(...a),
}));

import { GetBlob } from "@/features/common/services/azure-storage";
import { BlobSessionFs } from "../copilot-runtime/blob-session-fs";
import { FakeBlobStore } from "../copilot-runtime/fake-blob-store.test-helper";
import { userSession, type UserModel } from "@/features/auth-page/helpers";
import { ImageAPIEntry } from "../images-api";
import { CHAT_THREAD_ATTRIBUTE, MESSAGE_ATTRIBUTE } from "../models";

const getBlob = GetBlob as unknown as ReturnType<typeof vi.fn>;
const session = userSession as unknown as ReturnType<typeof vi.fn>;

const user = (email: string, isAdmin = false): UserModel => ({
  name: email,
  image: "",
  email,
  isAdmin,
  token: "",
  isLocalDevUser: false,
});

const OWNER = user("owner@example.test");
const OTHER = user("other@example.test");
const ADMIN = user("admin@example.test", true);

const addThread = (id: string, owner: UserModel, over: Record<string, unknown> = {}) => {
  const pk = `pk:${owner.email}`;
  rows[`${pk}|${id}`] = {
    id,
    userId: pk,
    type: CHAT_THREAD_ATTRIBUTE,
    isDeleted: false,
    ...over,
  };
};

beforeEach(() => {
  rows = {};
  pointRead.mockClear();
  session.mockReset();
  // Default caller: the owner of "thread1".
  session.mockResolvedValue(OWNER);
  addThread("thread1", OWNER);
});

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d, 1, 2, 3]);
const SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');

const stored = (data: Buffer, contentType?: string, originalfilename?: string) => {
  getBlob.mockResolvedValue({
    status: "OK",
    response: {
      // Split in small chunks: the sniff must work across chunk borders.
      stream: Readable.from([data.subarray(0, 3), data.subarray(3, 9), data.subarray(9)]),
      contentType,
      metadata: originalfilename ? { originalfilename } : undefined,
    },
  });
};

const request = (img: string, t = "thread1") =>
  new Request(`http://localhost/api/images?t=${encodeURIComponent(t)}&img=${encodeURIComponent(img)}`);

const expectSecurityHeaders = (res: Response) => {
  expect(res.headers.get("x-content-type-options")).toBe("nosniff");
  expect(res.headers.get("content-security-policy")).toBe("sandbox; default-src 'none'");
};

describe("ImageAPIEntry — what is served inline", () => {
  beforeEach(() => getBlob.mockReset());

  it("serves a PNG stored as image/png inline, with the full bytes", async () => {
    stored(PNG, "image/png");
    const res = await ImageAPIEntry(request("a.png"));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
    expect(res.headers.get("content-disposition")).toMatch(/^inline; /);
    expectSecurityHeaders(res);
    expect(Buffer.from(await res.arrayBuffer())).toEqual(PNG);
  });

  it("serves a stored image/svg+xml as an octet-stream attachment", async () => {
    stored(SVG, "image/svg+xml");
    const res = await ImageAPIEntry(request("x.svg"));
    expect(res.headers.get("content-type")).toBe("application/octet-stream");
    expect(res.headers.get("content-disposition")).toMatch(/^attachment; /);
    expectSecurityHeaders(res);
  });

  it("serves SVG bytes stored as image/png as an octet-stream attachment (sniff mismatch)", async () => {
    stored(SVG, "image/png");
    const res = await ImageAPIEntry(request("x.png"));
    expect(res.headers.get("content-type")).toBe("application/octet-stream");
    expect(res.headers.get("content-disposition")).toMatch(/^attachment; /);
    expectSecurityHeaders(res);
    expect(Buffer.from(await res.arrayBuffer())).toEqual(SVG);
  });

  it("serves text/html and files without a stored type as attachments", async () => {
    for (const type of ["text/html", "application/pdf", undefined]) {
      stored(Buffer.from("<html></html>"), type);
      const res = await ImageAPIEntry(request("x.html"));
      expect(res.headers.get("content-type")).toBe("application/octet-stream");
      expect(res.headers.get("content-disposition")).toMatch(/^attachment; /);
      expectSecurityHeaders(res);
    }
  });

  it("gives a non-Latin-1 download name an RFC 6266 header instead of failing", async () => {
    stored(Buffer.from("a,b"), "text/csv", '数据 "1".csv');
    const res = await ImageAPIEntry(request("data.csv"));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-disposition")).toContain("filename*=UTF-8''");
  });

  it("sets the security headers on a 404 too", async () => {
    const res = await ImageAPIEntry(request("../x.png"));
    expect(res.status).toBe(404);
    expectSecurityHeaders(res);
    expect(getBlob).not.toHaveBeenCalled();
  });
});

describe("ImageAPIEntry — who may read the files of a thread", () => {
  beforeEach(() => getBlob.mockReset());

  // chat-page.unit.images-api.006
  it("serves the file to the thread owner, with one point read in the owner's partition", async () => {
    stored(PNG, "image/png");
    const res = await ImageAPIEntry(request("a.png"));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
    expect(pointRead).toHaveBeenCalledTimes(1);
    expect(pointRead).toHaveBeenCalledWith("thread1", `pk:${OWNER.email}`);
    expect(getBlob).toHaveBeenCalledWith("images", "thread1/a.png");
  });

  // chat-page.unit.images-api.007
  it("answers another signed-in user with the same 404 as a missing thread, without reading the blob", async () => {
    stored(PNG, "image/png");
    session.mockResolvedValue(OTHER);
    const denied = await ImageAPIEntry(request("a.png"));
    const missing = await ImageAPIEntry(request("a.png", "nosuchthread"));

    expect(denied.status).toBe(404);
    expectSecurityHeaders(denied);
    expect(missing.status).toBe(404);
    expect(await denied.text()).toBe(await missing.text());
    expect(pointRead).toHaveBeenCalledWith("thread1", `pk:${OTHER.email}`);
    expect(getBlob).not.toHaveBeenCalled();
  });

  // chat-page.unit.images-api.008
  it("serves any thread to an administrator (reporting pages), without a read", async () => {
    stored(PNG, "image/png");
    session.mockResolvedValue(ADMIN);
    const res = await ImageAPIEntry(request("a.png"));
    expect(res.status).toBe(200);
    expect(pointRead).not.toHaveBeenCalled();
  });

  // chat-page.unit.images-api.009
  it("answers 401 without a session (the proxy does the same before the handler)", async () => {
    stored(PNG, "image/png");
    session.mockResolvedValue(null);
    const res = await ImageAPIEntry(request("a.png"));
    expect(res.status).toBe(401);
    expectSecurityHeaders(res);
    expect(pointRead).not.toHaveBeenCalled();
    expect(getBlob).not.toHaveBeenCalled();
  });

  // chat-page.unit.images-api.010
  it("answers 404 for a deleted thread and for a row of the owner that is not a thread", async () => {
    stored(PNG, "image/png");
    addThread("thread1", OWNER, { isDeleted: true });
    addThread("msg1", OWNER, { type: MESSAGE_ATTRIBUTE });
    expect((await ImageAPIEntry(request("a.png"))).status).toBe(404);
    expect((await ImageAPIEntry(request("a.png", "msg1"))).status).toBe(404);
    expect(getBlob).not.toHaveBeenCalled();
  });

  // chat-page.unit.images-api.011
  it("fails closed with 404 when the point read throws", async () => {
    stored(PNG, "image/png");
    pointRead.mockRejectedValueOnce(Object.assign(new Error("throttled"), { code: 429 }));
    const res = await ImageAPIEntry(request("a.png"));
    expect(res.status).toBe(404);
    expect(getBlob).not.toHaveBeenCalled();
  });
});

describe("ImageAPIEntry — Copilot workspace files linked as /api/images", () => {
  let store: FakeBlobStore;
  const ownerFs = () => new BlobSessionFs(store, `pk:${OWNER.email}/thread1`, undefined, undefined);
  const notFound = () =>
    getBlob.mockImplementation(async (_c: string, path: string) => ({
      status: "NOT_FOUND",
      errors: [{ message: `Blob not found: ${path}` }],
    }));

  beforeEach(async () => {
    getBlob.mockReset();
    mockRuntime.mockReset();
    mockThreadWorkspace.mockReset();
    store = new FakeBlobStore();
    mockRuntime.mockResolvedValue("copilot");
    mockThreadWorkspace.mockImplementation(async (userKey: string, threadId: string) => ({
      store,
      fs: new BlobSessionFs(store, `${userKey}/${threadId}`, undefined, undefined),
    }));
    notFound();
  });

  // chat-page.unit.images-api.012
  it("redirects (307, relative) to the workspace route when the blob is missing and outputs/<img> exists", async () => {
    await ownerFs().writeFileBytes("/workspace/outputs/agent_fix_check.pptx", Buffer.from("pptx"));
    const res = await ImageAPIEntry(request("agent_fix_check.pptx"));
    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toBe("/api/workspace/file?t=thread1&p=outputs%2Fagent_fix_check.pptx");
    expectSecurityHeaders(res);
    expect(getBlob).toHaveBeenCalledWith("images", "thread1/agent_fix_check.pptx");
    expect(mockThreadWorkspace).toHaveBeenCalledWith(`pk:${OWNER.email}`, "thread1");
  });

  it("finds the file in a subfolder of /workspace/outputs and in /workspace/images", async () => {
    await ownerFs().writeFileBytes("/workspace/outputs/run 2/report.docx", Buffer.from("doc"));
    await ownerFs().writeFileBytes("/workspace/images/cat.png", PNG);
    const nested = await ImageAPIEntry(request("report.docx"));
    expect(nested.status).toBe(307);
    expect(nested.headers.get("location")).toBe("/api/workspace/file?t=thread1&p=outputs%2Frun%202%2Freport.docx");
    const image = await ImageAPIEntry(request("cat.png"));
    expect(image.status).toBe(307);
    expect(image.headers.get("location")).toBe("/api/workspace/file?t=thread1&p=images%2Fcat.png");
  });

  it("keeps the 404 when the file is in neither store (and for workspace files outside outputs / images)", async () => {
    await ownerFs().writeFileBytes("/workspace/uploads/notes.pptx", Buffer.from("x"));
    for (const img of ["missing.pptx", "notes.pptx"]) {
      const res = await ImageAPIEntry(request(img));
      expect(res.status).toBe(404);
      expect(res.headers.get("location")).toBeNull();
      expect(await res.text()).toBe(`Blob not found: thread1/${img}`);
      expectSecurityHeaders(res);
    }
  });

  it("never redirects for another user's thread: 404 without a workspace lookup", async () => {
    await ownerFs().writeFileBytes("/workspace/outputs/agent_fix_check.pptx", Buffer.from("pptx"));
    session.mockResolvedValue(OTHER);
    const res = await ImageAPIEntry(request("agent_fix_check.pptx"));
    expect(res.status).toBe(404);
    expect(res.headers.get("location")).toBeNull();
    expect(mockThreadWorkspace).not.toHaveBeenCalled();
  });

  it("never redirects an administrator to another user's thread workspace", async () => {
    await ownerFs().writeFileBytes("/workspace/outputs/agent_fix_check.pptx", Buffer.from("pptx"));
    session.mockResolvedValue(ADMIN);
    const res = await ImageAPIEntry(request("agent_fix_check.pptx"));
    expect(res.status).toBe(404);
    expect(res.headers.get("location")).toBeNull();
    expect(mockThreadWorkspace).not.toHaveBeenCalled();
  });

  it("keeps the 404 for a user on the AI SDK path", async () => {
    await ownerFs().writeFileBytes("/workspace/outputs/agent_fix_check.pptx", Buffer.from("pptx"));
    mockRuntime.mockResolvedValue("ai-sdk");
    const res = await ImageAPIEntry(request("agent_fix_check.pptx"));
    expect(res.status).toBe(404);
    expect(res.headers.get("location")).toBeNull();
    expect(mockThreadWorkspace).not.toHaveBeenCalled();
  });

  it("rejects an img with ../ as before: 404, no blob read, no workspace lookup", async () => {
    await ownerFs().writeFileBytes("/workspace/outputs/x.pptx", Buffer.from("pptx"));
    for (const img of ["../x.pptx", "../../outputs/x.pptx", "outputs/x.pptx"]) {
      const res = await ImageAPIEntry(request(img));
      expect(res.status).toBe(404);
      expect(res.headers.get("location")).toBeNull();
    }
    expect(getBlob).not.toHaveBeenCalled();
    expect(mockThreadWorkspace).not.toHaveBeenCalled();
  });

  it("does not redirect when the blob read fails for another reason than not found", async () => {
    await ownerFs().writeFileBytes("/workspace/outputs/x.pptx", Buffer.from("pptx"));
    getBlob.mockResolvedValue({ status: "ERROR", errors: [{ message: "Error downloading blob" }] });
    const res = await ImageAPIEntry(request("x.pptx"));
    expect(res.status).toBe(404);
    expect(mockThreadWorkspace).not.toHaveBeenCalled();
  });
});
