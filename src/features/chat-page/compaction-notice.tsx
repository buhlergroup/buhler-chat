"use client";

import { useState } from "react";
import { ChevronDownIcon, FoldVerticalIcon } from "lucide-react";
import { Loader } from "@/components/ai-elements/loader";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/features/ui/collapsible";
import { cn } from "@/features/ui/lib";
import {
  compactionMarkerText,
  compactionNoticeText,
  type CompactionData,
} from "./chat-services/chat-api/compaction-part";

/**
 * The compaction divider.
 *
 * A trim is the one thing the chat does that makes the model know less than
 * the transcript on screen: the dropped turns stay in Cosmos and keep
 * rendering, so without this row the user has no way to tell that the model
 * can no longer quote what they can still scroll to. The row marks where the
 * conversation the model sees actually begins.
 *
 * Rendered as a muted centred row rather than inside a message bubble — it is
 * not something anyone said. The pill shape and `bg-muted/60` match the other
 * standalone transcript rows (the background-generation and poll-exhausted
 * notices in chat-page.tsx).
 *
 * The summary text ships inline on the data part, so "Show summary" is a
 * `Collapsible` (same primitive as the reasoning and tool panels) and never a
 * second request.
 */
function CompactionRow(props: {
  text: string;
  summaryText?: string;
  summaryModel?: string;
}) {
  const [open, setOpen] = useState(false);
  const hasSummary = Boolean(props.summaryText);

  return (
    <Collapsible
      className="not-prose mx-auto w-full max-w-md"
      onOpenChange={setOpen}
      open={open}
    >
      <div
        className="flex items-center gap-3 rounded-md bg-muted/60 px-4 py-2 text-muted-foreground text-sm"
        data-testid="compaction-notice"
      >
        <FoldVerticalIcon className="size-4 shrink-0" />
        <span className="flex-1">{props.text}</span>
        {hasSummary && (
          <CollapsibleTrigger className="flex shrink-0 items-center gap-1 text-xs transition-colors hover:text-foreground">
            {open ? "Hide summary" : "Show summary"}
            <ChevronDownIcon
              className={cn(
                "size-3.5 transition-transform",
                open ? "rotate-180" : "rotate-0",
              )}
            />
          </CollapsibleTrigger>
        )}
      </div>
      {hasSummary && (
        <CollapsibleContent className="mt-2 whitespace-pre-wrap rounded-md bg-muted/40 px-4 py-3 text-muted-foreground text-xs data-[state=closed]:animate-out data-[state=open]:animate-in">
          {props.summaryText}
          {props.summaryModel && (
            <div className="mt-2 text-[10px] uppercase tracking-wide">
              Summary by {props.summaryModel}
            </div>
          )}
        </CollapsibleContent>
      )}
    </Collapsible>
  );
}

/**
 * Renders a `data-compaction` part streamed with the turn it happened on.
 *
 * One phase only. The trim runs in `loadThreadContext`, before the stream
 * opens, so the outcome is known by the time the first frame is written; there
 * is no interval during which a spinner could be shown.
 */
export function CompactionNotice({ data }: { data: CompactionData }) {
  return (
    <CompactionRow
      text={compactionNoticeText(data)}
      {...(data.summaryText ? { summaryText: data.summaryText } : {})}
      {...(data.summaryModel ? { summaryModel: data.summaryModel } : {})}
    />
  );
}

/**
 * The same divider, rebuilt from the thread's persisted compaction row after a
 * reload. Data parts live only in the streaming message, so without this the
 * marker would vanish on refresh even though the trim is permanent.
 *
 * `trimmedTurns` is counted from the transcript itself (the user turns at or
 * before the watermark row), not stored — see chat-page.tsx.
 */
export function CompactionMarker(props: {
  trimmedTurns: number;
  summaryText?: string;
  summaryModel?: string;
  /** Real provider numbers from the turn that trimmed, when the row has them. */
  realTokensBefore?: number;
  realTokensAfter?: number;
}) {
  return (
    <CompactionRow
      text={compactionMarkerText(props.trimmedTurns, {
        ...(typeof props.realTokensBefore === "number"
          ? { tokensBefore: props.realTokensBefore }
          : {}),
        ...(typeof props.realTokensAfter === "number"
          ? { tokensAfter: props.realTokensAfter }
          : {}),
      })}
      {...(props.summaryText ? { summaryText: props.summaryText } : {})}
      {...(props.summaryModel ? { summaryModel: props.summaryModel } : {})}
    />
  );
}
