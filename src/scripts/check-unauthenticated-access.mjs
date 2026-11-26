#!/usr/bin/env node
// Probes a production build WITHOUT a session and fails if an endpoint answers
// with data or runs code that needs a signed-in user.
//
// Run after `next build`:  npm run check:unauth
//
// What it does:
//   1. Reads the build output: build/server/app-paths-manifest.json (every page
//      and route handler) and build/server/server-reference-manifest.json
//      (every Server Action id and the pages that can dispatch it).
//   2. Starts `next start` on PORT (default 3200) with the in-memory test
//      backend (AZURECHAT_TEST_BACKEND=memory), so no external service is
//      called. It refuses to start when a .env file is present, because Next
//      would load real service settings from it.
//   3. Seeds one chat thread as a signed-in test user (JWT made with the test
//      NEXTAUTH_SECRET) and uses its id for every [id] segment.
//   4. Without a session (no cookie, a garbage cookie, a JWT signed with the
//      wrong secret) it sends:
//        - every HTTP method to every route handler,
//        - GET (plain, RSC, prefetch) to every page,
//        - a POST with `Next-Action: <id>` for every Server Action id, to each
//          page that can dispatch it and to the public pages (forwarding),
//        - path and header tricks against the proxy matcher.
//   5. Checks that the seeded thread still exists (no action deleted it).
//
// A probe FAILS when the response is 2xx (unless the endpoint is in PUBLIC
// below), when it is 5xx (code ran without a session and crashed), or when the
// body contains the seeded user's id or e-mail. 3xx (redirect to sign-in or a
// URL normalisation) and 401/403/404/405 count as rejected.
//
// Usage:
//   node scripts/check-unauthenticated-access.mjs [--build build] [--port 3200]
//        [--base-url http://localhost:3200] [--json report.json] [--verbose]
// With --base-url the script uses a server that is already running (it must
// run with the same env as below) and does not start one.

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import http from "node:http";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// ---------------------------------------------------------------------------
// Arguments
// ---------------------------------------------------------------------------
const args = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const verbose = args.includes("--verbose");
const buildDir = path.resolve(appDir, arg("build", "build"));
const port = Number(arg("port", process.env.CHECK_UNAUTH_PORT ?? "3200"));
const externalBaseUrl = arg("base-url", null);
const baseUrl = externalBaseUrl ?? `http://localhost:${port}`;
const jsonReport = arg("json", null);
const target = new URL(baseUrl);

const SECRET = "check-unauth-secret-not-for-production";
const OWNER_EMAIL = "owner@unauth-check.invalid";
const OWNER_ID = createHash("sha256").update(OWNER_EMAIL).digest("hex");

// ---------------------------------------------------------------------------
// Endpoints that are PUBLIC on purpose. Each entry: the URL path it covers,
// why it is public, and (optional) a body check that must hold for a 2xx.
// Keep this list short. Everything else must reject a request without a
// session.
// ---------------------------------------------------------------------------
const PUBLIC = [
  {
    match: (p) => p === "/",
    why: "Login page. Shows the sign-in buttons only.",
  },
  {
    match: (p) => p === "/health",
    why: "Liveness probe for the hosting platform. Static {status:ok}.",
    body: (b) => b === "" || /^\{"status":"ok"\}$/.test(b),
  },
  {
    match: (p) => p === "/favicon.ico",
    why: "Static icon.",
  },
  {
    match: (p) => p === "/embed/auth/start" || p === "/embed/auth/complete",
    why: "Client-only sign-in popup for the embed view. No server data.",
  },
  {
    match: (p) => /^\/embed\/(chat|agent)\//.test(p),
    why: "Embed pages render a sign-in card when userSession() is null (checked in the page).",
  },
  {
    match: (p) => p === "/api/auth/session",
    why: "NextAuth session endpoint. Without a session it must return an empty object.",
    body: (b) => b === "" || b === "{}" || b === "null",
  },
  {
    match: (p) => p.startsWith("/api/auth/"),
    why: "NextAuth sign-in flow (provider list, CSRF token, sign-in/out pages, OAuth callback).",
  },
];

const publicEntry = (pathname) => PUBLIC.find((e) => e.match(pathname));

// ---------------------------------------------------------------------------
// Build output
// ---------------------------------------------------------------------------
const serverDir = path.join(buildDir, "server");
const appPathsPath = path.join(serverDir, "app-paths-manifest.json");
const actionsPath = path.join(serverDir, "server-reference-manifest.json");
for (const p of [appPathsPath, actionsPath, path.join(buildDir, "BUILD_ID")]) {
  if (!existsSync(p)) {
    console.error(`check-unauth: ${p} not found. Run "next build" first.`);
    process.exit(1);
  }
}
const appPaths = Object.keys(require(appPathsPath));
const actionManifest = require(actionsPath).node ?? {};
const buildId = readFileSync(path.join(buildDir, "BUILD_ID"), "utf8").trim();

let threadId = "probe-thread";
const PARAM_VALUES = { personaId: "probe-persona", fileId: "probe-file" };

// "/(authenticated)/chat/[id]/page" -> "/chat/<threadId>"
const toUrl = (entry) => {
  const segs = entry
    .replace(/^app\//, "/")
    .replace(/\/(page|route)$/, "")
    .split("/")
    .filter(Boolean)
    .filter((s) => !(s.startsWith("(") && s.endsWith(")")))
    .map((s) => {
      const m = /^\[(?:\.\.\.)?(.+)\]$/.exec(s);
      if (!m) return s;
      return m[1] === "id" ? threadId : PARAM_VALUES[m[1]] ?? `probe-${m[1]}`;
    });
  return "/" + segs.join("/");
};
const isInternal = (entry) => /\/_(not-found|global-error)\//.test(entry);

// ---------------------------------------------------------------------------
// HTTP. node:http keeps the raw path (no URL normalisation), which the path
// tricks need.
// ---------------------------------------------------------------------------
const request = (method, rawPath, { headers = {}, body } = {}) =>
  new Promise((resolve) => {
    const req = http.request(
      {
        host: target.hostname,
        port: target.port,
        method,
        path: rawPath,
        headers: { ...headers, ...(body ? { "content-length": Buffer.byteLength(body) } : {}) },
      },
      (res) => {
        const chunks = [];
        let size = 0;
        res.on("data", (c) => {
          if (size < 256 * 1024) chunks.push(c);
          size += c.length;
        });
        res.on("end", () =>
          resolve({
            status: res.statusCode ?? 0,
            location: res.headers.location ?? "",
            body: Buffer.concat(chunks).toString("utf8"),
          })
        );
      }
    );
    req.setTimeout(30_000, () => req.destroy(new Error("timeout")));
    req.on("error", (e) => resolve({ status: 0, location: "", body: "", error: e.message }));
    if (body) req.write(body);
    req.end();
  });

const ownerCookie = async () => {
  const { encode } = await import("next-auth/jwt");
  const now = Math.floor(Date.now() / 1000);
  const token = await encode({
    token: { name: "Owner", email: OWNER_EMAIL, sub: OWNER_EMAIL, isAdmin: false, iat: now, exp: now + 3600 },
    secret: SECRET,
  });
  return `next-auth.session-token=${token}`;
};

const wrongSecretCookie = async () => {
  const { encode } = await import("next-auth/jwt");
  const now = Math.floor(Date.now() / 1000);
  const token = await encode({
    token: { name: "Mallory", email: OWNER_EMAIL, sub: OWNER_EMAIL, isAdmin: true, iat: now, exp: now + 3600 },
    secret: "not-the-server-secret",
  });
  return `next-auth.session-token=${token}`;
};

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------
const serverEnv = () => ({
  ...process.env,
  NODE_ENV: "production",
  PORT: String(port),
  NEXTAUTH_SECRET: SECRET,
  NEXTAUTH_URL: baseUrl,
  AZURECHAT_TEST_BACKEND: "memory",
  AZURECHAT_E2E_ALLOW_FAKES: "1",
  AZURECHAT_TELEMETRY: "0",
  NEXT_TELEMETRY_DISABLED: "1",
  AZURE_COSMOSDB_URI: "https://cosmos.test.local",
  AZURE_COSMOSDB_KEY: "test-key",
  AZURE_COSMOSDB_DB_NAME: "chat",
  AZURE_COSMOSDB_CONTAINER_NAME: "history",
  AZURE_COSMOSDB_CONFIG_CONTAINER_NAME: "config",
  AZURE_OPENAI_API_KEY: "test-openai-key",
  AZURE_OPENAI_API_INSTANCE_NAME: "test-instance",
  AZURE_OPENAI_API_DEPLOYMENT_NAME: "gpt-test",
  AZURE_OPENAI_API_VERSION: "2024-10-21",
  AZURE_SEARCH_API_KEY: "test-search-key",
  AZURE_SEARCH_NAME: "test-search",
  AZURE_SEARCH_INDEX_NAME: "test-index",
  AZURE_KEY_VAULT_NAME: "test-kv",
  AZURE_STORAGE_ACCOUNT_NAME: "teststorage",
  AZURE_STORAGE_ACCOUNT_KEY: "test-storage-key",
  ADMIN_EMAIL_ADDRESS: "admin@unauth-check.invalid",
});

const startServer = async () => {
  const envFiles = [".env", ".env.local", ".env.production", ".env.production.local"].filter((f) =>
    existsSync(path.join(appDir, f))
  );
  if (envFiles.length > 0) {
    console.error(
      `check-unauth: refusing to start a server: ${envFiles.join(", ")} present in ${appDir}. ` +
        "Next would load real service settings from it. Move it away or pass --base-url."
    );
    process.exit(1);
  }
  const nextBin = require.resolve("next/dist/bin/next");
  const child = spawn(process.execPath, [nextBin, "start", "-p", String(port)], {
    cwd: appDir,
    env: serverEnv(),
    stdio: ["ignore", "pipe", "pipe"],
  });
  let log = "";
  child.stdout.on("data", (d) => (log += d));
  child.stderr.on("data", (d) => (log += d));
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) break;
    const r = await request("GET", "/health");
    if (r.status === 200) return { child, log: () => log };
    await new Promise((r) => setTimeout(r, 500));
  }
  console.error("check-unauth: server did not become ready.\n" + log.slice(-4000));
  child.kill("SIGTERM");
  process.exit(1);
};

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------
const results = [];
const failures = [];

const leaks = (body) => body.includes(OWNER_ID) || body.includes(OWNER_EMAIL);

const pathOf = (rawPath) => {
  try {
    return new URL(rawPath, baseUrl).pathname;
  } catch {
    return rawPath;
  }
};

const record = (kind, method, rawPath, variant, res, extra = {}) => {
  const pathname = pathOf(rawPath);
  const pub = extra.publicCheck === false ? undefined : publicEntry(pathname);
  let verdict = "rejected";
  let reason = "";
  if (res.status === 0) {
    verdict = "FAIL";
    reason = `no response (${res.error})`;
  } else if (leaks(res.body)) {
    verdict = "FAIL";
    reason = "body contains the seeded user's id or e-mail";
  } else if (res.status >= 500 && extra.allow5xx) {
    reason = extra.allow5xx;
  } else if (res.status >= 500) {
    verdict = "FAIL";
    reason = `HTTP ${res.status}: code ran without a session`;
  } else if (res.status >= 200 && res.status < 300) {
    if (pub && (!pub.body || pub.body(res.body.trim()))) {
      verdict = "public";
      reason = pub.why;
    } else if (pub) {
      verdict = "FAIL";
      reason = `public endpoint returned unexpected data: ${res.body.slice(0, 120)}`;
    } else {
      verdict = "FAIL";
      reason = `HTTP ${res.status} without a session`;
    }
  }
  const row = { kind, method, path: rawPath, variant, status: res.status, location: res.location, verdict, reason, ...extra.info };
  if (verdict !== "rejected") row.body = res.body.slice(0, 400);
  results.push(row);
  if (verdict === "FAIL") failures.push(row);
  if (verbose || verdict === "FAIL") {
    console.log(
      `${verdict.padEnd(8)} ${kind.padEnd(6)} ${method.padEnd(7)} ${String(res.status).padEnd(4)} ${rawPath} [${variant}]` +
        `${res.location ? ` -> ${res.location}` : ""}${reason ? `  (${reason})` : ""}${extra.info?.action ? `  ${extra.info.action}` : ""}`
    );
  }
};

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
const started = Date.now();
const server = externalBaseUrl ? null : await startServer();
const stop = () => server?.child.kill("SIGTERM");
process.on("exit", stop);

try {
  // Seed one thread owned by the test user.
  const owner = await ownerCookie();
  const seeded = await request("POST", "/api/test/new-thread", { headers: { cookie: owner } });
  if (seeded.status !== 200) {
    throw new Error(
      `seeding failed: POST /api/test/new-thread returned ${seeded.status}. ` +
        "The server must run with AZURECHAT_TEST_BACKEND=memory and AZURECHAT_E2E_ALLOW_FAKES=1."
    );
  }
  threadId = JSON.parse(seeded.body).id;
  const ownerThreadStatus = async () =>
    (
      await request("POST", `/api/chat/${threadId}/stop`, {
        headers: { cookie: owner, origin: baseUrl, "content-type": "application/json" },
        body: "{}",
      })
    ).status;
  const before = await ownerThreadStatus();
  if (before !== 200) throw new Error(`owner cannot reach the seeded thread (stop -> ${before})`);

  const variants = {
    "no-cookie": {},
    "garbage-cookie": { cookie: "next-auth.session-token=garbage; __Secure-next-auth.session-token=garbage" },
    "wrong-secret-jwt": { cookie: await wrongSecretCookie() },
  };

  // 1. Route handlers: every method, every session variant.
  const METHODS = ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"];
  const routes = appPaths.filter((e) => e.endsWith("/route") && !isInternal(e));
  const routeUrls = new Set();
  for (const entry of routes) {
    if (entry.includes("[...nextauth]")) {
      for (const sub of ["session", "providers", "csrf", "signin", "signout", "callback/azure-ad", "error", "unknown"]) {
        routeUrls.add(`/api/auth/${sub}`);
      }
    } else {
      routeUrls.add(toUrl(entry));
    }
  }
  for (const url of routeUrls) {
    for (const method of METHODS) {
      for (const [variant, headers] of Object.entries(variants)) {
        const hasBody = !["GET", "HEAD", "OPTIONS"].includes(method);
        const res = await request(method, url, {
          headers: { ...headers, origin: baseUrl, ...(hasBody ? { "content-type": "application/json" } : {}) },
          body: hasBody ? JSON.stringify({ id: threadId, threadId }) : undefined,
        });
        record("route", method, url, variant, res);
      }
    }
  }

  // 2. Pages: plain GET, RSC GET, prefetch, HEAD.
  const pages = appPaths.filter((e) => e.endsWith("/page") && !isInternal(e));
  const pageUrls = [...new Set(pages.map(toUrl))];
  for (const url of pageUrls) {
    for (const [variant, headers] of Object.entries(variants)) {
      record("page", "GET", url, variant, await request("GET", url, { headers }));
    }
    record("page", "GET", url, "rsc", await request("GET", url, { headers: { rsc: "1" } }));
    record("page", "GET", url, "rsc-prefetch", await request("GET", url, { headers: { rsc: "1", "next-router-prefetch": "1" } }));
    record("page", "GET", `${url}?_rsc=probe`, "rsc-query", await request("GET", `${url}?_rsc=probe`, { headers: { rsc: "1" } }));
    record("page", "HEAD", url, "no-cookie", await request("HEAD", url));
  }

  // 3. Server Actions: POST with Next-Action to every page that can dispatch
  // the action, and to two public pages (forwarding / no forwarding). The body
  // is an argument list with the seeded thread id, so an action that takes an
  // id (delete, rename, ...) would act on real data.
  const actionBody = JSON.stringify([threadId]);
  const actionHeaders = (id, extra = {}) => ({
    "next-action": id,
    accept: "text/x-component",
    "content-type": "text/plain;charset=UTF-8",
    origin: baseUrl,
    ...extra,
  });
  const actionIds = Object.keys(actionManifest);
  let actionProbes = 0;
  for (const id of actionIds) {
    const entry = actionManifest[id];
    const info = { action: `${entry.exportedName ?? "?"} (${entry.filename ?? "?"})` };
    const pageWorkers = Object.keys(entry.workers ?? {}).filter((w) => w.endsWith("/page"));
    const targets = new Set(pageWorkers.filter((w) => !isInternal(w)).map(toUrl));
    targets.add("/");
    targets.add("/embed/auth/start");
    let first = true;
    for (const url of targets) {
      const res = await request("POST", url, { headers: actionHeaders(id), body: actionBody });
      record("action", "POST", url, "no-cookie", res, { publicCheck: false, info });
      actionProbes++;
      if (first) {
        first = false;
        for (const v of ["garbage-cookie", "wrong-secret-jwt"]) {
          const r = await request("POST", url, { headers: actionHeaders(id, variants[v]), body: actionBody });
          record("action", "POST", url, v, r, { publicCheck: false, info });
          actionProbes++;
        }
      }
    }
    // Skip the forwarding step: run the action in the receiving worker only.
    const r = await request("POST", "/embed/auth/start", {
      headers: actionHeaders(id, { "x-action-forwarded": "1" }),
      body: actionBody,
    });
    record("action", "POST", "/embed/auth/start", "x-action-forwarded", r, { publicCheck: false, info });
    actionProbes++;
  }

  // 4. Path and header tricks against the proxy matcher and public prefixes.
  const chatAction = actionIds.find((id) =>
    Object.keys(actionManifest[id].workers ?? {}).some((w) => w.includes("/chat/[id]/page"))
  );
  const tricks = [
    ["GET", "/api/usage/"],
    ["GET", "/api//usage"],
    ["GET", "//api/usage"],
    ["GET", "/api%2Fusage"],
    ["GET", "/api/usage%2F"],
    ["GET", "/API/usage"],
    ["GET", "/api/Usage"],
    ["GET", "/api/usage.json"],
    ["GET", "/api/usage?_rsc=probe"],
    ["GET", "/api/usage;.png"],
    ["GET", "/api/usage%3B.png"],
    ["GET", "/embed/%2e%2e/api/usage"],
    ["GET", "/embed/..%2Fapi/usage"],
    ["GET", "/embed%2F..%2Fapi%2Fusage"],
    ["GET", "/embedx/../api/usage"],
    ["GET", "/api/auth/%2e%2e/usage"],
    ["GET", "/api/auth/..%2Fusage"],
    ["GET", "/health/..%2Fapi/usage"],
    ["GET", "/_next/static/..%2F..%2Fapi/usage"],
    ["GET", "/_next/static/%2e%2e/%2e%2e/api/usage"],
    ["GET", `/_next/data/${buildId}/chat.json`],
    ["GET", "/_next/image?url=%2Fapi%2Fusage&w=64&q=75"],
    ["GET", `/_next/image?url=%2Fchat%2F${threadId}&w=64&q=75`, "image optimizer: the internal fetch is not an image"],
    ["GET", "/chat/probe.png"],
    ["GET", "/chat/probe.css"],
    ["GET", "/chat/probe.js"],
    ["GET", `/chat/${threadId}.json`],
    ["GET", "/persona/probe.png/chat"],
    ["GET", "/api/code-interpreter/file/probe.png"],
    ["DELETE", "/api/code-interpreter/file/probe.png"],
    ["HEAD", "/chat"],
    ["OPTIONS", "/chat"],
    ["OPTIONS", "/api/usage"],
    ["TRACE", "/api/usage", "the runtime refuses TRACE before any route code runs"],
  ];
  // The third element allows a 5xx for a request that never reaches app code.
  for (const [method, p, allow5xx] of tricks) {
    record("trick", method, p, "no-cookie", await request(method, p, { headers: { origin: baseUrl } }), { allow5xx });
  }
  // CVE-2025-29927 style header that used to skip middleware.
  for (const value of [
    "middleware:middleware:middleware:middleware:middleware",
    "proxy:proxy:proxy:proxy:proxy",
    "src/middleware:src/middleware:src/middleware:src/middleware:src/middleware",
    "src/proxy:src/proxy:src/proxy:src/proxy:src/proxy",
  ]) {
    record("trick", "GET", "/api/usage", `x-middleware-subrequest=${value.split(":")[0]}`,
      await request("GET", "/api/usage", { headers: { "x-middleware-subrequest": value } }));
  }
  // Server Actions on paths the matcher skips as static assets.
  if (chatAction) {
    for (const p of ["/chat/probe.png", "/chat/probe.js", `/chat/${threadId}.css`, "/embed/chat/probe.png"]) {
      record("trick", "POST", p, "next-action", await request("POST", p, { headers: actionHeaders(chatAction), body: actionBody }), {
        publicCheck: false,
        info: { action: actionManifest[chatAction].exportedName },
      });
    }
  }

  // 5. No side effect: the owner still sees the seeded thread.
  const after = await ownerThreadStatus();
  if (after !== 200) {
    const row = { kind: "state", method: "-", path: `/api/chat/${threadId}/stop`, variant: "owner", status: after, verdict: "FAIL", reason: "seeded thread is gone after the unauthenticated probes" };
    results.push(row);
    failures.push(row);
    console.log(`FAIL     state  seeded thread no longer reachable for its owner (stop -> ${after})`);
  }

  const counts = results.reduce((acc, r) => ((acc[r.verdict] = (acc[r.verdict] ?? 0) + 1), acc), {});
  const secs = ((Date.now() - started) / 1000).toFixed(1);
  console.log(
    `check-unauth: ${routeUrls.size} route URLs, ${pageUrls.length} pages, ${actionIds.length} action ids ` +
      `(${actionProbes} action probes), ${results.length} requests in ${secs}s: ` +
      `${counts.rejected ?? 0} rejected, ${counts.public ?? 0} public, ${counts.FAIL ?? 0} failed`
  );
  if (jsonReport) writeFileSync(jsonReport, JSON.stringify({ threadId, results }, null, 2));
} catch (e) {
  console.error(`check-unauth: ${e instanceof Error ? e.message : String(e)}`);
  if (server) console.error(server.log().slice(-4000));
  stop();
  process.exit(1);
}

stop();
if (failures.length > 0) {
  console.error(
    `check-unauth: ${failures.length} request(s) were not rejected without a session. ` +
      "Add a session check (proxy.ts or the handler/action), or, if the endpoint is public on purpose, " +
      "add it to PUBLIC in scripts/check-unauthenticated-access.mjs with the reason."
  );
  process.exit(1);
}
process.exit(0);
