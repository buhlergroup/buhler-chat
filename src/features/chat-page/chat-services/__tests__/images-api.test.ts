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

import { GetBlob } from "@/features/common/services/azure-storage";
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
