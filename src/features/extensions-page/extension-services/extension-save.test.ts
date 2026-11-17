import { describe, it, expect } from "vitest";
import { extensionSecretNames, planHeaders, planMcpConfig } from "./extension-save";
import type { McpConfigModel } from "./models";

const MASK = "**********";
let n = 0;
const newId = () => `new${++n}`;

const baseMcp = (over: Partial<McpConfigModel> = {}): McpConfigModel => ({
  url: "https://mcp.example.com/mcp",
  transport: "auto",
  secrets: [],
  toolAllowList: [],
  auth: "none",
  ...over,
});

describe("planHeaders", () => {
  it("refuses a masked value for a header id the stored extension does not own", () => {
    // An attacker sends another extension's Key Vault id with the mask.
    const { headers, plan } = planHeaders(
      [{ id: "victim-secret-id", key: "x", value: MASK }],
      [{ id: "own-id", key: "y", value: MASK }],
      newId
    );
    expect(headers[0].id).not.toBe("victim-secret-id");
    expect(plan.errors).toEqual(["Enter a value for header x"]);
    expect(plan.deletes).toEqual(["own-id"]);
  });

  it("keeps a masked known header and writes a replaced one", () => {
    const { plan } = planHeaders(
      [
        { id: "a", key: "a", value: MASK },
        { id: "b", key: "b", value: "new-value" },
      ],
      [
        { id: "a", key: "a", value: MASK },
        { id: "b", key: "b", value: MASK },
      ],
      newId
    );
    expect(plan.writes).toEqual([{ name: "b", value: "new-value" }]);
    expect(plan.errors).toEqual([]);
  });
});

describe("planMcpConfig", () => {
  it("stores new secret values in Key Vault and keeps only the mask", () => {
    const { config, plan } = planMcpConfig(
      "ext1",
      baseMcp({ secrets: [{ id: "client-id", name: "TOKEN", value: "fake", placement: "bearer" }] }),
      undefined,
      newId
    );
    expect(config.secrets[0].value).toBe(MASK);
    expect(config.secrets[0].id).not.toBe("client-id");
    expect(plan.writes).toEqual([{ name: config.secrets[0].id, value: "fake" }]);
  });

  it("refuses a masked secret that is not stored", () => {
    const { plan } = planMcpConfig(
      "ext1",
      baseMcp({ secrets: [{ id: "foreign", name: "TOKEN", value: MASK, placement: "bearer" }] }),
      baseMcp(),
      newId
    );
    expect(plan.errors).toEqual(["Enter a value for secret TOKEN"]);
  });

  it("deletes removed secrets and never trusts a browser-sent tool list", () => {
    const stored = baseMcp({
      secrets: [{ id: "s1", name: "A", value: MASK, placement: "bearer" }],
      tools: [{ name: "stored_tool" }],
      auth: "oauth",
    });
    const { config, plan } = planMcpConfig(
      "ext1",
      baseMcp({ tools: [{ name: "injected" }], auth: "oauth" }),
      stored,
      newId
    );
    expect(plan.deletes).toEqual(["s1"]);
    expect(config.tools).toEqual([{ name: "stored_tool" }]);
  });

  it("resets the tool list when the server URL changes (per-user tokens are bound to the old URL)", () => {
    const stored = baseMcp({ tools: [{ name: "t" }], auth: "oauth" });
    const { config, plan, connectionChanged } = planMcpConfig(
      "ext1",
      baseMcp({ url: "https://other.example.com/mcp", auth: "oauth" }),
      stored,
      newId
    );
    expect(connectionChanged).toBe(true);
    expect(config.tools).toBeUndefined();
    expect(plan.writes).toEqual([]);
  });

  it("stores an OAuth client secret in Key Vault", () => {
    const { config, plan } = planMcpConfig(
      "ext1",
      baseMcp({ auth: "oauth", oauth: { clientId: "cid", clientSecret: "fake-cs" } }),
      undefined,
      newId
    );
    expect(config.oauth?.clientSecret).toBe(MASK);
    expect(plan.writes).toContainEqual({ name: "ext1-mcp-oauth-cs", value: "fake-cs" });
  });
});

describe("extensionSecretNames", () => {
  it("lists header, MCP secret and OAuth entries for delete", () => {
    expect(
      extensionSecretNames({
        id: "e",
        headers: [{ id: "h", key: "k", value: MASK }],
        mcp: baseMcp({
          secrets: [{ id: "s", name: "S", value: MASK, placement: "bearer" }],
          auth: "oauth",
        }),
      })
    ).toEqual(["h", "s", "e-mcp-oauth-client", "e-mcp-oauth-cs"]);
  });
});
