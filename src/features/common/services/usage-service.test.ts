import { describe, it, expect, vi, beforeEach } from "vitest";
import { createHash } from "crypto";

function sha256(v: string) {
  return createHash("sha256").update(v).digest("hex");
}

// ---- Build per-test spies that cosmos.ts will use ----
const mockRead = vi.fn();
const mockUpsert = vi.fn();
const mockQueryFetchAll = vi.fn();

// Capture container calls so we can inspect query args
let lastQuerySpec: any = null;
let lastQueryOpts: any = null;

vi.mock("@/features/common/services/cosmos", () => ({
  HistoryContainer: vi.fn(() => ({
    item: (_docId: string, _pk: string) => ({ read: mockRead }),
    items: {
      upsert: mockUpsert,
      query: (q: any, opts: any) => {
        lastQuerySpec = q;
        lastQueryOpts = opts;
        return { fetchAll: mockQueryFetchAll };
      },
    },
  })),
}));

// Mock helpers for userHashedId
vi.mock("@/features/auth-page/helpers", () => ({
  userHashedId: vi.fn(async () => sha256("test@example.com")),
}));

const USER_USAGE_ATTRIBUTE = "USER_USAGE";

function makeUsageDoc(userId: string, date: string, overrides: Record<string, any> = {}) {
  return {
    id: `${userId}-usage-${date}`,
    userId,
    date,
    type: USER_USAGE_ATTRIBUTE,
    models: {},
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalCachedTokens: 0,
    totalCostUsd: 0,
    ...overrides,
  };
}

describe("common.unit.usage — GetOrCreateDailyUsage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    lastQuerySpec = null;
    lastQueryOpts = null;
  });

  it("common.unit.usage.001: returns existing doc when found", async () => {
    const existing = makeUsageDoc("uid-1", "2026-05-15");
    mockRead.mockResolvedValueOnce({ resource: existing });
    const { GetOrCreateDailyUsage } = await import("./usage-service");
    const result = await GetOrCreateDailyUsage("uid-1", "2026-05-15");
    expect(result).toEqual(existing);
    expect(result.id).toBe("uid-1-usage-2026-05-15");
  });

  it("common.unit.usage.002: returns synthetic doc when not found; no upsert call", async () => {
    mockRead.mockRejectedValueOnce(new Error("Not found"));
    const { GetOrCreateDailyUsage } = await import("./usage-service");
    const result = await GetOrCreateDailyUsage("uid-1", "2026-05-15");
    expect(result.id).toBe("uid-1-usage-2026-05-15");
    expect(result.totalInputTokens).toBe(0);
    expect(result.type).toBe(USER_USAGE_ATTRIBUTE);
    expect(mockUpsert).not.toHaveBeenCalled();
  });
});

describe("common.unit.usage — IncrementUsage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("common.unit.usage.003: accumulates per-model and totals", async () => {
    const existing = makeUsageDoc("u", "2026-05-15", {
      models: {
        "gpt-5.4": {
          inputTokens: 10,
          outputTokens: 5,
          cachedTokens: 2,
          costUsd: 0.01,
          requestCount: 1,
        },
      },
      totalInputTokens: 10,
      totalOutputTokens: 5,
      totalCachedTokens: 2,
      totalCostUsd: 0.01,
    });
    mockRead.mockResolvedValueOnce({ resource: existing });
    mockUpsert.mockResolvedValueOnce({ resource: {} });

    const { IncrementUsage } = await import("./usage-service");
    await IncrementUsage("u", [{ model: "gpt-5.4", inputTokens: 2, outputTokens: 3, cachedTokens: 1, costUsd: 0.5 }]);

    expect(mockUpsert).toHaveBeenCalledOnce();
    const upsertedDoc = mockUpsert.mock.calls[0][0];
    const modelUsage = upsertedDoc.models["gpt-5.4"];
    expect(modelUsage.inputTokens).toBe(12);
    expect(modelUsage.outputTokens).toBe(8);
    expect(modelUsage.cachedTokens).toBe(3);
    expect(modelUsage.requestCount).toBe(2);
    expect(upsertedDoc.totalInputTokens).toBe(12);
    expect(upsertedDoc.totalOutputTokens).toBe(8);
    expect(upsertedDoc.totalCachedTokens).toBe(3);
    expect(parseFloat(upsertedDoc.totalCostUsd.toFixed(3))).toBe(0.51);
  });

  it("common.unit.usage.004: swallows Cosmos errors", async () => {
    mockRead.mockResolvedValueOnce({ resource: makeUsageDoc("u", "2026-05-15") });
    mockUpsert.mockRejectedValueOnce(new Error("Cosmos exploded"));
    const { IncrementUsage } = await import("./usage-service");
    await expect(
      IncrementUsage("u", [{ model: "gpt-5.4", inputTokens: 1, outputTokens: 1, cachedTokens: 0, costUsd: 0.1 }]),
    ).resolves.toBeUndefined();
  });

  it("common.unit.usage.008: counts each model of a turn under its own id, in one write", async () => {
    const existing = makeUsageDoc("u", "2026-05-15", {
      models: {
        "gpt-6-luna": { inputTokens: 100, outputTokens: 10, cachedTokens: 0, costUsd: 0.001, requestCount: 1 },
      },
      totalInputTokens: 100,
      totalOutputTokens: 10,
      totalCachedTokens: 0,
      totalCostUsd: 0.001,
    });
    mockRead.mockResolvedValueOnce({ resource: existing });
    mockUpsert.mockResolvedValueOnce({ resource: {} });

    const { IncrementUsage } = await import("./usage-service");
    await IncrementUsage("u", [
      { model: "gpt-6.2-sol", inputTokens: 1000, outputTokens: 200, cachedTokens: 500, costUsd: 0.02 },
      { model: "gpt-6-luna", inputTokens: 4000, outputTokens: 300, cachedTokens: 1000, costUsd: 0.0005 },
    ]);

    expect(mockRead).toHaveBeenCalledOnce();
    expect(mockUpsert).toHaveBeenCalledOnce();
    const doc = mockUpsert.mock.calls[0][0];
    expect(doc.models["gpt-6.2-sol"]).toEqual({ inputTokens: 1000, outputTokens: 200, cachedTokens: 500, costUsd: 0.02, requestCount: 1 });
    expect(doc.models["gpt-6-luna"].inputTokens).toBe(4100);
    expect(doc.models["gpt-6-luna"].requestCount).toBe(2);
    expect(parseFloat(doc.models["gpt-6-luna"].costUsd.toFixed(4))).toBe(0.0015);
    // The daily total (cost cap, downgrade) holds every model's cost.
    expect(doc.totalInputTokens).toBe(5100);
    expect(parseFloat(doc.totalCostUsd.toFixed(4))).toBe(0.0215);
  });

  it("common.unit.usage.009: writes nothing for a turn without models (negative)", async () => {
    const { IncrementUsage } = await import("./usage-service");
    await IncrementUsage("u", []);
    expect(mockRead).not.toHaveBeenCalled();
    expect(mockUpsert).not.toHaveBeenCalled();
  });
});

describe("common.unit.usage — CheckLimits", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("common.unit.usage.005: returns {exceeded:false} when model has no limits", async () => {
    // gpt-5.4-mini has no dailyTokenLimit or dailyCostLimit in MODEL_CONFIGS
    // This call should not even reach Cosmos since CheckLimits early-returns
    const { CheckLimits } = await import("./usage-service");
    const result = await CheckLimits("u", "gpt-5.4-mini");
    expect(result.exceeded).toBe(false);
  });

  it("common.unit.usage.006: returns exceeded:true, limitType:tokens when token limit hit", async () => {
    // Patch MODEL_CONFIGS on the actual models module before calling CheckLimits
    // Since usage-service imports MODEL_CONFIGS by reference, we patch the exported object
    const modelsModule = await import("@/features/chat-page/chat-services/models");
    const origDailyTokenLimit = (modelsModule.MODEL_CONFIGS["gpt-5.4"] as any).dailyTokenLimit;
    const origFallback = (modelsModule.MODEL_CONFIGS["gpt-5.4"] as any).fallbackModel;
    // Mutate the shared reference directly
    (modelsModule.MODEL_CONFIGS["gpt-5.4"] as any).dailyTokenLimit = 1000;
    (modelsModule.MODEL_CONFIGS["gpt-5.4"] as any).fallbackModel = "gpt-5.4-mini";

    try {
      const docWithUsage = makeUsageDoc("u", "2026-05-15", {
        models: {
          "gpt-5.4": {
            inputTokens: 600,
            outputTokens: 500, // total 1100 >= 1000
            cachedTokens: 0,
            costUsd: 0,
            requestCount: 5,
          },
        },
      });
      mockRead.mockResolvedValueOnce({ resource: docWithUsage });

      const { CheckLimits } = await import("./usage-service");
      const result = await CheckLimits("u", "gpt-5.4");
      expect(result.exceeded).toBe(true);
      expect(result.limitType).toBe("tokens");
      expect(result.currentUsage).toBe(1100);
      expect(result.limit).toBe(1000);
      expect(result.fallbackModel).toBe("gpt-5.4-mini");
    } finally {
      (modelsModule.MODEL_CONFIGS["gpt-5.4"] as any).dailyTokenLimit = origDailyTokenLimit;
      (modelsModule.MODEL_CONFIGS["gpt-5.4"] as any).fallbackModel = origFallback;
    }
  });

  it("common.unit.usage.007: returns exceeded:true, limitType:cost when cost limit hit", async () => {
    const modelsModule = await import("@/features/chat-page/chat-services/models");
    const origTokenLimit = (modelsModule.MODEL_CONFIGS["gpt-5.4"] as any).dailyTokenLimit;
    const origCostLimit = (modelsModule.MODEL_CONFIGS["gpt-5.4"] as any).dailyCostLimit;
    const origFallback = (modelsModule.MODEL_CONFIGS["gpt-5.4"] as any).fallbackModel;

    (modelsModule.MODEL_CONFIGS["gpt-5.4"] as any).dailyTokenLimit = undefined;
    (modelsModule.MODEL_CONFIGS["gpt-5.4"] as any).dailyCostLimit = 1.0;
    (modelsModule.MODEL_CONFIGS["gpt-5.4"] as any).fallbackModel = "gpt-5.4-mini";

    try {
      const docWithUsage = makeUsageDoc("u", "2026-05-15", {
        models: {
          "gpt-5.4": {
            inputTokens: 100,
            outputTokens: 50,
            cachedTokens: 0,
            costUsd: 1.5, // >= 1.0
            requestCount: 3,
          },
        },
      });
      mockRead.mockResolvedValueOnce({ resource: docWithUsage });

      const { CheckLimits } = await import("./usage-service");
      const result = await CheckLimits("u", "gpt-5.4");
      expect(result.exceeded).toBe(true);
      expect(result.limitType).toBe("cost");
      expect(result.currentUsage).toBe(1.5);
      expect(result.limit).toBe(1.0);
    } finally {
      (modelsModule.MODEL_CONFIGS["gpt-5.4"] as any).dailyTokenLimit = origTokenLimit;
      (modelsModule.MODEL_CONFIGS["gpt-5.4"] as any).dailyCostLimit = origCostLimit;
      (modelsModule.MODEL_CONFIGS["gpt-5.4"] as any).fallbackModel = origFallback;
    }
  });

  it("common.unit.usage.008: returns false when no usage row exists for that model", async () => {
    const modelsModule = await import("@/features/chat-page/chat-services/models");
    const origTokenLimit = (modelsModule.MODEL_CONFIGS["gpt-5.4"] as any).dailyTokenLimit;
    const origFallback = (modelsModule.MODEL_CONFIGS["gpt-5.4"] as any).fallbackModel;

    (modelsModule.MODEL_CONFIGS["gpt-5.4"] as any).dailyTokenLimit = 1000;
    (modelsModule.MODEL_CONFIGS["gpt-5.4"] as any).fallbackModel = "gpt-5.4-mini";

    try {
      // Doc exists but models["gpt-5.4"] entry is absent
      mockRead.mockResolvedValueOnce({ resource: makeUsageDoc("u", "2026-05-15") });

      const { CheckLimits } = await import("./usage-service");
      const result = await CheckLimits("u", "gpt-5.4");
      expect(result.exceeded).toBe(false);
    } finally {
      (modelsModule.MODEL_CONFIGS["gpt-5.4"] as any).dailyTokenLimit = origTokenLimit;
      (modelsModule.MODEL_CONFIGS["gpt-5.4"] as any).fallbackModel = origFallback;
    }
  });
});

describe("common.unit.usage — GetWeeklyUsage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    lastQuerySpec = null;
    lastQueryOpts = null;
  });

  it("common.unit.usage.009: queries with userId partitionKey and date >= weekAgo", async () => {
    const docs = [makeUsageDoc("uid-1", "2026-05-14"), makeUsageDoc("uid-1", "2026-05-13")];
    mockQueryFetchAll.mockResolvedValueOnce({ resources: docs });

    const { GetWeeklyUsage } = await import("./usage-service");
    const result = await GetWeeklyUsage("uid-1");

    expect(mockQueryFetchAll).toHaveBeenCalled();
    expect(lastQuerySpec).not.toBeNull();
    const params: any[] = lastQuerySpec.parameters;
    const userIdParam = params.find((p: any) => p.name === "@userId");
    const startDateParam = params.find((p: any) => p.name === "@startDate");
    expect(userIdParam?.value).toBe("uid-1");
    expect(typeof startDateParam?.value).toBe("string");
    // partitionKey should be the userId
    expect(lastQueryOpts?.partitionKey).toBe("uid-1");
    expect(result).toHaveLength(2);
  });
});

describe("common.unit.usage — GetDailyUsage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("common.unit.usage.010: defaults userId to userHashedId()", async () => {
    const hashedEmail = sha256("test@example.com");
    const today = new Date().toISOString().split("T")[0];
    const expectedDocId = `${hashedEmail}-usage-${today}`;
    const doc = makeUsageDoc(hashedEmail, today);
    mockRead.mockResolvedValueOnce({ resource: doc });

    const { GetDailyUsage } = await import("./usage-service");
    const result = await GetDailyUsage();
    // userHashedId() mock returns sha256("test@example.com")
    expect(result.userId).toBe(hashedEmail);
    expect(result.id).toBe(expectedDocId);
  });
});
