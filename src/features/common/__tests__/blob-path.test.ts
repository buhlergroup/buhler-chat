import { describe, it, expect } from "vitest";
import {
  isSafeBlobFileName,
  isSafeBlobPath,
  threadBlobPath,
  toSafeBlobFileName,
} from "../blob-path";

describe("common.unit.blob-path", () => {
  it("accepts normal file names", () => {
    for (const name of ["image.png", "abc123.jpeg", "my chart (1).png", "report.v2.csv", "Übersicht.xlsx"]) {
      expect(isSafeBlobFileName(name)).toBe(true);
    }
  });

  it("refuses separators, dot segments, control characters and long names", () => {
    for (const name of [
      "",
      ".",
      "..",
      "../x.png",
      "a/b.png",
      "a\\b.png",
      "..\\x.png",
      "x..png",
      "a\u0000.png",
      "a\n.png",
      " lead.png",
      "x".repeat(201),
      42,
      null,
    ]) {
      expect(isSafeBlobFileName(name)).toBe(false);
    }
  });

  it("threadBlobPath keeps the thread prefix and refuses everything that leaves it", () => {
    expect(threadBlobPath("thread1", "a.png")).toBe("thread1/a.png");
    expect(() => threadBlobPath("thread1", "../other/a.png")).toThrow();
    expect(() => threadBlobPath("thread1/../agent-skills", "a.png")).toThrow();
    expect(() => threadBlobPath("..", "a.png")).toThrow();
    expect(() => threadBlobPath("t", "%2e%2e")).not.toThrow(); // literal name, not decoded
    expect(() => threadBlobPath("", "a.png")).toThrow();
  });

  it("isSafeBlobPath refuses dot, empty and backslash segments", () => {
    expect(isSafeBlobPath("agent-skills/p1/s1-1.zip")).toBe(true);
    expect(isSafeBlobPath("t/a.png")).toBe(true);
    expect(isSafeBlobPath("t/../x")).toBe(false);
    expect(isSafeBlobPath("t/./x")).toBe(false);
    expect(isSafeBlobPath("/t/x")).toBe(false);
    expect(isSafeBlobPath("t//x")).toBe(false);
    expect(isSafeBlobPath("t\\x")).toBe(false);
    expect(isSafeBlobPath("t/x\u0001")).toBe(false);
    expect(isSafeBlobPath("")).toBe(false);
  });

  it("toSafeBlobFileName turns any name into a safe single name", () => {
    expect(toSafeBlobFileName("chart.png")).toBe("chart.png");
    expect(toSafeBlobFileName("../../agent-skills/x.svg")).toBe("x.svg");
    expect(toSafeBlobFileName("..\\..\\x.svg")).toBe("x.svg");
    expect(toSafeBlobFileName("..")).toBe("file");
    expect(toSafeBlobFileName("a..b.csv")).toBe("a_b.csv");
    expect(toSafeBlobFileName("a\u0000b.txt")).toBe("a_b.txt");
    const long = toSafeBlobFileName(`${"x".repeat(300)}.csv`);
    expect(long.length).toBeLessThanOrEqual(200);
    expect(long.endsWith(".csv")).toBe(true);
    for (const n of ["../../x", "..", "a/b", "\u0007", `${"y".repeat(500)}`]) {
      expect(isSafeBlobFileName(toSafeBlobFileName(n))).toBe(true);
    }
  });
});
