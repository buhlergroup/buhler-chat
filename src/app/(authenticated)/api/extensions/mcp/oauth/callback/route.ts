/**
 * OAuth redirect target for Remote MCP extensions (per-user sign-in).
 * The checks live in completeMcpOAuthCallback (mcp-oauth-callback.ts):
 * state of THIS user, ten-minute limit, issuer (RFC 9207), access rule. The browser only gets a
 * redirect back to a same-origin path.
 */

import { userHashedId } from "@/features/auth-page/helpers";
import { logWarn } from "@/features/common/services/logger";
import { completeMcpOAuthCallback } from "@/features/extensions-page/extension-services/mcp/mcp-oauth-callback";
import { safeReturnPath } from "@/features/extensions-page/extension-services/mcp/mcp-oauth";

const redirectBack = (req: Request, result: "connected" | "failed", returnTo?: string) => {
  const url = new URL(safeReturnPath(returnTo) ?? "/extensions", process.env.NEXTAUTH_URL ?? req.url);
  url.searchParams.set("mcp", result);
  return Response.redirect(url.toString(), 303);
};

export async function GET(req: Request) {
  const params = new URL(req.url).searchParams;
  if (params.get("error")) {
    logWarn("MCP OAuth callback: provider error", { providerError: params.get("error") ?? undefined });
    return redirectBack(req, "failed");
  }
  try {
    const result = await completeMcpOAuthCallback({
      code: params.get("code"),
      state: params.get("state") ?? "",
      iss: params.get("iss"),
      userId: await userHashedId(),
    });
    return redirectBack(req, result.ok ? "connected" : "failed", result.returnTo);
  } catch (error) {
    logWarn("MCP OAuth callback failed", { errorName: (error as { name?: string })?.name });
    return redirectBack(req, "failed");
  }
}
