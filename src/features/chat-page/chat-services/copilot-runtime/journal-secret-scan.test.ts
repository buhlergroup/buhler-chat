import { describe, it, expect, vi, afterEach } from "vitest";

vi.mock("@/features/common/services/logger", () => ({ logDebug: vi.fn(), logInfo: vi.fn(), logWarn: vi.fn(), logError: vi.fn() }));
vi.mock("@/features/auth-page/helpers", () => ({ userHashedId: vi.fn(async () => "f".repeat(64)) }));
vi.mock("../tools/extension-url-guard", () => ({ assertExtensionUrlAllowed: vi.fn(async (u: string) => u) }));

import { extensionTool } from "../tools/extension-tool";
import { envSecretValues, scanJournalText } from "./journal-secret-scan";
import { runAppTool, type ToolCallRecord, type TurnToolBinding } from "./tool-adapter";

/** One journal line per event, as the runtime appends them to events.jsonl. */
const jsonl = (events: unknown[]) => events.map((e) => JSON.stringify(e)).join("\n") + "\n";

const HEADER_SECRET = "hs_9f8e7d6c5b4a39281706f5e4d3c2b1a0";

describe("journal secret scan (also run by the smoke script on a live journal)", () => {
  it("finds tokens in tool-call headers, arguments and results", () => {
    const journal = jsonl([
      { type: "session.start", data: { sessionId: "thread-1" } },
      {
        type: "tool.execution_start",
        data: {
          toolCallId: "c1",
          toolName: "http_get",
          arguments: { url: "https://api.example.org/x", headers: { Authorization: "Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.qrstuvwxyz0123456789" } },
        },
      },
      { type: "tool.execution_start", data: { toolCallId: "c2", toolName: "call", arguments: { "x-api-key": "AbCdEf0123456789XyZ" } } },
      {
        type: "tool.execution_complete",
        data: { toolCallId: "c3", success: true, result: { content: "see https://acct.example.net/c/b?sv=2024&sig=AbCdEfGhIjKlMnOpQrStUvWxYz012345%3D" } },
      },
      { type: "tool.execution_complete", data: { toolCallId: "c4", success: true, result: { content: "DefaultEndpointsProtocol=https;AccountKey=abc" } } },
      { type: "tool.execution_start", data: { toolCallId: "c5", toolName: "oauth", arguments: { next: "https://x.example.org/cb?code=0123456789abcdefXYZ" } } },
      { type: "tool.execution_start", data: { toolCallId: "c6", toolName: "echo", arguments: { text: `key is ${HEADER_SECRET}` } } },
    ]);
    const hits = scanJournalText(journal, [["extension header secret", HEADER_SECRET]]);
    expect(hits).toEqual(
      expect.arrayContaining([
        "bearer token",
        "Authorization header",
        "api key field",
        "SAS signature",
        "connection string",
        "OAuth code / token",
        "JWT",
        "extension header secret",
      ]),
    );
  });

  it("a normal journal has no findings", () => {
    const journal = jsonl([
      { type: "session.start", data: { sessionId: "thread-1", selectedModel: "gpt-x" } },
      { type: "user.message", data: { content: "Summarise /workspace/uploads/notes.txt" } },
      { type: "tool.execution_start", data: { toolCallId: "v1", toolName: "view", arguments: { path: "/workspace/uploads/notes.txt" } } },
      { type: "tool.execution_complete", data: { toolCallId: "v1", success: true, result: { content: "Line 2 runs at 80 % load." } } },
      { type: "assistant.message", data: { content: "Line 2 runs at 80 % load. The token budget is fine." } },
    ]);
    expect(scanJournalText(journal, [["extension header secret", HEADER_SECRET]])).toEqual([]);
  });

  it("env secret values: only secret-like names with values of 16+ characters", () => {
    expect(
      envSecretValues({ AZURE_OPENAI_API_KEY: "k".repeat(20), SHORT_TOKEN: "abc", NEXT_PUBLIC_TITLE: "x".repeat(30), DB_PASSWORD: undefined }),
    ).toEqual([["AZURE_OPENAI_API_KEY", "k".repeat(20)]]);
  });
});

describe("journal secret scan on what an extension call hands to the runtime", () => {
  afterEach(() => vi.unstubAllGlobals());

  /** The journal lines of one app tool call: arguments in, result (or error) out. */
  async function journalOfCall(status: number, body: unknown): Promise<string> {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })),
    );
    const ext = { id: "e1", name: "Status", headers: [], functions: [], type: "EXTENSION" };
    const fn = { id: "f1", functionName: "get_status", endpoint: "https://status.example.org/api", endpointType: "GET", isOpen: false, code: "" };
    const schema = { name: "get_status", description: "Status.", parameters: { type: "object", properties: {} } };
    const records: ToolCallRecord[] = [];
    const binding: TurnToolBinding = {
      toolset: { get_status: extensionTool(fn as never, schema, { extension: ext as never, headerSecrets: { "X-Api-Key": HEADER_SECRET } }) },
      onResult: (r) => records.push(r),
      spill: async () => undefined,
    };
    const args = { query: {} };
    const result = await runAppTool("get_status", args, { toolCallId: "c1", signal: new AbortController().signal }, binding);
    return jsonl([
      { type: "tool.execution_start", data: { toolCallId: "c1", toolName: "get_status", arguments: args } },
      { type: "tool.execution_complete", data: { toolCallId: "c1", success: result.resultType === "success", result, records } },
    ]);
  }

  it("a successful call and a failed call put no header secret into the journal", async () => {
    const ok = await journalOfCall(200, { status: "green" });
    expect(ok).toContain("green");
    const failed = await journalOfCall(500, { error: "boom" });
    expect(failed).toContain("failed with status 500");
    for (const journal of [ok, failed]) {
      expect(scanJournalText(journal, [["extension header secret", HEADER_SECRET], ...envSecretValues(process.env)])).toEqual([]);
    }
  });
});
