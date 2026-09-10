"use client";

import { Brain } from "lucide-react";
import React from "react";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/features/ui/select";
import {
  ChatModel,
  clampReasoningEffort,
  getPickableReasoningEfforts,
  ReasoningEffort,
} from "../chat-services/models";
import { useChatStore } from "../chat-store-context";

interface ReasoningEffortSelectorProps {
  value: ReasoningEffort;
  onChange: (value: ReasoningEffort) => void;
  disabled?: boolean;
  showReasoningModelsOnly?: boolean;
  /**
   * The model the next turn will run on. Decides which levels are offered:
   * not every model accepts all four, and one that is offered anyway gets
   * pinned on the thread and then answers 400 on every turn. Omitted means
   * "no model known", which falls back to all four.
   */
  modelId?: ChatModel;
}

export const ReasoningEffortSelector: React.FC<ReasoningEffortSelectorProps> = ({
  value,
  onChange,
  disabled = false,
  showReasoningModelsOnly = false,
  modelId,
}) => {
  const toolsEnabled = useChatStore(
    (s) =>
      s.webSearchEnabled ||
      s.imageGenerationEnabled ||
      s.companyContentEnabled ||
      s.codeInterpreterEnabled,
  );

  if (!showReasoningModelsOnly) {
    return null;
  }

  const allEffortOptions = [
    {
      value: "minimal" as ReasoningEffort,
      label: "Minimal",
      description: "Fastest, minimal reasoning",
      disabled: toolsEnabled,
    },
    {
      value: "low" as ReasoningEffort,
      label: "Low",
      description: "Quick responses, basic reasoning",
      disabled: false,
    },
    {
      value: "medium" as ReasoningEffort,
      label: "Medium",
      description: "Balanced reasoning and speed",
      disabled: false,
    },
    {
      value: "high" as ReasoningEffort,
      label: "High",
      description: "Deep analysis, thorough reasoning",
      disabled: false,
    },
  ];

  // Only what this model's provider accepts. "Minimal" was offered to every
  // reasoning model and no GPT-5.5 or 5.6 deployment takes it, so selecting it
  // pinned a value on the thread that answered 400 from then on.
  const pickable = getPickableReasoningEfforts(modelId);
  const effortOptions = allEffortOptions.filter((o) => pickable.includes(o.value));

  // Show what will actually be sent. A thread that stored an effort this model
  // does not accept is clamped server-side, so displaying the stored value
  // would tell the user something untrue about their next turn.
  const shownValue = clampReasoningEffort(modelId, value) as ReasoningEffort;

  return (
    <div className="flex items-center">
      <Select value={shownValue} onValueChange={onChange} disabled={disabled}>
        <SelectTrigger className="w-auto h-8 text-xs gap-1 px-2">
          <Brain size={14} className="text-blue-500 shrink-0" />
          <SelectValue placeholder="Reasoning" />
        </SelectTrigger>
        <SelectContent>
          {effortOptions.map((option) => (
            <SelectItem 
              key={option.value} 
              value={option.value}
              disabled={option.disabled}
            >
              <div className="flex flex-col">
                <span className="font-medium">{option.label}</span>
              </div>
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
};
