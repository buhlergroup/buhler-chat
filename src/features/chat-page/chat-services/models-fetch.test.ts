import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/features/common/services/logger", () => ({
  logError: vi.fn(),
  logInfo: vi.fn(),
  logWarn: vi.fn(),
  logDebug: vi.fn(),
}));

import {
  DEFAULT_MODEL,
  MODEL_CONFIGS,
  getAvailableModelIds,
  getAvailableModels,
  getDefaultModel,
  getModelAvailability,
} from "./models";

// Every GET /api/models runs a budget check on the server: one Cosmos point
// read and one query. A chat page mounts several model pickers at once, so
// the calls made at the same time must share one request.

const body = {
  availableModels: { "model-a": { id: "model-a" } },
  availableModelIds: ["model-a"],
  disabledModels: { "model-b": { reason: "over budget" } },
  defaultModel: "model-a",
};

const okResponse = () =>
  ({ ok: true, json: async () => body }) as unknown as Response;

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn(async () => okResponse());
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("chat-page.unit.models-fetch.001 — concurrent /api/models calls share one request", () => {
  it("sends one request for calls made at the same time and gives each caller its data", async () => {
    const [availability, models, ids, def] = await Promise.all([
      getModelAvailability(),
      getAvailableModels(),
      getAvailableModelIds(),
      getDefaultModel(),
    ]);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith("/api/models");
    expect(availability).toEqual({
      availableModels: body.availableModels,
      disabledModels: body.disabledModels,
    });
    expect(models).toEqual(body.availableModels);
    expect(ids).toEqual(body.availableModelIds);
    expect(def).toBe("model-a");
  });

  it("fetches again once the shared request has settled (fresh budget state)", async () => {
    await getModelAvailability();
    await getModelAvailability();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("keeps the per-function fallbacks when the route fails", async () => {
    fetchMock.mockImplementation(async () => ({ ok: false }) as Response);
    const [availability, models, def] = await Promise.all([
      getModelAvailability(),
      getAvailableModels(),
      getDefaultModel(),
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(availability).toEqual({ availableModels: MODEL_CONFIGS, disabledModels: {} });
    expect(models).toEqual(MODEL_CONFIGS);
    expect(def).toBe(DEFAULT_MODEL);
  });

  it("keeps the fallbacks when the network call throws, and recovers on the next call", async () => {
    fetchMock.mockImplementationOnce(async () => {
      throw new Error("offline");
    });
    expect(await getAvailableModels()).toEqual(MODEL_CONFIGS);
    expect(await getAvailableModels()).toEqual(body.availableModels);
  });
});
