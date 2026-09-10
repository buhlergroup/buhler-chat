import { describe, it, expect, vi } from "vitest";

// ── Silence logger noise ──────────────────────────────────────────────────────
vi.mock("@/features/common/services/logger", () => ({
  logDebug: vi.fn(),
  logInfo: vi.fn(),
  logError: vi.fn(),
  logWarn: vi.fn(),
}));

// ── Auth ──────────────────────────────────────────────────────────────────────
vi.mock("@/features/auth-page/helpers", () => ({
  userHashedId: vi.fn(async () => "test-user-hash"),
}));

// ── Usage service ─────────────────────────────────────────────────────────────
const mockCheckLimits = vi.fn(async () => ({ exceeded: false }));
vi.mock("@/features/common/services/usage-service", () => ({
  CheckLimits: (...args: unknown[]) => mockCheckLimits(...args),
}));

// ── Budget service + downgrade config (new cost-control machinery) ─────────────
const mockCheckUserBudget = vi.fn(async () => ({ exceeded: false }) as {
  exceeded: boolean;
  window?: "daily" | "weekly";
  currentUsd?: number;
  limitUsd?: number;
});
vi.mock("@/features/common/services/budget-service", () => ({
  CheckUserBudget: (...args: unknown[]) => mockCheckUserBudget(...args),
}));

const mockGetDowngradeTargets = vi.fn(() => ({
  hardCapSet: [] as string[],
  intentByClass: {} as Record<string, string>,
}));
vi.mock("@/features/common/services/downgrade-config", () => ({
  getDowngradeTargets: (...args: unknown[]) => mockGetDowngradeTargets(...args),
}));

import { resolveModelAndLimits } from "../model-selection";
import { MODEL_CONFIGS, DEFAULT_MODEL } from "../../models";
import type { ChatThreadModel } from "../../models";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeThread(overrides: Partial<ChatThreadModel> = {}): ChatThreadModel {
  return {
    id: "thread-001",
    createdAt: new Date("2026-01-01"),
    isDeleted: false,
    userId: "user-hash",
    name: "Test thread",
    type: "CHAT_THREAD",
    bookmarked: false,
    selectedModel: DEFAULT_MODEL,
    ...overrides,
  } as ChatThreadModel;
}

// Pin a deployment name so the test doesn't depend on env vars.
const PINNED_MODEL = "gpt-5.4-mini" as const;
const PINNED_CONFIG = MODEL_CONFIGS[PINNED_MODEL];
const originalDeployment = PINNED_CONFIG.deploymentName;

beforeEach(() => {
  // Give the mini model a stable deployment name for tests.
  (MODEL_CONFIGS[PINNED_MODEL] as any).deploymentName = "mini-deployment-test";
  (MODEL_CONFIGS["gpt-5.5"] as any).deploymentName = "gpt55-deployment-test";
  mockCheckLimits.mockResolvedValue({ exceeded: false });
  mockCheckUserBudget.mockResolvedValue({ exceeded: false });
  mockGetDowngradeTargets.mockReturnValue({ hardCapSet: [], intentByClass: {} });
});

afterEach(() => {
  (MODEL_CONFIGS[PINNED_MODEL] as any).deploymentName = originalDeployment;
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("resolveModelAndLimits — explicit model in payload", () => {
  it("returns the expected modelDeployment and modelConfig for the selected model", async () => {
    const thread = makeThread({ selectedModel: "gpt-5.5" });
    const result = await resolveModelAndLimits({ selectedModel: PINNED_MODEL }, thread);

    expect(result.modelDeployment).toBe("mini-deployment-test");
    expect(result.modelConfig).toBe(MODEL_CONFIGS[PINNED_MODEL]);
    expect(result.selectedModel).toBe(PINNED_MODEL);
    expect(result.fallbackInfo.fellBack).toBe(false);
  });
});

describe("resolveModelAndLimits — falls back to thread.selectedModel when payload has none", () => {
  it("uses thread.selectedModel when payload.selectedModel is undefined", async () => {
    const thread = makeThread({ selectedModel: PINNED_MODEL });
    const result = await resolveModelAndLimits({}, thread);

    expect(result.selectedModel).toBe(PINNED_MODEL);
    expect(result.modelDeployment).toBe("mini-deployment-test");
  });
});

describe("resolveModelAndLimits — limit exceeded triggers fallback", () => {
  it("returns fellBack:true and switches to fallbackModel when limit is exceeded", async () => {
    // gpt-5.5 has fallbackModel "gpt-5.4-mini"
    mockCheckLimits.mockResolvedValue({
      exceeded: true,
      fallbackModel: "gpt-5.4-mini",
      limitType: "tokens",
      currentUsage: 50_000,
      limit: 40_000,
    });

    const thread = makeThread({ selectedModel: "gpt-5.5" });
    const result = await resolveModelAndLimits({ selectedModel: "gpt-5.5" }, thread);

    expect(result.fallbackInfo.fellBack).toBe(true);
    if (result.fallbackInfo.fellBack) {
      expect(result.fallbackInfo.reason).toBe("perModel");
      expect(result.fallbackInfo.originalModel).toBe("gpt-5.5");
      expect(result.fallbackInfo.fallbackModel).toBe("gpt-5.4-mini");
      expect(result.fallbackInfo.limitType).toBe("tokens");
    }
    expect(result.selectedModel).toBe("gpt-5.4-mini");
    expect(result.modelDeployment).toBe("mini-deployment-test");
  });
});

describe("resolveModelAndLimits — per-user budget cap (highest precedence)", () => {
  it("downgrades to the cheapest eligible target and OVERRIDES an explicit pick", async () => {
    mockCheckUserBudget.mockResolvedValue({
      exceeded: true,
      window: "daily",
      currentUsd: 4.2,
      limitUsd: 3,
    });
    mockGetDowngradeTargets.mockReturnValue({
      hardCapSet: ["gpt-5.4-mini"],
      intentByClass: {},
    });

    // User explicitly picked gpt-5.5 this turn — cap must still override it.
    const thread = makeThread({ selectedModel: "gpt-5.5" });
    const result = await resolveModelAndLimits({ selectedModel: "gpt-5.5" }, thread);

    expect(result.fallbackInfo.fellBack).toBe(true);
    if (result.fallbackInfo.fellBack) {
      expect(result.fallbackInfo.reason).toBe("cap");
      expect(result.fallbackInfo.originalModel).toBe("gpt-5.5");
      expect(result.fallbackInfo.fallbackModel).toBe("gpt-5.4-mini");
      expect(result.fallbackInfo.limitType).toBe("cost");
    }
    expect(result.selectedModel).toBe("gpt-5.4-mini");
    // Per-model CheckLimits must NOT run once the cap already downgraded.
    expect(mockCheckLimits).not.toHaveBeenCalled();
  });

  it("does NOT downgrade when no eligible target is deployed (fail-safe)", async () => {
    mockCheckUserBudget.mockResolvedValue({ exceeded: true, window: "weekly", currentUsd: 9, limitUsd: 7 });
    mockGetDowngradeTargets.mockReturnValue({ hardCapSet: [], intentByClass: {} });

    const thread = makeThread({ selectedModel: "gpt-5.5" });
    const result = await resolveModelAndLimits({ selectedModel: "gpt-5.5" }, thread);

    expect(result.fallbackInfo.fellBack).toBe(false);
    expect(result.selectedModel).toBe("gpt-5.5");
  });

  it("does not 'downgrade' when the cap target equals the current model", async () => {
    mockCheckUserBudget.mockResolvedValue({ exceeded: true, window: "daily", currentUsd: 4, limitUsd: 3 });
    mockGetDowngradeTargets.mockReturnValue({ hardCapSet: ["gpt-5.4-mini"], intentByClass: {} });

    const thread = makeThread({ selectedModel: "gpt-5.4-mini" });
    const result = await resolveModelAndLimits({ selectedModel: "gpt-5.4-mini" }, thread);

    expect(result.fallbackInfo.fellBack).toBe(false);
    expect(result.selectedModel).toBe("gpt-5.4-mini");
  });
});

describe("resolveModelAndLimits — intent-based downgrade", () => {
  it("downgrades by intent when there is NO explicit pick", async () => {
    mockGetDowngradeTargets.mockReturnValue({
      hardCapSet: [],
      intentByClass: { coding: "gpt-5.4-mini" },
    });
    // No payload.selectedModel and thread stays at DEFAULT_MODEL → not explicit.
    const thread = makeThread({ selectedModel: DEFAULT_MODEL, intent: "coding" });
    const result = await resolveModelAndLimits({}, thread);

    expect(result.fallbackInfo.fellBack).toBe(true);
    if (result.fallbackInfo.fellBack) {
      expect(result.fallbackInfo.reason).toBe("intent");
      expect(result.fallbackInfo.fallbackModel).toBe("gpt-5.4-mini");
    }
    expect(result.selectedModel).toBe("gpt-5.4-mini");
  });

  it("RESPECTS an explicit pick (no intent downgrade when payload.selectedModel set)", async () => {
    mockGetDowngradeTargets.mockReturnValue({
      hardCapSet: [],
      intentByClass: { coding: "gpt-5.4-mini" },
    });
    const thread = makeThread({ selectedModel: DEFAULT_MODEL, intent: "coding" });
    const result = await resolveModelAndLimits({ selectedModel: "gpt-5.5" }, thread);

    expect(result.fallbackInfo.fellBack).toBe(false);
    expect(result.selectedModel).toBe("gpt-5.5");
  });

  it("cap takes precedence over intent", async () => {
    mockCheckUserBudget.mockResolvedValue({ exceeded: true, window: "daily", currentUsd: 4, limitUsd: 3 });
    mockGetDowngradeTargets.mockReturnValue({
      hardCapSet: ["gpt-5.4-mini"],
      intentByClass: { coding: "gpt-5.5" },
    });
    const thread = makeThread({ selectedModel: DEFAULT_MODEL, intent: "coding" });
    const result = await resolveModelAndLimits({}, thread);

    expect(result.fallbackInfo.fellBack).toBe(true);
    if (result.fallbackInfo.fellBack) {
      expect(result.fallbackInfo.reason).toBe("cap");
    }
    expect(result.selectedModel).toBe("gpt-5.4-mini");
  });
});

describe("resolveModelAndLimits — cap downgrade respects vision capability", () => {
  // Cheapest hard-cap target first (DeepSeek, text-only) then a vision-capable
  // one (Kimi). A text turn should take the cheapest; an image turn must skip
  // the text-only model and take the cheapest VISION-capable target instead —
  // otherwise the image turn would be routed to a model that can't see it.
  const VISIONLESS = "DeepSeek-V4-Pro" as const;
  const VISION_CHEAP = "Kimi-K2.6" as const;
  let savedVisionless: string | undefined;
  let savedVision: string | undefined;

  beforeEach(() => {
    savedVisionless = (MODEL_CONFIGS[VISIONLESS] as any).deploymentName;
    savedVision = (MODEL_CONFIGS[VISION_CHEAP] as any).deploymentName;
    (MODEL_CONFIGS[VISIONLESS] as any).deploymentName = "deepseek-test";
    (MODEL_CONFIGS[VISION_CHEAP] as any).deploymentName = "kimi-test";
    // Sanity: the fix relies on these real capability flags.
    expect(MODEL_CONFIGS[VISIONLESS].capabilities ?? []).not.toContain("vision");
    expect(MODEL_CONFIGS[VISION_CHEAP].capabilities ?? []).toContain("vision");
    mockCheckUserBudget.mockResolvedValue({ exceeded: true, window: "weekly", currentUsd: 9, limitUsd: 7 });
    mockGetDowngradeTargets.mockReturnValue({
      hardCapSet: [VISIONLESS, VISION_CHEAP],
      intentByClass: {},
    });
  });
  afterEach(() => {
    (MODEL_CONFIGS[VISIONLESS] as any).deploymentName = savedVisionless;
    (MODEL_CONFIGS[VISION_CHEAP] as any).deploymentName = savedVision;
  });

  it("routes a TEXT-only capped turn to the cheapest target (text-only allowed)", async () => {
    const thread = makeThread({ selectedModel: "gpt-5.5" });
    const result = await resolveModelAndLimits({ selectedModel: "gpt-5.5" }, thread);
    expect(result.selectedModel).toBe(VISIONLESS);
  });

  it("routes an IMAGE-bearing capped turn to the cheapest VISION target, NOT the text-only one", async () => {
    const thread = makeThread({ selectedModel: "gpt-5.5" });
    const result = await resolveModelAndLimits(
      { selectedModel: "gpt-5.5", multimodalImages: ["data:image/png;base64,AAAA"] },
      thread,
    );
    expect(result.selectedModel).toBe(VISION_CHEAP);
    expect(result.selectedModel).not.toBe(VISIONLESS);
  });
});

// ---------------------------------------------------------------------------
// Reasoning-effort resolution
// ---------------------------------------------------------------------------

describe("resolveModelAndLimits — reasoning effort", () => {
  it("uses the effective model's default when the user picked nothing", async () => {
    const thread = makeThread({ selectedModel: PINNED_MODEL });
    const result = await resolveModelAndLimits({}, thread);
    expect(result.effectiveReasoningEffort).toBe(
      MODEL_CONFIGS[PINNED_MODEL].defaultReasoningEffort,
    );
  });

  it("lets an explicit user pick win over the model default", async () => {
    const thread = makeThread({ selectedModel: PINNED_MODEL });
    const result = await resolveModelAndLimits(
      { reasoningEffort: "high" },
      thread,
    );
    expect(result.effectiveReasoningEffort).toBe("high");
  });

  it("applies REASONING_EFFORT_OVERRIDES for the model that actually runs", async () => {
    const { resetReasoningEffortOverridesCache } = await import(
      "../../models/reasoning-effort"
    );
    const saved = process.env.REASONING_EFFORT_OVERRIDES;
    process.env.REASONING_EFFORT_OVERRIDES = JSON.stringify({
      [PINNED_MODEL]: "high",
    });
    resetReasoningEffortOverridesCache();
    try {
      const thread = makeThread({ selectedModel: PINNED_MODEL });
      const result = await resolveModelAndLimits({}, thread);
      expect(result.effectiveReasoningEffort).toBe("high");
    } finally {
      if (saved === undefined) delete process.env.REASONING_EFFORT_OVERRIDES;
      else process.env.REASONING_EFFORT_OVERRIDES = saved;
      resetReasoningEffortOverridesCache();
    }
  });

  it("resolves the effort of the DOWNGRADED model, not the one the user asked for", async () => {
    const { resetReasoningEffortOverridesCache } = await import(
      "../../models/reasoning-effort"
    );
    const saved = process.env.REASONING_EFFORT_OVERRIDES;
    // Override only the downgrade TARGET. Resolving the effort before the
    // downgrade (the old order) would miss this entirely.
    process.env.REASONING_EFFORT_OVERRIDES = JSON.stringify({
      [PINNED_MODEL]: "minimal",
    });
    resetReasoningEffortOverridesCache();
    // The CheckLimits mock's inferred return type is the narrow
    // `{ exceeded: boolean }`; widen for the exceeded shape.
    mockCheckLimits.mockResolvedValue({
      exceeded: true,
      fallbackModel: PINNED_MODEL,
      limitType: "tokens",
      currentUsage: 50_000,
      limit: 40_000,
    } as unknown as { exceeded: boolean });
    try {
      const thread = makeThread({ selectedModel: "gpt-5.5" });
      const result = await resolveModelAndLimits(
        { selectedModel: "gpt-5.5" },
        thread,
      );
      expect(result.selectedModel).toBe(PINNED_MODEL);
      expect(result.effectiveReasoningEffort).toBe("minimal");
    } finally {
      if (saved === undefined) delete process.env.REASONING_EFFORT_OVERRIDES;
      else process.env.REASONING_EFFORT_OVERRIDES = saved;
      resetReasoningEffortOverridesCache();
    }
  });
});
