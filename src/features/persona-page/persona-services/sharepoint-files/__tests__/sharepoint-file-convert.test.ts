import { describe, it, expect } from "vitest";
import sharp from "sharp";
import { crc32 } from "node:zlib";
import {
  FileConversionError,
  MAX_INPUT_PIXELS,
  prepareFileForCodeInterpreter,
  preparePreviewForCodeInterpreter,
} from "../sharepoint-file-convert";

const OPTIONS = { imageMaxPx: 2560 };

/**
 * A tiny PNG whose header claims `width` x `height` pixels: what a highly
 * compressed pixel bomb looks like before it is decoded.
 */
async function pngClaiming(width: number, height: number): Promise<Buffer> {
  const png = Buffer.from(
    await sharp({ create: { width: 4, height: 4, channels: 3, background: "#000000" } })
      .png()
      .toBuffer(),
  );
  // IHDR: length (4) + "IHDR" (4) + width (4) + height (4) + ... + CRC.
  const ihdr = png.indexOf("IHDR");
  png.writeUInt32BE(width, ihdr + 4);
  png.writeUInt32BE(height, ihdr + 8);
  png.writeUInt32BE(crc32(png.subarray(ihdr, ihdr + 4 + 13)) >>> 0, ihdr + 4 + 13);
  return png;
}

/** An animated GIF of `frames` frames of `width` x `height`. */
async function animatedGif(width: number, height: number, frames: number): Promise<Buffer> {
  const frame = (i: number) =>
    sharp({
      create: { width, height, channels: 3, background: { r: 40 * i, g: 80, b: 160 } },
    })
      .png()
      .toBuffer();
  const pngs = await Promise.all(Array.from({ length: frames }, (_, i) => frame(i)));
  return sharp(pngs, { join: { animated: true } }).gif().toBuffer();
}

describe("sharepoint-file-convert — decode limits (pinned)", () => {
  it("allows at most 40 megapixels", () => {
    expect(MAX_INPUT_PIXELS).toBe(40_000_000);
  });

  it("refuses a small PNG that would decode to more than 40 MP, before decoding it", async () => {
    const bomb = await pngClaiming(8000, 8000); // 64 MP in about 100 bytes
    expect(bomb.length).toBeLessThan(2_000_000);
    const started = Date.now();
    await expect(prepareFileForCodeInterpreter("bomb.png", bomb, OPTIONS)).rejects.toThrow(
      /more than 40 megapixels/,
    );
    await expect(prepareFileForCodeInterpreter("bomb.png", bomb, OPTIONS)).rejects.toBeInstanceOf(
      FileConversionError,
    );
    await expect(preparePreviewForCodeInterpreter("bomb.png", bomb, OPTIONS)).rejects.toBeInstanceOf(
      FileConversionError,
    );
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it("still scales a 36 MP photo down to 2560 px", async () => {
    const photo = await sharp({ create: { width: 7200, height: 5000, channels: 3, background: "#808080" } })
      .jpeg()
      .toBuffer();
    const res = await prepareFileForCodeInterpreter("photo.jpg", photo, OPTIONS);
    expect([res.width, res.height]).toEqual([2560, 1778]);
  });

  it("decodes only the first frame of a large animated GIF", async () => {
    const gif = await animatedGif(3000, 60, 3);
    expect((await sharp(gif).metadata()).pages).toBe(3);
    const res = await prepareFileForCodeInterpreter("anim.gif", gif, OPTIONS);
    const meta = await sharp(res.data).metadata();
    expect(meta.pages ?? 1).toBe(1);
    expect([res.width, res.height]).toEqual([2560, 51]);
    expect([meta.width, meta.height]).toEqual([2560, 51]);
    expect(res.note).toMatch(/first frame/);
  });

  it("passes a small animated GIF through unchanged, with the size of one frame", async () => {
    const gif = await animatedGif(100, 50, 3);
    const res = await prepareFileForCodeInterpreter("small.gif", gif, OPTIONS);
    expect(res.data.equals(gif)).toBe(true);
    expect([res.width, res.height]).toEqual([100, 50]);
    expect(res.note).toBeUndefined();
  });
});
