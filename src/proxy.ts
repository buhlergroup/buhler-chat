import { getToken } from "next-auth/jwt";
import { NextRequest, NextResponse } from "next/server";

// Areas that require an administrator session.
const requireAdmin: string[] = ["/reporting"];

// A Server Action is a POST with a "Next-Action" header to a PAGE path. Next
// dispatches it on any page whose bundle imports the action, and that includes
// the public pages below (/embed/* imports the whole chat UI). So the public
// path rules must not let a Server Action through: no action runs without a
// session, whatever path it is posted to.
const isServerAction = (request: NextRequest) =>
  request.headers.has("next-action");

// "/embed" and "/embed/..." only. A bare startsWith("/embed") would also make
// "/embedded" or "/embed-admin" public.
const isUnder = (pathname: string, prefix: string) =>
  pathname === prefix || pathname.startsWith(`${prefix}/`);

export async function proxy(request: NextRequest) {
  const res = NextResponse.next();
  const pathname = request.nextUrl.pathname;

  if (isServerAction(request) && !(await getToken({ req: request }))) {
    return new NextResponse("Unauthorized", { status: 401 });
  }

  // Public: NextAuth endpoints (needed to sign in) and the health probe.
  if (isUnder(pathname, "/api/auth") || pathname === "/health") {
    return res;
  }

  // /embed/* is public and gates itself. It shows a sign-in card and uses a
  // popup, because Microsoft Entra blocks sign-in inside iframes. It may be
  // framed by allow-listed ancestors. EMBED_ALLOWED_ANCESTORS is resolved here at
  // RUNTIME (proxy runs per request) so it can change via an env var without a
  // rebuild. next.config.js headers() are baked at build time. Defaults to 'self'
  // only; the embed feature is opt-in per deployment. No X-Frame-Options: it has
  // no allow-list semantics and CSP supersedes it.
  if (isUnder(pathname, "/embed")) {
    const frameAncestors = (
      process.env.EMBED_ALLOWED_ANCESTORS || "'self'"
    ).trim();
    res.headers.set(
      "Content-Security-Policy",
      `frame-ancestors ${frameAncestors};`,
    );
    return res;
  }

  // Root: send a logged-in user to /chat; otherwise show the login page.
  if (pathname === "/") {
    const token = await getToken({ req: request });
    if (token) {
      const url = new URL(`/chat`, request.url);
      return NextResponse.redirect(url);
    }
    return res;
  }

  // Default deny: every route that is not explicitly public above requires a
  // valid session. A previous version listed only some routes in the matcher,
  // which left /api/document and the /extensions Server Actions reachable
  // without a session.
  const token = await getToken({ req: request });
  if (!token) {
    // API callers get 401. Page requests go to the login page.
    if (pathname.startsWith("/api/")) {
      return new NextResponse("Unauthorized", { status: 401 });
    }
    const url = new URL(`/`, request.url);
    return NextResponse.redirect(url);
  }

  if (requireAdmin.some((path) => pathname.startsWith(path))) {
    if (!token.isAdmin) {
      const url = new URL(`/unauthorized`, request.url);
      return NextResponse.rewrite(url);
    }
  }

  return res;
}

// Default deny: run on every route except Next.js internals and static assets.
// Public routes are allowed inside proxy() above. Static files never carry a
// session and must load for the login page itself. /api/auth is matched here but
// allowed in proxy(), so sign-in keeps working.
//
// The file-extension rule skips ROOT-LEVEL files only (the files in public/,
// e.g. /ai-icon.png). It used to skip every path that ends in ".png", ".js",
// ..., and a dynamic segment takes any value: /chat/x.png rendered the chat
// page and ran its Server Actions, and /api/code-interpreter/file/x.png ran
// its handler, all without the proxy.
// scripts/check-unauthenticated-access.mjs probes these paths in CI.
export const config = {
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|logo.svg|robots.txt|sitemap.xml|manifest.webmanifest|[^/]+\\.(?:png|jpg|jpeg|gif|svg|ico|webp|avif|woff|woff2|ttf|eot|css|js|map)$).*)",
  ],
};
