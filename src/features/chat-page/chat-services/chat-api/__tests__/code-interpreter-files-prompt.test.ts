import { describe, it, expect } from "vitest";
import {
  buildCodeInterpreterFilesPrompt,
  codeInterpreterPathOf,
} from "../code-interpreter-files-prompt";

describe("chat-page.unit.code-interpreter-files-prompt", () => {
  const files = [
    { id: "assistant-B", name: "zeta.csv", source: "agent-document" },
    { id: "assistant-A", name: "Report 2026.xlsx", source: "upload" },
    { id: "assistant-S", name: "skill.zip", source: "skill" },
    { id: "assistant-X", name: "not-in-container.csv", source: "upload" },
  ];

  it("lists the exact /mnt/data/<file id>-<name> path of each attached file", () => {
    const text = buildCodeInterpreterFilesPrompt(files, [
      "assistant-A",
      "assistant-B",
      "assistant-S",
    ]);
    expect(text).toContain("## Files in the code interpreter");
    expect(text).toContain('- "Report 2026.xlsx": "/mnt/data/assistant-A-Report 2026.xlsx"');
    expect(text).toContain('- "zeta.csv": "/mnt/data/assistant-B-zeta.csv"');
    // Skill archives (load_skill finds them) and files not in this turn's container are left out.
    expect(text).not.toContain("skill.zip");
    expect(text).not.toContain("not-in-container.csv");
  });

  it("is sorted and stable (prompt cache)", () => {
    const a = buildCodeInterpreterFilesPrompt(files, ["assistant-A", "assistant-B"]);
    const b = buildCodeInterpreterFilesPrompt([...files].reverse(), ["assistant-B", "assistant-A"]);
    expect(a).toBe(b);
    expect(a.indexOf("Report 2026.xlsx")).toBeLessThan(a.indexOf("zeta.csv"));
  });

  it("is empty without files, and skips ids that are not file ids", () => {
    expect(buildCodeInterpreterFilesPrompt([], [])).toBe("");
    expect(
      buildCodeInterpreterFilesPrompt([{ id: "a/../b", name: "x.csv" }], ["a/../b"])
    ).toBe("");
  });

  it("puts a name with a line break on one line in the label", () => {
    const text = buildCodeInterpreterFilesPrompt([{ id: "f1", name: "a\nb.csv" }], ["f1"]);
    expect(text).toContain('- "a b.csv": "/mnt/data/f1-a\\nb.csv"');
    expect(codeInterpreterPathOf({ id: "f1", name: "x.csv" })).toBe("/mnt/data/f1-x.csv");
  });
});
