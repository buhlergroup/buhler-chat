/**
 * Gates for the runtime's tools on the Copilot path: the permission handler
 * and the pre-tool hook. Both run for every tool call the model (or a
 * sub-agent) makes; the runtime's own session-state I/O goes straight to the
 * sessionFs provider and passes neither.
 *
 * File access:
 *   - read (view, our rg/grep/glob): anywhere in the jail, so `/workspace/**`
 *     and `/session-state/**` (the journal helps to recover details after a
 *     compaction). Paths in `readDenied` are refused.
 *   - write (create, edit, apply_patch): only `/workspace/**`. The journal
 *     under `/session-state` is the runtime's; a model that could write it
 *     could forge its own history.
 *
 * Both gates check: the permission handler sees the paths the runtime
 * resolved, the pre-tool hook sees the raw arguments before the tool runs.
 */
import type { PermissionHandler, PermissionRequest, SessionHooks } from "@microsoft/copilot-sdk";
import { logWarn } from "@/features/common/services/logger";
import { normalizeSessionPath, WORKSPACE_ROOT } from "./session-path";
import { ALL_SEARCH_TOOL_NAMES } from "./workspace-tools";

/**
 * The runtime's built-in tools this path allows: the file tools whose I/O goes
 * through the sessionFs provider (BlobSessionFs), never to the server's disk.
 * GPT models get `apply_patch` where Claude models get `create` / `edit`.
 */
export const COPILOT_FILE_TOOLS = ["view", "create", "edit", "apply_patch"] as const;
/** The built-in tools that write files. */
export const WRITE_FILE_TOOLS: ReadonlySet<string> = new Set(["create", "edit", "apply_patch"]);
/** The runtime's tool that starts a sub-agent. */
export const SUBAGENT_TOOL = "task";

type PreToolUseHandler = NonNullable<SessionHooks["onPreToolUse"]>;
export type PreToolUseInput = Parameters<PreToolUseHandler>[0];
export type PreToolUseOutput = Exclude<Awaited<ReturnType<PreToolUseHandler>>, void>;

export const WRITE_DENIED = "Files can only be written inside /workspace.";

const normalized = (p: unknown): string | undefined => {
  if (typeof p !== "string" || p.length === 0) return undefined;
  try {
    return normalizeSessionPath(p);
  } catch {
    return undefined;
  }
};

/** True for a path inside the jail (`/workspace` or `/session-state`). */
export const insideJail = (p: unknown): boolean => normalized(p) !== undefined;

/** True for a path inside `/workspace` (the only place the model may write). */
export function insideWorkspace(p: unknown): boolean {
  const n = normalized(p);
  return n !== undefined && (n === WORKSPACE_ROOT || n.startsWith(`${WORKSPACE_ROOT}/`));
}

const PATCH_HEADER = /^\*\*\* (?:Add File|Update File|Delete File|Move to):\s*(.+?)\s*$/gm;

/** Paths an apply_patch input names (Add / Update / Delete File, Move to). */
export function patchPaths(patch: string): string[] {
  const out: string[] = [];
  for (const m of patch.matchAll(PATCH_HEADER)) out.push(m[1]);
  return out;
}

/**
 * The paths a write tool call targets, from its raw arguments; undefined
 * when they cannot be read (the call is then denied).
 */
export function writeTargets(toolName: string, args: unknown): string[] | undefined {
  if (toolName === "apply_patch") {
    const text =
      typeof args === "string"
        ? args
        : args && typeof args === "object"
          ? ((args as Record<string, unknown>).input ?? (args as Record<string, unknown>).patch)
          : undefined;
    if (typeof text !== "string") return undefined;
    const paths = patchPaths(text);
    return paths.length > 0 ? paths : undefined;
  }
  if (!args || typeof args !== "object") return undefined;
  const a = args as Record<string, unknown>;
  const path = a.path ?? a.file_path ?? a.filePath;
  return typeof path === "string" ? [path] : undefined;
}

/** All file paths of a write permission request (the file and every planned edit). */
export function writeRequestPaths(request: Extract<PermissionRequest, { kind: "write" }>): string[] {
  const paths = [request.fileName];
  for (const edit of request.fileEdits ?? []) {
    if (edit.before?.path) paths.push(edit.before.path);
    if (edit.after?.path) paths.push(edit.after.path);
  }
  return paths;
}

export interface GateOptions {
  /** Names of the app's custom tools in this turn (incl. sub-agent-only tools). */
  appToolNames: () => ReadonlySet<string>;
  /** Normalised paths the model may not read (e.g. a journal file with a secret). */
  readDenied?: (normalizedPath: string) => boolean;
}

const readAllowed = (path: unknown, readDenied?: (p: string) => boolean): boolean => {
  const n = normalized(path);
  return n !== undefined && !(readDenied?.(n) ?? false);
};

/** Allows our own tools, reads inside the jail, writes inside /workspace; nothing else. */
export function permissionGate(options: GateOptions): PermissionHandler {
  return (request) => {
    switch (request.kind) {
      case "custom-tool":
        return options.appToolNames().has(request.toolName) ? { kind: "approve-once" } : { kind: "reject" };
      // File tools: their I/O goes to the provider, which jails the path again.
      case "read":
        return readAllowed(request.path, options.readDenied) ? { kind: "approve-once" } : { kind: "reject" };
      case "write":
        if (writeRequestPaths(request).every(insideWorkspace)) return { kind: "approve-once" };
        logWarn("copilot-runtime: write outside /workspace denied", { kind: request.kind });
        return { kind: "reject" };
      default:
        logWarn("copilot-runtime: permission denied", { kind: request.kind });
        return { kind: "reject" };
    }
  };
}

const allow = (): PreToolUseOutput => ({ permissionDecision: "allow" });
const deny = (reason: string): PreToolUseOutput => ({ permissionDecision: "deny", permissionDecisionReason: reason });

export interface SubAgentHookGate {
  /** Decides a `task` call (sub-agent start). */
  checkTask(input: PreToolUseInput): Promise<PreToolUseOutput> | PreToolUseOutput;
  /** False when a sub-agent calls a tool outside its allow-list. */
  toolAllowed(input: PreToolUseInput): boolean;
}

/**
 * The pre-tool hook: denies every tool that is not ours or an allowed file
 * tool, writes outside /workspace, reads of denied paths, and sub-agent
 * starts the turn's sub-agent gate refuses.
 */
export function preToolGate(
  options: GateOptions & { subAgents?: () => SubAgentHookGate | undefined },
): PreToolUseHandler {
  const files = new Set<string>([...COPILOT_FILE_TOOLS, ...ALL_SEARCH_TOOL_NAMES]);
  return async (input) => {
    const name = input.toolName;
    const gate = options.subAgents?.();
    if (input.agentId && gate && !gate.toolAllowed(input)) return deny("Tool not allowed for this agent");
    if (name === SUBAGENT_TOOL) return gate ? gate.checkTask(input) : deny("Sub-agents are not available");
    if (WRITE_FILE_TOOLS.has(name)) {
      const targets = writeTargets(name, input.toolArgs);
      return targets && targets.every(insideWorkspace) ? allow() : deny(WRITE_DENIED);
    }
    if (name === "view") {
      const path = (input.toolArgs as { path?: unknown } | undefined)?.path;
      return readAllowed(path, options.readDenied) ? allow() : deny("This path cannot be read.");
    }
    return files.has(name) || options.appToolNames().has(name) ? allow() : deny("Tool not allowed");
  };
}
