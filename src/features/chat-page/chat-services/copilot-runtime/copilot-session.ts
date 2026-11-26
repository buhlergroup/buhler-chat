import "server-only";

import os from "node:os";
import path from "node:path";
import {
  CopilotClient,
  RuntimeConnection,
  type CopilotSession,
  type PermissionHandler,
  type SessionHooks,
  type Tool as CopilotTool,
} from "@microsoft/copilot-sdk";
import type { UIMessage, UIMessageChunk } from "ai";
import type { Tool as AiTool } from "@ai-sdk/provider-utils";
import { logError, logInfo, logWarn } from "@/features/common/services/logger";
import type { ChatModel } from "../models";
import { BlobSessionFs, type BlobStore, type SessionFsOpListener } from "./blob-session-fs";
import { getAgentWorkspaceStore } from "./azure-blob-store";
import { CopilotEventMapper, type MappedTurnResult, type TurnUsage } from "./event-mapper";
import { buildCopilotInference, copilotModelSelectionId } from "./providers";
import { buildNamespace, normalizeSessionPath, SESSION_STATE_ROOT, WORKSPACE_ROOT } from "./session-path";
import { WORKSPACE_TOOL_NAMES, workspaceTools } from "./workspace-tools";
import { buildCopilotSystemMessage } from "./system-message";
import { toCopilotTools, toolDescription, toolJsonSchema, type ToolCallRecord, type TurnToolBinding } from "./tool-adapter";

/**
 * The runtime's built-in tools this path allows: the file tools whose I/O goes
 * through the sessionFs provider (BlobSessionFs), never to the server's disk.
 * GPT models get `apply_patch` where Claude models get `create` / `edit`.
 * The built-in glob / grep / rg are NOT allowed: they run ripgrep on the host
 * disk. workspace-tools.ts replaces them with provider-backed versions.
 * Shell, web fetch, workflows, sub-agents and code search stay off.
 */
export const COPILOT_FILE_TOOLS = ["view", "create", "edit", "apply_patch"] as const;

type PreToolUseHandler = NonNullable<SessionHooks["onPreToolUse"]>;
export type HistoryImportConversationEvent = Parameters<
  CopilotSession["rpc"]["history"]["importConversation"]
>[0]["events"][number];

const SESSION_IDLE_EVICT_MS = 20 * 60 * 1000;
const TURN_TIMEOUT_MS = 590 * 1000;
const ABORT_GRACE_MS = 10 * 1000;

interface LiveSession {
  session: CopilotSession;
  fs: BlobSessionFs;
  namespace: string;
  binding: { current?: TurnToolBinding };
  toolSignature: string;
  selectionId: string;
  reasoningEffort?: string;
  contextNote?: string;
  busy: boolean;
  lastUsed: number;
  /** Runtime compactions of this session (they also run between turns). */
  compactions: CopilotTurnResult["compactions"];
}

interface RuntimeState {
  client?: Promise<CopilotClient>;
  sessions: Map<string, LiveSession>;
  sweeper?: ReturnType<typeof setInterval>;
}

// One client (one runtime child process) per server process. Kept on
// globalThis so dev-mode module reloads do not spawn more runtimes.
const g = globalThis as typeof globalThis & { __copilotRuntime?: RuntimeState };
const state: RuntimeState = (g.__copilotRuntime ??= { sessions: new Map() });

/** Environment of the runtime child process: no app secrets, telemetry off. */
function runtimeEnv(): Record<string, string> {
  const keep = [
    "PATH", "Path", "SystemRoot", "SYSTEMROOT", "TEMP", "TMP", "TMPDIR", "HOME",
    "USERPROFILE", "LOCALAPPDATA", "APPDATA", "LANG", "HTTPS_PROXY", "HTTP_PROXY", "NO_PROXY",
  ];
  const env: Record<string, string> = {};
  for (const key of keep) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  env.COPILOT_TELEMETRY_DISABLED = "true";
  env.COPILOT_GITHUB_TELEMETRY_DISABLED = "true";
  return env;
}

export function getCopilotClient(): Promise<CopilotClient> {
  state.client ??= (async () => {
    const client = new CopilotClient({
      mode: "empty",
      runtime: RuntimeConnection.forSpawnedStdio({
        env: runtimeEnv(),
        // Runtime config dir. Session state does NOT go here: sessionFs routes it to Blob.
        baseDirectory: process.env.COPILOT_RUNTIME_HOME || path.join(os.tmpdir(), "copilot-runtime-home"),
        sessionIdleTimeoutSeconds: SESSION_IDLE_EVICT_MS / 1000,
      }),
      sessionFs: {
        initialCwd: WORKSPACE_ROOT,
        sessionStatePath: SESSION_STATE_ROOT,
        conventions: "posix",
        capabilities: { binary: true },
      },
      observability: { logLevel: "error" },
    });
    const started = Date.now();
    await client.start();
    logInfo("copilot-runtime: client started", { ms: Date.now() - started });
    return client;
  })().catch((err) => {
    state.client = undefined;
    throw err;
  });
  if (!state.sweeper) {
    state.sweeper = setInterval(() => void evictIdleSessions(), 60 * 1000);
    state.sweeper.unref?.();
  }
  return state.client;
}

async function evictIdleSessions(maxIdleMs = SESSION_IDLE_EVICT_MS): Promise<void> {
  const now = Date.now();
  for (const [id, live] of state.sessions) {
    if (live.busy || now - live.lastUsed < maxIdleMs) continue;
    state.sessions.delete(id);
    await live.session.disconnect().catch(() => undefined);
  }
}

/** Disconnects every live session and stops the runtime (smoke script / shutdown). */
export async function shutdownCopilotRuntime(): Promise<void> {
  for (const [id, live] of state.sessions) {
    state.sessions.delete(id);
    await live.session.disconnect().catch(() => undefined);
  }
  if (state.sweeper) clearInterval(state.sweeper);
  state.sweeper = undefined;
  const client = state.client;
  state.client = undefined;
  if (client) await (await client).stop().catch(() => undefined);
}

/** Drops live sessions so the next turn resumes from Blob (restart simulation). */
export async function forgetLiveSessions(): Promise<void> {
  for (const [id, live] of state.sessions) {
    state.sessions.delete(id);
    await live.session.disconnect().catch(() => undefined);
  }
}

const insideJail = (p: string | undefined): boolean => {
  if (!p) return false;
  try {
    normalizeSessionPath(p);
    return true;
  } catch {
    return false;
  }
};

/** Allows our own tools and the file tools inside the workspace; nothing else may run. */
function permissionGate(appToolNames: () => ReadonlySet<string>): PermissionHandler {
  return (request) => {
    switch (request.kind) {
      case "custom-tool":
        return appToolNames().has(request.toolName) ? { kind: "approve-once" } : { kind: "reject" };
      // File tools: their I/O goes to the provider, which jails the path again.
      case "read":
        return insideJail(request.path) ? { kind: "approve-once" } : { kind: "reject" };
      case "write":
        return insideJail(request.fileName) ? { kind: "approve-once" } : { kind: "reject" };
      default:
        logWarn("copilot-runtime: permission denied", { kind: request.kind });
        return { kind: "reject" };
    }
  };
}

function preToolGate(appToolNames: () => ReadonlySet<string>): PreToolUseHandler {
  const files = new Set<string>([...COPILOT_FILE_TOOLS, ...WORKSPACE_TOOL_NAMES]);
  return (input) =>
    files.has(input.toolName) || appToolNames().has(input.toolName)
      ? { permissionDecision: "allow" }
      : { permissionDecision: "deny", permissionDecisionReason: "Tool not allowed" };
}

async function toolSignature(toolset: Record<string, AiTool>): Promise<string> {
  const parts: string[] = [];
  for (const name of Object.keys(toolset).sort()) {
    parts.push(`${name}:${toolDescription(toolset[name])}:${JSON.stringify(await toolJsonSchema(toolset[name]))}`);
  }
  return parts.join("\n");
}

const textOf = (message: UIMessage): string =>
  message.parts
    .filter((p): p is { type: "text"; text: string } => p.type === "text")
    .map((p) => p.text)
    .join("\n");

const MAX_SEED_TOOL_CHARS = 20_000;

/**
 * Seeds a NEW session with the visible thread history (Cosmos rows), for a
 * thread that started on the AI SDK path or whose session state is gone.
 * Text and tool calls are imported; images are not.
 */
export function historyToImportEvents(history: UIMessage[]): HistoryImportConversationEvent[] {
  const events: HistoryImportConversationEvent[] = [];
  let n = 0;
  for (const message of history) {
    if (message.role === "user") {
      const content = textOf(message);
      if (content) events.push({ type: "user.message", data: { content } });
      continue;
    }
    if (message.role !== "assistant") continue;
    const tools = message.parts.filter(
      (p) => p.type === "dynamic-tool" || p.type.startsWith("tool-"),
    ) as Array<{ toolCallId: string; toolName?: string; type: string; input?: unknown; output?: unknown; state?: string }>;
    const toolRequests = tools.map((t) => ({
      toolCallId: t.toolCallId,
      name: t.toolName ?? t.type.replace(/^tool-/, ""),
      arguments: (t.input ?? {}) as Record<string, unknown>,
    }));
    if (toolRequests.length > 0) {
      events.push({
        type: "assistant.message",
        data: { messageId: `seed-${n++}`, content: "", toolRequests },
      } as HistoryImportConversationEvent);
      for (const t of toolRequests) {
        const part = tools.find((p) => p.toolCallId === t.toolCallId);
        const text = JSON.stringify(part?.output ?? null) ?? "null";
        events.push({
          type: "tool.execution_start",
          data: { toolCallId: t.toolCallId, toolName: t.name, arguments: t.arguments },
        } as HistoryImportConversationEvent);
        events.push({
          type: "tool.execution_complete",
          data: {
            toolCallId: t.toolCallId,
            success: true,
            result: { content: text.slice(0, MAX_SEED_TOOL_CHARS) },
          },
        } as HistoryImportConversationEvent);
      }
    }
    const content = textOf(message);
    if (content) {
      events.push({ type: "assistant.message", data: { messageId: `seed-${n++}`, content } } as HistoryImportConversationEvent);
    }
  }
  return events;
}

export interface CopilotTurnInput {
  threadId: string;
  /** Opaque, stable per user (the hashed user id): first part of the blob namespace. */
  userKey: string;
  modelId: ChatModel;
  reasoningEffort?: string;
  /** The app's system message (buildSystemMessage), fixed for the session. */
  systemMessage: string;
  /** This request's toolset from buildToolset. */
  toolset: Record<string, AiTool>;
  /** Visible history BEFORE this turn, used only to seed a new session. */
  priorHistory: UIMessage[];
  prompt: string;
  /** data: URLs of images attached to this turn. */
  images?: string[];
  /** Per-turn context (e.g. the document hint); sent again only when it changes. */
  contextNote?: string;
  abortSignal: AbortSignal;
  /** Builds the `finish` chunk metadata (usage for the header). */
  finishMetadata?: (usage: TurnUsage) => unknown;
  /** Tests / smoke: another store, and a view of every file operation. */
  store?: BlobStore;
  onFsOp?: SessionFsOpListener;
}

export interface CopilotTurnResult extends MappedTurnResult {
  sessionMode: "live" | "resumed" | "created";
  seededEvents: number;
  turnUsage: TurnUsage;
  reasoningDurationMs?: number;
  /** ms from send to the first text or reasoning chunk. */
  firstChunkMs?: number;
  /** Runtime compactions that finished during this turn. */
  compactions: Array<{ success: boolean; preTokens?: number; postTokens?: number }>;
}

export interface CopilotTurnHandle {
  stream: ReadableStream<UIMessageChunk>;
  result: Promise<CopilotTurnResult>;
}

const DATA_URL = /^data:([^;,]+);base64,(.*)$/s;

async function openSession(input: CopilotTurnInput): Promise<{ live: LiveSession; mode: CopilotTurnResult["sessionMode"]; seeded: number }> {
  const sessionId = `thread-${input.threadId}`;
  const namespace = buildNamespace(input.userKey, input.threadId);
  const selectionId = copilotModelSelectionId(input.modelId);
  const existing = state.sessions.get(sessionId);
  if (existing) {
    if (existing.namespace !== namespace) throw new Error("Session namespace mismatch");
    return { live: existing, mode: "live", seeded: 0 };
  }

  const client = await getCopilotClient();
  const store = input.store ?? (await getAgentWorkspaceStore());
  const fs = new BlobSessionFs(store, namespace, input.onFsOp);
  const binding: LiveSession["binding"] = {};
  const appToolNames = () => new Set(Object.keys(binding.current?.toolset ?? input.toolset));
  const definitions: CopilotTool[] = [
    ...(await toCopilotTools(input.toolset, () => binding.current)),
    ...workspaceTools(fs),
  ];
  const config = {
    model: selectionId,
    clientName: "chat",
    github: { capi: { enabled: false } },
    inference: {
      ...buildCopilotInference(),
      ...(input.reasoningEffort ? { reasoningEffort: input.reasoningEffort } : {}),
    },
    tools: {
      definitions,
      availableTools: [...COPILOT_FILE_TOOLS.map((n) => `builtin:${n}`), "custom:*"],
    },
    systemMessage: buildCopilotSystemMessage(input.systemMessage),
    permissions: { onRequest: permissionGate(appToolNames) },
    hooks: { handlers: { onPreToolUse: preToolGate(appToolNames) } },
    state: {
      createSessionFsProvider: () => fs,
      infiniteSessions: { enabled: true },
      enableCrossSessionStore: false,
      skipEmbeddingRetrieval: true,
    },
    events: { streaming: true },
    workingDirectory: WORKSPACE_ROOT,
  };

  // The session state lives in Blob under the thread's namespace. If it is
  // there, the session survives a server restart by resuming from it.
  const hasState = await fs.exists(`${SESSION_STATE_ROOT}/events.jsonl`);
  let session: CopilotSession;
  let mode: CopilotTurnResult["sessionMode"];
  let seeded = 0;
  if (hasState) {
    session = await client.resumeSession(sessionId, config);
    mode = "resumed";
  } else {
    session = await client.createSession({ ...config, sessionId });
    mode = "created";
    const events = historyToImportEvents(input.priorHistory);
    if (events.length > 0) {
      await session.rpc.history.importConversation({ events });
      seeded = events.length;
    }
  }
  const live: LiveSession = {
    session,
    fs,
    namespace,
    binding,
    toolSignature: await toolSignature(input.toolset),
    selectionId,
    reasoningEffort: input.reasoningEffort,
    busy: false,
    lastUsed: Date.now(),
    compactions: [],
  };
  session.on((event) => {
    if (event.type !== "session.compaction_complete") return;
    const d = event.data as { success?: boolean; preCompactionTokens?: number; postCompactionTokens?: number };
    live.compactions.push({ success: d.success === true, preTokens: d.preCompactionTokens, postTokens: d.postCompactionTokens });
    logInfo("copilot-runtime: compaction", { threadId: input.threadId, ...live.compactions.at(-1) });
  });
  state.sessions.set(sessionId, live);
  logInfo("copilot-runtime: session opened", { threadId: input.threadId, mode, seeded });
  return { live, mode, seeded };
}

/**
 * Runs one chat turn on the Copilot runtime. Returns the UI chunk stream at
 * once; `result` settles when the turn is over (finished, failed or aborted).
 */
export async function runCopilotTurn(input: CopilotTurnInput): Promise<CopilotTurnHandle> {
  const { live, mode, seeded } = await openSession(input);
  if (live.busy) throw new Error("A reply is still running in this chat. Wait for it or stop it first.");
  live.busy = true;
  live.lastUsed = Date.now();

  try {
    // Model or effort switch between turns: one session, same history.
    const selectionId = copilotModelSelectionId(input.modelId);
    if (selectionId !== live.selectionId || input.reasoningEffort !== live.reasoningEffort) {
      await live.session.setModel(selectionId, input.reasoningEffort ? { reasoningEffort: input.reasoningEffort } : undefined);
      live.selectionId = selectionId;
      live.reasoningEffort = input.reasoningEffort;
    }
    // The toolset can change between turns (extensions, documents, skills).
    const signature = await toolSignature(input.toolset);
    if (signature !== live.toolSignature) {
      // setTools replaces ALL client tools, so the workspace tools go along.
      await live.session.setTools([
        ...(await toCopilotTools(input.toolset, () => live.binding.current)),
        ...workspaceTools(live.fs),
      ]);
      live.toolSignature = signature;
    }
  } catch (err) {
    live.busy = false;
    throw err;
  }

  const rawResults = new Map<string, ToolCallRecord>();
  live.binding.current = {
    toolset: input.toolset,
    abortSignal: input.abortSignal,
    onResult: (record) => rawResults.set(record.toolCallId, record),
  };

  let controller!: ReadableStreamDefaultController<UIMessageChunk>;
  const stream = new ReadableStream<UIMessageChunk>({ start: (c) => void (controller = c) });

  const sentAt = Date.now();
  let firstChunkMs: number | undefined;
  let reasoningStartedAt: number | undefined;
  let reasoningEndedAt: number | undefined;
  const emit = (chunk: UIMessageChunk) => {
    if (firstChunkMs === undefined && (chunk.type === "text-delta" || chunk.type === "reasoning-delta")) {
      firstChunkMs = Date.now() - sentAt;
    }
    if (chunk.type === "reasoning-delta") reasoningStartedAt ??= Date.now();
    else if (reasoningStartedAt !== undefined && reasoningEndedAt === undefined && chunk.type !== "reasoning-end") {
      reasoningEndedAt = Date.now();
    }
    try {
      controller.enqueue(chunk);
    } catch {
      // Stream already closed (client gone): the turn still runs to the end.
    }
  };

  const mapper = new CopilotEventMapper(emit, {
    appToolNames: new Set(Object.keys(input.toolset)),
    finishMetadata: input.finishMetadata,
    rawToolOutput: (id) => {
      const rec = rawResults.get(id);
      return rec && !rec.error ? { output: rec.output } : undefined;
    },
    toolErrorText: (id) => rawResults.get(id)?.uiError,
  });
  mapper.start();

  let settle!: () => void;
  const settled = new Promise<void>((resolve) => (settle = resolve));
  const compactionsBefore = live.compactions.length;
  const unsubscribe = live.session.on((event) => {
    try {
      if (mapper.handle(event)) settle();
    } catch (err) {
      logError("copilot-runtime: event mapping failed", {
        type: event.type,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  });

  let abortTimer: ReturnType<typeof setTimeout> | undefined;
  const onAbort = () => {
    live.session.abort().catch(() => undefined);
    abortTimer = setTimeout(() => {
      mapper.abort();
      settle();
    }, ABORT_GRACE_MS);
  };
  if (input.abortSignal.aborted) onAbort();
  else input.abortSignal.addEventListener("abort", onAbort, { once: true });
  const turnTimer = setTimeout(() => {
    live.session.abort().catch(() => undefined);
    mapper.fail("The reply took too long and was stopped.", "Timeout");
    settle();
  }, TURN_TIMEOUT_MS);

  const prompt =
    input.contextNote && input.contextNote !== live.contextNote
      ? `${input.contextNote}\n\n${input.prompt}`
      : input.prompt;
  if (input.contextNote) live.contextNote = input.contextNote;
  const attachments = (input.images ?? []).flatMap((url) => {
    const m = DATA_URL.exec(url);
    return m ? [{ type: "blob" as const, data: m[2], mimeType: m[1] }] : [];
  });

  live.session
    .send({ prompt, ...(attachments.length > 0 ? { attachments } : {}) })
    .catch((err) => {
      mapper.fail(err instanceof Error ? err.message : String(err), "SendError");
      settle();
    });

  const result = settled.then((): CopilotTurnResult => {
    clearTimeout(turnTimer);
    if (abortTimer) clearTimeout(abortTimer);
    input.abortSignal.removeEventListener("abort", onAbort);
    unsubscribe();
    live.binding.current = undefined;
    live.busy = false;
    live.lastUsed = Date.now();
    try {
      controller.close();
    } catch {
      // already closed
    }
    const reasoningDurationMs =
      reasoningStartedAt !== undefined
        ? Math.max(0, (reasoningEndedAt ?? Date.now()) - reasoningStartedAt)
        : undefined;
    return {
      ...mapper.result(),
      sessionMode: mode,
      seededEvents: seeded,
      turnUsage: { ...mapper.turnUsage },
      reasoningDurationMs,
      firstChunkMs,
      compactions: live.compactions.slice(compactionsBefore),
    };
  });

  return { stream, result };
}

/** Diagnostics: tool names the runtime offers the model in a live session. */
export async function liveSessionToolNames(threadId: string): Promise<string[] | undefined> {
  const live = state.sessions.get(`thread-${threadId}`);
  if (!live) return undefined;
  const current = await live.session.rpc.tools.getCurrentMetadata();
  return (current.tools ?? []).map((t) => t.name);
}

/** Diagnostics: runtime compactions seen in a live session. */
export function liveSessionCompactions(threadId: string): CopilotTurnResult["compactions"] | undefined {
  return state.sessions.get(`thread-${threadId}`)?.compactions;
}
