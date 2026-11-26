import { describe, it, expect } from "vitest";
import { Readable } from "node:stream";

import { BINARY_SNIFF_BYTES, LineSplitter, MAX_LINE_BYTES, readAtMost, scanLines, utf8Boundary } from "./stream-lines";

/** Lines of `data` fed in chunks of `size` bytes (or at the given cut points). */
function split(data: Buffer, cuts: number | number[], maxLineBytes?: number) {
  const out: string[] = [];
  const s = new LineSplitter((text) => {
    out.push(text);
  }, maxLineBytes);
  const points = typeof cuts === "number" ? Array.from({ length: Math.ceil(data.length / cuts) }, (_, i) => i * cuts) : [0, ...cuts];
  for (let i = 0; i < points.length; i++) s.push(data.subarray(points[i], i + 1 < points.length ? points[i + 1] : data.length));
  s.end();
  return { lines: out, binary: s.binary };
}

/** What the search did before streaming: decode all, split, drop the empty last element of a trailing newline. */
function reference(data: Buffer): string[] {
  const text = data.toString("utf8");
  const lines = text.split(/\r?\n/);
  if (lines.length > 0 && lines[lines.length - 1] === "" && text.endsWith("\n")) lines.pop();
  return lines;
}

describe("LineSplitter", () => {
  it.each([
    ["LF", "a\nb\nc\n"],
    ["CRLF", "a\r\nb\r\nc\r\n"],
    ["final line without newline", "a\nb\nlast"],
    ["final CR without LF stays", "a\r\nb\r"],
    ["lone CR inside a line", "a\rb\nc"],
    ["empty lines", "\n\n\nx\n\n"],
    ["only a newline", "\n"],
    ["empty input", ""],
  ])("%s: same lines as a whole-file split, for every chunk size", (_name, text) => {
    const data = Buffer.from(text, "utf8");
    for (const size of [1, 2, 3, 5, 64]) expect(split(data, size).lines, `chunk ${size}`).toEqual(reference(data));
  });

  it("CRLF split between two chunks", () => {
    const data = Buffer.from("one\r\ntwo\r\n");
    expect(split(data, [4]).lines).toEqual(["one", "two"]); // "one\r" | "\ntwo\r\n"
    expect(split(data, [3, 4, 5]).lines).toEqual(["one", "two"]);
  });

  it("multi-byte UTF-8 characters split across chunks decode whole", () => {
    const text = "grüße €uro 𝄞 clef\n日本語のテキスト\nend";
    const data = Buffer.from(text, "utf8");
    for (let cut = 1; cut < data.length; cut++) {
      expect(split(data, [cut]).lines, `cut at ${cut}`).toEqual(text.split("\n"));
    }
    expect(split(data, 1).lines).toEqual(text.split("\n"));
  });

  it("invalid UTF-8 becomes U+FFFD exactly as a whole-file decode", () => {
    const data = Buffer.from([0x61, 0xe2, 0x82, 0x0a, 0xff, 0x62, 0x0d, 0x0a, 0xc3]);
    expect(split(data, 1).lines).toEqual(reference(data));
  });

  it("a very long line is cut at the cap on a character boundary; its rest is skipped, not buffered", () => {
    const long = "é".repeat(100); // 200 bytes
    const data = Buffer.from(`${long}\r\nnext\n`, "utf8");
    for (const size of [1, 7, 64, 1000]) {
      const { lines } = split(data, size, 51);
      expect(lines, `chunk ${size}`).toEqual(["é".repeat(25), "next"]);
    }
    // Exactly at the cap, with the CR of a CRLF just over it: not truncated.
    const exact = Buffer.from(`${"a".repeat(51)}\r\nb\n`);
    expect(split(exact, 10, 51).lines).toEqual(["a".repeat(51), "b"]);
    expect(MAX_LINE_BYTES).toBe(64 * 1024);
  });

  it("utf8Boundary backs off an incomplete character only", () => {
    const b = Buffer.from("a€", "utf8"); // 61 e2 82 ac
    expect(utf8Boundary(b, 4)).toBe(4);
    expect(utf8Boundary(b, 3)).toBe(1);
    expect(utf8Boundary(b, 2)).toBe(1);
    expect(utf8Boundary(b, 1)).toBe(1);
  });

  it("binary: a NUL in the first 8 KB stops before any line, also when it arrives in a later chunk", () => {
    const head = Buffer.from("text line\n".repeat(500)); // 5,000 bytes, no NUL
    const data = Buffer.concat([head, Buffer.from([0]), Buffer.from("more\n")]);
    const r = split(data, 1000);
    expect(r.binary).toBe(true);
    expect(r.lines).toEqual([]);
    // A NUL after the first 8 KB is text, as before.
    const late = Buffer.concat([Buffer.alloc(BINARY_SNIFF_BYTES, 0x61), Buffer.from("\n\0x\n")]);
    expect(split(late, 4096).binary).toBe(false);
    // A short binary file (all of it under 8 KB).
    expect(split(Buffer.from([0x68, 0x00]), 1).binary).toBe(true);
  });

  it("the handler stops the splitter", () => {
    const seen: number[] = [];
    const s = new LineSplitter((_t, i) => {
      seen.push(i);
      return i < 2;
    });
    expect(s.push(Buffer.from("a\n".repeat(BINARY_SNIFF_BYTES)))).toBe(false);
    expect(s.stopped).toBe(true);
    expect(seen).toEqual([0, 1, 2]);
  });
});

describe("scanLines / readAtMost", () => {
  /** A stream of `n` chunks that records how many were pulled. */
  function counted(chunk: Buffer, n: number) {
    const state = { pulled: 0, destroyed: false };
    const stream = new Readable({
      highWaterMark: 1,
      read() {
        if (state.pulled >= n) return void this.push(null);
        state.pulled++;
        this.push(chunk);
      },
      destroy(err, cb) {
        state.destroyed = true;
        cb(err);
      },
    });
    return { stream, state };
  }

  it("stops pulling chunks when the handler is done and destroys the stream", async () => {
    const { stream, state } = counted(Buffer.from("x\n".repeat(4096)), 1000); // 8 KB chunks
    let lines = 0;
    const end = await scanLines(stream, new LineSplitter(() => ++lines < 10_000));
    expect(end).toBe("stopped");
    expect(lines).toBe(10_000);
    expect(state.pulled).toBeLessThanOrEqual(4);
    expect(state.destroyed).toBe(true);
  });

  it("reports a binary stream after its first chunk", async () => {
    const { stream, state } = counted(Buffer.concat([Buffer.from([0]), Buffer.alloc(BINARY_SNIFF_BYTES)]), 100);
    expect(await scanLines(stream, new LineSplitter(() => true))).toBe("binary");
    expect(state.pulled).toBeLessThanOrEqual(2);
  });

  it("beforeChunk can stop a scan (budget, deadline)", async () => {
    const { stream, state } = counted(Buffer.from("a\n".repeat(8192)), 100);
    let chunks = 0;
    expect(await scanLines(stream, new LineSplitter(() => true), () => ++chunks <= 3)).toBe("stopped");
    expect(state.pulled).toBeLessThanOrEqual(5);
  });

  it("readAtMost returns the bytes up to the cap and stops a longer stream", async () => {
    expect((await readAtMost(Readable.from([Buffer.from("ab"), Buffer.from("cd")]), 4))?.toString()).toBe("abcd");
    const { stream, state } = counted(Buffer.alloc(1000), 100);
    expect(await readAtMost(stream, 2500)).toBeUndefined();
    expect(state.pulled).toBeLessThanOrEqual(4);
    expect(state.destroyed).toBe(true);
  });
});
