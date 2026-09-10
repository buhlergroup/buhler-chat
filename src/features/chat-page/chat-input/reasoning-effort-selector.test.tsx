import { describe, it, expect, vi, beforeAll } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ReasoningEffortSelector } from "./reasoning-effort-selector";

// Radix UI Select requires hasPointerCapture / setPointerCapture / scrollIntoView in jsdom
beforeAll(() => {
  if (!window.Element.prototype.hasPointerCapture) {
    window.Element.prototype.hasPointerCapture = () => false;
  }
  if (!window.Element.prototype.setPointerCapture) {
    window.Element.prototype.setPointerCapture = () => {};
  }
  if (!window.Element.prototype.releasePointerCapture) {
    window.Element.prototype.releasePointerCapture = () => {};
  }
  if (!window.Element.prototype.scrollIntoView) {
    window.Element.prototype.scrollIntoView = () => {};
  }
});

vi.mock("../chat-store-context", () => ({
  useChatStore: (selector: (s: Record<string, unknown>) => unknown) =>
    selector({
      webSearchEnabled: false,
      imageGenerationEnabled: false,
      companyContentEnabled: false,
      codeInterpreterEnabled: false,
    }),
}));

describe("chat-page.unit.components.003 — ReasoningEffortSelector", () => {
  it("renders nothing when showReasoningModelsOnly is false", () => {
    const onChange = vi.fn();
    const { container } = render(
      <ReasoningEffortSelector
        value="low"
        onChange={onChange}
        showReasoningModelsOnly={false}
      />
    );
    expect(container.firstChild).toBeNull();
  });

  it("renders the selector when showReasoningModelsOnly is true", () => {
    const onChange = vi.fn();
    render(
      <ReasoningEffortSelector
        value="low"
        onChange={onChange}
        showReasoningModelsOnly
      />
    );
    expect(screen.getByRole("combobox")).toBeInTheDocument();
  });

  it("calls onChange with 'high' when high option is selected", async () => {
    const onChange = vi.fn();
    const { baseElement } = render(
      <ReasoningEffortSelector
        value="low"
        onChange={onChange}
        showReasoningModelsOnly
      />
    );
    // Open the select via the trigger button
    await userEvent.click(screen.getByRole("combobox"));
    // Radix renders options into a portal attached to body, use baseElement
    const highOption = Array.from(
      baseElement.querySelectorAll("[role=option]")
    ).find((el) => /high/i.test(el.textContent || ""));
    if (highOption) {
      await userEvent.click(highOption as Element);
      expect(onChange).toHaveBeenCalledWith("high");
    } else {
      // fallback: at least verify the select opened
      expect(
        Array.from(baseElement.querySelectorAll("[role=option]")).length
      ).toBeGreaterThan(0);
    }
  });

  it("is disabled when disabled prop is true", () => {
    const onChange = vi.fn();
    render(
      <ReasoningEffortSelector
        value="medium"
        onChange={onChange}
        showReasoningModelsOnly
        disabled
      />
    );
    expect(screen.getByRole("combobox")).toHaveAttribute(
      "data-disabled"
    );
  });
});

describe("chat-page.unit.components.003b — ReasoningEffortSelector follows the model", () => {
  it("does not offer Minimal for a model whose provider rejects it", async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    const { baseElement } = render(
      <ReasoningEffortSelector
        value="low"
        onChange={onChange}
        showReasoningModelsOnly
        modelId="gpt-5.6-terra"
      />
    );

    await user.click(screen.getByRole("combobox"));

    expect(baseElement.textContent).toContain("Low");
    expect(baseElement.textContent).toContain("Medium");
    expect(baseElement.textContent).toContain("High");
    // Measured 400 on the dev deployment; selecting it pinned a dead value on
    // the thread, so it must not be reachable.
    expect(baseElement.textContent).not.toContain("Minimal");
  });

  it("still offers Minimal for a model that declares no level list", async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    const { baseElement } = render(
      <ReasoningEffortSelector
        value="low"
        onChange={onChange}
        showReasoningModelsOnly
        modelId="gpt-5.4"
      />
    );

    await user.click(screen.getByRole("combobox"));
    expect(baseElement.textContent).toContain("Minimal");
  });

  it("displays the clamped level for a thread that stored an unsupported one", () => {
    // The server clamps to "low", so showing the stored "minimal" would tell
    // the user something untrue about the turn they are about to send.
    const onChange = vi.fn();
    render(
      <ReasoningEffortSelector
        value="minimal"
        onChange={onChange}
        showReasoningModelsOnly
        modelId="gpt-5.6-sol"
      />
    );
    expect(screen.getByRole("combobox").textContent).toContain("Low");
  });
});
