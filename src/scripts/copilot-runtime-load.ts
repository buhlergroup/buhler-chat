/**
 * Load measurement of the Copilot runtime path: memory per live session, CPU
 * and event-loop lag under concurrent turns, resume time from Blob, and the
 * effect of idle eviction. Drives the runtime module (copilot-session.ts)
 * directly, like copilot-runtime-smoke.ts, with a fake user context.
 *
 *   cd src
 *   npx tsx --expose-gc scripts/copilot-runtime-load.ts
 *
 * The model is a FAKE: a local OpenAI-compatible server (child process, a
 * free port on 127.0.0.1) that streams canned replies, so no tokens are paid
 * and long histories can be measured. The runtime reaches it through a stub
 * of providers.ts (same model list and selection ids, other endpoint).
 *
 * Linux only (it reads /proc). Phases (LOAD_PHASES, comma list, default
 * memory,cpu,idle,guard,resume):
 *   memory   RSS of the runtime process tree and of this (host) process at
 *            LOAD_STEPS live sessions (default 0,1,25,50,100,200,400), for a
 *            short history (~5 turns, ~3k tokens) and a long one (~60k
 *            tokens), seeded with history.importConversation. Session state
 *            goes to an in-memory store; its bytes are reported apart.
 *            After the last step every session is disconnected (our own
 *            eviction) and the RSS is sampled again.
 *   cpu      10 and 32 concurrent turns, the fake model streams at
 *            LOAD_TOKENS_PER_SECOND (default 60) one token per chunk:
 *            CPU of host and runtime (share of one core), peak runtime RSS,
 *            event-loop lag of the host.
 *   idle     the runtime's own idle timeout (--session-idle-timeout, set by a
 *            wrapper script as COPILOT_CLI_PATH, LOAD_IDLE_SECONDS, default
 *            30) with our sweep off: RSS before and after, and what a turn on
 *            a session the runtime dropped does.
 *   guard    the memory guard of copilot-session.ts: LOAD_GUARD_SESSIONS
 *            (default 250) short sessions against COPILOT_RUNTIME_MEMORY_BUDGET_MB
 *            = LOAD_GUARD_BUDGET_MB (default 300); live sessions and RSS
 *            every 10 s for LOAD_GUARD_WAIT_SEC (default 120).
 *   resume   dev Blob storage (AZURE_STORAGE_ACCOUNT_NAME in .env.local),
 *            namespace prefix `loadtest/`, deleted at the end:
 *            time of a turn on an evicted session (resume from Blob) vs. a
 *            live one, short and long history, LOAD_RESUMES each (default 20).
 *
 * Only RSS numbers, timings and counts are printed; never env values.
 */
import { readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync, spawn, type ChildProcess } from "node:child_process";
import { monitorEventLoopDelay } from "node:perf_hooks";
import Module from "node:module";

// ── module redirects: "server-only", the auth helpers, providers.ts ────────
const moduleWithResolve = Module as unknown as {
  _resolveFilename: (request: string, parent?: { filename?: string }, ...rest: unknown[]) => string;
};
const originalResolve = moduleWithResolve._resolveFilename;
const PROVIDERS = path.join("copilot-runtime", "providers.ts");
const providersStub = path.join(os.tmpdir(), `copilot-load-providers-${process.pid}.cjs`);
const authStub = path.join(os.tmpdir(), `copilot-load-auth-${process.pid}.cjs`);
const AUTH_HELPERS = path.join("features", "auth-page", "helpers.ts");
moduleWithResolve._resolveFilename = function (request, parent, ...rest) {
  if (request === "server-only") {
    return path.join(path.dirname(originalResolve.call(this, request, parent, ...rest)), "empty.js");
  }
  const resolved = originalResolve.call(this, request, parent, ...rest);
  if (resolved.endsWith(AUTH_HELPERS)) return authStub;
  // The stub itself loads the real providers.ts.
  if (resolved.endsWith(PROVIDERS) && parent?.filename !== providersStub) return providersStub;
  return resolved;
};

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

const NL = String.fromCharCode(10);
writeFileSync(
  authStub,
  [
    'const crypto = require("node:crypto");',
    'const user = () => ({ name: "load", email: "load@example.invalid", image: "", isAdmin: false, token: "", isLocalDevUser: true });',
    "module.exports = {",
    '  userHashedId: async () => "loadtest",',
    "  getCurrentUser: async () => user(),",
    "  userSession: async () => user(),",
    '  hashValue: (v) => crypto.createHash("sha256").update(v).digest("hex"),',
    "};",
  ].join(NL),
);

// ── the fake model server ──────────────────────────────────────────────────
const FAKE_SERVER = String.raw`
const http = require("node:http");
const WORDS = "the of and to in is for on that with as are this be by from at or an it not can which have".split(" ");
let cfg = { tokens: 30, rate: 0 };
const stats = { requests: 0, paths: {}, promptChars: 0 };
const server = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    if (req.url === "/__config") { cfg = { ...cfg, ...JSON.parse(body) }; res.end("{}"); return; }
    if (req.url === "/__stats") { res.end(JSON.stringify(stats)); return; }
    stats.requests++;
    stats.paths[req.url] = (stats.paths[req.url] || 0) + 1;
    stats.promptChars += body.length;
    if (!req.url.endsWith("/chat/completions")) { res.statusCode = 404; res.end("{}"); return; }
    let parsed = {};
    try { parsed = JSON.parse(body); } catch {}
    const promptTokens = Math.ceil(body.length / 4);
    const id = "chatcmpl-" + Math.random().toString(36).slice(2);
    const chunk = (delta, finish) => "data: " + JSON.stringify({ id, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model: parsed.model || "fake", choices: [{ index: 0, delta, finish_reason: finish }] }) + "\n\n";
    if (!parsed.stream) {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ id, object: "chat.completion", created: 0, model: parsed.model || "fake", choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }], usage: { prompt_tokens: promptTokens, completion_tokens: 1, total_tokens: promptTokens + 1 } }));
      return;
    }
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
    res.write(chunk({ role: "assistant", content: "" }, null));
    let n = 0;
    const { tokens, rate } = cfg;
    const end = () => {
      res.write(chunk({}, "stop"));
      res.write("data: " + JSON.stringify({ id, object: "chat.completion.chunk", created: 0, model: parsed.model || "fake", choices: [], usage: { prompt_tokens: promptTokens, completion_tokens: tokens, total_tokens: promptTokens + tokens } }) + "\n\n");
      res.end("data: [DONE]\n\n");
    };
    const step = () => {
      if (rate <= 0) {
        res.write(chunk({ content: Array.from({ length: tokens }, (_, i) => WORDS[i % WORDS.length]).join(" ") }, null));
        return end();
      }
      if (n >= tokens) return end();
      res.write(chunk({ content: (n ? " " : "") + WORDS[n % WORDS.length] }, null));
      n++;
      setTimeout(step, 1000 / rate);
    };
    step();
  });
});
server.keepAliveTimeout = 60000;
server.listen(0, "127.0.0.1", () => console.log("PORT " + server.address().port));
`;

async function startFakeServer(): Promise<{ child: ChildProcess; url: string }> {
  const file = path.join(os.tmpdir(), `copilot-load-fake-${process.pid}.cjs`);
  writeFileSync(file, FAKE_SERVER);
  const child = spawn(process.execPath, [file], { stdio: ["ignore", "pipe", "inherit"] });
  const port = await new Promise<number>((resolve, reject) => {
    child.stdout!.on("data", (d: Buffer) => {
      const m = /PORT (\d+)/.exec(d.toString());
      if (m) resolve(Number(m[1]));
    });
    child.on("exit", (code) => reject(new Error(`fake server exited ${code}`)));
  });
  return { child, url: `http://127.0.0.1:${port}` };
}

function writeProvidersStub(fakeUrl: string) {
  const real = originalResolve.call(Module, path.resolve("features/chat-page/chat-services/copilot-runtime/providers.ts"), undefined);
  writeFileSync(
    providersStub,
    [
      `const real = require(${JSON.stringify(real)});`,
      "module.exports = {",
      "  ...real,",
      "  buildCopilotInference: () => {",
      "    const r = real.buildCopilotInference();",
      `    return { providers: r.providers.map((p) => ({ name: p.name, type: "openai", wireApi: "completions", baseUrl: ${JSON.stringify(`${fakeUrl}/v1`)}, apiKey: "fake" })), models: r.models };`,
      "  },",
      "};",
    ].join(NL),
  );
}

async function fakeConfig(url: string, cfg: { tokens?: number; rate?: number }) {
  await fetch(`${url}/__config`, { method: "POST", body: JSON.stringify(cfg) });
}

// ── process measurements (Linux /proc) ─────────────────────────────────────
const CLK_TCK = 100;
const PAGE_KB = 4;

function descendants(root: number, exclude: number[]): number[] {
  const out = execSync("ps -e -o pid=,ppid=").toString().trim().split(NL);
  const children = new Map<number, number[]>();
  for (const line of out) {
    const [pid, ppid] = line.trim().split(/\s+/).map(Number);
    if (!children.has(ppid)) children.set(ppid, []);
    children.get(ppid)!.push(pid);
  }
  const result: number[] = [];
  const stack = [...(children.get(root) ?? [])];
  while (stack.length) {
    const pid = stack.pop()!;
    if (exclude.includes(pid)) continue;
    result.push(pid);
    stack.push(...(children.get(pid) ?? []));
  }
  return result;
}

function procStat(pid: number): { rssMb: number; cpuSec: number } {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    // fields[0] is field 3 (state): utime = 14, stime = 15, rss = 24 (pages)
    const utime = Number(fields[11]);
    const stime = Number(fields[12]);
    const rssPages = Number(fields[21]);
    return { rssMb: (rssPages * PAGE_KB) / 1024, cpuSec: (utime + stime) / CLK_TCK };
  } catch {
    return { rssMb: 0, cpuSec: 0 };
  }
}

let excludePids: number[] = [];
function runtimeSample(): { rssMb: number; cpuSec: number; pids: number } {
  const pids = descendants(process.pid, excludePids).filter((pid) => {
    try {
      const comm = readFileSync(`/proc/${pid}/comm`, "utf8").trim();
      // Only the runtime: not ps/sh of this sampler, not tsx's esbuild service.
      return comm !== "ps" && comm !== "sh" && comm !== "esbuild";
    } catch {
      return false;
    }
  });
  let rssMb = 0;
  let cpuSec = 0;
  for (const pid of pids) {
    const s = procStat(pid);
    rssMb += s.rssMb;
    cpuSec += s.cpuSec;
  }
  return { rssMb, cpuSec, pids: pids.length };
}

const debug = (...a: unknown[]) => {
  if (process.env.LOAD_DEBUG) console.log("DBG", new Date().toISOString().slice(11, 19), ...a);
};
const hostRssMb = () => process.memoryUsage().rss / 1024 / 1024;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function settle(ms = 4000) {
  const gc = (globalThis as { gc?: () => void }).gc;
  gc?.();
  await sleep(ms);
  gc?.();
}
const pct = (values: number[], p: number) => {
  const s = [...values].sort((a, b) => a - b);
  return s.length ? s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)] : NaN;
};
const r1 = (n: number) => Math.round(n * 10) / 10;
const r2 = (n: number) => Math.round(n * 100) / 100;

// ── synthetic history ──────────────────────────────────────────────────────
const VOCAB =
  "plant line section motor valve silo batch recipe order alarm sensor value report shift energy flow pressure temperature quality operator maintenance schedule capacity product dryer mixer conveyor scale weight lot trace audit".split(
    " ",
  );
let seed = 7;
const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648), seed / 2147483648);
/** About `tokens` tokens of text (4 chars per token). */
function text(tokens: number): string {
  const words: string[] = [];
  let chars = 0;
  while (chars < tokens * 4) {
    const w = VOCAB[Math.floor(rnd() * VOCAB.length)] + (rnd() < 0.1 ? `-${Math.floor(rnd() * 1000)}` : "");
    words.push(w);
    chars += w.length + 1;
  }
  return words.join(" ");
}
type Msg = { id: string; role: "user" | "assistant"; parts: Array<{ type: "text"; text: string }> };
function history(turns: number, totalTokens: number): Msg[] {
  const per = totalTokens / turns;
  const msgs: Msg[] = [];
  for (let i = 0; i < turns; i++) {
    msgs.push({ id: `u${i}`, role: "user", parts: [{ type: "text", text: text(per * 0.15) }] });
    msgs.push({ id: `a${i}`, role: "assistant", parts: [{ type: "text", text: text(per * 0.85) }] });
  }
  return msgs;
}
const HISTORIES = {
  short: () => history(5, 3_000),
  long: () => history(20, 60_000),
};

// ── main ───────────────────────────────────────────────────────────────────
async function main() {
  debug("start fake server");
  const fake = await startFakeServer();
  debug("fake server", fake.url);
  excludePids = [fake.child.pid!];
  writeProvidersStub(fake.url);
  // Caps out of the way: the measurement controls the session count itself.
  process.env.COPILOT_MAX_LIVE_SESSIONS = "100000";
  process.env.COPILOT_MAX_TURNS_PER_PROCESS = "1000";
  process.env.COPILOT_MAX_TURNS_PER_USER = "1000";
  process.env.COPILOT_RUNTIME_MEMORY_BUDGET_MB = "0";
  process.env.COPILOT_SESSION_IDLE_MINUTES = "0";

  const session = await import("@/features/chat-page/chat-services/copilot-runtime/copilot-session");
  const { buildToolset } = await import("@/features/chat-page/chat-services/tools/registry");
  const { buildSystemMessage } = await import("@/features/chat-page/chat-services/chat-api/prompt-builder");
  const { CHAT_DEFAULT_SYSTEM_PROMPT } = await import("@/features/theme/theme-config");
  const { MODEL_CONFIGS } = await import("@/features/chat-page/chat-services/models");
  const { FakeBlobStore } = await import("@/features/chat-page/chat-services/copilot-runtime/fake-blob-store.test-helper");
  type ChatModel = keyof typeof MODEL_CONFIGS;
  const model = (process.env.LOAD_MODEL ?? "gpt-5.6-luna") as ChatModel;
  const runId = Date.now().toString(36);
  const phases = (process.env.LOAD_PHASES ?? "memory,cpu,idle,guard,resume").split(",").map((p) => p.trim());
  const steps = (process.env.LOAD_STEPS ?? "0,1,25,50,100,200,400").split(",").map(Number);
  const tokRate = Number(process.env.LOAD_TOKENS_PER_SECOND ?? 60);
  const kinds = (process.env.LOAD_KINDS ?? "short,long").split(",") as Array<keyof typeof HISTORIES>;

  debug("modules loaded");
  const system = buildSystemMessage({ staticSystemPrompt: CHAT_DEFAULT_SYSTEM_PROMPT, personaMessage: "", documentHint: undefined });
  const toolset = await buildToolset({
    user: "loadtest",
    threadId: "load",
    threadDocumentIds: [],
    personaDocumentIds: [],
    defaultTools: {},
    extensions: [],
    clientDateTime: new Date().toISOString(),
    depth: 0,
    mcpOutputLimit: Number.POSITIVE_INFINITY,
    searchDocumentsAlways: true,
  } as Parameters<typeof buildToolset>[0]);

  // In-memory lease backend (one process, no Blob calls) for the local phases.
  const leaseBlobs = new Map<string, { leaseId?: string; metadata: Record<string, string> }>();
  let leaseN = 0;
  const memLeases = {
    ensureBlob: async (n: string) => void (leaseBlobs.has(n) || leaseBlobs.set(n, { metadata: {} })),
    acquire: async (n: string) => {
      const b = leaseBlobs.get(n)!;
      if (b.leaseId) return undefined;
      return (b.leaseId = `l${++leaseN}`);
    },
    renew: async () => undefined,
    release: async (n: string, _id: string, metadata: Record<string, string>) => {
      const b = leaseBlobs.get(n)!;
      b.metadata = { ...b.metadata, ...metadata };
      b.leaseId = undefined;
    },
    readMetadata: async (n: string) => ({ ...(leaseBlobs.get(n)?.metadata ?? {}) }),
  };

  type Store = NonNullable<Parameters<typeof session.runCopilotTurn>[0]["store"]>;
  type Leases = NonNullable<Parameters<typeof session.runCopilotTurn>[0]["leases"]>;
  async function turn(args: {
    userKey: string;
    threadId: string;
    history: Msg[];
    store: Store;
    leases?: Leases;
    prompt?: string;
  }): Promise<{ ms: number; mode: string; error?: string; text: number }> {
    const started = performance.now();
    debug("turn", args.threadId);
    const handle = await session.runCopilotTurn({
      threadId: args.threadId,
      userKey: args.userKey,
      modelId: model,
      systemMessage: system,
      toolset,
      priorHistory: args.history as never,
      prompt: args.prompt ?? "Summarise the last answer in one line.",
      abortSignal: new AbortController().signal,
      store: args.store,
      leases: args.leases ?? memLeases,
    });
    let textChars = 0;
    let error: string | undefined;
    const reader = handle.stream.getReader();
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      const c = value as { type: string; delta?: string; errorText?: string };
      if (c.type === "text-delta") textChars += c.delta?.length ?? 0;
      if (c.type === "error") error = c.errorText;
    }
    const result = await handle.result;
    debug("turn done", args.threadId, result.sessionMode, Math.round(performance.now() - started), error ?? "");
    return { ms: performance.now() - started, mode: result.sessionMode, error, text: textChars };
  }

  async function pool<T>(n: number, total: number, fn: (i: number) => Promise<T>): Promise<T[]> {
    const out: T[] = new Array(total);
    let next = 0;
    await Promise.all(
      Array.from({ length: Math.min(n, total) }, async () => {
        for (let i = next++; i < total; i = next++) out[i] = await fn(i);
      }),
    );
    return out;
  }

  const report: Record<string, unknown> = { runId, model, cpus: os.cpus().length, cpuModel: os.cpus()[0]?.model };

  // ── memory ───────────────────────────────────────────────────────────────
  if (phases.includes("memory")) {
    const rows: Array<Record<string, number | string>> = [];
    for (const kind of kinds) {
      await session.shutdownCopilotRuntime();
      await fakeConfig(fake.url, { tokens: 30, rate: 0 });
      const store = new FakeBlobStore();
      const hist = HISTORIES[kind]();
      const histChars = hist.reduce((a, m) => a + m.parts[0].text.length, 0);
      debug("client start");
      await session.getCopilotClient();
      debug("client started");
      await settle();
      let live = 0;
      let errors = 0;
      const base = { rt: runtimeSample().rssMb, host: hostRssMb() };
      let prev = { sessions: 0, rt: base.rt };
      for (const target of steps) {
        const from = live;
        const t0 = performance.now();
        const res = await pool(8, target - from, (i) =>
          turn({ userKey: `loadu${from + i}`, threadId: `${runId}-${kind}-${from + i}`, history: hist, store }),
        );
        errors += res.filter((r) => r.error).length;
        live = target;
        const createMs = res.length ? (performance.now() - t0) / res.length : 0;
        await settle();
        const rt = runtimeSample();
        const storeMb = [...store.blobs.values()].reduce((a, b) => a + b.data.length, 0) / 1024 / 1024;
        const row = {
          kind,
          sessions: target,
          runtimeRssMb: r1(rt.rssMb),
          hostRssMb: r1(hostRssMb()),
          storeMb: r1(storeMb),
          runtimeMbPerSession: target ? r2((rt.rssMb - base.rt) / target) : 0,
          runtimeMarginalMbPerSession: target > prev.sessions ? r2((rt.rssMb - prev.rt) / (target - prev.sessions)) : 0,
          hostMbPerSessionExclStore: target ? r2((hostRssMb() - base.host - storeMb) / target) : 0,
          msPerCreate: Math.round(createMs),
          errors,
          historyTokens: Math.round(histChars / 4),
        };
        rows.push(row);
        prev = { sessions: target, rt: rt.rssMb };
        console.log("MEM", JSON.stringify(row));
      }
      // Our own eviction: disconnect every live session.
      const before = runtimeSample().rssMb;
      await session.forgetLiveSessions();
      await settle(8000);
      const after = runtimeSample().rssMb;
      console.log("MEM-DISCONNECT", JSON.stringify({ kind, before: r1(before), afterDisconnectAll: r1(after) }));
      rows.push({ kind, sessions: -1, runtimeRssMb: r1(after), note: "after disconnect of all sessions" });
    }
    report.memory = rows;
  }

  // ── cpu ──────────────────────────────────────────────────────────────────
  if (phases.includes("cpu")) {
    const rows: Array<Record<string, number | string>> = [];
    await session.shutdownCopilotRuntime();
    const store = new FakeBlobStore();
    await fakeConfig(fake.url, { tokens: 30, rate: 0 });
    const hist = HISTORIES.short();
    for (const n of [10, 32]) {
      // Sessions exist first (created + seeded), then n turns at once.
      await pool(8, n, (i) => turn({ userKey: `cpuu${n}-${i}`, threadId: `${runId}-cpu${n}-${i}`, history: hist, store }));
      await fakeConfig(fake.url, { tokens: 400, rate: tokRate });
      await settle(2000);
      const lag = monitorEventLoopDelay({ resolution: 1 });
      const rt0 = runtimeSample();
      const host0 = process.cpuUsage();
      const t0 = performance.now();
      lag.enable();
      let peakRt = rt0.rssMb;
      const peakTimer = setInterval(() => (peakRt = Math.max(peakRt, runtimeSample().rssMb)), 500);
      const res = await Promise.all(
        Array.from({ length: n }, (_, i) =>
          turn({ userKey: `cpuu${n}-${i}`, threadId: `${runId}-cpu${n}-${i}`, history: [], store, prompt: "Write a long answer." }),
        ),
      );
      lag.disable();
      clearInterval(peakTimer);
      const wall = (performance.now() - t0) / 1000;
      const rt1 = runtimeSample();
      const host1 = process.cpuUsage(host0);
      const row = {
        concurrentTurns: n,
        wallSec: r1(wall),
        turnP50Sec: r1(pct(res.map((r) => r.ms), 50) / 1000),
        hostCpuPctOfOneCore: r1(((host1.user + host1.system) / 1e6 / wall) * 100),
        runtimeCpuPctOfOneCore: r1(((rt1.cpuSec - rt0.cpuSec) / wall) * 100),
        runtimeRssBeforeMb: r1(rt0.rssMb),
        runtimeRssPeakMb: r1(peakRt),
        loopLagP50Ms: r1(lag.percentile(50) / 1e6),
        loopLagP99Ms: r1(lag.percentile(99) / 1e6),
        loopLagMaxMs: r1(lag.max / 1e6),
        tokensPerSecPerTurn: tokRate,
        errors: res.filter((r) => r.error).length,
        modes: [...new Set(res.map((r) => r.mode))].join("/"),
      };
      rows.push(row);
      console.log("CPU", JSON.stringify(row));
      await fakeConfig(fake.url, { tokens: 30, rate: 0 });
    }
    report.cpu = rows;
  }

  // ── idle: the runtime's own idle timeout ──────────────────────────────────
  if (phases.includes("idle")) {
    const idleSec = Number(process.env.LOAD_IDLE_SECONDS ?? 30);
    const n = Number(process.env.LOAD_IDLE_SESSIONS ?? 100);
    await session.shutdownCopilotRuntime();
    // The runtime binary behind a wrapper that sets its idle timeout
    // (--session-idle-timeout) and keeps the pid (exec).
    const real = path.join(
      path.dirname(require.resolve("@microsoft/copilot-sdk-linux-x64/package.json")),
      "prebuilds",
      "linux-x64",
      "copilot-runtime",
    );
    const wrapper = path.join(os.tmpdir(), `copilot-load-runtime-${process.pid}.sh`);
    writeFileSync(
      wrapper,
      [
        "#!/bin/bash",
        'a=("$@"); found=0',
        'for i in "${!a[@]}"; do if [ "${a[$i]}" = "--session-idle-timeout" ]; then a[$((i+1))]=' + idleSec + "; found=1; fi; done",
        'if [ $found = 0 ]; then a+=(--session-idle-timeout ' + idleSec + "); fi",
        `exec ${JSON.stringify(real)} "\${a[@]}"`,
        "",
      ].join(NL),
      { mode: 0o700 },
    );
    process.env.COPILOT_CLI_PATH = wrapper;
    await fakeConfig(fake.url, { tokens: 30, rate: 0 });
    const store = new FakeBlobStore();
    const hist = HISTORIES.long();
    await session.getCopilotClient();
    await settle();
    const base = runtimeSample().rssMb;
    await pool(8, n, (i) => turn({ userKey: `idleu${i}`, threadId: `${runId}-idle-${i}`, history: hist, store }));
    await settle();
    const loaded = runtimeSample().rssMb;
    const runtimeArgs = descendants(process.pid, excludePids)
      .map((pid) => {
        try {
          return readFileSync(`/proc/${pid}/cmdline`, "utf8").split(String.fromCharCode(0)).join(" ");
        } catch {
          return "";
        }
      })
      .find((a) => a.includes("--stdio"));
    const idleFlag = /--session-idle-timeout (\d+)/.exec(runtimeArgs ?? "")?.[1] ?? "none";
    await sleep((idleSec * 2 + 30) * 1000);
    const afterIdle = runtimeSample().rssMb;
    // A turn on a session the runtime dropped by itself.
    const probe = await turn({ userKey: "idleu0", threadId: `${runId}-idle-0`, history: hist, store }).catch(
      (err: unknown) => ({ ms: 0, mode: "threw", error: err instanceof Error ? err.message : String(err), text: 0 }),
    );
    const stats = session.runtimeStats();
    const row = {
      idleTimeoutSec: idleSec,
      runtimeIdleFlag: idleFlag,
      sessions: n,
      baseRssMb: r1(base),
      loadedRssMb: r1(loaded),
      afterRuntimeIdleRssMb: r1(afterIdle),
      probeMode: probe.mode,
      probeError: probe.error?.slice(0, 160) ?? "",
      liveSessionsAfterProbe: stats.liveSessions,
    };
    console.log("IDLE", JSON.stringify(row));
    report.idle = row;
    delete process.env.COPILOT_CLI_PATH;
    await session.shutdownCopilotRuntime();
  }

  // ── memory guard of copilot-session.ts (its 30 s sweep) ─────────────────────
  if (phases.includes("guard")) {
    const budget = Number(process.env.LOAD_GUARD_BUDGET_MB ?? 300);
    const n = Number(process.env.LOAD_GUARD_SESSIONS ?? 250);
    await session.shutdownCopilotRuntime();
    await fakeConfig(fake.url, { tokens: 30, rate: 0 });
    const store = new FakeBlobStore();
    const hist = HISTORIES.short();
    process.env.COPILOT_RUNTIME_MEMORY_BUDGET_MB = String(budget);
    const series: Array<Record<string, number>> = [];
    const t0 = Date.now();
    const sample = () => {
      const st = session.runtimeStats();
      const row = { sec: Math.round((Date.now() - t0) / 1000), liveSessions: st.liveSessions, runtimeRssMb: r1(st.runtimeRssMb ?? -1) };
      series.push(row);
      console.log("GUARD", JSON.stringify(row));
    };
    const timer = setInterval(sample, 10_000);
    await pool(8, n, (i) => turn({ userKey: `guardu${i}`, threadId: `${runId}-guard-${i}`, history: hist, store }));
    sample();
    await sleep(Number(process.env.LOAD_GUARD_WAIT_SEC ?? 120) * 1000);
    clearInterval(timer);
    sample();
    report.guard = { budgetMb: budget, created: n, series };
    process.env.COPILOT_RUNTIME_MEMORY_BUDGET_MB = "0";
    await session.shutdownCopilotRuntime();
  }

  // ── resume from Blob (dev storage) ─────────────────────────────────────────
  if (phases.includes("resume")) {
    const { getAgentWorkspaceStore, getAgentWorkspaceLeases } = await import(
      "@/features/chat-page/chat-services/copilot-runtime/azure-blob-store"
    );
    const store = await getAgentWorkspaceStore();
    const leases = await getAgentWorkspaceLeases();
    const n = Number(process.env.LOAD_RESUMES ?? 20);
    const rows: Array<Record<string, number | string>> = [];
    await session.shutdownCopilotRuntime();
    await fakeConfig(fake.url, { tokens: 30, rate: 0 });
    try {
      for (const kind of kinds) {
        const hist = HISTORIES[kind]();
        const ids = Array.from({ length: n }, (_, i) => `${runId}-${kind}-${i}`);
        const created = await pool(4, n, (i) => turn({ userKey: "loadtest", threadId: ids[i], history: hist, store, leases }));
        const liveRes = await pool(1, n, (i) => turn({ userKey: "loadtest", threadId: ids[i], history: hist, store, leases }));
        await session.forgetLiveSessions();
        const resumed = await pool(1, n, (i) => turn({ userKey: "loadtest", threadId: ids[i], history: hist, store, leases }));
        // A burst: all evicted sessions resume at once (after a restart).
        await session.forgetLiveSessions();
        const t0 = performance.now();
        const burst = await Promise.all(ids.map((id) => turn({ userKey: "loadtest", threadId: id, history: hist, store, leases })));
        const burstWall = performance.now() - t0;
        const row = {
          kind,
          n,
          createP50Ms: Math.round(pct(created.map((r) => r.ms), 50)),
          liveTurnP50Ms: Math.round(pct(liveRes.map((r) => r.ms), 50)),
          liveTurnP95Ms: Math.round(pct(liveRes.map((r) => r.ms), 95)),
          resumedTurnP50Ms: Math.round(pct(resumed.map((r) => r.ms), 50)),
          resumedTurnP95Ms: Math.round(pct(resumed.map((r) => r.ms), 95)),
          burstOf: n,
          burstWallMs: Math.round(burstWall),
          burstTurnP95Ms: Math.round(pct(burst.map((r) => r.ms), 95)),
          modes: [...new Set(resumed.map((r) => r.mode))].join("/"),
          errors: [...created, ...liveRes, ...resumed, ...burst].filter((r) => r.error).length,
        };
        rows.push(row);
        console.log("RESUME", JSON.stringify(row));
        await session.forgetLiveSessions();
      }
    } finally {
      await session.shutdownCopilotRuntime();
      // Everything under loadtest/ (this run and leftovers of earlier ones).
      // A lease blob of a failed turn stays leased until its lease runs out
      // (at most 60 s): retry once after that.
      let names: string[] = [];
      let deleted = 0;
      for (let attempt = 0; attempt < 2; attempt++) {
        names = await store.listNames("loadtest/");
        if (names.length === 0) break;
        if (attempt > 0) await sleep(65_000);
        for (const name of names) if (await store.delete(name).catch(() => false)) deleted++;
      }
      const left = (await store.listNames("loadtest/")).length;
      console.log("RESUME-CLEANUP", JSON.stringify({ deleted, left }));
    }
    report.resume = rows;
  }

  const fakeStats = (await (await fetch(`${fake.url}/__stats`)).json()) as { requests: number; paths: Record<string, number> };
  report.fakeModel = { requests: fakeStats.requests, paths: fakeStats.paths };
  console.log(NL + "REPORT " + JSON.stringify(report, null, 1));
  await session.shutdownCopilotRuntime();
  fake.child.kill();
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error("LOAD FAILED", err instanceof Error ? err.stack : err);
    process.exit(1);
  },
);
