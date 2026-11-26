/**
 * `glob` and `grep` for the agent workspace, served from the Blob session
 * filesystem.
 *
 * They REPLACE the runtime's built-in glob / grep / rg: those run ripgrep on
 * the host disk in the session's working directory and do not go through the
 * sessionFs provider (measured: with a provider configured, built-in glob
 * listed a file that existed only on the host disk and missed the file that
 * existed only in the provider). These versions only see the thread's own
 * namespace.
 */
import type { Tool as CopilotTool, ToolResultObject } from "@microsoft/copilot-sdk";
import { normalizeSessionPath, WORKSPACE_ROOT } from "./session-path";

/** What the tools need from the filesystem (BlobSessionFs implements it). */
export interface WorkspaceFiles {
  listFiles(dir: string): Promise<string[]>;
  readFile(path: string): Promise<string>;
  stat(path: string): Promise<{ isFile: boolean; size: number }>;
}

export const WORKSPACE_TOOL_NAMES = ["glob", "grep"] as const;

const MAX_GLOB_RESULTS = 500;
const MAX_GREP_FILES = 300;
const MAX_GREP_FILE_BYTES = 2 * 1024 * 1024;
const MAX_GREP_LINES = 200;
const MAX_LINE_CHARS = 300;

/** Converts a glob (`**`, `*`, `?`, `{a,b}`, `[abc]`) to an anchored RegExp. */
export function globToRegExp(glob: string): RegExp {
  let re = "";
  let inBraces = 0;
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*") {
      if (glob[i + 1] === "*") {
        // `**/` matches zero or more directories; a bare `**` matches anything.
        if (glob[i + 2] === "/") {
          re += "(?:.*/)?";
          i += 2;
        } else {
          re += ".*";
          i += 1;
        }
      } else {
        re += "[^/]*";
      }
    } else if (c === "?") re += "[^/]";
    else if (c === "{") {
      inBraces++;
      re += "(?:";
    } else if (c === "}" && inBraces > 0) {
      inBraces--;
      re += ")";
    } else if (c === "," && inBraces > 0) re += "|";
    else if (c === "[") {
      const end = glob.indexOf("]", i + 1);
      if (end > i) {
        re += `[${glob.slice(i + 1, end).replace(/\\/g, "\\\\")}]`;
        i = end;
      } else re += "\\[";
    } else re += c.replace(/[.+^$()|\\]/g, "\\$&");
  }
  return new RegExp(`^${re}$`);
}

const ok = (text: string): ToolResultObject => ({ textResultForLlm: text, resultType: "success" });
const failure = (text: string): ToolResultObject => ({ textResultForLlm: text, resultType: "failure", error: text });

function baseDir(raw: unknown): string {
  const value = Array.isArray(raw) ? raw[0] : raw;
  return normalizeSessionPath(typeof value === "string" && value.length > 0 ? value : WORKSPACE_ROOT);
}

/** Files under `base` whose path relative to `base` (or absolute path) matches `pattern`. */
async function matchFiles(fs: WorkspaceFiles, base: string, pattern: string | undefined): Promise<string[]> {
  const files = await fs.listFiles(base);
  if (!pattern) return files;
  const re = globToRegExp(pattern.replace(/\\/g, "/"));
  const basename = !pattern.includes("/");
  return files.filter((file) => {
    const rel = file.slice(base.length + 1);
    return re.test(rel) || re.test(file) || (basename && re.test(rel.split("/").pop() ?? ""));
  });
}

export function workspaceTools(fs: WorkspaceFiles): CopilotTool[] {
  return [
    {
      name: "glob",
      description:
        "Find files in the chat's file workspace by glob pattern (e.g. **/*.md, notes/*.txt). Returns matching file paths.",
      parameters: {
        type: "object",
        properties: {
          pattern: { type: "string", description: "Glob pattern, relative to path." },
          path: { type: "string", description: `Directory to search. Default ${WORKSPACE_ROOT}.` },
        },
        required: ["pattern"],
      },
      overridesBuiltInTool: true,
      skipPermission: true,
      defer: "never",
      handler: async (args: unknown) => {
        const a = (args ?? {}) as { pattern?: string; path?: unknown; paths?: unknown };
        try {
          const base = baseDir(a.path ?? a.paths);
          const found = await matchFiles(fs, base, a.pattern);
          if (found.length === 0) return ok("No files matched.");
          const shown = found.slice(0, MAX_GLOB_RESULTS);
          const more = found.length > shown.length ? `\n(${found.length - shown.length} more not shown)` : "";
          return ok(shown.join("\n") + more);
        } catch (err) {
          return failure(err instanceof Error ? err.message : String(err));
        }
      },
    },
    {
      name: "grep",
      description:
        "Search the content of files in the chat's file workspace with a regular expression. Returns path:line: text for each match.",
      parameters: {
        type: "object",
        properties: {
          pattern: { type: "string", description: "Regular expression to search for." },
          path: { type: "string", description: `File or directory to search. Default ${WORKSPACE_ROOT}.` },
          glob: { type: "string", description: "Only search files matching this glob." },
          ignore_case: { type: "boolean", description: "Case-insensitive search." },
        },
        required: ["pattern"],
      },
      overridesBuiltInTool: true,
      skipPermission: true,
      defer: "never",
      handler: async (args: unknown) => {
        const a = (args ?? {}) as { pattern?: string; path?: unknown; glob?: string; ignore_case?: boolean; "-i"?: boolean };
        try {
          if (!a.pattern) return failure("pattern is required");
          let re: RegExp;
          try {
            re = new RegExp(a.pattern, a.ignore_case || a["-i"] ? "i" : "");
          } catch {
            return failure(`Invalid regular expression: ${a.pattern}`);
          }
          const target = baseDir(a.path);
          const st = await fs.stat(target).catch(() => undefined);
          const files = st?.isFile ? [target] : await matchFiles(fs, target, a.glob);
          const lines: string[] = [];
          let skipped = 0;
          for (const file of files.slice(0, MAX_GREP_FILES)) {
            const fileStat = await fs.stat(file).catch(() => undefined);
            if (!fileStat || fileStat.size > MAX_GREP_FILE_BYTES) {
              skipped++;
              continue;
            }
            const content = await fs.readFile(file);
            content.split(/\r?\n/).forEach((line, idx) => {
              if (lines.length < MAX_GREP_LINES && re.test(line)) {
                lines.push(`${file}:${idx + 1}: ${line.slice(0, MAX_LINE_CHARS)}`);
              }
            });
            if (lines.length >= MAX_GREP_LINES) break;
          }
          if (lines.length === 0) return ok(`No matches.${skipped ? ` (${skipped} large files skipped)` : ""}`);
          return ok(lines.join("\n"));
        } catch (err) {
          return failure(err instanceof Error ? err.message : String(err));
        }
      },
    },
  ];
}
