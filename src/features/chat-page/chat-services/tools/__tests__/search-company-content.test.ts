// @vitest-environment node
import { describe, it, expect, vi } from "vitest";

const logs = vi.hoisted(() => ({
  logInfo: vi.fn(),
  logDebug: vi.fn(),
  logError: vi.fn(),
  logWarn: vi.fn(),
}));
vi.mock("@/features/common/services/logger", () => logs);

const TOKEN = "eyJ0eXAiOiJKV1QiLCJhbGciOi.secret-part";
vi.mock("@/features/auth-page/helpers", () => ({
  getCurrentUser: vi.fn(async () => ({ token: TOKEN, email: "user@example.com" })),
}));

import { searchCompanyContentTool } from "../search-company-content";

describe("searchCompanyContentTool — logging", () => {
  it("never logs any part of the access token", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ retrievalHits: [] }), { status: 200 }))
    );
    const t = searchCompanyContentTool({ threadId: "t1" } as never);
    await (t as any).execute({ query: "policy" }, { abortSignal: undefined });

    const logged = JSON.stringify(
      [logs.logInfo, logs.logDebug, logs.logError, logs.logWarn].flatMap((fn) => fn.mock.calls)
    );
    expect(logged).not.toContain(TOKEN.substring(0, 10));
    expect(logged).not.toContain("tokenPrefix");
  });
});
