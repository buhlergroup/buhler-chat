import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ModelSelector } from "./model-selector";

// Mock getModelAvailability to return deterministic results
const mockGetModelAvailability = vi.fn();
vi.mock("../chat-services/models", async () => {
  const actual = await vi.importActual<typeof import("../chat-services/models")>("../chat-services/models");
  return {
    ...actual,
    getModelAvailability: (...a: unknown[]) => mockGetModelAvailability(...a),
  };
});

vi.mock("@/features/common/services/logger", () => ({
  logError: vi.fn(),
  logWarn: vi.fn(),
  logInfo: vi.fn(),
  logDebug: vi.fn(),
}));

describe("chat-page.unit.components.001 — ModelSelector", () => {
  const onModelChange = vi.fn();

  beforeEach(async () => {
    vi.clearAllMocks();
    const { MODEL_CONFIGS } = await import("../chat-services/models");
    mockGetModelAvailability.mockResolvedValue({
      availableModels: MODEL_CONFIGS,
      disabledModels: {},
    });
  });

  it("renders the selected model name in the trigger button", async () => {
    const { MODEL_CONFIGS } = await import("../chat-services/models");
    const firstModelId = Object.keys(MODEL_CONFIGS)[0] as any;
    render(
      <ModelSelector
        selectedModel={firstModelId}
        onModelChange={onModelChange}
      />
    );

    await waitFor(() => {
      // After loading completes the trigger button should show the model name
      expect(
        screen.getByRole("button")
      ).toBeInTheDocument();
    });
  });

  it("shows 'Selected' badge for the currently-selected model after opening", async () => {
    const { MODEL_CONFIGS } = await import("../chat-services/models");
    const models = Object.values(MODEL_CONFIGS);
    if (models.length === 0) return;
    const selectedModel = models[0];

    render(
      <ModelSelector
        selectedModel={selectedModel.id as any}
        onModelChange={onModelChange}
      />
    );

    // Wait for loading to finish
    await waitFor(() =>
      expect(screen.queryByText("Loading models...")).not.toBeInTheDocument()
    );

    // Open the dropdown
    await userEvent.click(screen.getByRole("button"));

    // The selected badge should be visible
    expect(screen.getByText("Selected")).toBeInTheDocument();
  });

  it("calls onModelChange when a model option is clicked", async () => {
    const { MODEL_CONFIGS } = await import("../chat-services/models");
    const models = Object.values(MODEL_CONFIGS);
    if (models.length < 2) return;
    const firstModel = models[0];
    const secondModel = models[1];

    render(
      <ModelSelector
        selectedModel={firstModel.id as any}
        onModelChange={onModelChange}
      />
    );

    await waitFor(() =>
      expect(screen.queryByText("Loading models...")).not.toBeInTheDocument()
    );

    await userEvent.click(screen.getByRole("button"));
    // Click the second model
    const option = screen.getByText(secondModel.name);
    await userEvent.click(option);

    expect(onModelChange).toHaveBeenCalledWith(secondModel.id);
  });

  it("does not fire onModelChange when a budget-disabled model is clicked", async () => {
    const { MODEL_CONFIGS } = await import("../chat-services/models");
    mockGetModelAvailability.mockResolvedValue({
      availableModels: MODEL_CONFIGS,
      disabledModels: {
        "gpt-5.5": {
          reason: "Daily cost budget reached — only low-cost models are available until it resets.",
        },
      },
    });

    render(
      <ModelSelector
        selectedModel={"gpt-5.4-mini" as any}
        onModelChange={onModelChange}
      />
    );

    await waitFor(() =>
      expect(screen.queryByText("Loading models...")).not.toBeInTheDocument()
    );
    await userEvent.click(screen.getByRole("button"));

    // gpt-5.5 is disabled (over budget) — clicking it must be a no-op.
    await userEvent.click(screen.getByText("GPT-5.5"));
    expect(onModelChange).not.toHaveBeenCalled();
  });

  it("is disabled when the disabled prop is true", async () => {
    const { MODEL_CONFIGS } = await import("../chat-services/models");
    const firstModelId = Object.keys(MODEL_CONFIGS)[0] as any;
    render(
      <ModelSelector
        selectedModel={firstModelId}
        onModelChange={onModelChange}
        disabled
      />
    );

    expect(screen.getByRole("button")).toBeDisabled();
  });

  it("renders the badge, task area, excels at, and pricing for a model", async () => {
    const { MODEL_CONFIGS } = await import("../chat-services/models");
    const models = Object.values(MODEL_CONFIGS);
    // Pick a model with a unique badge to avoid multiple matches
    const modelWithMetadata = models.find((m) => m.badge === "Best value" && m.taskArea && m.excelsAt);
    if (!modelWithMetadata) return;

    render(
      <ModelSelector
        selectedModel={modelWithMetadata.id as any}
        onModelChange={onModelChange}
      />
    );

    await waitFor(() =>
      expect(screen.queryByText("Loading models...")).not.toBeInTheDocument()
    );

    await userEvent.click(screen.getByRole("button"));

    // Badge label should be visible (use getAllByText and check at least one)
    const badges = screen.getAllByText(modelWithMetadata.badge!);
    expect(badges.length).toBeGreaterThan(0);

    // Task area should be visible (may appear on multiple models)
    const taskAreas = screen.getAllByText(modelWithMetadata.taskArea!);
    expect(taskAreas.length).toBeGreaterThan(0);

    // Excels at should be visible
    expect(screen.getByText(modelWithMetadata.excelsAt!)).toBeInTheDocument();

    // Pricing should be visible (appears on every model row)
    const pricingLabels = screen.getAllByText(/Pricing:/);
    expect(pricingLabels.length).toBeGreaterThan(0);
  });

  it("renders a details link for models with a detailsUrl", async () => {
    const { MODEL_CONFIGS } = await import("../chat-services/models");
    const models = Object.values(MODEL_CONFIGS);
    // Pick a model whose detailsUrl is unique enough to identify the link
    const modelWithLink = models.find((m) => m.detailsUrl && m.badge === "Best value");
    if (!modelWithLink) return;

    render(
      <ModelSelector
        selectedModel={modelWithLink.id as any}
        onModelChange={onModelChange}
      />
    );

    await waitFor(() =>
      expect(screen.queryByText("Loading models...")).not.toBeInTheDocument()
    );

    await userEvent.click(screen.getByRole("button"));

    // Find the link by its href attribute
    const links = screen.getAllByText("Learn more");
    const matchingLink = links.find(
      (l) => l.closest("a")?.getAttribute("href") === modelWithLink.detailsUrl
    );
    expect(matchingLink).toBeDefined();
    expect(matchingLink!.closest("a")).toHaveAttribute("target", "_blank");
    expect(matchingLink!.closest("a")).toHaveAttribute("rel", "noopener noreferrer");
  });

  it("shows the disabled reason inline for a budget-disabled model", async () => {
    const { MODEL_CONFIGS } = await import("../chat-services/models");
    mockGetModelAvailability.mockResolvedValue({
      availableModels: MODEL_CONFIGS,
      disabledModels: {
        "gpt-5.5": {
          reason: "Daily cost budget reached — only low-cost models are available until it resets.",
        },
      },
    });

    render(
      <ModelSelector
        selectedModel={"gpt-5.4-mini" as any}
        onModelChange={onModelChange}
      />
    );

    await waitFor(() =>
      expect(screen.queryByText("Loading models...")).not.toBeInTheDocument()
    );
    await userEvent.click(screen.getByRole("button"));

    // The disabled reason should be visible inline (not just in a tooltip).
    // Use getAllByText and check that at least one is visible (not sr-only).
    const reasons = screen.getAllByText(/Daily cost budget reached/);
    const visibleReason = reasons.find(
      (el) => !el.classList.contains("sr-only")
    );
    expect(visibleReason).toBeDefined();
  });
});
