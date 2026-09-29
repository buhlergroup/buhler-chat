import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "./select";

describe("SelectItem compactText", () => {
  it("uses compact text in the closed trigger and keeps rich content in the menu", async () => {
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
      configurable: true,
      value: vi.fn(),
    });

    render(
      <Select value="model-a" onValueChange={vi.fn()}>
        <SelectTrigger>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem
            value="model-a"
            textValue="Model A"
            compactText={<span>Model A</span>}
          >
            <div>
              <span>General-purpose analysis</span>
              <span>Pricing: $1.00 in / $4.00 out</span>
              <span>Learn more</span>
            </div>
          </SelectItem>
        </SelectContent>
      </Select>
    );

    const trigger = screen.getByRole("combobox");
    expect(trigger).toHaveTextContent("Model A");
    expect(trigger).not.toHaveTextContent(/Pricing:|Learn more|General-purpose/);

    trigger.focus();
    fireEvent.keyDown(trigger, { key: "ArrowDown" });
    const option = await screen.findByRole("option");
    expect(option).toHaveTextContent("Model A");
    expect(option).toHaveTextContent("General-purpose analysis");
    expect(option).toHaveTextContent("Pricing: $1.00 in / $4.00 out");
    expect(option).toHaveTextContent("Learn more");
  });
});