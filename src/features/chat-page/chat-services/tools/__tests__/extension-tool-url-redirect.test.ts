// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/features/common/services/logger", () => ({
  logDebug: vi.fn(),
  logInfo: vi.fn(),
  logError: vi.fn(),
  logWarn: vi.fn(),
}));

vi.mock("@/features/auth-page/helpers", () => ({
  userHashedId: vi.fn(async () => "hashed-user"),
}));

// The guard's own address rules are covered by extension-url-guard.test.ts.
// Here it is a spy, to see that it runs on every hop.
vi.mock("../extension-url-guard", () => ({
  assertExtensionUrlAllowed: vi.fn(async (u: string) => u),
}));

import { extensionTool, fetchExtensionUrl, MAX_EXTENSION_REDIRECTS } from "../extension-tool";
import { assertExtensionUrlAllowed } from "../extension-url-guard";
import type { ExtensionModel, ExtensionFunctionModel } from "@/features/extensions-page/extension-services/models";

const guard = assertExtensionUrlAllowed as unknown as ReturnType<typeof vi.fn>;

const extension: ExtensionModel = {
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
};

const functionDef = (endpoint: string, endpointType = "GET"): ExtensionFunctionModel => ({
  id: "fn-1",
  functionName: "get_item",
  code: "{}",
  endpoint,
  endpointType: endpointType as ExtensionFunctionModel["endpointType"],
  isOpen: false,
});

const parsed = (...keys: string[]) => ({
  name: "get_item",
  description: "Get an item",
  parameters: {
    type: "object",
    properties: {
      query: {
        type: "object",
        properties: Object.fromEntries(keys.map((k) => [k, { type: "string" }])),
      },
    },
  },
});

const run = (endpoint: string, keys: string[], args: unknown, secrets: Record<string, string> = {}) =>
  (extensionTool(functionDef(endpoint), parsed(...keys), { extension, headerSecrets: secrets }) as any).execute(
    args,
    { abortSignal: undefined }
  );

const ok = () => new Response(JSON.stringify({ ok: 1 }), { status: 200 });
const redirect = (status: number, location?: string) =>
  new Response(null, { status, headers: location ? { location } : {} });

beforeEach(() => {
  vi.clearAllMocks();
  guard.mockImplementation(async (u: string) => u);
});

describe("extensionTool – URL built from model arguments", () => {
  it("a query key equal to the host cannot swap the host", async () => {
    const mockFetch = vi.fn(async () => ok());
    vi.stubGlobal("fetch", mockFetch);
    await run("https://api.example.com/v1/items", ["api.example.com", "api"], {
      query: { "api.example.com": "attacker.test", api: "attacker.test" },
    }, { "x-api-key": "secret-key" });
    const [url] = mockFetch.mock.calls[0] as unknown as [string];
    expect(new URL(url).origin).toBe("https://api.example.com");
  });

  it("path traversal, ? and # in a value stay inside one encoded path segment", async () => {
    const mockFetch = vi.fn(async () => ok());
    vi.stubGlobal("fetch", mockFetch);
    await run("https://api.example.com/v1/items/{id}", ["id"], { query: { id: "../../admin?all=1#x" } });
    const [url] = mockFetch.mock.calls[0] as unknown as [string];
    expect(url).toBe("https://api.example.com/v1/items/..%2F..%2Fadmin%3Fall%3D1%23x");
  });

  it("refuses a value that turns a path segment into '..' and never calls fetch", async () => {
    const mockFetch = vi.fn();
    vi.stubGlobal("fetch", mockFetch);
    await expect(run("https://api.example.com/v1/{id}/x", ["id"], { query: { id: ".." } })).rejects.toThrow(
      /not allowed/
    );
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("drops query keys that the schema does not declare", async () => {
    const mockFetch = vi.fn(async () => ok());
    vi.stubGlobal("fetch", mockFetch);
    await run("https://api.example.com/search", ["q"], {
      query: { q: "x", search: "evil", "https://api.example.com": "https://x.test" },
    });
    const [url] = mockFetch.mock.calls[0] as unknown as [string];
    expect(url).toBe("https://api.example.com/search?q=x");
  });
});

describe("extensionTool – redirects", () => {
  it("calls fetch with redirect: manual", async () => {
    const mockFetch = vi.fn(async () => ok());
    vi.stubGlobal("fetch", mockFetch);
    await run("https://api.example.com/search", [], {});
    const [, init] = mockFetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(init.redirect).toBe("manual");
  });

  it("follows a same-origin https redirect and runs the guard on every hop", async () => {
    const mockFetch = vi.fn().mockResolvedValueOnce(redirect(302, "/v2/search")).mockResolvedValueOnce(ok());
    vi.stubGlobal("fetch", mockFetch);
    expect(await run("https://api.example.com/search", [], {})).toEqual({ ok: 1 });
    expect(mockFetch.mock.calls[1][0]).toBe("https://api.example.com/v2/search");
    expect(guard.mock.calls.map((c) => c[0])).toEqual([
      "https://api.example.com/search",
      "https://api.example.com/v2/search",
    ]);
  });

  it.each([
    ["another origin", "https://attacker.test/collect"],
    ["http on the same host", "http://api.example.com/search"],
    ["the metadata address", "https://169.254.169.254/metadata"],
  ])("refuses a redirect to %s and sends nothing there", async (_label, location) => {
    const mockFetch = vi.fn().mockResolvedValueOnce(redirect(302, location));
    vi.stubGlobal("fetch", mockFetch);
    await expect(
      run("https://api.example.com/search", [], {}, { "x-api-key": "secret-key" })
    ).rejects.toThrow(/not allowed/);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("refuses a same-origin hop that the guard rejects", async () => {
    guard.mockImplementation(async (u: string) => {
      if (u.endsWith("/internal")) throw new Error("non-public address");
      return u;
    });
    const mockFetch = vi.fn().mockResolvedValueOnce(redirect(307, "/internal"));
    vi.stubGlobal("fetch", mockFetch);
    await expect(run("https://api.example.com/search", [], {})).rejects.toThrow(/not allowed/);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it(`stops after ${MAX_EXTENSION_REDIRECTS} hops`, async () => {
    const mockFetch = vi.fn(async () => redirect(302, "/loop"));
    vi.stubGlobal("fetch", mockFetch);
    await expect(
      fetchExtensionUrl("https://api.example.com/loop", { method: "GET" }, async (u) => u)
    ).rejects.toThrow(/too many/);
    expect(mockFetch).toHaveBeenCalledTimes(MAX_EXTENSION_REDIRECTS + 1);
  });

  it("continues a 303 after POST with GET and no body", async () => {
    const mockFetch = vi.fn().mockResolvedValueOnce(redirect(303, "/result")).mockResolvedValueOnce(ok());
    vi.stubGlobal("fetch", mockFetch);
    await fetchExtensionUrl("https://api.example.com/jobs", { method: "POST", body: "{}" }, async (u) => u);
    const [, init] = mockFetch.mock.calls[1] as unknown as [string, RequestInit];
    expect(init.method).toBe("GET");
    expect(init.body).toBeUndefined();
  });

  it("reports a network error as it is, not as a refused endpoint", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("fetch failed");
      })
    );
    await expect(run("https://api.example.com/search", [], {})).rejects.toThrow(/fetch failed/);
  });
});
