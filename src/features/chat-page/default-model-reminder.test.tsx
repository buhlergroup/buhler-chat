import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { DEFAULT_MODEL, MODEL_CONFIGS } from "./chat-services/models";
import {
  DefaultModelReminder,
  shouldShowDefaultModelReminder,
} from "./default-model-reminder";

describe("DefaultModelReminder", () => {
  it("appears when no model is saved and names the configured default", () => {
    expect(shouldShowDefaultModelReminder(undefined)).toBe(true);
    render(<DefaultModelReminder show />);

    expect(screen.getByRole("status")).toHaveTextContent(
      `This chat is using the configured default model: ${MODEL_CONFIGS[DEFAULT_MODEL].name}.`
    );
  });

  it("appears when a new thread explicitly stores the configured default", () => {
    expect(shouldShowDefaultModelReminder(DEFAULT_MODEL)).toBe(true);
  });

  it("is dismissed after an explicit model selection", () => {
    const { rerender } = render(
      <DefaultModelReminder show />
    );
    expect(screen.getByRole("status")).toBeInTheDocument();

    rerender(<DefaultModelReminder show={false} />);
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("stays hidden when the thread began with a valid non-default model", () => {
    const otherModel = Object.keys(MODEL_CONFIGS).find(
      (model) => model !== DEFAULT_MODEL
    );
    expect(otherModel).toBeDefined();
    expect(shouldShowDefaultModelReminder(otherModel)).toBe(false);
    render(<DefaultModelReminder show={false} />);

    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });
});