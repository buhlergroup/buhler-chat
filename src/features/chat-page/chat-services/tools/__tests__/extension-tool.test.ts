import { describe, it, expect, vi, beforeEach } from "vitest";

// ─── module mocks ────────────────────────────────────────────────────────────
vi.mock("@/features/common/services/logger", () => ({
  logDebug: vi.fn(),
  logInfo: vi.fn(),
  logError: vi.fn(),
  logWarn: vi.fn(),
}));

vi.mock("@/features/auth-page/helpers", () => ({
  userHashedId: vi.fn(async () => "hashed-user"),
}));

// Bypass the SSRF guard for unit tests — the guard's own behavior is
// covered by extension-url-guard.test.ts.
vi.mock("../extension-url-guard", () => ({
  assertExtensionUrlAllowed: vi.fn(async (u: string) => u),
}));

vi.mock("@/features/chat-page/chat-services/chat-api/chat-api-rag-extension", () => ({
  SearchAzureAISimilarDocuments: vi.fn(
    async () =>
      new Response(JSON.stringify([{ id: "c1", content: "doc" }]), {
        status: 200,
      })
  ),
}));

// ─── subject under test ───────────────────────────────────────────────────────
import { extensionTool } from "../extension-tool";
import { SearchAzureAISimilarDocuments } from "@/features/chat-page/chat-services/chat-api/chat-api-rag-extension";
import type { ExtensionModel, ExtensionFunctionModel } from "@/features/extensions-page/extension-services/models";

// ─── helpers ─────────────────────────────────────────────────────────────────
function makeExtension(overrides: Partial<ExtensionModel> = {}): ExtensionModel {
  return {
    id: "ext-1",
    name: "Test Extension",
    description: "A test extension",
    executionSteps: "call the API",
    headers: [],
    userId: "user-1",
    isPublished: true,
    createdAt: new Date(),
    type: "EXTENSION",
    functions: [],
    ...overrides,
  };
}

function makeFunctionDef(overrides: Partial<ExtensionFunctionModel> = {}): ExtensionFunctionModel {
  return {
    id: "fn-1",
    functionName: "query_api",
    code: JSON.stringify({
      name: "query_api",
      description: "Query the API",
      parameters: {
        type: "object",
        properties: {
          q: { type: "string", description: "search term" },
        },
        required: ["q"],
      },
    }),
    endpoint: "https://api.example.com/search",
    endpointType: "POST",
    isOpen: false,
    ...overrides,
  };
}

const PARSED_FUNCTION = {
  name: "query_api",
  description: "Query the API",
  parameters: {
    type: "object",
    properties: {
      q: { type: "string", description: "search term" },
    },
    required: ["q"],
  },
};

// ─── tests ───────────────────────────────────────────────────────────────────
describe("extensionTool – schema", () => {
  it("sends the author schema without strict decoding, so the model may omit optional fields", () => {
    const t = extensionTool(makeFunctionDef(), PARSED_FUNCTION, { extension: makeExtension(), headerSecrets: {} });
    expect((t as { strict?: boolean }).strict).toBe(false);
  });
});

describe("extensionTool – execute", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("calls the correct URL and method with merged headers", async () => {
    const mockFetch = vi.fn(async () =>
      new Response(JSON.stringify({ ok: true }), { status: 200 })
    );
    vi.stubGlobal("fetch", mockFetch);

    const functionDef = makeFunctionDef();
    const extension = makeExtension();
    const t = extensionTool(functionDef, PARSED_FUNCTION, {
      extension,
      headerSecrets: { "x-api-key": "secret-key" },
    });

    await (t as any).execute({ q: "hello" }, { abortSignal: undefined });

    expect(mockFetch).toHaveBeenCalledOnce();
    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.example.com/search");
    expect((init.headers as Record<string, string>)["x-api-key"]).toBe("secret-key");
    expect((init.headers as Record<string, string>)["authorization"]).toBe("hashed-user");
    expect(init.method).toBe("POST");
  });

  it("passes abortSignal to fetch", async () => {
    const controller = new AbortController();
    const mockFetch = vi.fn(async () =>
      new Response(JSON.stringify({ result: 1 }), { status: 200 })
    );
    vi.stubGlobal("fetch", mockFetch);

    const t = extensionTool(makeFunctionDef(), PARSED_FUNCTION, {
      extension: makeExtension(),
      headerSecrets: {},
    });

    await (t as any).execute({ q: "test" }, { abortSignal: controller.signal });

    const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(init.signal).toBe(controller.signal);
  });

  it("returns parsed JSON from the API response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ results: ["a", "b"] }), { status: 200 }))
    );

    const t = extensionTool(makeFunctionDef(), PARSED_FUNCTION, {
      extension: makeExtension(),
      headerSecrets: {},
    });

    const result = await (t as any).execute({ q: "x" }, { abortSignal: undefined });
    expect(result).toEqual({ results: ["a", "b"] });
  });

  it("throws on HTTP 400 instead of returning {error:...}", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response("Bad Request", { status: 400, statusText: "Bad Request" })
      )
    );

    const t = extensionTool(makeFunctionDef(), PARSED_FUNCTION, {
      extension: makeExtension(),
      headerSecrets: {},
    });

    await expect(
      (t as any).execute({ q: "x" }, { abortSignal: undefined })
    ).rejects.toThrow(/400/);
  });

  it("throws on HTTP 500", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response("Internal Server Error", {
            status: 500,
            statusText: "Internal Server Error",
          })
      )
    );

    const t = extensionTool(makeFunctionDef(), PARSED_FUNCTION, {
      extension: makeExtension(),
      headerSecrets: {},
    });

    await expect(
      (t as any).execute({ q: "x" }, { abortSignal: undefined })
    ).rejects.toThrow(/500/);
  });

  it("handles GET method without setting body", async () => {
    const mockFetch = vi.fn(async () =>
      new Response(JSON.stringify({ data: "ok" }), { status: 200 })
    );
    vi.stubGlobal("fetch", mockFetch);

    const getFunctionDef = makeFunctionDef({ endpointType: "GET" });
    const t = extensionTool(getFunctionDef, PARSED_FUNCTION, {
      extension: makeExtension(),
      headerSecrets: {},
    });

    await (t as any).execute({ q: "test" }, { abortSignal: undefined });

    const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(init.method).toBe("GET");
    expect(init.body).toBeUndefined();
  });

  it("attaches body for POST when args.body is present", async () => {
    const mockFetch = vi.fn(async () =>
      new Response(JSON.stringify({ created: true }), { status: 200 })
    );
    vi.stubGlobal("fetch", mockFetch);

    const bodyFunctionParsed = {
      name: "create_item",
      description: "Creates an item",
      parameters: {
        type: "object",
        properties: {
          body: {
            type: "object",
            properties: { name: { type: "string" } },
            required: ["name"],
          },
        },
        required: ["body"],
      },
    };

    const bodyFunctionDef = makeFunctionDef({
      endpoint: "https://api.example.com/items",
      endpointType: "POST",
    });

    const t = extensionTool(bodyFunctionDef, bodyFunctionParsed, {
      extension: makeExtension(),
      headerSecrets: {},
    });

    await (t as any).execute(
      { body: { name: "Widget" } },
      { abortSignal: undefined }
    );

    const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(init.body as string)).toEqual({ name: "Widget" });
  });

  it("lifts extension JSON Schema so tool has a description", () => {
    const t = extensionTool(makeFunctionDef(), PARSED_FUNCTION, {
      extension: makeExtension(),
      headerSecrets: {},
    });
    // The tool wrapper should carry the description from parsedFunction
    expect((t as any).description).toBe("Query the API");
  });
});

describe("extensionTool - in-process /api/document (no network hop)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("runs the app's own /api/document search in-process and never calls fetch", async () => {
    const mockFetch = vi.fn();
    vi.stubGlobal("fetch", mockFetch);

    // NEXTAUTH_URL is http://localhost:3000 in the test setup, so this endpoint
    // is same-origin and must be handled in-process.
    const functionDef = makeFunctionDef({
      endpoint: "http://localhost:3000/api/document",
      functionName: "aisearch",
    });
    const t = extensionTool(functionDef, PARSED_FUNCTION, {
      extension: makeExtension(),
      headerSecrets: {
        searchName: "valid-search",
        indexName: "valid-index",
        apiKey: "k",
      },
    });

    const result = await (t as any).execute(
      { body: { search: "hello" } },
      { abortSignal: undefined }
    );

    expect(SearchAzureAISimilarDocuments).toHaveBeenCalledOnce();
    expect(mockFetch).not.toHaveBeenCalled();
    expect(result).toEqual([{ id: "c1", content: "doc" }]);
  });

  it("still uses network fetch for an external extension endpoint", async () => {
    const mockFetch = vi.fn(
      async () => new Response(JSON.stringify({ ok: true }), { status: 200 })
    );
    vi.stubGlobal("fetch", mockFetch);

    const functionDef = makeFunctionDef({
      endpoint: "https://api.example.com/search",
    });
    const t = extensionTool(functionDef, PARSED_FUNCTION, {
      extension: makeExtension(),
      headerSecrets: {},
    });

    await (t as any).execute({ q: "hello" }, { abortSignal: undefined });

    expect(SearchAzureAISimilarDocuments).not.toHaveBeenCalled();
    expect(mockFetch).toHaveBeenCalledOnce();
  });
});
