"use client";

import { ExternalLink } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { Badge } from "@/features/ui/badge";
import {
  ModelConfig,
  ModelCapability,
  ModelPricing,
} from "../chat-services/models";
import { Code, Cpu, Eye, Globe, ImagePlus, Zap } from "lucide-react";

/** Icon + label for each capability badge shown on a model row. */
const CAPABILITY_META: Record<ModelCapability, { icon: LucideIcon; label: string }> = {
  vision: { icon: Eye, label: "Image input" },
  imageGen: { icon: ImagePlus, label: "Image generation" },
  webSearch: { icon: Globe, label: "Web search" },
  code: { icon: Code, label: "Code / Python" },
};

export const PRICING_TIER_THRESHOLDS = {
  low: 1,
  middle: 10,
} as const;

export type PricingTier = "low" | "middle" | "high";

/** Classify by the more expensive of input and output tokens. */
export function getPricingTier(pricing: ModelPricing): PricingTier {
  const score = Math.max(pricing.inputPerMillion, pricing.outputPerMillion);

  if (score <= PRICING_TIER_THRESHOLDS.low) return "low";
  if (score <= PRICING_TIER_THRESHOLDS.middle) return "middle";
  return "high";
}

export const PRICING_TIER_CLASSES: Record<PricingTier, string> = {
  low: "text-green-600 dark:text-green-400",
  middle: "text-amber-600 dark:text-amber-400",
  high: "text-red-600 dark:text-red-400",
};

/** Badge variant for each model badge label. */
function badgeVariantForLabel(
  badge: string | undefined,
): "default" | "secondary" | "outline" {
  switch (badge) {
    case "Best value":
      return "secondary";
    case "Fast":
      return "secondary";
    case "Balanced":
      return "outline";
    case "Deep reasoning":
      return "default";
    case "Agentic":
      return "default";
    default:
      return "secondary";
  }
}

export interface ModelOptionProps {
  model: ModelConfig;
  isSelected: boolean;
  isDisabled: boolean;
  disabledReason?: string;
  showName?: boolean;
  /** When true, the disabled reason replaces the description/metadata. */
  showDisabledReasonInline: boolean;
}

export function ModelOptionName({ model }: { model: ModelConfig }) {
  return <span className="font-medium text-sm">{model.name}</span>;
}

/**
 * Shared model-option content used by both the header dropdown and the
 * composer Select. Renders the model name, badge, description, task area,
 * "excels at" use case, pricing, capability icons, and an optional details
 * link.
 *
 * This component is intentionally stateless and client-safe: it receives
 * everything it needs as props and has no server-only imports.
 */
export function ModelOptionContent({
  model,
  isSelected,
  isDisabled,
  disabledReason,
  showName = true,
  showDisabledReasonInline,
}: ModelOptionProps) {
  const pricing = model.pricing;

  return (
    <div className="flex items-start gap-3 flex-1 min-w-0">
      {/* Icon column */}
      <div className="flex-shrink-0 mt-0.5">
        {model.supportsReasoning ? (
          <Cpu size={16} className="text-blue-600" />
        ) : (
          <Zap size={16} className="text-green-600" />
        )}
      </div>

      {/* Content column */}
      <div className="flex flex-col gap-1 flex-1 min-w-0">
        {/* Row 1: name + badges */}
        <div className="flex items-center gap-2 flex-wrap">
          {showName && <ModelOptionName model={model} />}
          {model.badge && (
            <Badge variant={badgeVariantForLabel(model.badge)} className="text-[10px] leading-none px-1.5 py-0.5">
              {model.badge}
            </Badge>
          )}
          {isSelected && (
            <span className="text-xs bg-primary text-primary-foreground px-1.5 py-0.5 rounded">
              Selected
            </span>
          )}
        </div>

        {/* When disabled, the reason replaces the rich metadata so the
            explanation is visible inline (critical on touch, where hover
            tooltips never fire). */}
        {isDisabled && showDisabledReasonInline ? (
          <span className="text-xs text-muted-foreground">
            {disabledReason}
          </span>
        ) : (
          <>
            {/* Description */}
            <span className="text-xs text-muted-foreground">
              {model.description}
            </span>

            {/* Task area + excels at */}
            {model.taskArea && (
              <div className="text-xs text-muted-foreground/80">
                <span className="font-semibold">Task: </span>
                {model.taskArea}
              </div>
            )}
            {model.excelsAt && (
              <div className="text-xs text-muted-foreground/80">
                <span className="font-semibold">Excels at: </span>
                {model.excelsAt}
              </div>
            )}

            {/* Pricing row */}
            <div className="text-xs text-muted-foreground/70">
              <span className="font-semibold">Pricing: </span>
              <span className={PRICING_TIER_CLASSES[getPricingTier(pricing)]}>
                ${pricing.inputPerMillion.toFixed(2)} in / $
                {pricing.outputPerMillion.toFixed(2)} out
                {pricing.cachedInputPerMillion !== undefined &&
                  pricing.cachedInputPerMillion < pricing.inputPerMillion && (
                    <span className="ml-1">
                      (${pricing.cachedInputPerMillion.toFixed(2)} cached)
                    </span>
                  )}
              </span>
              <span className="ml-1">per 1M tokens</span>
            </div>

            {/* Capability icons */}
            {model.capabilities && model.capabilities.length > 0 && (
              <div className="flex items-center gap-2 mt-0.5">
                {model.capabilities.map((cap) => {
                  const meta = CAPABILITY_META[cap];
                  const Icon = meta.icon;
                  return (
                    <span
                      key={cap}
                      title={meta.label}
                      aria-label={meta.label}
                      className="text-muted-foreground/70"
                    >
                      <Icon size={13} />
                    </span>
                  );
                })}
              </div>
            )}

            {/* Details link */}
            {model.detailsUrl && (
              <a
                href={model.detailsUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 text-xs text-primary hover:underline mt-0.5"
                onClick={(e) => {
                  // Stop propagation so clicking the link doesn't also select
                  // the model in the dropdown.
                  e.stopPropagation();
                }}
              >
                Learn more
                <ExternalLink size={11} />
              </a>
            )}
          </>
        )}
      </div>
    </div>
  );
}