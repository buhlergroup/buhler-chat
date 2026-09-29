"use client";

import { DEFAULT_MODEL, MODEL_CONFIGS } from "./chat-services/models";

interface DefaultModelReminderProps {
  show: boolean;
}

export function shouldShowDefaultModelReminder(
  initialModel: string | undefined,
): boolean {
  return (
    !initialModel ||
    initialModel === DEFAULT_MODEL ||
    !MODEL_CONFIGS[initialModel as keyof typeof MODEL_CONFIGS]
  );
}

export function DefaultModelReminder({ show }: DefaultModelReminderProps) {
  if (!show) return null;

  return (
    <div
      role="status"
      aria-live="polite"
      className="mb-2 rounded border border-border bg-muted/60 px-3 py-2 text-xs text-muted-foreground"
    >
      This chat is using the configured default model: {" "}
      <span className="font-semibold text-foreground">
        {MODEL_CONFIGS[DEFAULT_MODEL]?.name ?? DEFAULT_MODEL}
      </span>.
    </div>
  );
}