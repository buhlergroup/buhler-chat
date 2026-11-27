import { describe, it, expect } from "vitest";
import { pastedTextFile, pastedTextFileName } from "./pasted-text-file";

const now = new Date("2026-11-27T08:27:05.123Z");

/** jsdom's File has no text(). */
const readText = (file: Blob) =>
  new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error);
    reader.onload = () => resolve(String(reader.result));
    reader.readAsText(file, "utf-8");
  });

describe("pastedTextFile (a big paste becomes a text file)", () => {
  it("text exactly at the limit stays message text", () => {
    expect(pastedTextFile("a".repeat(100), 100, now)).toBeUndefined();
  });

  it("one byte over the limit becomes a .txt file with the full text", async () => {
    const text = "a".repeat(101);
    const file = pastedTextFile(text, 100, now)!;
    expect(file).toBeInstanceOf(File);
    expect(file.name).toBe("pasted-text-20261127-082705.txt");
    expect(file.type).toBe("text/plain;charset=utf-8");
    expect(file.size).toBe(101);
    expect(await readText(file)).toBe(text);
  });

  it("counts UTF-8 bytes, not characters", () => {
    // 50 characters, 100 bytes: at the limit.
    expect(pastedTextFile("ä".repeat(50), 100, now)).toBeUndefined();
    // 51 characters, 102 bytes: over it, although only 51 characters.
    const file = pastedTextFile("ä".repeat(51), 100, now)!;
    expect(file.size).toBe(102);
    // 4-byte characters.
    expect(pastedTextFile("😀".repeat(25), 100, now)).toBeUndefined();
    expect(pastedTextFile("😀".repeat(26), 100, now)).toBeDefined();
  });

  it("no limit (AI SDK path) or no text: stays as it is", () => {
    expect(pastedTextFile("a".repeat(100_000), undefined, now)).toBeUndefined();
    expect(pastedTextFile("a".repeat(100_000), 0, now)).toBeUndefined();
    expect(pastedTextFile("", 10, now)).toBeUndefined();
  });

  it("the file name has a UTC time stamp", () => {
    expect(pastedTextFileName(now)).toBe("pasted-text-20261127-082705.txt");
  });
});
