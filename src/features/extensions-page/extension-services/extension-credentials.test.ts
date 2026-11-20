// @vitest-environment node
import { describe, it, expect } from "vitest";
import { extensionCredentialInfo, hostOf, mcpSignInNotice, usesStoredSecrets } from "./extension-credentials";
import type { ExtensionModel } from "./models";

const MASK = "**********";

const http = (over: Partial<ExtensionModel> = {}): ExtensionModel =>
  ({
    id: "h1",
    name: "n",
    description: "d",
    executionSteps: "s",
    headers: [],
    functions: [],
    userId: "owner",
    isPublished: true,
    createdAt: new Date(),
    type: "EXTENSION",
    ...over,
  }) as ExtensionModel;

const mcp = (over: Partial<NonNullable<ExtensionModel["mcp"]>> = {}, ext: Partial<ExtensionModel> = {}) =>
  http({
    id: "m1",
    kind: "mcp",
    mcp: {
      url: "https://mcp.example.test:8443/mcp?x=1",
      transport: "auto",
      secrets: [],
      toolAllowList: [],
      auth: "none",
      ...over,
    },
    ...ext,
  });

// Pinned: the notices for shared credentials (agent editor and chat) and for
// a sign-in to an extension somebody else set up.
describe("usesStoredSecrets", () => {
  it("is true for an HTTP extension with headers and an MCP extension with header rows", () => {
    expect(usesStoredSecrets(http({ headers: [{ id: "x", key: "X-Api-Key", value: MASK }] }))).toBe(true);
    expect(
      usesStoredSecrets(mcp({ secrets: [{ id: "s", name: "X-Api-Key", target: "X-Api-Key", placement: "header", value: MASK }] }))
    ).toBe(true);
  });

  it("is false without stored values, also for a per-user OAuth sign-in", () => {
    expect(usesStoredSecrets(http())).toBe(false);
    expect(usesStoredSecrets(mcp({ auth: "oauth", oauth: { clientId: "cid" } }))).toBe(false);
  });
});

describe("extensionCredentialInfo", () => {
  it("returns booleans only, never a header name or value", () => {
    const extension = http({ headers: [{ id: "kv-id", key: "X-Secret-Name", value: MASK }] });
    const info = extensionCredentialInfo(extension, "someone-else");
    expect(info).toEqual({ id: "h1", usesStoredSecrets: true, ownedByYou: false });
    expect(JSON.stringify(info)).not.toMatch(/X-Secret-Name|kv-id|\*\*\*/);
    expect(extensionCredentialInfo(extension, "owner").ownedByYou).toBe(true);
  });
});

describe("mcpSignInNotice", () => {
  const authUrl = new URL("https://login.example.test/oauth2/authorize?client_id=c&state=s");

  it("names the sign-in host and the MCP server host for a user who does not own the extension", () => {
    expect(mcpSignInNotice(mcp({ auth: "oauth" }), authUrl, "user-b")).toEqual({
      signInHost: "login.example.test",
      serverHost: "mcp.example.test:8443",
    });
  });

  it("has no notice for the owner", () => {
    expect(mcpSignInNotice(mcp({ auth: "oauth" }), authUrl, "owner")).toBeUndefined();
  });

  it("hostOf drops path and query", () => {
    expect(hostOf("https://a.example.test/p?q=secret")).toBe("a.example.test");
    expect(hostOf("not a url")).toBeUndefined();
  });
});
