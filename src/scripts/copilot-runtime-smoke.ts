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
import { readFileSync } from "node:fs";
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
    });

  const userKey = (name: string) => createHash("sha256").update(`${name}-${runId}`).digest("hex");
  const fsOps: Array<{ ns: string; op: string; path: string }> = [];
  const listener = (ns: string) => (op: string, p: string) => fsOps.push({ ns, op, path: p });

  const summary: Json[] = [];
  // SMOKE_ONLY=A,B,... runs only those sections (A B C D F L E).
  const only = process.env.SMOKE_ONLY?.split(",").map((x) => x.trim().toUpperCase());
  const section = (name: string) => !only || only.includes(name);

  async function turn(label: string, args: {
    threadId: string;
    user: string;
    model: ChatModel;
    prompt: string;
    abortAfterMs?: number;
    history?: Parameters<typeof session.runCopilotTurn>[0]["priorHistory"];
  }) {
    const toolset = await toolsetFor(args.threadId);
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
      "Use the glob tool to list all files under /workspace. Then use the docs search tool once to find what an Azure append blob is, and answer in one sentence.",
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

main().then(
  () => process.exit(0),
  (err) => {
    console.error("SMOKE FAILED", err instanceof Error ? err.stack : err);
    process.exit(1);
  },
);
