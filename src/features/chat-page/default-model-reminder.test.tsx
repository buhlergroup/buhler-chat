import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { MODEL_CONFIGS } from "./chat-services/models";
import {
  DefaultModelReminder,
  shouldShowDefaultModelReminder,
} from "./default-model-reminder";

// A server default that differs from the client code default, as when
// DEFAULT_MODEL_ID is set on the server.
const SERVER_DEFAULT = "gpt-5.6-terra";

describe("DefaultModelReminder", () => {
  it("appears when no model is saved and names the server default", () => {
    expect(shouldShowDefaultModelReminder(undefined, SERVER_DEFAULT, 0)).toBe(true);
    render(<DefaultModelReminder show defaultModel={SERVER_DEFAULT} />);

    expect(screen.getByRole("status")).toHaveTextContent(
      `This chat is using the configured default model: ${MODEL_CONFIGS[SERVER_DEFAULT].name}.`
    );
  });

  it("appears when a new thread explicitly stores the server default", () => {
    expect(shouldShowDefaultModelReminder(SERVER_DEFAULT, SERVER_DEFAULT, 0)).toBe(true);
  });

  it("stays hidden on an existing thread that uses the default model", () => {
    expect(shouldShowDefaultModelReminder(SERVER_DEFAULT, SERVER_DEFAULT, 3)).toBe(false);
    expect(shouldShowDefaultModelReminder(undefined, SERVER_DEFAULT, 1)).toBe(false);
  });

  it("is dismissed after an explicit model selection", () => {
    const { rerender } = render(
      <DefaultModelReminder show defaultModel={SERVER_DEFAULT} />
    );
    expect(screen.getByRole("status")).toBeInTheDocument();

    rerender(<DefaultModelReminder show={false} defaultModel={SERVER_DEFAULT} />);
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("stays hidden when the thread began with a valid non-default model", () => {
    const otherModel = Object.keys(MODEL_CONFIGS).find(
      (model) => model !== SERVER_DEFAULT
    );
    expect(otherModel).toBeDefined();
    expect(shouldShowDefaultModelReminder(otherModel, SERVER_DEFAULT, 0)).toBe(false);
    render(<DefaultModelReminder show={false} defaultModel={SERVER_DEFAULT} />);

    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });
});
