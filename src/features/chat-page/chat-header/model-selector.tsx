"use client";
import { Button } from "@/features/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/features/ui/dropdown-menu";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/features/ui/tooltip";
import { ChevronDown, Cpu, Lock, Zap } from "lucide-react";
import { FC, useCallback, useEffect, useState } from "react";
import {
  ChatModel,
  MODEL_CONFIGS,
  getModelAvailability,
  ModelConfig,
  DisabledModels,
} from "../chat-services/models";
import { logError } from "@/features/common/services/logger";
import { ModelOptionContent } from "./model-option";

interface ModelSelectorProps {
  selectedModel: ChatModel;
  /**
   * The model the LAST turn actually ran on (from usage metadata). When it
   * differs from selectedModel, an automatic downgrade (budget cap or intent
   * routing) is in effect — the trigger reflects what's really being used so
   * the label isn't misleading.
   */
  effectiveModel?: ChatModel;
  onModelChange: (model: ChatModel) => void;
  disabled?: boolean;
}

export const ModelSelector: FC<ModelSelectorProps> = ({
  selectedModel,
  effectiveModel,
  onModelChange,
  disabled = false,
}) => {
  const [availableModels, setAvailableModels] = useState<Record<ChatModel, ModelConfig>>(MODEL_CONFIGS);
  const [disabledModels, setDisabledModels] = useState<DisabledModels>({});
  const [loading, setLoading] = useState(true);

  const refreshAvailability = useCallback(async () => {
    try {
      const { availableModels, disabledModels } = await getModelAvailability();
      setAvailableModels(availableModels);
      setDisabledModels(disabledModels);
    } catch (error) {
      logError('Error fetching available models', { error: error instanceof Error ? error.message : String(error) });
      // Fallback to all models if API fails
      setAvailableModels(MODEL_CONFIGS);
      setDisabledModels({});
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refreshAvailability();
  }, [refreshAvailability]);

  // A finished turn may have downgraded the model (budget cap / intent). When
  // the effective model diverges from the pick, re-fetch availability so the
  // dropdown's grey-out reflects the new budget state without a manual reopen.
  useEffect(() => {
    if (effectiveModel && effectiveModel !== selectedModel) {
      refreshAvailability();
    }
  }, [effectiveModel, selectedModel, refreshAvailability]);

  // Show the model actually in use. If a downgrade is active, that's the
  // effective model, not the (now-overridden) pick.
  const downgradeActive = !!(
    effectiveModel &&
    effectiveModel !== selectedModel &&
    MODEL_CONFIGS[effectiveModel]
  );
  const displayModelId = downgradeActive ? effectiveModel! : selectedModel;
  const currentModel = MODEL_CONFIGS[displayModelId];

  return (
    <TooltipProvider delayDuration={150}>
      <DropdownMenu
        onOpenChange={(open) => {
          // Budget state can tip over mid-session; re-check when the user
          // opens the picker so the grey-out reflects current reality rather
          // than the value cached at mount.
          if (open) refreshAvailability();
        }}
      >
        <DropdownMenuTrigger asChild>
          <Button
            variant="outline"
            size="sm"
            disabled={disabled || loading}
            className="flex items-center gap-2 h-8"
            title={
              downgradeActive
                ? `Auto-selected ${currentModel?.name} to manage cost — pick a model to override`
                : undefined
            }
          >
            {currentModel?.supportsReasoning ? (
              <Cpu size={14} />
            ) : (
              <Zap size={14} />
            )}
            <span className="text-sm">{currentModel?.name || displayModelId}</span>
            {downgradeActive && (
              <span className="text-[10px] leading-none text-muted-foreground border rounded px-1 py-0.5">
                auto
              </span>
            )}
            <ChevronDown size={14} />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align="start"
          // Cap to the viewport height Radix leaves available (accounts for
          // trigger position + collisions) and scroll vertically so a long
          // model list isn't clipped on small screens.
          // Widened from w-64 to accommodate the richer metadata (pricing,
          // task area, excels at, details link).
          className="w-[28rem] max-w-[calc(100vw-2rem)] max-h-[var(--radix-dropdown-menu-content-available-height)] overflow-y-auto"
        >
          {loading ? (
            <DropdownMenuItem disabled className="p-3">
              Loading models...
            </DropdownMenuItem>
          ) : (
            Object.values(availableModels).map((model) => {
              const disabledReason = disabledModels[model.id]?.reason;
              const isDisabled = !!disabledReason;
              const reasonId = `model-reason-${model.id}`;

              const item = (
                <DropdownMenuItem
                  disabled={isDisabled}
                  onClick={() => {
                    if (!isDisabled) onModelChange(model.id);
                  }}
                  className="flex items-start gap-3 p-3 cursor-pointer"
                >
                  {isDisabled && (
                    <Lock size={14} className="flex-shrink-0 mt-0.5 text-muted-foreground" />
                  )}
                  <ModelOptionContent
                    model={model}
                    isSelected={selectedModel === model.id}
                    isDisabled={isDisabled}
                    disabledReason={disabledReason}
                    showDisabledReasonInline={isDisabled}
                  />
                </DropdownMenuItem>
              );

              if (!isDisabled) return <div key={model.id}>{item}</div>;

              // Disabled (e.g. over budget): keep it visible but greyed, expose
              // the reason to hover (desktop) AND to screen readers via
              // aria-describedby, and make the whole row keyboard-focusable so
              // non-mouse users can reach the explanation.
              return (
                <Tooltip key={model.id}>
                  <TooltipTrigger asChild>
                    <span
                      tabIndex={0}
                      role="note"
                      aria-disabled="true"
                      aria-describedby={reasonId}
                      className="block cursor-not-allowed opacity-60 focus:outline-none focus:ring-1 focus:ring-ring rounded-sm"
                    >
                      {item}
                      <span id={reasonId} className="sr-only">
                        {disabledReason}
                      </span>
                    </span>
                  </TooltipTrigger>
                  <TooltipContent side="right" className="max-w-56">
                    {disabledReason}
                  </TooltipContent>
                </Tooltip>
              );
            })
          )}
        </DropdownMenuContent>
      </DropdownMenu>
    </TooltipProvider>
  );
};
