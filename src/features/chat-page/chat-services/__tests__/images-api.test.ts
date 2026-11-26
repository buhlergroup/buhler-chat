// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from "vitest";
import { Readable } from "node:stream";

vi.mock("@/features/common/services/azure-storage", () => ({
  GetBlob: vi.fn(),
  UploadBlob: vi.fn(),
}));

import { GetBlob } from "@/features/common/services/azure-storage";
import { ImageAPIEntry } from "../images-api";

const getBlob = GetBlob as unknown as ReturnType<typeof vi.fn>;

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
