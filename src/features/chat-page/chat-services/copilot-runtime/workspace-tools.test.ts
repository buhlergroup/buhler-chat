import { describe, it, expect } from "vitest";

import { globToRegExp, workspaceTools, type WorkspaceFiles } from "./workspace-tools";
import { normalizeSessionPath } from "./session-path";

/** Files of ONE namespace, jailed like BlobSessionFs. */
function fakeFiles(files: Record<string, string>): WorkspaceFiles & { listed: string[] } {
  const listed: string[] = [];
  return {
    listed,
    async listFiles(dir) {
      const n = normalizeSessionPath(dir);
      listed.push(n);
      return Object.keys(files).filter((f) => f.startsWith(`${n}/`)).sort();
    },
    async readFile(p) {
      const n = normalizeSessionPath(p);
      if (!(n in files)) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      return files[n];
    },
    async stat(p) {
      const n = normalizeSessionPath(p);
      if (n in files) return { isFile: true, size: files[n].length };
      return { isFile: false, size: 0 };
    },
  };
}

const call = async (fs: WorkspaceFiles, name: "glob" | "grep", args: Record<string, unknown>) => {
  const t = workspaceTools(fs).find((x) => x.name === name)!;
  return (await t.handler!(args, { sessionId: "s", toolCallId: "c", toolName: name, arguments: args })) as {
    textResultForLlm: string;
    resultType: string;
  };
};

describe("globToRegExp", () => {
  it.each([
    ["**/*", "a.txt", true],
    ["**/*", "notes/a.txt", true],
    ["*.txt", "a.txt", true],
    ["*.txt", "notes/a.txt", false],
    ["notes/*.txt", "notes/a.txt", true],
    ["**/*.{md,txt}", "x/y/z.md", true],
    ["file?.csv", "file1.csv", true],
    ["file[12].csv", "file3.csv", false],
  ])("%s ~ %s = %s", (glob, path, expected) => {
    expect(globToRegExp(glob).test(path)).toBe(expected);
  });
});

describe("workspace glob / grep", () => {
  const files = {
    "/workspace/notes/plan.txt": "alpha-42\nbeta",
    "/workspace/readme.md": "# Readme\nalpha too",
    "/session-state/events.jsonl": "{\"secret\":\"state\"}",
  };

  it("they override the built-ins and need no permission prompt", () => {
    for (const t of workspaceTools(fakeFiles(files))) {
      expect(t.overridesBuiltInTool).toBe(true);
      expect(t.skipPermission).toBe(true);
    }
  });

  it("glob lists the workspace from the provider", async () => {
    const fs = fakeFiles(files);
    expect((await call(fs, "glob", { pattern: "**/*" })).textResultForLlm).toBe(
      "/workspace/notes/plan.txt\n/workspace/readme.md",
    );
    expect((await call(fs, "glob", { pattern: "*.md" })).textResultForLlm).toBe("/workspace/readme.md");
    expect((await call(fs, "glob", { pattern: "*.txt", path: "/workspace/notes" })).textResultForLlm).toBe(
      "/workspace/notes/plan.txt",
    );
    expect((await call(fs, "glob", { pattern: "*.pdf" })).textResultForLlm).toBe("No files matched.");
    expect(fs.listed).toEqual(["/workspace", "/workspace", "/workspace/notes", "/workspace"]);
  });

  it("grep searches file content with a regex", async () => {
    const fs = fakeFiles(files);
    expect((await call(fs, "grep", { pattern: "alpha" })).textResultForLlm).toBe(
      "/workspace/notes/plan.txt:1: alpha-42\n/workspace/readme.md:2: alpha too",
    );
    expect((await call(fs, "grep", { pattern: "ALPHA-\\d+", ignore_case: true, glob: "**/*.txt" })).textResultForLlm).toBe(
      "/workspace/notes/plan.txt:1: alpha-42",
    );
    expect((await call(fs, "grep", { pattern: "beta", path: "/workspace/notes/plan.txt" })).textResultForLlm).toBe(
      "/workspace/notes/plan.txt:2: beta",
    );
    expect((await call(fs, "grep", { pattern: "(" })).resultType).toBe("failure");
  });

  it("paths outside the workspace fail; nothing reaches the disk", async () => {
    const fs = fakeFiles(files);
    for (const path of ["/etc", "C:\\Windows", "/workspace/../session-state", "\\\\server\\share"]) {
      expect((await call(fs, "glob", { pattern: "**/*", path })).resultType).toBe("failure");
      expect((await call(fs, "grep", { pattern: "x", path })).resultType).toBe("failure");
    }
  });
});
