"use client";

import { MODEL_CONFIGS } from "./chat-services/models";

interface DefaultModelReminderProps {
  show: boolean;
  /**
   * The server default model (DEFAULT_MODEL resolved on the server, which
   * honours DEFAULT_MODEL_ID). The client bundle only knows the code default.
   */
  defaultModel: string;
}

/**
 * The reminder is for new chats only: a thread with no messages yet whose
 * model is the server default (or missing / unknown, which also falls back to
 * the default).
 */
export function shouldShowDefaultModelReminder(
  initialModel: string | undefined,
  defaultModel: string,
  messageCount: number,
): boolean {
  if (messageCount > 0) return false;
  return (
    !initialModel ||
    initialModel === defaultModel ||
    !MODEL_CONFIGS[initialModel as keyof typeof MODEL_CONFIGS]
  );
}

export function DefaultModelReminder({ show, defaultModel }: DefaultModelReminderProps) {
  if (!show) return null;

  return (
    <div
      role="status"
      aria-live="polite"
      className="mb-2 rounded border border-border bg-muted/60 px-3 py-2 text-xs text-muted-foreground"
    >
      This chat is using the configured default model: {" "}
      <span className="font-semibold text-foreground">
        {MODEL_CONFIGS[defaultModel as keyof typeof MODEL_CONFIGS]?.name ?? defaultModel}
      </span>.
    </div>
  );
}
