// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/features/common/services/logger", () => ({
  logInfo: vi.fn(),
  logWarn: vi.fn(),
  logError: vi.fn(),
  logDebug: vi.fn(),
}));

import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js";
import {
  filterMcpTools,
  mapMcpCallResult,
  mcpExtensionTools,
  MAX_MCP_TOOL_OUTPUT_CHARS,
  normalizeMcpInputSchema,
} from "../mcp-tool";
import { ToolUserError, uiErrorText } from "../tool-user-error";
import type {
  McpConnectionOptions,
  McpSession,
  McpSessionFactory,
} from "@/features/extensions-page/extension-services/mcp/mcp-client";
import type { ExtensionModel } from "@/features/extensions-page/extension-services/models";

const connection: McpConnectionOptions = {
  url: "https://mcp.example.com/mcp?api_key=fake",
  transport: "auto",
  headers: { Authorization: "Bearer fake" },
};

const extension = (mcp: Partial<NonNullable<ExtensionModel["mcp"]>> = {}): ExtensionModel => ({
  id: "AbCdEfGh000000000000000000000000000",
  name: "Market",
  description: "d",
  executionSteps: "s",
  headers: [],
  functions: [],
  userId: "u",
  isPublished: false,
  createdAt: new Date(),
  type: "EXTENSION",
  kind: "mcp",
  mcp: {
    url: connection.url,
    transport: "auto",
    secrets: [],
    toolAllowList: [],
    auth: "none",
    tools: [
      { name: "get_price", description: "Price", inputSchema: { type: "object", properties: { sym: { type: "string" } } } },
      { name: "delete_all", description: "Dangerous" },
    ],
    ...mcp,
  },
});

let session: McpSession;
let openSession: McpSessionFactory;

beforeEach(() => {
  session = {
    listTools: vi.fn(async () => ({ tools: [{ name: "live_tool" }] })),
    callTool: vi.fn(async () => ({ content: [{ type: "text", text: "42" }] })),
    close: vi.fn(async () => {}),
  };
  openSession = vi.fn(async () => session);
});

const execute = (t: unknown, args: unknown) =>
  (t as { execute: (a: unknown, o: { abortSignal?: AbortSignal }) => Promise<unknown> }).execute(args, {});

describe("mcpExtensionTools", () => {
  it("keys tools by extension id prefix and tool name, from the stored list (no network)", async () => {
    const tools = await mcpExtensionTools(extension(), connection, openSession);
    expect(tools.map(([k]) => k)).toEqual(["AbCdEfGh_get_price", "AbCdEfGh_delete_all"]);
    expect(openSession).not.toHaveBeenCalled();
  });

  it("applies the allow-list", async () => {
    const tools = await mcpExtensionTools(extension({ toolAllowList: ["get_price"] }), connection, openSession);
    expect(tools.map(([k]) => k)).toEqual(["AbCdEfGh_get_price"]);
  });

  it("lists tools live when none are stored", async () => {
    const tools = await mcpExtensionTools(extension({ tools: undefined }), connection, openSession);
    expect(tools.map(([k]) => k)).toEqual(["AbCdEfGh_live_tool"]);
    expect(session.close).toHaveBeenCalled();
  });

  it("skips the extension when the live listing fails (the chat goes on)", async () => {
    openSession = vi.fn(async () => {
      throw new Error("connect ECONNREFUSED");
    });
    expect(await mcpExtensionTools(extension({ tools: undefined }), connection, openSession)).toEqual([]);
  });

  it("calls the MCP tool with the model's arguments and closes the session", async () => {
    const [[, t]] = await mcpExtensionTools(extension({ toolAllowList: ["get_price"] }), connection, openSession);
    const out = await execute(t, { sym: "ABB" });
    expect(session.callTool).toHaveBeenCalledWith("get_price", { sym: "ABB" }, undefined);
    expect(out).toEqual({ text: "42" });
    expect(session.close).toHaveBeenCalled();
  });

  it("maps a tool-level error to a thrown error with the server text", async () => {
    session.callTool = vi.fn(async () => ({ isError: true, content: [{ type: "text", text: "bad symbol" }] }));
    const [[, t]] = await mcpExtensionTools(extension({ toolAllowList: ["get_price"] }), connection, openSession);
    await expect(execute(t, {})).rejects.toThrow(/returned an error: bad symbol/);
  });

  it("maps an auth failure to a sign-in message without the URL or secrets", async () => {
    session.callTool = vi.fn(async () => {
      throw new UnauthorizedError("401 at https://mcp.example.com/mcp?api_key=fake");
    });
    const [[, t]] = await mcpExtensionTools(extension({ toolAllowList: ["get_price"] }), connection, openSession);
    const error = await execute(t, {}).catch((e: Error) => e);
    expect((error as Error).message).toMatch(/needs a sign-in/);
    expect((error as Error).message).not.toContain("fake");
  });

  it("does not fail for an OAuth server the user has not connected: returns the Connect action", async () => {
    session.callTool = vi.fn(async () => {
      throw new UnauthorizedError("no token");
    });
    const [[, t]] = await mcpExtensionTools(
      extension({ toolAllowList: ["get_price"], auth: "oauth" }),
      connection,
      openSession,
      "agent-9"
    );
    expect(await execute(t, {})).toEqual({
      text: expect.stringContaining('Connect Market'),
      mcpConnect: { extensionId: "AbCdEfGh000000000000000000000000000", extensionName: "Market", personaId: "agent-9" },
    });
  });

  it("sends the server schema without strict decoding, so the model may omit optional fields", async () => {
    const [[, t]] = await mcpExtensionTools(extension({ toolAllowList: ["get_price"] }), connection, openSession);
    expect((t as { strict?: boolean }).strict).toBe(false);
  });

  it("marks tool-level and transport errors as safe to show in the chat", async () => {
    session.callTool = vi.fn(async () => ({ isError: true, content: [{ type: "text", text: "Use overview without patterns." }] }));
    const [[, t]] = await mcpExtensionTools(extension({ toolAllowList: ["get_price"] }), connection, openSession);
    const toolError = await execute(t, {}).catch((e: unknown) => e);
    expect(toolError).toBeInstanceOf(ToolUserError);
    expect(uiErrorText(toolError)).toBe("Market / get_price returned an error: Use overview without patterns.");

    session.callTool = vi.fn(async () => {
      throw new Error("socket hang up at https://mcp.example.com/mcp?api_key=fake");
    });
    const transportError = await execute(t, {}).catch((e: unknown) => e);
    expect(uiErrorText(transportError)).toBe("Market / get_price: The MCP server request failed.");
    expect(uiErrorText(transportError)).not.toContain("fake");
  });

  it("shows a cleaned, short error text in the chat; the model gets the server's text", async () => {
    const echo =
      "upstream 401 from https://internal.example.net/v2/quote?sig=AbC123 " +
      "Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2lnbmF0dXJl " +
      "api_key=sk-live-0123456789 " +
      "x".repeat(900);
    session.callTool = vi.fn(async () => ({ isError: true, content: [{ type: "text", text: echo }] }));
    const [[, t]] = await mcpExtensionTools(extension({ toolAllowList: ["get_price"] }), connection, openSession);
    const toolError = (await execute(t, {}).catch((e: unknown) => e)) as Error;
    expect(toolError.message).toContain("https://internal.example.net/v2/quote?sig=AbC123");
    const ui = uiErrorText(toolError);
    expect(ui.startsWith("Market / get_price returned an error: upstream 401 from [url]")).toBe(true);
    expect(ui).not.toMatch(/internal\.example|eyJhbGci|sk-live|AbC123/);
    expect(Array.from(ui).length).toBeLessThanOrEqual(300);
  });

  it("keeps the generic text for errors that are not marked as safe", () => {
    expect(uiErrorText(new Error("Cosmos 500 at https://internal.example"))).toBe("An error occurred.");
    expect(uiErrorText("boom")).toBe("An error occurred.");
  });

  it("maps a timeout", async () => {
    session.callTool = vi.fn(async () => {
      throw Object.assign(new Error("Request timed out"), { code: -32001 });
    });
    const [[, t]] = await mcpExtensionTools(extension({ toolAllowList: ["get_price"] }), connection, openSession);
    await expect(execute(t, {})).rejects.toThrow(/did not answer in time/);
  });
});

describe("mapMcpCallResult", () => {
  it("joins text, names binary content, keeps structured content", () => {
    expect(
      mapMcpCallResult({
        content: [
          { type: "text", text: "a" },
          { type: "image", mimeType: "image/png", data: "..." },
          { type: "resource", resource: { uri: "x://1", text: "res" } },
        ],
        structuredContent: { price: 1 },
      })
    ).toEqual({ text: "a\n[image (image/png) not shown]\nres", structuredContent: { price: 1 } });
  });

  it("caps the output", () => {
    const r = mapMcpCallResult({ content: [{ type: "text", text: "x".repeat(MAX_MCP_TOOL_OUTPUT_CHARS + 10) }] });
    expect(r.text.endsWith("[output truncated]")).toBe(true);
    expect(r.text.length).toBeLessThan(MAX_MCP_TOOL_OUTPUT_CHARS + 50);
  });
});

describe("schema helpers", () => {
  it("falls back to an empty object schema", () => {
    expect(normalizeMcpInputSchema(undefined)).toEqual({ type: "object", properties: {} });
    expect(normalizeMcpInputSchema({ type: "string" })).toEqual({ type: "object", properties: {} });
    expect(normalizeMcpInputSchema({ type: "object" })).toEqual({ type: "object", properties: {} });
  });

  it("an empty allow-list allows all tools", () => {
    expect(filterMcpTools([{ name: "a" }, { name: "b" }], [])).toHaveLength(2);
  });
});
