import { describe, it, expect } from "vitest";
import {
  contentDisposition,
  sniffRasterImageType,
  storableContentType,
} from "../safe-content-type";

const bytes = (...values: (number | string)[]) =>
  new Uint8Array(
    values.flatMap((v) => (typeof v === "string" ? [...v].map((c) => c.charCodeAt(0)) : [v]))
  );

describe("common.unit.safe-content-type", () => {
  it("keeps known types and turns everything else into octet-stream", () => {
    expect(storableContentType("image/png")).toBe("image/png");
    expect(storableContentType("IMAGE/JPG")).toBe("image/jpeg");
    expect(storableContentType("text/csv; charset=utf-8")).toBe("text/csv");
    for (const t of ["image/svg+xml", "text/html", "application/xhtml+xml", "text/xml", "application/javascript", "", undefined, null]) {
      expect(storableContentType(t)).toBe("application/octet-stream");
    }
  });

  it("sniffs PNG, JPEG, GIF and WebP signatures only", () => {
    expect(sniffRasterImageType(bytes(0x89, "PNG", 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0))).toBe("image/png");
    expect(sniffRasterImageType(bytes(0xff, 0xd8, 0xff, 0xe0))).toBe("image/jpeg");
    expect(sniffRasterImageType(bytes("GIF89a"))).toBe("image/gif");
    expect(sniffRasterImageType(bytes("RIFF", 0, 0, 0, 0, "WEBP"))).toBe("image/webp");
    expect(sniffRasterImageType(bytes("<svg xmlns="))).toBeNull();
    expect(sniffRasterImageType(bytes("<html>"))).toBeNull();
    expect(sniffRasterImageType(new Uint8Array(0))).toBeNull();
  });

  it("builds an RFC 6266 Content-Disposition that never throws on non-Latin-1 names", () => {
    const value = contentDisposition("attachment", 'Bericht "Q3" \\ 数据.csv');
    expect(value).toBe(
      `attachment; filename="Bericht Q3  __.csv"; filename*=UTF-8''Bericht%20%22Q3%22%20%5C%20%E6%95%B0%E6%8D%AE.csv`
    );
    // The value must be a valid header value (ByteString).
    expect(() => new Headers({ "content-disposition": value })).not.toThrow();
    expect(() => new Headers({ "content-disposition": contentDisposition("inline", "\ud800.png") })).not.toThrow();
    expect(contentDisposition("inline", "")).toBe(`inline; filename="download"; filename*=UTF-8''download`);
    expect(contentDisposition("attachment", "a'(b)*.txt")).toContain("filename*=UTF-8''a%27%28b%29%2A.txt");
  });
});
