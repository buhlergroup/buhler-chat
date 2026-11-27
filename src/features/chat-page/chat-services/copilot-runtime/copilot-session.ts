import "server-only";

import { randomUUID } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import {
  CopilotClient,
  RuntimeConnection,
  type CopilotSession,
  type Tool as CopilotTool,
} from "@microsoft/copilot-sdk";
import type { UIMessage, UIMessageChunk } from "ai";
import type { Tool as AiTool } from "@ai-sdk/provider-utils";
import { logError, logInfo, logWarn } from "@/features/common/services/logger";
import { MODEL_CONFIGS, type ChatModel } from "../models";
import { friendlyErrorMessage } from "../chat-api/persist-assistant";
import { BlobSessionFs, type BlobStore, type SessionFsOpListener } from "./blob-session-fs";
import { getAgentWorkspaceLeases, getAgentWorkspaceStore } from "./azure-blob-store";
import { acquireThreadLease, type LeaseBackend, type ThreadLeaseOptions } from "./thread-lease";
import { CopilotEventMapper, type MappedTurnResult, type RuntimeCompaction, type TurnUsage } from "./event-mapper";
import { buildCopilotInference, copilotModelSelectionId } from "./providers";
import { appRuntimeDir, resolveCopilotRuntimePath } from "./runtime-path";
import { buildNamespace, SESSION_STATE_ROOT, WORKSPACE_ROOT } from "./session-path";
import { SEARCH_TOOLS_BY_FAMILY, workspaceTools, type SearchToolFamily } from "./workspace-tools";
import { workspaceViewTool } from "./workspace-view";
import { copilotProviderFor } from "./runtime-flag";
import { buildCopilotSystemMessage } from "./system-message";
import {
  TOOL_RESULTS_DIR,
  toCopilotTools,
  toolDescription,
  toolJsonSchema,
  type ToolCallRecord,
  type TurnToolBinding,
} from "./tool-adapter";
import { COPILOT_FILE_TOOLS, SUBAGENT_TOOL, permissionGate, preToolGate } from "./session-gates";
import { historyToImportEvents, prepareHistoryImages, readCapped, type SeedImages } from "./history-seed";
import { GetImageFromStore } from "../chat-image-service";
import { buildSubAgentPlan, SubAgentTurnGate, type SubAgentPlan, type SubAgentPlanInput } from "./subagents";
import {
  idleSessionsToEvict,
  isRuntimeGoneError,
  isSessionGoneError,
  processRssMb,
  runtimeIdleBackstopSeconds,
  readRuntimeLimits,
  sessionsOverMemoryBudget,
  sessionsToEvict,
  TurnLimiter,
} from "./runtime-limits";

export { COPILOT_FILE_TOOLS } from "./session-gates";

/**
 * Share of the prompt limit at which the runtime starts compacting in the
 * background. The limit is the history budget (copilotMaxPromptTokens in
 * providers.ts), not the context window.
 */
export const COMPACTION_THRESHOLD = 0.9;
/** Share at which the runtime blocks the turn until compaction is done. */
export const COMPACTION_BLOCK_THRESHOLD = 0.97;
/** How often idle sessions and the memory budget are checked. */
const SWEEP_EVERY_MS = 30 * 1000;
const TURN_TIMEOUT_MS = 590 * 1000;
const ABORT_GRACE_MS = 10 * 1000;

interface LiveSession {
  session: CopilotSession;
  /** The client the session belongs to (a restarted runtime has a new one). */
  client: CopilotClient;
  fs: BlobSessionFs;
  namespace: string;
  binding: { current?: TurnToolBinding; gate?: SubAgentTurnGate };
  toolSignature: string;
  /** Sub-agent definitions of the session; a change reopens the session. */
  agentSignature: string;
  plan?: SubAgentPlan;
  selectionId: string;
  reasoningEffort?: string;
  contextNote?: string;
  busy: boolean;
  lastUsed: number;
  /** Runtime compactions of this session (they also run between turns). */
  compactions: RuntimeCompaction[];
  /** How many of `compactions` the chat was already told about. */
  compactionsShown: number;
}

interface RuntimeState {
  /** Id of this server process, recorded on the thread lease blob. */
  instanceId: string;
  client?: Promise<CopilotClient>;
  /** The started client, once `client` resolved (for the connection check). */
  started?: CopilotClient;
  sessions: Map<string, LiveSession>;
  sweeper?: ReturnType<typeof setInterval>;
  /** A sweep is running (disconnects take time; sweeps never overlap). */
  sweeping?: boolean;
  limiter?: TurnLimiter;
  /** Abort of each running turn, per session id (lockThreadSessions stops it). */
  turnAborts?: Map<string, AbortController>;
}

// One client (one runtime child process) per server process. Kept on
// globalThis so dev-mode module reloads do not spawn more runtimes.
const g = globalThis as typeof globalThis & { __copilotRuntime?: RuntimeState };
const state: RuntimeState = (g.__copilotRuntime ??= { instanceId: randomUUID(), sessions: new Map() });
const limiter = (state.limiter ??= new TurnLimiter(() => readRuntimeLimits()));

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

/** Pid of the runtime child process (SDK internal field), for the memory guard. */
const runtimePid = (client: CopilotClient | undefined): number | undefined =>
  (client as unknown as { cliProcess?: { pid?: number } | null } | undefined)?.cliProcess?.pid;

/** True once the client's connection to the runtime process is gone. */
const connectionClosed = (client: CopilotClient | undefined): boolean =>
  (client as unknown as { connectionClosed?: boolean } | undefined)?.connectionClosed === true;

/**
 * Drops the runtime: every live session (they belong to the old connection)
 * and the client. The next turn starts a new runtime and resumes its thread
 * from Blob.
 */
export async function resetCopilotRuntime(reason: string): Promise<void> {
  logWarn("copilot-runtime: runtime connection lost, restarting on the next turn", { reason });
  const client = state.client;
  state.client = undefined;
  state.started = undefined;
  state.sessions.clear();
  if (client) await client.then((c) => c.forceStop()).catch(() => undefined);
}

export async function getCopilotClient(): Promise<CopilotClient> {
  if (state.started && connectionClosed(state.started)) await resetCopilotRuntime("connection closed");
  state.client ??= (async () => {
    const client = new CopilotClient({
      mode: "empty",
      runtime: RuntimeConnection.forSpawnedStdio({
        path: resolveCopilotRuntimePath(),
        env: runtimeEnv(),
        // Runtime config dir (app-owned, 0700). Session state does NOT go
        // here: sessionFs routes it to Blob.
        baseDirectory: appRuntimeDir("home"),
        // A backstop only: our sweep (COPILOT_SESSION_IDLE_MINUTES) drops idle
        // sessions first. A session the runtime drops by itself is still in
        // state.sessions, and its next turn fails (measured: "Session not found").
        sessionIdleTimeoutSeconds: runtimeIdleBackstopSeconds(readRuntimeLimits()),
      }),
      sessionFs: {
        initialCwd: WORKSPACE_ROOT,
        sessionStatePath: SESSION_STATE_ROOT,
        conventions: "posix",
        // readFileRange: bounded reads are one ranged Blob GET (BlobSessionFs.readFileRange).
        // Runtime 1.0.116 does not use it for view (measured; our view override
        // streams instead), it is there for runtime reads that do.
        capabilities: { binary: true, readFileRange: true },
      },
      observability: { logLevel: "error" },
      // BYOK only: never look for a GitHub sign-in (stored OAuth tokens, gh CLI,
      // GH_TOKEN). Without this the runtime called api.github.com on Linux.
      github: { useLoggedInUser: false },
    });
    const started = Date.now();
    await client.start();
    state.started = client;
    logInfo("copilot-runtime: client started", { ms: Date.now() - started });
    return client;
  })().catch((err) => {
    state.client = undefined;
    throw err;
  });
  if (!state.sweeper) {
    state.sweeper = setInterval(() => void sweepSessions(), SWEEP_EVERY_MS);
    state.sweeper.unref?.();
  }
  return state.client;
}

async function dropSession(id: string, live: LiveSession | undefined): Promise<void> {
  if (!live) return;
  if (state.sessions.get(id) === live) state.sessions.delete(id);
  await live.session.disconnect().catch(() => undefined);
}

/**
 * Drops sessions of a runtime that is gone, sessions idle for
 * COPILOT_SESSION_IDLE_MINUTES, and, while the runtime's RSS is over
 * COPILOT_RUNTIME_MEMORY_BUDGET_MB, the least recently used idle sessions
 * (one batch per sweep: the RSS is sampled again on the next one).
 */
async function sweepSessions(): Promise<void> {
  if (state.sweeping) return;
  state.sweeping = true;
  try {
    const limits = readRuntimeLimits();
    for (const [id, live] of state.sessions) {
      const dead = live.client !== state.started || connectionClosed(live.client);
      if (dead && !live.busy) await dropSession(id, live);
    }
    const idle = await dropIdle(idleSessionsToEvict(state.sessions, Date.now(), limits.sessionIdleMs));
    if (idle > 0) logInfo("copilot-runtime: evicted idle sessions", { count: idle });

    const rssMb = processRssMb(runtimePid(state.started));
    const overBudget = await dropIdle(sessionsOverMemoryBudget(state.sessions, rssMb, limits.memoryBudgetMb));
    if (overBudget > 0) {
      logWarn("copilot-runtime: runtime over its memory budget, evicted idle sessions", {
        count: overBudget,
        rssMb: Math.round(rssMb ?? 0),
        budgetMb: limits.memoryBudgetMb,
        liveSessions: state.sessions.size,
      });
    }
  } finally {
    state.sweeping = false;
  }
}

/** Drops the listed sessions that are still idle (a turn may have started meanwhile). */
async function dropIdle(ids: string[]): Promise<number> {
  let dropped = 0;
  for (const id of ids) {
    const live = state.sessions.get(id);
    if (!live || live.busy) continue;
    await dropSession(id, live);
    dropped++;
  }
  return dropped;
}

/** Keeps at most COPILOT_MAX_LIVE_SESSIONS live sessions (least recently used go first). */
async function enforceSessionCap(): Promise<void> {
  const dropped = await dropIdle(sessionsToEvict(state.sessions, readRuntimeLimits().maxLiveSessions));
  if (dropped > 0) logWarn("copilot-runtime: evicted live sessions (cap)", { count: dropped });
}

/** Disconnects every live session and stops the runtime (smoke script / shutdown). */
export async function shutdownCopilotRuntime(): Promise<void> {
  for (const [id, live] of state.sessions) await dropSession(id, live);
  if (state.sweeper) clearInterval(state.sweeper);
  state.sweeper = undefined;
  const client = state.client;
  state.client = undefined;
  state.started = undefined;
  if (client) await (await client).stop().catch(() => undefined);
}

/** The runtime's event journal; a thread has session state while it exists. */
const EVENTS_JOURNAL = `${SESSION_STATE_ROOT}/events.jsonl`;

/** Removes the session state (a disconnect may have written some back). */
export async function clearSessionState(fs: Pick<BlobSessionFs, "readdir" | "rm">): Promise<void> {
  for (const name of await fs.readdir(SESSION_STATE_ROOT).catch(() => [] as string[])) {
    await fs.rm(`${SESSION_STATE_ROOT}/${name}`, true, true).catch(() => undefined);
  }
}

/** Drops this process's live session of a thread, before its state is removed. */
export async function discardLiveSession(threadId: string): Promise<void> {
  const id = `thread-${threadId}`;
  const live = state.sessions.get(id);
  if (!live) return;
  state.sessions.delete(id);
  await live.session.disconnect().catch(() => undefined);
}

/** Drops live sessions so the next turn resumes from Blob (restart simulation). */
export async function forgetLiveSessions(): Promise<void> {
  for (const [id, live] of state.sessions) await dropSession(id, live);
}

/** How long a reset waits for the lease after it stopped this process's turn (its abort grace and a margin). */
const RESET_WAIT_MS = ABORT_GRACE_MS + 5_000;

/** Aborts of the turns running in this process, per session id (a reset stops them). */
const turnAborts = (state.turnAborts ??= new Map());

/**
 * Before a rewind or reset deletes the session state of a thread:
 *   1. stops this process's running turn of the thread (if any), so it does
 *      not append to the journal while the state is deleted;
 *   2. takes the thread lease, so no turn runs on any instance meanwhile
 *      (it waits for the stopped turn to end);
 *   3. drops this process's live session of the thread.
 * The caller deletes, then calls `release()`: it gives the lease blob a new
 * generation (holder `reset-<uuid>`), so any OTHER instance that still holds a
 * live session drops it on its next turn (thread-lease.ts: previousHolder
 * differs from its own id). Throws ThreadBusyError when a turn on another
 * instance still holds the lease; the caller must not delete then.
 */
export async function lockThreadSessions(
  userKey: string,
  threadId: string,
  leases?: LeaseBackend,
  leaseOptions?: Partial<Omit<ThreadLeaseOptions, "holder" | "onLost">>,
): Promise<{ release(): Promise<void> }> {
  const id = `thread-${threadId}`;
  const running = turnAborts.get(id);
  if (running) {
    logInfo("copilot-runtime: stopping the running turn for a reset", { threadId });
    running.abort();
  }
  const namespace = buildNamespace(userKey, threadId);
  const backend = leases ?? (await getAgentWorkspaceLeases());
  const lease = await acquireThreadLease(backend, `${namespace}/lease`, {
    ...(running ? { waitMs: RESET_WAIT_MS } : {}),
    ...leaseOptions,
    holder: `reset-${randomUUID()}`,
  });
  await dropSession(id, state.sessions.get(id));
  logInfo("copilot-runtime: thread locked for a reset", { threadId });
  return { release: () => lease.release() };
}

/** Logs a failed workspace tool call (the model gets a fixed text, tool-error-text.ts). */
const workspaceToolFailed = (threadId: string) => (tool: string, err: unknown) =>
  logWarn("copilot-runtime: workspace tool failed", {
    threadId,
    tool,
    error: err instanceof Error ? err.message : String(err),
  });

/** The runtime gives GPT models `rg` and Claude models `grep`; ours follow. */
function searchFamily(modelId: ChatModel): SearchToolFamily {
  const config = MODEL_CONFIGS[modelId];
  return config && copilotProviderFor(config) === "anthropic" ? "claude" : "gpt";
}

/** Built-in file tools of a model family plus our search tools (what `general` gets). */
function workspaceToolNames(family: SearchToolFamily): { all: string[]; readOnly: string[] } {
  const files = family === "claude" ? ["view", "create", "edit"] : ["view", "apply_patch"];
  const search = [...SEARCH_TOOLS_BY_FAMILY[family]];
  return { all: [...files, ...search], readOnly: ["view", ...search] };
}

async function toolSignature(toolset: Record<string, AiTool>, family: SearchToolFamily): Promise<string> {
  const parts: string[] = [`search:${family}`];
  for (const name of Object.keys(toolset).sort()) {
    parts.push(`${name}:${toolDescription(toolset[name])}:${JSON.stringify(await toolJsonSchema(toolset[name]))}`);
  }
  return parts.join("\n");
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
  /**
   * Sub-agents of the session (`general` + the chat agent's sub-agents).
   * Undefined: `general` only, on the parent model.
   */
  subAgents?: SubAgentPlanInput;
  /** Access re-check of a persona sub-agent; runs in this turn's request context. */
  canUsePersona?: (personaId: string) => Promise<boolean>;
  /** Tests / smoke: sees every session event of the turn (incl. sub-agents). */
  onEvent?: (event: { type: string; agentId?: string; data?: unknown }) => void;
  /** Tests / smoke: another store, and a view of every file operation. */
  store?: BlobStore;
  onFsOp?: SessionFsOpListener;
  /** Tests / smoke: another chat image store (images of earlier turns, seeding only). */
  readThreadImage?: (fileName: string, maxBytes: number) => Promise<Uint8Array | undefined>;
  /** Tests / smoke: another lease backend, other lease timings. */
  leases?: LeaseBackend;
  leaseOptions?: Partial<Omit<ThreadLeaseOptions, "holder" | "onLost">>;
}

export interface CopilotTurnResult extends MappedTurnResult {
  sessionMode: "live" | "resumed" | "created";
  seededEvents: number;
  turnUsage: TurnUsage;
  reasoningDurationMs?: number;
  /** ms from send to the first text or reasoning chunk. */
  firstChunkMs?: number;
  /** Runtime compactions that finished during this turn. */
  compactions: RuntimeCompaction[];
  /** The compaction the chat showed with this turn (also one from between turns), to store with it. */
  compactionNotice?: RuntimeCompaction;
  /** Sub-agent name -> persona id, for the sub-agents that ran (usage attribution). */
  subAgentPersonas: Record<string, string>;
}

export interface CopilotTurnHandle {
  stream: ReadableStream<UIMessageChunk>;
  result: Promise<CopilotTurnResult>;
}

const DATA_URL = /^data:([^;,]+);base64,(.*)$/s;

/** The text the chat shows for a runtime error; the details only go to the log. */
function runtimeErrorText(message: string, name?: string): string {
  if (name === "Timeout") return message;
  logError("copilot-runtime: turn error", { name, message });
  return friendlyErrorMessage({ message, name });
}

/** The BYOK models the runtime knows (a model added later needs a new session config). */
const inferenceSignature = (): string =>
  buildCopilotInference()
    .models.map((m) => `${m.provider}/${m.id}`)
    .sort()
    .join(",");

/** True for the runtime's error on a model the session's config does not list. */
export const isModelNotRegisteredError = (err: unknown): boolean =>
  /not registered|unknown model|model .* not (?:found|available)/i.test(err instanceof Error ? err.message : String(err));

function planFor(input: CopilotTurnInput, family: SearchToolFamily): SubAgentPlan {
  const names = workspaceToolNames(family);
  return buildSubAgentPlan(input.subAgents ?? { personas: [] }, {
    appToolNames: Object.keys(input.toolset),
    workspaceToolNames: names.all,
    readOnlyWorkspaceToolNames: names.readOnly,
  });
}

/** True when the model accepts image input (its "vision" capability). */
const modelTakesImages = (modelId: ChatModel): boolean =>
  MODEL_CONFIGS[modelId]?.capabilities?.includes("vision") === true;

/** An image of this thread from the chat image store, at most `maxBytes`. */
async function readChatImage(threadId: string, fileName: string, maxBytes: number): Promise<Uint8Array | undefined> {
  const res = await GetImageFromStore(threadId, fileName);
  if (res.status !== "OK") return undefined;
  return readCapped(res.response.stream as unknown as AsyncIterable<unknown>, maxBytes);
}

/**
 * Images of earlier turns for a new session (history-seed.ts). Only images
 * of this thread, read and written through its own namespace. A failure
 * costs the images, never the turn.
 */
async function seedImages(input: CopilotTurnInput, fs: BlobSessionFs, vision: boolean): Promise<SeedImages | undefined> {
  const skipped: Record<string, number> = {};
  try {
    const images = await prepareHistoryImages(input.priorHistory, {
      threadId: input.threadId,
      vision,
      fs,
      readThreadImage: input.readThreadImage ?? ((name, max) => readChatImage(input.threadId, name, max)),
      onSkip: (reason) => void (skipped[reason] = (skipped[reason] ?? 0) + 1),
    });
    if (images.size > 0) {
      const kinds: Record<string, number> = {};
      for (const seed of [...images.values()].flat()) kinds[seed.kind] = (kinds[seed.kind] ?? 0) + 1;
      logInfo("copilot-runtime: earlier images seeded", { threadId: input.threadId, vision, ...kinds, skipped });
    }
    return images;
  } catch (err) {
    logWarn("copilot-runtime: earlier images not seeded", {
      threadId: input.threadId,
      error: err instanceof Error ? err.message : String(err),
    });
    return undefined;
  }
}

async function openSession(
  input: CopilotTurnInput,
  plan: SubAgentPlan,
): Promise<{ live: LiveSession; mode: CopilotTurnResult["sessionMode"]; seeded: number }> {
  const sessionId = `thread-${input.threadId}`;
  const namespace = buildNamespace(input.userKey, input.threadId);
  const selectionId = copilotModelSelectionId(input.modelId);
  const client = await getCopilotClient();
  const existing = state.sessions.get(sessionId);
  if (existing) {
    if (existing.namespace !== namespace) throw new Error("Session namespace mismatch");
    // In use again: a sweep running meanwhile must not pick it as idle.
    existing.lastUsed = Date.now();
    const stateGone = !(await existing.fs.exists(EVENTS_JOURNAL));
    if (!stateGone && existing.client === client && existing.agentSignature === `${plan.signature}|${inferenceSignature()}`) {
      // Most recently used goes to the end (LRU order).
      state.sessions.delete(sessionId);
      state.sessions.set(sessionId, existing);
      return { live: existing, mode: "live", seeded: 0 };
    }
    if (existing.busy) throw new Error("A reply is still running in this chat. Wait for it or stop it first.");
    // Other sub-agents, new models, or a restarted runtime: reopen from the Blob state.
    await dropSession(sessionId, existing);
    if (stateGone) {
      // The chat was reset (possibly on another instance): its session state is
      // gone, so this live session would still answer from the deleted turns.
      await clearSessionState(existing.fs);
      logInfo("copilot-runtime: dropped a live session whose state was removed", { threadId: input.threadId });
    }
  }

  const store = input.store ?? (await getAgentWorkspaceStore());
  const fs = new BlobSessionFs(store, namespace, input.onFsOp);
  const binding: LiveSession["binding"] = {};
  const family = searchFamily(input.modelId);
  const registered = { ...input.toolset, ...plan.extraTools };
  const appToolNames = () =>
    new Set(Object.keys(binding.current?.toolset ?? registered));
  const definitions: CopilotTool[] = [
    ...(await toCopilotTools(registered, () => binding.current)),
    ...workspaceTools(fs, family, { spill: (p, c) => fs.writeFile(p, c), onError: workspaceToolFailed(input.threadId) }),
    workspaceViewTool(fs, family, { onError: (err) => workspaceToolFailed(input.threadId)("view", err) }),
  ];
  const config = {
    model: selectionId,
    clientName: "chat",
    github: { capi: { enabled: false }, telemetryEnabled: false },
    inference: {
      ...buildCopilotInference(),
      ...(input.reasoningEffort ? { reasoningEffort: input.reasoningEffort } : {}),
    },
    tools: {
      definitions,
      availableTools: [...COPILOT_FILE_TOOLS.map((n) => `builtin:${n}`), `builtin:${SUBAGENT_TOOL}`, "custom:*"],
      // Our adapter writes large app-tool results to /workspace/tool-results/
      // itself and marks them skipLargeOutputProcessing (our search tools
      // too): the runtime's own spill file is deleted when the session closes
      // (measured). Its spill stays on for the built-in file tools, inside the
      // jail instead of the OS temp directory.
      largeOutput: { enabled: true, outputDirectory: TOOL_RESULTS_DIR },
    },
    // Sub-agents: no built-in (coding) agents; `general` + the chat agent's sub-agents.
    agents: {
      includedBuiltinAgents: [],
      definitions: plan.definitions,
      ...(plan.parentExcludedTools.length > 0 ? { default: { excludedTools: plan.parentExcludedTools } } : {}),
    },
    systemMessage: buildCopilotSystemMessage(input.systemMessage),
    permissions: { onRequest: permissionGate({ appToolNames }) },
    hooks: {
      handlers: {
        onPreToolUse: preToolGate({ appToolNames, subAgents: () => binding.gate }),
        onSubagentStart: async (hook: { agentName: string }) => {
          if (!binding.gate) throw new Error("No turn is running");
          await binding.gate.onStart(hook.agentName);
        },
      },
    },
    state: {
      createSessionFsProvider: () => fs,
      // Compact only near the history budget (maxPromptTokens in
      // providers.ts: HISTORY_TOKEN_BUDGET, capped below the model's
      // long-context billing threshold and its input limit). Compaction costs
      // a model call, breaks the cache prefix and can drop details, so it
      // must not run earlier; the budget keeps prompts in the cheaper tier.
      infiniteSessions: {
        enabled: true,
        backgroundCompactionThreshold: COMPACTION_THRESHOLD,
        bufferExhaustionThreshold: COMPACTION_BLOCK_THRESHOLD,
      },
      enableCrossSessionStore: false,
      skipEmbeddingRetrieval: true,
    },
    events: { streaming: true },
    workingDirectory: WORKSPACE_ROOT,
  };

  // The session state lives in Blob under the thread's namespace. If it is
  // there, the session survives a server restart by resuming from it.
  const hasState = await fs.exists(EVENTS_JOURNAL);
  let session: CopilotSession;
  let mode: CopilotTurnResult["sessionMode"];
  let seeded = 0;
  if (hasState) {
    session = await client.resumeSession(sessionId, config);
    mode = "resumed";
  } else {
    session = await client.createSession({ ...config, sessionId });
    mode = "created";
    const vision = modelTakesImages(input.modelId);
    const images = await seedImages(input, fs, vision);
    const events = historyToImportEvents(input.priorHistory, images, { vision });
    if (events.length > 0) {
      await session.rpc.history.importConversation({ events });
      seeded = events.length;
    }
  }
  const live: LiveSession = {
    session,
    client,
    fs,
    namespace,
    binding,
    toolSignature: await toolSignature(registered, family),
    agentSignature: `${plan.signature}|${inferenceSignature()}`,
    plan,
    selectionId,
    reasoningEffort: input.reasoningEffort,
    busy: false,
    lastUsed: Date.now(),
    compactions: [],
    compactionsShown: 0,
  };
  const compactionStarts: number[] = [];
  session.on((event) => {
    if (event.agentId) return;
    if (event.type === "session.compaction_start") compactionStarts.push(Date.now());
    if (event.type !== "session.compaction_complete") return;
    const d = event.data as { success?: boolean; preCompactionTokens?: number; postCompactionTokens?: number };
    const started = compactionStarts.shift();
    live.compactions.push({
      success: d.success === true,
      preTokens: d.preCompactionTokens,
      postTokens: d.postCompactionTokens,
      durationMs: started !== undefined ? Date.now() - started : undefined,
    });
    logInfo("copilot-runtime: compaction", { threadId: input.threadId, ...live.compactions.at(-1) });
  });
  state.sessions.set(sessionId, live);
  await enforceSessionCap();
  logInfo("copilot-runtime: session opened", { threadId: input.threadId, mode, seeded, subAgents: plan.definitions.length });
  return { live, mode, seeded };
}

/**
 * Runs one chat turn on the Copilot runtime. Returns the UI chunk stream at
 * once; `result` settles when the turn is over (finished, failed or aborted).
 * Throws TurnLimitError (429) when the user or the process runs too many
 * turns, ThreadBusyError (409) when the thread is busy.
 */
export async function runCopilotTurn(input: CopilotTurnInput): Promise<CopilotTurnHandle> {
  const releaseSlot = limiter.acquire(input.userKey);
  // One session per thread across instances: hold the thread's Blob lease
  // for the whole turn (thread-lease.ts).
  let lease: Awaited<ReturnType<typeof acquireThreadLease>> | undefined;
  // A reset of the thread (lockThreadSessions) stops the turn through this.
  const resetAbort = new AbortController();
  const sessionId = `thread-${input.threadId}`;
  const forgetAbort = () => {
    if (turnAborts.get(sessionId) === resetAbort) turnAborts.delete(sessionId);
  };
  try {
    const namespace = buildNamespace(input.userKey, input.threadId);
    const leases = input.leases ?? (await getAgentWorkspaceLeases());
    const leaseLost = new AbortController();
    lease = await acquireThreadLease(leases, `${namespace}/lease`, {
      ...input.leaseOptions,
      holder: state.instanceId,
      onLost: (err) => {
        logWarn("copilot-runtime: thread lease lost, stopping the turn", {
          threadId: input.threadId,
          error: err instanceof Error ? err.message : String(err),
        });
        leaseLost.abort();
      },
    });
    turnAborts.set(sessionId, resetAbort);
    const live = state.sessions.get(sessionId);
    if (live && lease.previousHolder !== state.instanceId) {
      // Generation check: this process writes its id on every release, so a
      // different holder means another instance ran the thread since, or the
      // chat was rewound / reset (holder `reset-…`, or a new lease blob with
      // no holder after a full reset). The in-memory session is stale.
      await dropSession(sessionId, live);
      logInfo("copilot-runtime: dropped a stale live session", { threadId: input.threadId });
    }
    const handle = await runTurnInSession({
      ...input,
      abortSignal: AbortSignal.any([input.abortSignal, leaseLost.signal, resetAbort.signal]),
    });
    const held = lease;
    const result = handle.result.finally(async () => {
      releaseSlot();
      forgetAbort();
      await held.release().catch((err) =>
        logWarn("copilot-runtime: lease release failed", {
          threadId: input.threadId,
          error: err instanceof Error ? err.message : String(err),
        }),
      );
    });
    return { stream: handle.stream, result };
  } catch (err) {
    releaseSlot();
    forgetAbort();
    await lease?.release().catch(() => undefined);
    if (isRuntimeGoneError(err)) await resetCopilotRuntime(err instanceof Error ? err.message : String(err));
    else if (isSessionGoneError(err)) await dropSession(sessionId, state.sessions.get(sessionId));
    throw err;
  }
}

async function runTurnInSession(input: CopilotTurnInput): Promise<CopilotTurnHandle> {
  const family = searchFamily(input.modelId);
  const plan = planFor(input, family);
  let { live, mode, seeded } = await openSession(input, plan);
  if (live.busy) throw new Error("A reply is still running in this chat. Wait for it or stop it first.");
  live.busy = true;
  live.lastUsed = Date.now();
  const registered = { ...input.toolset, ...plan.extraTools };

  try {
    // Model or effort switch between turns: one session, same history.
    const selectionId = copilotModelSelectionId(input.modelId);
    if (selectionId !== live.selectionId || input.reasoningEffort !== live.reasoningEffort) {
      const effort = input.reasoningEffort ? { reasoningEffort: input.reasoningEffort } : undefined;
      try {
        await live.session.setModel(selectionId, effort);
      } catch (err) {
        if (!isModelNotRegisteredError(err)) throw err;
        // The session's model list is older than the deployment: reopen it
        // from its Blob state with the current list (once), on this model.
        logWarn("copilot-runtime: model not registered in the session, reopening it", { threadId: input.threadId, model: selectionId });
        live.busy = false;
        await dropSession(`thread-${input.threadId}`, live);
        ({ live, mode, seeded } = await openSession(input, plan));
        live.busy = true;
        if (live.selectionId !== selectionId || live.reasoningEffort !== input.reasoningEffort) {
          await live.session.setModel(selectionId, effort);
        }
      }
      live.selectionId = selectionId;
      live.reasoningEffort = input.reasoningEffort;
    }
    // The toolset can change between turns (extensions, documents, skills).
    const signature = await toolSignature(registered, family);
    if (signature !== live.toolSignature) {
      // setTools replaces ALL client tools, so the workspace tools go along.
      await live.session.setTools([
        ...(await toCopilotTools(registered, () => live.binding.current)),
        ...workspaceTools(live.fs, family, { spill: (p, c) => live.fs.writeFile(p, c), onError: workspaceToolFailed(input.threadId) }),
        workspaceViewTool(live.fs, family, { onError: (err) => workspaceToolFailed(input.threadId)("view", err) }),
      ]);
      live.toolSignature = signature;
    }
  } catch (err) {
    live.busy = false;
    if (isRuntimeGoneError(err) || isSessionGoneError(err)) await dropSession(`thread-${input.threadId}`, live);
    throw err;
  }

  const rawResults = new Map<string, ToolCallRecord>();
  // Tools (also those of sub-agents) run in THIS request's async context.
  const run = AsyncLocalStorage.snapshot();
  live.binding.current = {
    toolset: registered,
    run,
    // Large results go to /workspace/tool-results/ in the thread's namespace.
    spill: (path, content) => live.fs.writeFile(path, content),
    abortSignal: input.abortSignal,
    onResult: (record) => rawResults.set(record.toolCallId, record),
    // A tool's own model call (web_search, run_code) counts in this turn's usage.
    onModelUsage: (usage) => mapper.addToolModelUsage(usage),
  };
  const canUsePersona = input.canUsePersona;
  const gate = new SubAgentTurnGate(plan, {
    ...(canUsePersona ? { canUsePersona: (id: string) => run(() => canUsePersona(id)) } : {}),
    onDenied: (reason, detail) => logWarn("copilot-runtime: sub-agent start denied", { threadId: input.threadId, reason, ...detail }),
  });
  live.binding.gate = gate;

  let controller!: ReadableStreamDefaultController<UIMessageChunk>;
  const stream = new ReadableStream<UIMessageChunk>({ start: (c) => void (controller = c) });

  const sentAt = Date.now();
  let firstChunkMs: number | undefined;
  let reasoningStartedAt: number | undefined;
  let reasoningEndedAt: number | undefined;
  let callStartedAt: number | undefined;
  const emit = (chunk: UIMessageChunk) => {
    if (firstChunkMs === undefined && (chunk.type === "text-delta" || chunk.type === "reasoning-delta")) {
      firstChunkMs = Date.now() - sentAt;
    }
    if (chunk.type === "reasoning-start" && reasoningStartedAt === undefined) {
      // Reasoning that arrives in one piece (not streamed) started with the
      // model call, not when its text arrived.
      reasoningStartedAt = callStartedAt ?? Date.now();
    } else if (chunk.type === "reasoning-delta") reasoningStartedAt ??= Date.now();
    else if (
      reasoningStartedAt !== undefined &&
      reasoningEndedAt === undefined &&
      chunk.type !== "reasoning-end" &&
      chunk.type !== "start-step"
    ) {
      reasoningEndedAt = Date.now();
    }
    try {
      controller.enqueue(chunk);
    } catch {
      // Stream already closed (client gone): the turn still runs to the end.
    }
  };
  const reasoningDurationMs = () =>
    reasoningStartedAt !== undefined ? Math.max(0, (reasoningEndedAt ?? Date.now()) - reasoningStartedAt) : undefined;

  const mapper = new CopilotEventMapper(emit, {
    appToolNames: new Set(Object.keys(registered)),
    // The finish metadata carries the reasoning time too, so the chat shows
    // "Thought for Ns" right after the turn, as after a reload.
    finishMetadata: input.finishMetadata
      ? (usage) => {
          const meta = input.finishMetadata!(usage);
          const ms = reasoningDurationMs();
          return ms !== undefined && ms > 0 && meta && typeof meta === "object" ? { ...meta, reasoningDurationMs: ms } : meta;
        }
      : undefined,
    rawToolOutput: (id) => {
      const rec = rawResults.get(id);
      return rec && !rec.error ? { output: rec.output } : undefined;
    },
    toolErrorText: (id) => rawResults.get(id)?.uiError,
    subAgentDisplayName: (name) => gate.displayName(name),
    subAgentNameOf: (agentId) => gate.agentNameOf(agentId),
    errorText: runtimeErrorText,
  });
  mapper.start();
  // Compactions that finished between turns are shown with this one.
  const pendingCompactions = live.compactions.slice(live.compactionsShown);
  for (const c of pendingCompactions) mapper.emitCompaction(c);
  live.compactionsShown = live.compactions.length;

  let settle!: () => void;
  const settled = new Promise<void>((resolve) => (settle = resolve));
  const compactionsBefore = live.compactions.length;
  const unsubscribe = live.session.on((event) => {
    try {
      input.onEvent?.(event);
      gate.onEvent(event);
      if (!event.agentId && event.type === "assistant.turn_start") callStartedAt = Date.now();
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

  callStartedAt = Date.now();
  live.session
    .send({ prompt, ...(attachments.length > 0 ? { attachments } : {}) })
    .catch((err) => {
      if (isRuntimeGoneError(err)) void resetCopilotRuntime(err instanceof Error ? err.message : String(err));
      // Only this session is gone (the runtime dropped it): the next turn
      // resumes it from Blob; the other sessions of the runtime stay.
      else if (isSessionGoneError(err)) void dropSession(`thread-${input.threadId}`, live);
      mapper.fail(err instanceof Error ? err.message : String(err), "SendError");
      settle();
    });

  const result = settled.then((): CopilotTurnResult => {
    clearTimeout(turnTimer);
    if (abortTimer) clearTimeout(abortTimer);
    input.abortSignal.removeEventListener("abort", onAbort);
    unsubscribe();
    live.binding.current = undefined;
    live.binding.gate = undefined;
    live.busy = false;
    live.lastUsed = Date.now();
    live.compactionsShown = live.compactions.length;
    try {
      controller.close();
    } catch {
      // already closed
    }
    const usage = mapper.turnUsage;
    const subAgentPersonas: Record<string, string> = {};
    for (const name of Object.keys(usage.bySubAgent)) {
      const personaId = gate.personaIdOf(name);
      if (personaId) subAgentPersonas[name] = personaId;
    }
    return {
      ...mapper.result(),
      sessionMode: mode,
      seededEvents: seeded,
      turnUsage: { ...usage, byModel: { ...usage.byModel }, bySubAgent: { ...usage.bySubAgent } },
      reasoningDurationMs: reasoningDurationMs(),
      firstChunkMs,
      compactions: live.compactions.slice(compactionsBefore),
      compactionNotice: [...pendingCompactions, ...live.compactions.slice(compactionsBefore)].filter((c) => c.success).at(-1),
      subAgentPersonas,
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

/** Diagnostics / tests: live sessions, running turns and the runtime's RSS (Linux) in this process. */
export function runtimeStats(): { liveSessions: number; runningTurns: number; runtimeRssMb?: number } {
  return { liveSessions: state.sessions.size, runningTurns: limiter.running, runtimeRssMb: processRssMb(runtimePid(state.started)) };
}
