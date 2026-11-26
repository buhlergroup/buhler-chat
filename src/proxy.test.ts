import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("next-auth/jwt", () => ({
  getToken: vi.fn(),
}));

import { getToken } from "next-auth/jwt";
import { proxy, config } from "./proxy";
import { readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative } from "node:path";

const mockedGetToken = getToken as ReturnType<typeof vi.fn>;

function makeRequest(path: string) {
  return new NextRequest(`http://localhost${path}`);
}

describe("proxy middleware", () => {
  beforeEach(() => {
    mockedGetToken.mockReset();
  });

  // middleware.unit.proxy.001 — logged-in user hitting `/` redirected to /chat
  it("001: logged-in user at / is redirected to /chat", async () => {
    mockedGetToken.mockResolvedValue({ isAdmin: false });
    const res = await proxy(makeRequest("/"));
    expect(res.status).toBeGreaterThanOrEqual(300);
    expect(res.status).toBeLessThan(400);
    expect(res.headers.get("location")).toMatch(/\/chat$/);
  });

  // middleware.unit.proxy.002 — anonymous user hitting /chat/x redirected to /
  it("002: anonymous user at /chat/x is redirected to /", async () => {
    mockedGetToken.mockResolvedValue(null);
    const res = await proxy(makeRequest("/chat/some-thread"));
    expect(res.status).toBeGreaterThanOrEqual(300);
    expect(res.status).toBeLessThan(400);
    expect(res.headers.get("location")).toMatch(/\/$|\/$/);
  });

  // middleware.unit.proxy.003 — authenticated non-admin hitting /reporting is rewritten to /unauthorized
  it("003: non-admin at /reporting is rewritten to /unauthorized", async () => {
    mockedGetToken.mockResolvedValue({ isAdmin: false });
    const res = await proxy(makeRequest("/reporting"));
    // NextResponse.rewrite keeps status 200 (internal rewrite)
    expect(res.headers.get("x-middleware-rewrite") ?? res.url).toMatch(/\/unauthorized/);
  });

  // middleware.unit.proxy.004 — authenticated admin hitting /reporting passes through
  it("004: admin at /reporting passes through (next())", async () => {
    mockedGetToken.mockResolvedValue({ isAdmin: true });
    const res = await proxy(makeRequest("/reporting"));
    // next() — no redirect, no rewrite to /unauthorized
    const location = res.headers.get("location");
    expect(location).toBeNull();
    const rewrite = res.headers.get("x-middleware-rewrite");
    expect(rewrite ?? "").not.toMatch(/\/unauthorized/);
  });

  // middleware.unit.proxy.005 — anonymous user hitting / passes through (no redirect)
  it("005: anonymous user at / is NOT redirected", async () => {
    mockedGetToken.mockResolvedValue(null);
    const res = await proxy(makeRequest("/"));
    // no redirect because token is null
    const location = res.headers.get("location");
    expect(location).toBeNull();
  });

  // middleware.unit.proxy.006 — authenticated user hitting /api/chat passes through
  it("006: authenticated user at /api/chat passes through", async () => {
    mockedGetToken.mockResolvedValue({ isAdmin: false });
    const res = await proxy(makeRequest("/api/chat"));
    const location = res.headers.get("location");
    expect(location).toBeNull();
  });

  // middleware.unit.proxy.007 — non-admin hitting /reporting/chat/abc is rewritten
  it("007: non-admin at /reporting/chat/abc is rewritten to /unauthorized", async () => {
    mockedGetToken.mockResolvedValue({ isAdmin: false });
    const res = await proxy(makeRequest("/reporting/chat/abc"));
    const rewrite = res.headers.get("x-middleware-rewrite") ?? res.url;
    expect(rewrite).toMatch(/\/unauthorized/);
  });

  // middleware.unit.proxy.008 — anonymous hitting /api/images gets 401
  it("008: anonymous at /api/images returns 401", async () => {
    mockedGetToken.mockResolvedValue(null);
    const res = await proxy(makeRequest("/api/images"));
    expect(res.status).toBe(401);
  });

  // middleware.unit.proxy.009 — /health passes through unauthenticated
  it("009: /health passes through when unauthenticated", async () => {
    mockedGetToken.mockResolvedValue(null);
    const res = await proxy(makeRequest("/health"));
    const location = res.headers.get("location");
    expect(location).toBeNull();
  });

  // middleware.unit.proxy.010 — /api/auth/... passes through unauthenticated
  // proxy() now explicitly allows /api/auth so sign-in works under the
  // catch-all matcher.
  it("010: /api/auth/callback/azure passes through (public)", async () => {
    mockedGetToken.mockResolvedValue(null);
    const res = await proxy(makeRequest("/api/auth/callback/azure"));
    expect(res.headers.get("location")).toBeNull();
    expect(res.status).not.toBe(401);
  });

  // middleware.unit.proxy.011 — anonymous hitting /persona/x redirects to /
  it("011: anonymous at /persona/abc redirects to /", async () => {
    mockedGetToken.mockResolvedValue(null);
    const res = await proxy(makeRequest("/persona/abc"));
    expect(res.status).toBeGreaterThanOrEqual(300);
    expect(res.status).toBeLessThan(400);
    expect(res.headers.get("location")).toMatch(/\/$/);
  });

  // middleware.unit.proxy.012 — anonymous /api/document (the SSRF route) returns 401
  it("012: anonymous at /api/document returns 401 (was previously unguarded)", async () => {
    mockedGetToken.mockResolvedValue(null);
    const res = await proxy(makeRequest("/api/document"));
    expect(res.status).toBe(401);
  });

  // middleware.unit.proxy.013 — anonymous /extensions (Server Actions) redirected to /
  it("013: anonymous at /extensions is redirected to / (Server Actions gated)", async () => {
    mockedGetToken.mockResolvedValue(null);
    const res = await proxy(makeRequest("/extensions"));
    expect(res.status).toBeGreaterThanOrEqual(300);
    expect(res.status).toBeLessThan(400);
    expect(res.headers.get("location")).toMatch(/\/$/);
  });

  // middleware.unit.proxy.014 — authenticated /api/document passes through
  it("014: authenticated at /api/document passes through", async () => {
    mockedGetToken.mockResolvedValue({ isAdmin: false });
    const res = await proxy(makeRequest("/api/document"));
    expect(res.headers.get("location")).toBeNull();
    expect(res.status).not.toBe(401);
  });
});

// ---------------------------------------------------------------------------
// Regression guards. The original vulnerability was that config.matcher listed
// only some routes, so the proxy never ran for /api/document or /extensions.
// Calling proxy() directly bypasses the matcher, so these tests check the
// matcher itself and the default-deny behaviour for unknown routes.
// ---------------------------------------------------------------------------

function matcherMatches(pathname: string): boolean {
  const patterns = config.matcher as string[];
  return patterns.some((p) => new RegExp(`^${p}$`).test(pathname));
}

describe("proxy - matcher covers every sensitive route", () => {
  it.each([
    "/api/document",
    "/extensions",
    "/api/chat",
    "/api/images",
    "/api/usage",
    "/api/models",
    "/api/code-interpreter/upload",
    "/chat/abc",
    "/agent/x",
    "/persona/x",
    "/prompt",
    "/reporting",
    "/a-brand-new-page",
    "/api/some-future-endpoint",
  ])("runs the proxy for %s", (path) => {
    expect(matcherMatches(path)).toBe(true);
  });

  it.each([
    "/_next/static/chunk.js",
    "/_next/image",
    "/favicon.ico",
    "/logo.svg",
    "/robots.txt",
    "/hero.png",
    "/app.css",
  ])("skips static asset %s", (path) => {
    expect(matcherMatches(path)).toBe(false);
  });
});

describe("proxy - default-deny for unknown/future routes", () => {
  beforeEach(() => {
    mockedGetToken.mockReset();
  });

  it("blocks an unknown API route with no session (401)", async () => {
    mockedGetToken.mockResolvedValue(null);
    const res = await proxy(makeRequest("/api/some-future-endpoint"));
    expect(res.status).toBe(401);
  });

  it("blocks an unknown page route with no session (redirect to /)", async () => {
    mockedGetToken.mockResolvedValue(null);
    const res = await proxy(makeRequest("/a-brand-new-page"));
    expect(res.status).toBeGreaterThanOrEqual(300);
    expect(res.status).toBeLessThan(400);
    expect(res.headers.get("location")).toMatch(/\/$/);
  });
});

// ---------------------------------------------------------------------------
// Endpoint enumeration guard. Walks src/app for every route.ts and page.tsx,
// derives the URL, and asserts the matcher runs the proxy for it and that every
// non-public endpoint requires a session. A new endpoint is covered
// automatically. If the matcher ever stops covering one, or a route is added
// under a public prefix by mistake, this fails.
// ---------------------------------------------------------------------------

const APP_DIR = join(dirname(fileURLToPath(import.meta.url)), "app");

function collectEndpointFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...collectEndpointFiles(full));
    } else if (/^(route|page)\.(ts|tsx)$/.test(entry)) {
      out.push(full);
    }
  }
  return out;
}

function toUrlPath(file: string): string {
  const rel = relative(APP_DIR, file)
    .replace(/\\/g, "/")
    .replace(/\/(route|page)\.(ts|tsx)$/, "");
  const segments = rel
    .split("/")
    .filter(Boolean)
    .filter((seg) => !(seg.startsWith("(") && seg.endsWith(")")))
    .map((seg) => (seg.startsWith("[") ? "x" : seg));
  return "/" + segments.join("/");
}

const isApiRoute = (file: string) => /[/\\]route\.(ts|tsx)$/.test(file);
const isPublicUrl = (p: string) =>
  p === "/" ||
  p === "/health" ||
  p.startsWith("/api/auth") ||
  p === "/embed" ||
  p.startsWith("/embed/");

const discoveredEndpoints = collectEndpointFiles(APP_DIR).map((file) => ({
  file,
  url: toUrlPath(file),
  api: isApiRoute(file),
}));

describe("proxy - every app endpoint is covered by the matcher", () => {
  it("discovers a non-trivial number of endpoints", () => {
    expect(discoveredEndpoints.length).toBeGreaterThan(5);
  });

  it.each(discoveredEndpoints.map((e) => [e.url, e.file] as const))(
    "matcher runs the proxy for %s",
    (url) => {
      expect(matcherMatches(url)).toBe(true);
    }
  );
});

describe("proxy - every non-public endpoint requires a session", () => {
  beforeEach(() => {
    mockedGetToken.mockReset();
  });

  const protectedApi = discoveredEndpoints.filter(
    (e) => e.api && !isPublicUrl(e.url)
  );
  it.each(protectedApi.map((e) => [e.url] as const))(
    "unauthenticated API %s returns 401",
    async (url) => {
      mockedGetToken.mockResolvedValue(null);
      const res = await proxy(makeRequest(url));
      expect(res.status).toBe(401);
    }
  );

  const protectedPages = discoveredEndpoints.filter(
    (e) => !e.api && !isPublicUrl(e.url)
  );
  it.each(protectedPages.map((e) => [e.url] as const))(
    "unauthenticated page %s redirects to login",
    async (url) => {
      mockedGetToken.mockResolvedValue(null);
      const res = await proxy(makeRequest(url));
      expect(res.status).toBeGreaterThanOrEqual(300);
      expect(res.status).toBeLessThan(400);
      expect(res.headers.get("location")).toMatch(/\/$/);
    }
  );
});

// ---------------------------------------------------------------------------
// Server Actions and public prefixes. A Server Action is a POST with a
// "Next-Action" header to a page path; Next dispatches it on any page that
// imports the action, including the public /embed/* pages. Probed with
// scripts/check-unauthenticated-access.mjs against a production build.
// ---------------------------------------------------------------------------

function makeActionRequest(path: string) {
  return new NextRequest(`http://localhost${path}`, {
    method: "POST",
    headers: { "next-action": "0123456789abcdef", "content-type": "text/plain;charset=UTF-8" },
    body: "[]",
  });
}

describe("proxy - Server Actions need a session on every path", () => {
  beforeEach(() => {
    mockedGetToken.mockReset();
  });

  it.each(["/", "/embed/chat/abc", "/embed/agent/abc", "/embed/auth/start", "/health", "/api/auth/session", "/chat/abc"])(
    "anonymous Server Action POST to %s returns 401",
    async (path) => {
      mockedGetToken.mockResolvedValue(null);
      const res = await proxy(makeActionRequest(path));
      expect(res.status).toBe(401);
    }
  );

  it("a signed-in Server Action POST to /embed/chat/abc passes through", async () => {
    mockedGetToken.mockResolvedValue({ isAdmin: false });
    const res = await proxy(makeActionRequest("/embed/chat/abc"));
    expect(res.status).not.toBe(401);
    expect(res.headers.get("location")).toBeNull();
  });

  it("a plain anonymous GET of /embed/chat/abc stays public (sign-in card)", async () => {
    mockedGetToken.mockResolvedValue(null);
    const res = await proxy(makeRequest("/embed/chat/abc"));
    expect(res.status).not.toBe(401);
    expect(res.headers.get("location")).toBeNull();
  });
});

describe("proxy - public prefixes match whole segments only", () => {
  beforeEach(() => {
    mockedGetToken.mockReset();
  });

  it.each(["/embedded", "/embed-admin/x"])("anonymous %s is redirected to /", async (path) => {
    mockedGetToken.mockResolvedValue(null);
    const res = await proxy(makeRequest(path));
    expect(res.status).toBeGreaterThanOrEqual(300);
    expect(res.status).toBeLessThan(400);
    expect(res.headers.get("location")).toMatch(/\/$/);
  });

  it("anonymous /api/authx returns 401", async () => {
    mockedGetToken.mockResolvedValue(null);
    const res = await proxy(makeRequest("/api/authx"));
    expect(res.status).toBe(401);
  });
});

describe("proxy - matcher skips root-level static files only", () => {
  it.each([
    "/chat/x.png",
    "/chat/x.js",
    "/chat/x.css",
    "/embed/chat/x.png",
    "/api/code-interpreter/file/x.png",
    "/persona/x.svg/chat",
  ])("runs the proxy for %s (dynamic segment that looks like a file)", (path) => {
    expect(matcherMatches(path)).toBe(true);
  });

  it.each(["/ai-icon.png", "/user-icon.png", "/hero.png", "/app.css"])(
    "skips root-level static file %s",
    (path) => {
      expect(matcherMatches(path)).toBe(false);
    }
  );
});
