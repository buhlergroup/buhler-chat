import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/features/ui/select";
import { DEFAULT_MODEL, MODEL_CONFIGS } from "../chat-services/models";
import {
  getPricingTier,
  ModelOptionContent,
  PRICING_TIER_CLASSES,
  PRICING_TIER_THRESHOLDS,
} from "./model-option";

describe("model-option pricing presentation", () => {
  it("classifies the higher input/output price against the shared thresholds", () => {
    expect(PRICING_TIER_THRESHOLDS).toEqual({ low: 1, middle: 10 });
    expect(getPricingTier({ inputPerMillion: 0.2, outputPerMillion: 1 })).toBe("low");
    expect(getPricingTier({ inputPerMillion: 1.01, outputPerMillion: 10 })).toBe("middle");
    expect(getPricingTier({ inputPerMillion: 2, outputPerMillion: 10.01 })).toBe("high");
    expect(PRICING_TIER_CLASSES).toEqual({
      low: "text-green-600 dark:text-green-400",
      middle: "text-amber-600 dark:text-amber-400",
      high: "text-red-600 dark:text-red-400",
    });
  });

  it("renders semibold neutral labels, exact prices, and light/dark tier colors", () => {
    const model = {
      ...MODEL_CONFIGS[DEFAULT_MODEL],
      taskArea: "Analysis",
      excelsAt: "Detailed reasoning",
      pricing: {
        inputPerMillion: 0.25,
        outputPerMillion: 4,
        cachedInputPerMillion: 0.05,
      },
    };
    const { container } = render(
      <ModelOptionContent
        model={model}
        isSelected={false}
        isDisabled={false}
        showDisabledReasonInline={false}
      />
    );

    const taskLabel = container.querySelector("span.font-semibold");
    const labels = Array.from(container.querySelectorAll("span.font-semibold"));
    const pricing = container.querySelector(".text-amber-600");

    expect(taskLabel).toHaveTextContent("Task:");
    expect(labels.map((label) => label.textContent?.trim())).toEqual([
      "Task:",
      "Excels at:",
      "Pricing:",
    ]);
    expect(labels.every((label) => !label.className.includes("text-green"))).toBe(true);
    expect(container.textContent).toContain("$0.25 in / $4.00 out");
    expect(container.textContent).toContain("($0.05 cached)");
    expect(pricing).toHaveClass("dark:text-amber-400");
  });

  it("opens the Learn more link in the composer Select without changing the model", async () => {
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
      configurable: true,
      value: vi.fn(),
    });
    const model = MODEL_CONFIGS[DEFAULT_MODEL];
    expect(model.detailsUrl).toBeTruthy();
    const onValueChange = vi.fn();
    const user = userEvent.setup({ pointerEventsCheck: 0 });

    render(
      <Select value="other-model" onValueChange={onValueChange}>
        <SelectTrigger>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="other-model">Other model</SelectItem>
          <SelectItem value={model.id} textValue={model.name}>
            <ModelOptionContent
              model={model}
              isSelected={false}
              isDisabled={false}
              showDisabledReasonInline={false}
            />
          </SelectItem>
        </SelectContent>
      </Select>
    );

    const trigger = screen.getByRole("combobox");
    trigger.focus();
    await user.keyboard("{ArrowDown}");
    const link = (await screen.findByText("Learn more")).closest("a")!;
    const linkClicks = vi.fn((e: MouseEvent) => e.preventDefault());
    link.addEventListener("click", linkClicks);

    await user.click(link);

    // The native click reaches the link, so the browser opens it ...
    expect(linkClicks).toHaveBeenCalledTimes(1);
    // ... and Radix does not select the item on pointerup or close the list.
    expect(onValueChange).not.toHaveBeenCalled();
    expect(screen.getByText("Learn more")).toBeInTheDocument();

    // A mouse pick elsewhere on the same item still selects the model.
    await user.click(screen.getByText(model.description));
    expect(onValueChange).toHaveBeenCalledWith(model.id);
  });
});