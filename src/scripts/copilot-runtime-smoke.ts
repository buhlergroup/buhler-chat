/**
 * Smoke test of the Copilot runtime path against the dev models and the dev
 * storage account in src/.env.local. Drives the runtime module directly with
 * a fake user context (no signed-in user, no Cosmos writes).
 *
 *   cd src
 *   npx tsx scripts/copilot-runtime-smoke.ts
 *
 * Env (optional): SMOKE_GPT_MODEL (default gpt-5.6-luna), SMOKE_CLAUDE_MODEL
 * (default claude-sonnet-5), SMOKE_MCP_URL (a public MCP server without
 * sign-in; default the Microsoft Learn MCP server), SMOKE_SKIP_BASELINE=true.
 *
 * Prints, per turn: the UI chunks (deltas folded), usage incl. cache reads,
 * first-chunk latency, the session mode (created / live / resumed) and the
 * file operations the runtime sent to the Blob provider. Values of secrets
 * are never printed.
 */
import { readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import { execSync } from "node:child_process";
import path from "node:path";
import { createHash } from "node:crypto";
import Module from "node:module";

// The app's server modules import "server-only", which throws outside the
// React server build. This script IS server code: resolve it to its no-op
// entry (the same file Next uses under the react-server condition).
const moduleWithResolve = Module as unknown as {
  _resolveFilename: (request: string, ...rest: unknown[]) => string;
};
const originalResolve = moduleWithResolve._resolveFilename;
moduleWithResolve._resolveFilename = function (request: string, ...rest: unknown[]) {
  if (request === "server-only") {
    return path.join(path.dirname(originalResolve.call(this, request, ...rest)), "empty.js");
  }
  return originalResolve.call(this, request, ...rest);
};

// ── env from .env.local (values are never printed) ─────────────────────────
function loadEnvFile(file: string) {
  let text = "";
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return;
  }
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/.exec(line);
    if (!m || line.trimStart().startsWith("#")) continue;
    let value = m[2];
    if (/^(["']).*\1$/.test(value)) value = value.slice(1, -1);
    process.env[m[1]] ??= value;
  }
}
loadEnvFile(path.resolve(process.cwd(), ".env.local"));

// Section U writes CHAT_DOCUMENT rows and AI Search chunks, which read the
// signed-in user. The smoke has none: the auth helpers resolve to a stub whose
// user is SMOKE_USER_KEY (a hashed id made up for this run), never a real user.
const authStub = path.join(os.tmpdir(), `copilot-smoke-auth-${process.pid}.cjs`);
writeFileSync(
  authStub,
  [
    'const crypto = require("node:crypto");',
    'const user = () => ({ name: "smoke", email: "smoke@example.invalid", image: "", isAdmin: false, token: "", isLocalDevUser: true });',
    "module.exports = {",
    '  userHashedId: async () => { if (!process.env.SMOKE_USER_KEY) throw new Error("no smoke user"); return process.env.SMOKE_USER_KEY; },',
    "  getCurrentUser: async () => user(),",
    "  userSession: async () => user(),",
    '  hashValue: (v) => crypto.createHash("sha256").update(v).digest("hex"),',
    "};",
  ].join(String.fromCharCode(10)),
);
const resolveWithAuthStub = moduleWithResolve._resolveFilename;
const AUTH_HELPERS = path.join("features", "auth-page", "helpers.ts");
moduleWithResolve._resolveFilename = function (request: string, ...rest: unknown[]) {
  const resolved = resolveWithAuthStub.call(this, request, ...rest);
  return resolved.endsWith(AUTH_HELPERS) ? authStub : resolved;
};


type Json = Record<string, unknown>;

async function main() {
  const { buildToolset } = await import("@/features/chat-page/chat-services/tools/registry");
  const session = await import("@/features/chat-page/chat-services/copilot-runtime/copilot-session");
  const { getAgentWorkspaceStore } = await import(
    "@/features/chat-page/chat-services/copilot-runtime/azure-blob-store"
  );
  const { buildSystemMessage } = await import("@/features/chat-page/chat-services/chat-api/prompt-builder");
  const { CHAT_DEFAULT_SYSTEM_PROMPT } = await import("@/features/theme/theme-config");
  const { MODEL_CONFIGS } = await import("@/features/chat-page/chat-services/models");
  type ChatModel = keyof typeof MODEL_CONFIGS;

  const gptModel = (process.env.SMOKE_GPT_MODEL ?? "gpt-5.6-luna") as ChatModel;
  const claudeModel = (process.env.SMOKE_CLAUDE_MODEL ?? "claude-sonnet-5") as ChatModel;
  const mcpUrl = process.env.SMOKE_MCP_URL ?? "https://learn.microsoft.com/api/mcp";
  const runId = Date.now().toString(36);
  const store = await getAgentWorkspaceStore();

  const system = buildSystemMessage({
    staticSystemPrompt: CHAT_DEFAULT_SYSTEM_PROMPT,
    personaMessage: "",
    documentHint: undefined,
  });

  const mcpExtension = {
    id: "5m0ke0mcp-extension",
    name: "Docs",
    description: "Public documentation search",
    executionSteps: "Search the docs",
    headers: [],
    userId: "smoke",
    isPublished: false,
    createdAt: new Date(),
    functions: [],
    type: "EXTENSION",
    kind: "mcp",
    mcp: { url: mcpUrl, transport: "auto", secrets: [], toolAllowList: [], auth: "none" },
  };

  const toolsetFor = (threadId: string) =>
    buildToolset({
      user: "smoke-user",
      threadId,
      threadDocumentIds: [],
      personaDocumentIds: [],
      defaultTools: {},
      extensions: [{ extension: mcpExtension as any, headerSecrets: {}, mcp: { url: mcpUrl, transport: "auto", headers: {} } }],
      clientDateTime: new Date().toISOString(),
      depth: 0,
      // As the route does on the Copilot path.
      mcpOutputLimit: Number.POSITIVE_INFINITY,
      searchDocumentsAlways: true,
    });

  const userKey = (name: string) => createHash("sha256").update(`${name}-${runId}`).digest("hex");
  const fsOps: Array<{ ns: string; op: string; path: string }> = [];
  const listener = (ns: string) => (op: string, p: string) => fsOps.push({ ns, op, path: p });

  const summary: Json[] = [];
  // SMOKE_ONLY=A,B,... runs only those sections (A B C D F L E U M P S).
  const only = process.env.SMOKE_ONLY?.split(",").map((x) => x.trim().toUpperCase());
  const section = (name: string) => !only || only.includes(name);

  async function turn(label: string, args: {
    threadId: string;
    user: string;
    model: ChatModel;
    prompt: string;
    abortAfterMs?: number;
    history?: Parameters<typeof session.runCopilotTurn>[0]["priorHistory"];
    extraTools?: Record<string, unknown>;
    contextNote?: string;
  }) {
    const toolset = { ...(await toolsetFor(args.threadId)), ...(args.extraTools ?? {}) } as Awaited<ReturnType<typeof toolsetFor>>;
    const abort = new AbortController();
    const opsBefore = fsOps.length;
    const started = Date.now();
    const handle = await session.runCopilotTurn({
      threadId: args.threadId,
      userKey: userKey(args.user),
      modelId: args.model,
      reasoningEffort: MODEL_CONFIGS[args.model].defaultReasoningEffort,
      systemMessage: system,
      toolset,
      priorHistory: args.history ?? [],
      ...(args.contextNote ? { contextNote: args.contextNote } : {}),
      prompt: args.prompt,
      abortSignal: abort.signal,
      store,
      onFsOp: listener(`${args.user}/${args.threadId}`),
    });
    if (args.abortAfterMs) setTimeout(() => abort.abort(), args.abortAfterMs);
    const chunks: string[] = [];
    let last = "";
    const reader = handle.stream.getReader();
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      const c = value as Json;
      const t = String(c.type);
      if (t.endsWith("-delta")) {
        if (last === t) {
          chunks[chunks.length - 1] += String(c.delta ?? "");
        } else {
          chunks.push(`${t}: ${String(c.delta ?? "")}`);
        }
        last = t;
        continue;
      }
      last = "";
      const detail =
        t === "tool-input-available"
          ? ` ${c.toolName}${c.dynamic ? " (builtin)" : ""} ${JSON.stringify(c.input).slice(0, 160)}`
          : t === "tool-output-available"
            ? ` ${JSON.stringify(c.output).slice(0, 160)}`
            : t === "tool-output-error" || t === "error"
              ? ` ${String(c.errorText).slice(0, 200)}`
              : t === "finish"
                ? ` ${c.finishReason}`
                : "";
      chunks.push(`${t}${detail}`);
    }
    const result = await handle.result;
    const u = result.turnUsage;
    const ops = fsOps.slice(opsBefore);
    const opCounts = ops.reduce<Record<string, number>>((acc, o) => ((acc[o.op] = (acc[o.op] ?? 0) + 1), acc), {});
    const workspaceOps = ops.filter((o) => !o.path.replace(/\\/g, "/").startsWith("/session-state"));
    console.log(`\n=== ${label} [${args.model}] session=${result.sessionMode} seeded=${result.seededEvents}`);
    for (const line of chunks) console.log(`  ${line.length > 400 ? `${line.slice(0, 400)}...` : line}`);
    console.log(
      `  usage: calls=${u.calls} input=${u.inputTokens} cacheRead=${u.cacheReadTokens} cacheWrite=${u.cacheWriteTokens} output=${u.outputTokens} lastPrompt=${u.lastInputTokens} ttft(runtime)=${u.firstTimeToFirstTokenMs}ms firstChunk=${result.firstChunkMs}ms wall=${Date.now() - started}ms finish=${result.finishReason}${result.error ? ` error=${result.error.message}` : ""}`,
    );
    console.log(`  fs ops: ${JSON.stringify(opCounts)}${result.compactions.length ? ` compactions=${JSON.stringify(result.compactions)}` : ""}`);
    if (workspaceOps.length > 0) {
      console.log(`  non-state paths: ${JSON.stringify([...new Set(workspaceOps.map((o) => `${o.op} ${o.path}`))].slice(0, 20))}`);
    }
    summary.push({
      label,
      model: args.model,
      sessionMode: result.sessionMode,
      calls: u.calls,
      inputTokens: u.inputTokens,
      cacheReadTokens: u.cacheReadTokens,
      cacheWriteTokens: u.cacheWriteTokens,
      outputTokens: u.outputTokens,
      firstChunkMs: result.firstChunkMs,
      finishReason: result.finishReason,
      text: result.text.slice(0, 300),
      toolResults: result.steps.flatMap((s) => s.toolResults.map((r) => r.toolName)),
    });
    return result;
  }

  const threadA = `smoke-a-${runId}`;
  const threadB = `smoke-b-${runId}`;

  // ── Thread A: GPT, tools, files, restart, model switch ───────────────────
  if (section("A")) {
  await turn("A1 time + create file", {
    threadId: threadA,
    user: "alice",
    model: gptModel,
    prompt:
      "Call get_current_time and tell me the time. Then create the file /workspace/notes/plan.txt with exactly the line: alpha-42",
  });
  await turn("A2 glob + MCP", {
    threadId: threadA,
    user: "alice",
    model: gptModel,
    prompt:
      "Use the glob tool to list all files under /workspace and the rg tool to find alpha with line numbers (content mode). Then use the docs search tool once to find what an Azure append blob is, and answer in one sentence.",
  });
  console.log(`
tools offered to ${gptModel}: ${(await session.liveSessionToolNames(threadA))?.join(", ")}`);
  await turn("A3 view + OS paths", {
    threadId: threadA,
    user: "alice",
    model: gptModel,
    prompt:
      "Use view to read /workspace/notes/plan.txt and quote it. Then use view to read /etc/passwd and then C:\\Windows\\win.ini, and report exactly what each call returned.",
  });

  // Restart simulation: drop the live session AND stop the runtime process.
  await session.shutdownCopilotRuntime();
  console.log("\n--- runtime stopped; next turn must resume from Blob ---");
  await turn("A4 after restart (resume)", {
    threadId: threadA,
    user: "alice",
    model: gptModel,
    prompt: "Without using any tool: which exact line did you write into the file earlier?",
  });
  await turn("A5 model switch to Claude", {
    threadId: threadA,
    user: "alice",
    model: claudeModel,
    prompt: "Without using any tool: what time did get_current_time return in the first turn? One line.",
  });

  }

  // ── Thread B: Claude, another user, isolation + cache ────────────────────
  if (section("B")) {
  await turn("B1 create own file", {
    threadId: threadB,
    user: "bob",
    model: claudeModel,
    prompt: "Create /workspace/secret-b.txt with the line: bravo-7. Then reply 'done'.",
  });
  console.log(`
tools offered to ${claudeModel}: ${(await session.liveSessionToolNames(threadB))?.join(", ")}`);
  await turn("B2 glob + grep (isolation)", {
    threadId: threadB,
    user: "bob",
    model: claudeModel,
    prompt:
      "Use glob with pattern **/* under /workspace and list every file you find. Then grep the workspace for 'alpha' and for 'bravo' and report the matches.",
  });
  await turn("B3 read other thread (isolation)", {
    threadId: threadB,
    user: "bob",
    model: claudeModel,
    prompt:
      "Use view on /workspace/notes/plan.txt, then on /workspace/../" +
      threadA +
      "/workspace/notes/plan.txt, then on /session-state/../../" +
      threadA +
      "/f/workspace/notes/plan.txt. Report each result exactly.",
  });
  await turn("B4 cache turn", {
    threadId: threadB,
    user: "bob",
    model: claudeModel,
    prompt: "Without tools: summarise this chat in one sentence.",
  });

  }

  // ── Abort ────────────────────────────────────────────────────────────────
  if (section("C")) {
  await turn("C1 abort after 2.5 s", {
    threadId: `smoke-c-${runId}`,
    user: "carol",
    model: gptModel,
    prompt: "Write a 600-word story about a lighthouse keeper.",
    abortAfterMs: 2500,
  });
  await turn("C2 after abort (same session still works)", {
    threadId: `smoke-c-${runId}`,
    user: "carol",
    model: gptModel,
    prompt: "Reply with the single word: ready",
  });

  }

  // ── Seeding: a thread with existing (AI SDK path) history ───────────────
  if (section("D")) {
  await turn("D1 seeded from history", {
    threadId: `smoke-d-${runId}`,
    user: "dave",
    model: claudeModel,
    prompt: "What is my favourite colour? One word.",
    history: [
      { id: "u1", role: "user", parts: [{ type: "text", text: "My favourite colour is teal." }] },
      { id: "a1", role: "assistant", parts: [{ type: "text", text: "Noted: teal." }] },
    ],
  });

  }

  // ── Compaction: a fact from turn 1 must survive one compaction ──────────
  // COPILOT_MAX_PROMPT_TOKENS stands in for a small model so that one
  // compaction happens after a few turns; the thresholds are the production
  // ones (copilot-session.ts).
  if (section("F")) {
    process.env.COPILOT_MAX_PROMPT_TOKENS = process.env.SMOKE_COMPACTION_LIMIT ?? "12000";
    const threadF = `smoke-f-${runId}`;
    const words = ["pump", "valve", "sensor", "motor", "belt", "silo", "mixer", "dryer", "sieve", "scale"];
    const filler = (n: number) =>
      Array.from({ length: 900 }, (_, i) => words[(i * 7 + n) % words.length]).join(" ");
    await turn("F0 fact", {
      threadId: threadF,
      user: "frank",
      model: gptModel,
      prompt: "Remember this fact for later: the project code word is KINGFISHER-58. Reply only: noted",
    });
    for (let n = 1; n <= 12 && (session.liveSessionCompactions(threadF)?.length ?? 0) === 0; n++) {
      await turn(`F${n} load`, {
        threadId: threadF,
        user: "frank",
        model: gptModel,
        prompt: `Inspection log ${n}: ${filler(n)}
Reply only with: ok ${n}`,
      });
    }
    await turn("F recall after compaction", {
      threadId: threadF,
      user: "frank",
      model: gptModel,
      prompt: "Without tools: what is the project code word?",
    });
    console.log(`
compactions in thread F: ${JSON.stringify(session.liveSessionCompactions(threadF))}`);
    delete process.env.COPILOT_MAX_PROMPT_TOKENS;
  }

  // ── Lease: a second concurrent turn on the same thread ──────────────────
  if (section("L")) {
    const threadL = `smoke-l-${runId}`;
    const first = turn("L1 long turn", {
      threadId: threadL,
      user: "lena",
      model: gptModel,
      prompt: "Write 700 words about grain silos.",
    });
    await new Promise((r) => setTimeout(r, 1500));
    const t0 = Date.now();
    try {
      await turn("L2 concurrent turn", { threadId: threadL, user: "lena", model: gptModel, prompt: "Say hi" });
      console.log("L2 unexpectedly ran");
    } catch (err) {
      console.log(`
=== L2 concurrent turn refused after ${Date.now() - t0} ms: ${(err as Error).name}: ${(err as Error).message}`);
    }
    await first;
    await turn("L3 after release", { threadId: threadL, user: "lena", model: gptModel, prompt: "Reply with: free" });
  }

  // ── First call: Copilot path vs AI SDK path, system message modes ──────
  if (section("E") && process.env.SMOKE_SKIP_BASELINE !== "true") {
    const { streamText } = await import("ai");
    const { resolveProvider } = await import("@/features/chat-page/chat-services/models/provider-seam");
    for (const model of [gptModel, claudeModel]) {
      for (const mode of ["replace", "customize"] as const) {
        process.env.COPILOT_SYSTEM_MESSAGE_MODE = mode;
        const r = await turn(`E first call, copilot ${mode}`, {
          threadId: `smoke-e-${mode}-${model.replace(/[^A-Za-z0-9]/g, "")}-${runId}`,
          user: "erin",
          model,
          prompt: "Reply with the single word: OK",
        });
        summary.push({ label: `first-call ${model} copilot-${mode}`, firstCallInputTokens: r.steps[0]?.usage?.inputTokens, firstChunkMs: r.firstChunkMs });
      }
      delete process.env.COPILOT_SYSTEM_MESSAGE_MODE;
      // AI SDK path: same system message and app toolset, same prompt.
      const toolset = await toolsetFor(`smoke-e-aisdk-${runId}`);
      const config = MODEL_CONFIGS[model];
      const resolved = resolveProvider({
        modelId: model,
        thread: { id: `smoke-e-aisdk-${runId}`, codeInterpreterContainerId: undefined },
        toggles: { codeInterpreter: false, imageGeneration: false, webSearch: false },
        reasoning: { supported: config.supportsReasoning, effort: config.defaultReasoningEffort as never },
      });
      const t0 = Date.now();
      let first: number | undefined;
      const res = streamText({
        model: resolved.model,
        instructions: system,
        messages: [{ role: "user", content: "Reply with the single word: OK" }],
        tools: toolset,
        providerOptions: resolved.providerOptions,
      });
      for await (const part of res.fullStream) {
        if (first === undefined && (part.type === "text-delta" || part.type === "reasoning-delta")) first = Date.now() - t0;
      }
      const usage = await res.usage;
      console.log(`
=== E first call, AI SDK path [${model}] input=${usage.inputTokens} cacheRead=${usage.inputTokenDetails?.cacheReadTokens} firstChunk=${first}ms`);
      summary.push({ label: `first-call ${model} ai-sdk`, firstCallInputTokens: usage.inputTokens, firstChunkMs: first });
    }
  }

  // ── U: chat uploads into the workspace, rg/view on them, index on request ─
  if (section("U")) {
    const files = await import("@/features/chat-page/chat-services/copilot-runtime/workspace-files");
    const { indexDocumentTool } = await import("@/features/chat-page/chat-services/copilot-runtime/index-document");
    const { extractTextTool, extractWorkspaceText } = await import(
      "@/features/chat-page/chat-services/copilot-runtime/extract-text"
    );
    const { DeleteDocumentsOfChatThread } = await import("@/features/chat-page/chat-services/azure-ai-search/azure-ai-search");
    const { HistoryContainer } = await import("@/features/common/services/cosmos");
    const sharp = (await import("sharp")).default;
    const user = userKey("ursula");
    process.env.SMOKE_USER_KEY = user;
    const threadU = `smoke-u-${runId}`;
    // The upload path of the chat UI: UploadFileToAgentWorkspace -> uploadToThreadWorkspace.
    const pdf = minimalPdf(["Recipe notes for the spring batch.", "The secret ingredient is cardamom.", "Batch code: QX-7731"]);
    const png = await sharp(
      Buffer.from(
        '<svg xmlns="http://www.w3.org/2000/svg" width="240" height="240"><rect width="240" height="240" fill="white"/><circle cx="120" cy="120" r="90" fill="red"/></svg>',
      ),
    )
      .png()
      .toBuffer();
    const t0 = Date.now();
    const upPdf = await files.uploadToThreadWorkspace(user, threadU, "Recipe Notes.pdf", pdf);
    const upPdf2 = await files.uploadToThreadWorkspace(user, threadU, "Recipe Notes.pdf", pdf);
    const upPng = await files.uploadToThreadWorkspace(user, threadU, "shape.png", png);
    console.log(`\n=== U uploads (${Date.now() - t0} ms): ${JSON.stringify([upPdf, upPdf2, upPng])}`);
    const { fs, store: wsStore } = await files.threadWorkspace(user, threadU);
    const extracted = await extractWorkspaceText(files.workspaceExtractDeps({ fs, userKey: user }), upPdf.path);
    console.log(`extract_text: ${JSON.stringify(extracted)}`);
    if (extracted.status === "extracted") {
      console.log(`extracted text: ${JSON.stringify((await fs.readFile(extracted.path)).slice(0, 200))}`);
    }
    const extra = {
      extract_text: extractTextTool(files.workspaceExtractDeps({ fs, userKey: user })),
      index_document: indexDocumentTool(files.chatDocumentIndexDeps({ fs, threadId: threadU, userKey: user })),
    };
    const note = await files.workspaceUploadsNote(fs);
    console.log(`context note: ${note}`);
    await turn("U1 rg in the PDF text + view the image", {
      threadId: threadU,
      user: "ursula",
      model: gptModel,
      extraTools: extra,
      contextNote: note,
      prompt:
        "Without indexing anything: use rg to find the batch code in my uploaded recipe notes, then use view on /workspace/uploads/shape.png and say what shape and colour it shows.",
    });
    await turn("U2 index on request + search_documents", {
      threadId: threadU,
      user: "ursula",
      model: gptModel,
      extraTools: extra,
      contextNote: note,
      prompt: "Index the recipe notes with index_document, then answer with search_documents: what is the secret ingredient?",
    });
    const row = await files.chatDocumentIndexDeps({ fs, threadId: threadU, userKey: user }).findRow("uploads/Recipe Notes.pdf");
    console.log(`CHAT_DOCUMENT row: ${row ? "created" : "missing"}`);
    await turn("U3 index again (replaces)", {
      threadId: threadU,
      user: "ursula",
      model: gptModel,
      extraTools: extra,
      contextNote: note,
      prompt: "Index /workspace/uploads/Recipe Notes.pdf again and tell me the status and chunk count it returned.",
    });
    // Deleting the chat documents removes the uploads (SoftDeleteChatDocumentsForCurrentUser calls this).
    const removed = await files.removeThreadWorkspaceFiles(user, threadU, "uploads", wsStore);
    console.log(`removed ${removed} upload blobs; uploads left: ${(await fs.listEntries("/workspace/uploads")).length}`);
    await DeleteDocumentsOfChatThread(threadU);
    const { resources } = await HistoryContainer()
      .items.query({ query: "SELECT r.id FROM r WHERE r.chatThreadId=@t", parameters: [{ name: "@t", value: threadU }] })
      .fetchAll();
    for (const r of resources as Array<{ id: string }>) await HistoryContainer().item(r.id, user).delete().catch(() => undefined);
    console.log(`cleaned ${resources.length} smoke rows`);
  }

  // ── M: a large MCP result goes to a workspace file and survives a restart ─
  if (section("M")) {
    const threadM = `smoke-m-${runId}`;
    const mFiles = await import("@/features/chat-page/chat-services/copilot-runtime/workspace-files");
    const { store: mStore } = await mFiles.threadWorkspace(userKey("mia"), threadM);
    const listResults = async () =>
      (await mStore.listNames(`${userKey("mia")}/${threadM}/f/workspace/tool-results/`)).map((n: string) => n.split("/f/")[1]);
    await turn("M1 large MCP result -> file, rg in the same turn", {
      threadId: threadM,
      user: "mia",
      model: gptModel,
      prompt:
        "Use the docs fetch tool once on https://learn.microsoft.com/en-us/azure/azure-resource-manager/management/azure-subscription-service-limits . The full result is saved to a file: use rg on that file to find the maximum number of tag name/value pairs per resource, and quote the line.",
    });
    console.log(`tool-results files after M1: ${JSON.stringify(await listResults())}`);
    await session.shutdownCopilotRuntime();
    console.log(`after runtime stop: ${JSON.stringify(await listResults())}`);
    await turn("M2 after restart: rg on the saved result", {
      threadId: threadM,
      user: "mia",
      model: gptModel,
      prompt:
        "Without fetching again: use rg on the saved docs result file from before to find the limit for resource groups per subscription, and quote the line.",
    });
  }

  // ── P: provider built-ins as our own tools (generate_image, web_search, run_code) ─
  if (section("P")) {
    const pFiles = await import("@/features/chat-page/chat-services/copilot-runtime/workspace-files");
    const { providerTools } = await import("@/features/chat-page/chat-services/copilot-runtime/provider-tools");
    const user = userKey("paula");
    const threadP = `smoke-p-${runId}`;
    const { fs: pFs, store: pStore } = await pFiles.threadWorkspace(user, threadP);
    const extra = providerTools({
      fs: pFs,
      threadId: threadP,
      userKey: user,
      toggles: { imageGeneration: true, webSearch: true, codeInterpreter: true },
    });
    const showTools = (r: Awaited<ReturnType<typeof turn>>) => {
      for (const t of r.steps.flatMap((s) => s.toolResults)) {
        console.log(`  tool output part ${t.toolName}: ${JSON.stringify(t.output).slice(0, 900)}`);
      }
    };
    const p1 = await turn("P1 generate_image into the workspace", {
      threadId: threadP,
      user: "paula",
      model: gptModel,
      extraTools: extra,
      prompt: "Use generate_image to draw a small red bicycle on a white background (name it bicycle). Then tell me the workspace path.",
    });
    showTools(p1);
    const imgs = await pFs.listEntries("/workspace/images");
    console.log(`  /workspace/images: ${JSON.stringify(imgs.map((e) => ({ path: e.path, bytes: e.size })))}`);
    const p2 = await turn("P2 web_search with citations", {
      threadId: threadP,
      user: "paula",
      model: gptModel,
      extraTools: extra,
      prompt: "Use web_search: what is the latest stable version of Node.js LTS? Answer in one sentence and cite the sources as markdown links.",
    });
    showTools(p2);
    const csv = ["month,units", "Jan,120", "Feb,135", "Mar,160", "Apr,150", "May,180", "Jun,210"].join(String.fromCharCode(10));
    const up = await pFiles.uploadToThreadWorkspace(user, threadP, "sales.csv", Buffer.from(csv));
    console.log(`  uploaded ${up.path} (${up.bytes} bytes)`);
    const p3 = await turn("P3 run_code on the uploaded CSV -> chart", {
      threadId: threadP,
      user: "paula",
      model: gptModel,
      extraTools: extra,
      contextNote: await pFiles.workspaceUploadsNote(pFs),
      prompt:
        "Use run_code with /workspace/uploads/sales.csv: make a bar chart of units per month saved as sales_chart.png, and print the total units. Tell me the total and where the chart is.",
    });
    showTools(p3);
    const outs = await pFs.listEntries("/workspace/outputs");
    console.log(`  /workspace/outputs: ${JSON.stringify(outs.map((e) => ({ path: e.path, bytes: e.size })))}`);
    const removedP = await pFiles.removeThreadWorkspaceFiles(user, threadP, "all", pStore);
    console.log(`  cleaned ${removedP} blobs of thread P`);
  }

  // ── S: milestone 4 (regex limits, reset, journal scan, sub-agents, compaction) ─
  // SMOKE_ONLY=S. Sub-sections with SMOKE_S=regex,reset,journal,sub,compact (default all).
  if (section("S")) {
    const files = await import("@/features/chat-page/chat-services/copilot-runtime/workspace-files");
    const { workspaceTools } = await import("@/features/chat-page/chat-services/copilot-runtime/workspace-tools");
    const { copilotModelSelectionId } = await import("@/features/chat-page/chat-services/copilot-runtime/providers");
    const { extensionTool } = await import("@/features/chat-page/chat-services/tools/extension-tool");
    const { tool } = await import("ai");
    const { z } = await import("zod");
    const subs = (process.env.SMOKE_S ?? "regex,reset,journal,sub,compact").split(",");
    const sub = (name: string) => subs.includes(name);
    const noAiSdkSubAgents = async (threadId: string) => {
      const { call_sub_agent: _c, search_sub_agent: _s, ...rest } = await toolsetFor(threadId);
      return rest;
    };
    const cleanup: Array<[string, string]> = [];

    if (sub("regex")) {
      const user = userKey("sam");
      const threadR = `smoke-sr-${runId}`;
      cleanup.push([user, threadR]);
      const { fs } = await files.threadWorkspace(user, threadR);
      const NL = String.fromCharCode(10);
      await fs.writeFile("/workspace/evil.txt", Array.from({ length: 2000 }, () => `${"a".repeat(40)}!`).join(NL));
      const rg = workspaceTools(fs, "gpt").find((t) => t.name === "rg")! as unknown as {
        handler: (a: unknown, i: { toolCallId: string }) => Promise<{ resultType: string; textResultForLlm: string; skipLargeOutputProcessing?: boolean }>;
      };
      let ticks = 0;
      const iv = setInterval(() => ticks++, 5);
      for (const [label, pattern] of [
        ["(a+)+$ on 2,000 lines of 40 a + !", "(a+)+$"],
        ["pattern of 1,500 chars", "a".repeat(1500)],
        ["backreference", "(a)\\1"],
      ] as const) {
        const t0 = Date.now();
        const ticks0 = ticks;
        const r = await rg.handler({ pattern, output_mode: "count" }, { toolCallId: `evil-${label.length}` });
        console.log(
          `\n=== S regex: ${label}: ${Date.now() - t0} ms, ${r.resultType}, timer ticks during the search ${ticks - ticks0}, skipLargeOutputProcessing=${r.skipLargeOutputProcessing}: ${r.textResultForLlm.slice(0, 140).replace(/\s+/g, " ")}`,
        );
      }
      clearInterval(iv);
    }

    if (sub("reset")) {
      const threadT = `smoke-st-${runId}`;
      cleanup.push([userKey("tara"), threadT]);
      await turn("S reset 1: remember a code word", {
        threadId: threadT,
        user: "tara",
        model: gptModel,
        prompt: "Remember this code word for later: ZEBRA-4417. Reply only with OK.",
      });
      const { fs } = await files.threadWorkspace(userKey("tara"), threadT);
      console.log(`journal before reset: events.jsonl exists = ${await fs.exists("/session-state/events.jsonl")}`);
      // What ResetChatThread runs on the Copilot path (chat-thread-service: scope "all").
      process.env.AGENT_RUNTIME ??= "copilot";
      await files.removeThreadWorkspaceFilesQuietly(userKey("tara"), threadT, "all");
      console.log(`journal after reset: events.jsonl exists = ${await fs.exists("/session-state/events.jsonl")}`);
      await turn("S reset 2: ask for the code word (empty history after reset)", {
        threadId: threadT,
        user: "tara",
        model: gptModel,
        prompt: "What code word did I ask you to remember? If you do not know, say NONE.",
      });
    }

    if (sub("journal")) {
      const user = userKey("jules");
      const threadJ = `smoke-sj-${runId}`;
      cleanup.push([user, threadJ]);
      process.env.SMOKE_USER_KEY = user;
      const headerSecret = `smk-${createHash("sha256").update(`secret-${runId}`).digest("hex").slice(0, 32)}`;
      const ext = {
        id: "5m0kehttp-extension",
        name: "Status page",
        description: "A public status page",
        executionSteps: "",
        headers: [{ id: "h1", key: "X-Api-Key", value: "(secret)" }],
        userId: "smoke",
        isPublished: false,
        createdAt: new Date(),
        functions: [],
        type: "EXTENSION",
      };
      const fn = {
        id: "f1",
        functionName: "get_status_page",
        code: JSON.stringify({ name: "get_status_page", description: "Fetch the public status page.", parameters: { type: "object", properties: {} } }),
        endpoint: "https://www.example.com/",
        endpointType: "GET",
        isOpen: false,
      };
      const httpTool = extensionTool(fn as never, JSON.parse(fn.code), { extension: ext as never, headerSecrets: { "X-Api-Key": headerSecret } });
      await files.uploadToThreadWorkspace(user, threadJ, "notes.txt", Buffer.from("Plant notes: line 2 runs at 80 % load.", "utf8"));
      await turn("S journal: HTTP extension with header secret + MCP + upload", {
        threadId: threadJ,
        user: "jules",
        model: gptModel,
        extraTools: { smoke001_get_status_page: httpTool },
        prompt:
          "1) Call get_status_page once and tell me its title. 2) Use the docs MCP search tool for 'blob lease duration' (one call). 3) view /workspace/uploads/notes.txt and quote it.",
      });
      // Scan every journal file for secrets (values are never printed).
      const { fs, store: jStore } = await files.threadWorkspace(user, threadJ);
      const ns = `${user}/${threadJ}`;
      const pointers = await jStore.listNames(`${ns}/f/session-state/`);
      const envSecrets = Object.entries(process.env)
        .filter(([k, v]) => /KEY|SECRET|TOKEN|PASSWORD|CONNECTION/i.test(k) && typeof v === "string" && v.length >= 16)
        .map(([k, v]) => [k, v as string] as const);
      const patterns: Array<[string, RegExp]> = [
        ["bearer token", /Bearer\s+[A-Za-z0-9._~+/=-]{20,}/],
        ["Authorization header", /"?authorization"?\s*[:=]/i],
        ["api key field", /"?(?:api[-_]?key|x-api-key|ocp-apim-subscription-key)"?\s*[:=]\s*"?[A-Za-z0-9]{16,}/i],
        ["SAS signature", /[?&]sig=[A-Za-z0-9%/+=]{20,}/],
        ["OAuth code / token", /[?&](?:code|access_token|refresh_token)=[A-Za-z0-9._-]{16,}/],
        ["connection string", /AccountKey=|SharedAccessSignature=|Password=/i],
        ["JWT", /eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/],
      ];
      const hits: string[] = [];
      let bytes = 0;
      for (const pointer of pointers) {
        if (pointer.endsWith("/.~dir")) continue;
        const path = pointer.slice(`${ns}/f`.length);
        const text = Buffer.from(await fs.readFileBytes(path)).toString("utf8");
        bytes += text.length;
        if (text.includes(headerSecret)) hits.push(`${path}: extension header secret`);
        for (const [name, re] of patterns) if (re.test(text)) hits.push(`${path}: ${name}`);
        for (const [k, v] of envSecrets) if (text.includes(v)) hits.push(`${path}: value of ${k}`);
      }
      console.log(
        `\n=== S journal scan: ${pointers.length} files, ${bytes} chars, ${envSecrets.length} env secret values checked; findings: ${hits.length ? JSON.stringify(hits) : "none"}`,
      );
    }

    if (sub("sub")) {
      const user = "sofia";
      const threadS = `smoke-ss-${runId}`;
      cleanup.push([userKey(user), threadS]);
      const forecastKey = "wx000001_station_forecast";
      let forecastCalls = 0;
      const subAgents = {
        generalModelSelectionId: copilotModelSelectionId(gptModel),
        personas: [
          {
            personaId: "smoke-persona-weather",
            displayName: "Weather Desk",
            description: "Answers weather questions for a city with its own station forecast tool.",
            instructions: "You are the weather desk. Always call your station forecast tool and report its code.",
            modelSelectionId: copilotModelSelectionId(gptModel),
            toolset: {
              [forecastKey]: tool({
                description: "Station forecast for a city.",
                inputSchema: z.object({ city: z.string() }),
                execute: async ({ city }: { city: string }) => {
                  forecastCalls++;
                  return { city, forecast: "Sunny, 21 C", code: "WX-4417" };
                },
              }),
            },
          },
        ],
      };
      const events: Array<{ t: number; type: string; agentId?: string; data?: any }> = [];
      const runS = async (label: string, prompt: string) => {
        const toolset = await noAiSdkSubAgents(threadS);
        const abort = new AbortController();
        const handle = await session.runCopilotTurn({
          threadId: threadS,
          userKey: userKey(user),
          modelId: gptModel,
          reasoningEffort: MODEL_CONFIGS[gptModel].defaultReasoningEffort,
          systemMessage: system,
          toolset,
          priorHistory: [],
          prompt,
          abortSignal: abort.signal,
          store,
          subAgents: subAgents as never,
          canUsePersona: async () => true,
          onEvent: (e) => events.push({ t: Date.now(), ...(e as { type: string }) }),
          finishMetadata: (u) => ({ usage: u }),
        });
        const parts: string[] = [];
        const reader = handle.stream.getReader();
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          const c = value as Json;
          if (c.type === "tool-input-available" || c.type === "tool-output-available" || c.type === "tool-output-error") {
            parts.push(`${c.type} ${c.toolName ?? ""} ${JSON.stringify(c.input ?? c.output ?? c.errorText).slice(0, 200)}`);
          }
          if (c.type === "finish") parts.push(`finish metadata reasoningDurationMs=${(c.messageMetadata as Json)?.reasoningDurationMs}`);
        }
        const r = await handle.result;
        console.log(`\n=== ${label}`);
        for (const p of parts) console.log(`  ${p}`);
        console.log(`  text: ${r.text.slice(0, 300)}`);
        console.log(
          `  usage: total input=${r.turnUsage.inputTokens} output=${r.turnUsage.outputTokens}; byModel=${JSON.stringify(r.turnUsage.byModel)}; bySubAgent=${JSON.stringify(r.turnUsage.bySubAgent)}; personas=${JSON.stringify(r.subAgentPersonas)}; reasoningDurationMs=${r.reasoningDurationMs}`,
        );
        return r;
      };
      events.length = 0;
      await runS(
        "S sub 1: general twice in parallel",
        "Use the general sub-agent twice IN PARALLEL (two task calls in ONE message): one writes /workspace/a.txt with the word alpha, the other writes /workspace/b.txt with the word beta. Then list both paths.",
      );
      const starts = events.filter((e) => e.type === "subagent.started");
      const ends = events.filter((e) => e.type === "subagent.completed" || e.type === "subagent.failed");
      let running = 0;
      let maxRunning = 0;
      for (const e of [...starts, ...ends].sort((a, b) => a.t - b.t)) {
        running += e.type === "subagent.started" ? 1 : -1;
        maxRunning = Math.max(maxRunning, running);
      }
      console.log(`  sub-agents started=${starts.length} completed=${ends.length} max running at once=${maxRunning}`);
      const parentTools = await session.liveSessionToolNames(threadS);
      console.log(`  parent sees: ${parentTools?.join(", ")} (persona-only tool hidden: ${!parentTools?.includes(forecastKey)})`);
      events.length = 0;
      await runS("S sub 2: persona sub-agent with its own tool", "Ask the Weather Desk agent for the forecast in Zurich and tell me the code it reports.");
      const personaToolCalls = events.filter((e) => e.type === "tool.execution_start" && e.data?.toolName === forecastKey);
      console.log(`  forecast tool calls=${forecastCalls}, by a sub-agent (agentId set)=${personaToolCalls.every((e) => !!e.agentId) && personaToolCalls.length > 0}`);
    }

    if (sub("compact")) {
      const threadC = `smoke-sc-${runId}`;
      cleanup.push([userKey("carl"), threadC]);
      const previous = process.env.COPILOT_MAX_PROMPT_TOKENS;
      process.env.COPILOT_MAX_PROMPT_TOKENS = "6000";
      const filler = (n: number) =>
        Array.from({ length: n }, (_, i) => `Line ${i}: the inspection log of conveyor ${i % 17} lists bearing temperature ${40 + (i % 23)} C and belt speed ${1 + (i % 5)} m/s.`).join(" ");
      let notice = false;
      for (let n = 1; n <= 8 && !notice; n++) {
        const r = await turn(`S compact ${n}`, {
          threadId: threadC,
          user: "carl",
          model: gptModel,
          prompt: `${n === 1 ? "The project code is HERON-12. " : ""}Here is part ${n} of a log; reply with just 'noted ${n}'. ${filler(60)}`,
        });
        const shown = (r as unknown as { compactionNotice?: unknown }).compactionNotice;
        if (shown) {
          notice = true;
          console.log(`  compaction notice with turn ${n}: ${JSON.stringify(shown)} (stored with the turn as the data-compaction part)`);
        }
      }
      if (previous === undefined) delete process.env.COPILOT_MAX_PROMPT_TOKENS;
      else process.env.COPILOT_MAX_PROMPT_TOKENS = previous;
      console.log(`  compactions in thread: ${JSON.stringify(session.liveSessionCompactions(threadC))}`);
    }

    for (const [user, thread] of cleanup) {
      const removed = await files.removeThreadWorkspaceFiles(user, thread, "all", store);
      console.log(`  cleaned ${removed} blobs of ${thread}`);
    }
  }

  // ── Runtime process memory ──────────────────────────────────────────────
  try {
    const cmd =
      process.platform === "win32"
        ? `powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter 'ParentProcessId=${process.pid}' | ForEach-Object { $p = Get-Process -Id $_.ProcessId; '{0} {1} {2}' -f $p.ProcessName, $p.Id, $p.WorkingSet64 }"`
        : `ps -o comm=,pid=,rss= --ppid ${process.pid}`;
    console.log(`\nruntime child processes (name pid memory${process.platform === "win32" ? "Bytes" : "KiB"}):\n${execSync(cmd).toString().trim()}`);
  } catch (err) {
    console.log("memory sample failed", err instanceof Error ? err.message : err);
  }

  // ── Blob evidence: per-namespace listing ─────────────────────────────────
  for (const [user, thread] of [["alice", threadA], ["bob", threadB]] as const) {
    const ns = `${userKey(user)}/${thread}`;
    const names = await store.listNames(`${ns}/f/workspace/`);
    console.log(`\nblob files in ${user}'s workspace: ${names.map((n) => n.slice(ns.length)).join(", ") || "(none)"}`);
  }
  const crossNs = fsOps.filter((o) => o.ns.startsWith("bob") && o.path.includes(threadA));
  console.log(`bob's provider calls that named alice's thread id: ${crossNs.length} (all are jailed into bob's namespace or rejected)`);

  console.log("\nSUMMARY " + JSON.stringify(summary, null, 1));
  await session.shutdownCopilotRuntime();
}

/** A one-page PDF with the given lines of text (Helvetica), for the upload smoke. */
function minimalPdf(lines: string[]): Buffer {
  const NL = String.fromCharCode(10);
  const esc = (t: string) => t.replace(/[()\\]/g, (c) => `\\${c}`);
  const body = ["BT", "/F1 14 Tf", "72 720 Td"];
  lines.forEach((l, i) => {
    if (i > 0) body.push("0 -24 Td");
    body.push(`(${esc(l)}) Tj`);
  });
  body.push("ET");
  const stream = body.join(NL);
  const objs = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    `<< /Length ${Buffer.byteLength(stream)} >>${NL}stream${NL}${stream}${NL}endstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let out = `%PDF-1.4${NL}`;
  const offsets: number[] = [];
  objs.forEach((o, i) => {
    offsets.push(Buffer.byteLength(out));
    out += `${i + 1} 0 obj${NL}${o}${NL}endobj${NL}`;
  });
  const xref = Buffer.byteLength(out);
  out += `xref${NL}0 ${objs.length + 1}${NL}0000000000 65535 f ${NL}`;
  out += offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n ${NL}`).join("");
  out += `trailer${NL}<< /Size ${objs.length + 1} /Root 1 0 R >>${NL}startxref${NL}${xref}${NL}%%EOF${NL}`;
  return Buffer.from(out, "latin1");
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error("SMOKE FAILED", err instanceof Error ? err.stack : err);
    process.exit(1);
  },
);
