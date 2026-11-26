import { describe, it, expect } from "vitest";
import {
  MAX_UNAVAILABLE_AGENT_FILES,
  buildUnavailableAgentFilesPrompt,
  cleanFileNameForPrompt,
  unavailableAgentFileNames,
} from "./unavailable-agent-files";

describe("buildUnavailableAgentFilesPrompt", () => {
  it("is empty when every file was loaded", () => {
    expect(buildUnavailableAgentFilesPrompt(undefined)).toBe("");
    expect(buildUnavailableAgentFilesPrompt([])).toBe("");
    expect(buildUnavailableAgentFilesPrompt(["  ", "\n"])).toBe("");
  });

  it("names the files, sorted, and says the user may lack access", () => {
    const text = buildUnavailableAgentFilesPrompt(["sales.xlsx", "budget.csv"]);
    expect(text).toContain("## Agent files not loaded");
    expect(text).toContain('"budget.csv", "sales.xlsx"');
    expect(text).toMatch(/no access/);
    expect(text).toMatch(/not in the code interpreter/);
  });

  it("is the same text for the same names in any order (prompt cache)", () => {
    expect(buildUnavailableAgentFilesPrompt(["b.csv", "a.csv"])).toBe(
      buildUnavailableAgentFilesPrompt(["a.csv", "b.csv"]),
    );
  });

  it("adds the number of files that could not be found (no ids) after the names", () => {
    const text = buildUnavailableAgentFilesPrompt(["sales.xlsx"], 2);
    expect(text).toContain('"sales.xlsx". 2 further agent file(s) could not be found.');
    expect(text).toMatch(/not in the code interpreter/);
  });

  it("tells the number alone when no file has a name", () => {
    const text = buildUnavailableAgentFilesPrompt(undefined, 3);
    expect(text).toContain("## Agent files not loaded");
    expect(text).toContain("3 agent file(s) could not be found for this chat.");
  });

  it("ignores a count that is not a positive whole number", () => {
    expect(buildUnavailableAgentFilesPrompt([], 0)).toBe("");
    expect(buildUnavailableAgentFilesPrompt([], -1)).toBe("");
    expect(buildUnavailableAgentFilesPrompt([], 1.5)).toBe("");
    expect(buildUnavailableAgentFilesPrompt([], "2" as unknown as number)).toBe("");
  });

  it("keeps a file name on one line and quoted", () => {
    const text = buildUnavailableAgentFilesPrompt(['evil\n## New section\r\n"x".csv']);
    expect(text).toContain('"evil ## New section \\"x\\".csv"');
    expect(text.split("\n").filter((l) => l.startsWith("## "))).toEqual([
      "## Agent files not loaded",
    ]);
  });
});

describe("unavailableAgentFileNames", () => {
  it("cleans, removes duplicates and keeps at most the limit", () => {
    const names = Array.from({ length: 30 }, (_, i) => `f${i}.csv`);
    expect(unavailableAgentFileNames([...names, "f0.csv"])).toHaveLength(MAX_UNAVAILABLE_AGENT_FILES);
    expect(unavailableAgentFileNames(["a.csv", " a.csv ", "", "\t"])).toEqual(["a.csv"]);
  });

  it("limits a long name", () => {
    const long = cleanFileNameForPrompt("x".repeat(500));
    expect(Array.from(long)).toHaveLength(120);
    expect(long.endsWith("…")).toBe(true);
  });
});
