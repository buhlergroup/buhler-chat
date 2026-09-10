/**
 * message-adapter.ts
 *
 * Pure adapter between Cosmos ChatMessageModel rows and AI SDK v5 UIMessages.
 *
 * Cosmos schema (unchanged):
 *   - One row per logical event: role = "user" | "assistant" | "tool" | "system" | "reasoning"
 *   - Tool calls are persisted as separate rows with role = "tool" (authoritative: openai-responses-stream.ts)
 *     Content is JSON: { name, arguments, result, call_id?, parentAssistantMessageId?, timestamp? }
 *   - Assistant rows carry reasoningContent (text) and reasoningState (encrypted blob) for reasoning models
 *
 * AI SDK v5 UIMessage shape:
 *   - role: "user" | "assistant" | "system"
 *   - parts: UIMessagePart[]  — tool calls live as DynamicToolUIPart inside the assistant turn
 *
 * Round-trip lossiness (intentional):
 *   - ids and createdAt are regenerated when converting UIMessage → ChatMessageModel because
 *     UIMessage carries no Cosmos-level id/createdAt. The caller must supply them if needed.
 *   - reasoningState is round-tripped as-is via UIMessage metadata (not a standard UIMessagePart field);
 *     it is preserved through a custom metadata field on the assistant UIMessage.
 *   - multiModalImages on user rows are represented as FileUIPart entries with mediaType "image/*".
 *     On the return trip the URL is stored back in multiModalImages[].
 */

import type { UIMessage } from "ai";
import { MESSAGE_ATTRIBUTE, type ChatMessageModel } from "../models";

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Shape persisted in content of role="tool" rows (authoritative: openai-responses-stream.ts) */
interface PersistedToolContent {
  name: string;
  arguments: string;
  result?: string;
  call_id?: string;
  parentAssistantMessageId?: string;
  timestamp?: string;
}

function isPersistedToolContent(value: unknown): value is PersistedToolContent {
  if (value === null || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  return typeof candidate.name === "string";
}

function tryParseToolContent(content: string): PersistedToolContent | null {
  try {
    const parsed: unknown = JSON.parse(content);
    return isPersistedToolContent(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Step-layout entry kinds. See ChatMessageModel.stepLayout.
 */
const STEP_START = "step-start";
const TEXT_PREFIX = "text:";
const TOOL_PREFIX = "tool:";
const REASONING_ENTRY = "reasoning";

/**
 * Derive the step layout from an assistant UIMessage's parts. Returns
 * undefined when the message carries no `step-start` part — i.e. it was built
 * by a path that has no step information (the empty-finish sentinel, or an
 * old row being re-persisted). Those keep writing rows without a layout, so
 * nothing about the pre-existing shape changes.
 */
function deriveStepLayout(parts: UIMessage["parts"]): string[] | undefined {
  if (!parts.some((p) => p.type === STEP_START)) return undefined;
  const layout: string[] = [];
  for (const part of parts) {
    if (part.type === STEP_START) {
      layout.push(STEP_START);
    } else if (part.type === "text") {
      layout.push(`${TEXT_PREFIX}${(part as import("ai").TextUIPart).text.length}`);
    } else if (part.type === "reasoning") {
      layout.push(REASONING_ENTRY);
    } else if (part.type === "dynamic-tool") {
      layout.push(
        `${TOOL_PREFIX}${(part as import("ai").DynamicToolUIPart).toolCallId}`,
      );
    }
  }
  return layout;
}

/**
 * Rebuild an assistant message's parts in the order the live turn produced
 * them, re-inserting the `step-start` markers convertToModelMessages splits
 * on. `parts` is what the legacy rebuild produced: [reasoning?, text?,
 * ...tools]. Returns null when the layout can't be honoured (text lengths
 * don't add up, a referenced tool call is missing), in which case the caller
 * keeps the legacy ordering — a wrong-but-familiar history beats a corrupted
 * one.
 */
function applyStepLayout(
  layout: string[],
  parts: UIMessage["parts"],
): UIMessage["parts"] | null {
  const textParts = parts.filter(
    (p): p is import("ai").TextUIPart => p.type === "text",
  );
  const reasoningParts = parts.filter(
    (p): p is import("ai").ReasoningUIPart => p.type === "reasoning",
  );
  const toolParts = new Map(
    parts
      .filter((p): p is import("ai").DynamicToolUIPart => p.type === "dynamic-tool")
      .map((p) => [p.toolCallId, p]),
  );

  // The row stores one concatenated `content`, so the legacy rebuild yields a
  // single text part; the layout says how to cut it back into per-step slices.
  const fullText = textParts.map((p) => p.text).join("");
  const declaredTextLength = layout
    .filter((e) => e.startsWith(TEXT_PREFIX))
    .reduce((sum, e) => sum + (Number(e.slice(TEXT_PREFIX.length)) || 0), 0);
  if (declaredTextLength !== fullText.length) return null;

  const rebuilt: UIMessage["parts"] = [];
  const usedToolIds = new Set<string>();
  let textOffset = 0;
  let reasoningEmitted = false;
  for (const entry of layout) {
    if (entry === STEP_START) {
      rebuilt.push({ type: STEP_START } as unknown as UIMessage["parts"][number]);
    } else if (entry.startsWith(TEXT_PREFIX)) {
      const length = Number(entry.slice(TEXT_PREFIX.length));
      if (!Number.isFinite(length) || length < 0) return null;
      rebuilt.push({
        type: "text",
        text: fullText.slice(textOffset, textOffset + length),
        state: "done",
      } as import("ai").TextUIPart);
      textOffset += length;
    } else if (entry === REASONING_ENTRY) {
      // Reasoning is persisted as one blob on the row, so it is replayed once
      // at the position the layout first names it.
      if (!reasoningEmitted && reasoningParts.length > 0) {
        rebuilt.push(...reasoningParts);
        reasoningEmitted = true;
      }
    } else if (entry.startsWith(TOOL_PREFIX)) {
      const toolCallId = entry.slice(TOOL_PREFIX.length);
      const toolPart = toolParts.get(toolCallId);
      if (!toolPart) return null;
      rebuilt.push(toolPart);
      usedToolIds.add(toolCallId);
    }
  }

  // Anything the layout didn't name (a tool row written by an older code
  // path, reasoning the layout omitted) is appended so no content is lost.
  if (!reasoningEmitted) rebuilt.unshift(...reasoningParts);
  for (const [id, part] of toolParts) {
    if (!usedToolIds.has(id)) rebuilt.push(part);
  }
  return rebuilt;
}

function generateId(): string {
  return (
    Date.now().toString(36) +
    Math.random().toString(36).slice(2, 9)
  );
}

// ---------------------------------------------------------------------------
// uiMessagesFromChatMessages
// ---------------------------------------------------------------------------

/**
 * Flatten Cosmos rows (one per logical event, including separate tool rows) into
 * AI SDK UIMessages (tool calls live as DynamicToolUIPart inside assistant messages).
 *
 * Mapping rules:
 * - user rows  → UIMessage role="user",  parts: TextUIPart + optional FileUIParts for images
 * - system rows → UIMessage role="system", parts: [TextUIPart]
 * - assistant rows → UIMessage role="assistant", parts: [optional ReasoningUIPart, TextUIPart]
 * - tool rows IMMEDIATELY after an assistant row → folded into that assistant's parts as DynamicToolUIPart
 * - stray tool rows (no preceding assistant) → attached to the most-recent assistant message;
 *   if none exists, a synthetic assistant UIMessage with no text part is created.
 *   This is an edge case that should not occur in normal operation.
 * - "reasoning" role rows are treated as a standalone text row (legacy / unlikely in practice).
 */
export function uiMessagesFromChatMessages(rows: ChatMessageModel[]): UIMessage[] {
  const result: UIMessage[] = [];
  // Index of the most-recently produced assistant UIMessage in result[].
  let lastAssistantIdx = -1;

  for (const row of rows) {
    if (row.isDeleted) continue;

    if (row.role === "tool") {
      const toolContent = tryParseToolContent(row.content);

      // Find the target assistant message to attach this tool call to.
      // Prefer the last assistant message in the result array.
      if (lastAssistantIdx === -1) {
        // Edge case: stray tool row with no preceding assistant message.
        // Create a synthetic assistant message to host the tool part.
        const syntheticAssistant: UIMessage = {
          id: row.id,
          role: "assistant",
          // Store threadId in metadata so round-trip can recover it.
          metadata: { threadId: row.threadId },
          parts: [],
        };
        result.push(syntheticAssistant);
        lastAssistantIdx = result.length - 1;
      }

      const assistantMsg = result[lastAssistantIdx] as UIMessage;
      const toolPart: import("ai").DynamicToolUIPart = {
        type: "dynamic-tool",
        toolName: toolContent?.name ?? row.name ?? "unknown",
        toolCallId: toolContent?.call_id ?? row.id,
        state: "output-available" as const,
        input: toolContent?.arguments !== undefined
          ? safeParseJson(toolContent.arguments)
          : {},
        output: toolContent?.result !== undefined
          ? safeParseJson(toolContent.result)
          : null,
      };
      (assistantMsg.parts as import("ai").UIMessagePart<import("ai").UIDataTypes, import("ai").UITools>[]).push(toolPart);
      continue;
    }

    if (row.role === "assistant") {
      const parts: UIMessage["parts"] = [];

      // Reasoning part first, then text — matches rendering order.
      if (row.reasoningContent) {
        const reasoningPart: import("ai").ReasoningUIPart = {
          type: "reasoning",
          text: row.reasoningContent,
          state: "done",
        };
        parts.push(reasoningPart);
      }

      if (row.content) {
        const textPart: import("ai").TextUIPart = {
          type: "text",
          text: row.content,
          state: "done",
        };
        parts.push(textPart);
      }

      const msg: UIMessage = {
        id: row.id,
        role: "assistant",
        // Carry reasoningState, reasoningDurationMs and threadId through
        // metadata so round-trip preserves them.
        metadata: {
          threadId: row.threadId,
          ...(row.reasoningState !== undefined && { reasoningState: row.reasoningState }),
          ...(row.reasoningDurationMs !== undefined && {
            reasoningDurationMs: row.reasoningDurationMs,
          }),
          ...(row.stepLayout !== undefined && { stepLayout: row.stepLayout }),
        },
        parts,
      };
      result.push(msg);
      lastAssistantIdx = result.length - 1;
      continue;
    }

    if (row.role === "user") {
      const parts: UIMessage["parts"] = [];

      if (row.content) {
        parts.push({ type: "text", text: row.content } as import("ai").TextUIPart);
      }

      // Attach images as FileUIPart entries.
      const images = row.multiModalImages ?? (row.multiModalImage ? [row.multiModalImage] : []);
      for (const imgUrl of images) {
        const filePart: import("ai").FileUIPart = {
          type: "file",
          mediaType: "image/*",
          url: imgUrl,
        };
        parts.push(filePart);
      }

      result.push({
        id: row.id,
        role: "user",
        metadata: { threadId: row.threadId },
        parts,
      });
      // A user row resets the lastAssistantIdx tracking — the next assistant row will
      // be a fresh turn, not the same one tool rows from this user turn should attach to.
      lastAssistantIdx = -1;
      continue;
    }

    if (row.role === "system") {
      result.push({
        id: row.id,
        role: "system",
        metadata: { threadId: row.threadId },
        parts: [{ type: "text", text: row.content } as import("ai").TextUIPart],
      });
      lastAssistantIdx = -1;
      continue;
    }

    if (row.role === "reasoning") {
      // Legacy: reasoning was stored as its own row before being folded into assistant rows.
      // Treat as a standalone text row attached to the preceding assistant, or create one.
      if (lastAssistantIdx === -1) {
        result.push({
          id: row.id,
          role: "assistant",
          metadata: { threadId: row.threadId },
          parts: [{ type: "reasoning", text: row.content, state: "done" } as import("ai").ReasoningUIPart],
        });
        lastAssistantIdx = result.length - 1;
      } else {
        const assistantMsg = result[lastAssistantIdx] as UIMessage;
        (assistantMsg.parts as import("ai").UIMessagePart<import("ai").UIDataTypes, import("ai").UITools>[]).push(
          { type: "reasoning", text: row.content, state: "done" } as import("ai").ReasoningUIPart
        );
      }
      continue;
    }

    // "function" role — legacy alias for "tool"; treat identically.
    if (row.role === "function") {
      const toolContent = tryParseToolContent(row.content);
      if (lastAssistantIdx === -1) {
        const syntheticAssistant: UIMessage = {
          id: generateId(),
          role: "assistant",
          metadata: { threadId: row.threadId },
          parts: [],
        };
        result.push(syntheticAssistant);
        lastAssistantIdx = result.length - 1;
      }
      const assistantMsg = result[lastAssistantIdx] as UIMessage;
      const toolPart: import("ai").DynamicToolUIPart = {
        type: "dynamic-tool",
        toolName: toolContent?.name ?? row.name ?? "unknown",
        toolCallId: toolContent?.call_id ?? row.id,
        state: "output-available" as const,
        input: toolContent?.arguments !== undefined
          ? safeParseJson(toolContent.arguments)
          : {},
        output: toolContent?.result !== undefined
          ? safeParseJson(toolContent.result)
          : null,
      };
      (assistantMsg.parts as import("ai").UIMessagePart<import("ai").UIDataTypes, import("ai").UITools>[]).push(toolPart);
      continue;
    }
  }

  // Step boundaries. The loop above builds each assistant turn as one flat
  // block (reasoning, text, then every tool part), which convertToModelMessages
  // serialises as a SINGLE assistant message followed by one tool message.
  // The live turn was several steps, so the rehydrated history didn't match the
  // prefix the provider had cached and the next turn paid to rewrite it. Rows
  // that carry a stepLayout are reordered back into the live shape here; rows
  // without one (written before the layout existed) keep the old behaviour.
  for (const msg of result) {
    if (msg.role !== "assistant") continue;
    const layout = (msg.metadata as { stepLayout?: unknown } | undefined)
      ?.stepLayout;
    if (!Array.isArray(layout) || layout.length === 0) continue;
    const rebuilt = applyStepLayout(layout as string[], msg.parts);
    if (rebuilt) {
      (msg as { parts: UIMessage["parts"] }).parts = rebuilt;
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// chatMessagesFromUIMessages
// ---------------------------------------------------------------------------

/**
 * Inverse of uiMessagesFromChatMessages.
 *
 * Converts AI SDK UIMessages back to Cosmos ChatMessageModel rows:
 * - "user" UIMessage → one user row; FileUIParts become multiModalImages[]
 * - "system" UIMessage → one system row
 * - "assistant" UIMessage →
 *     - one assistant row (content = concatenated text parts; reasoningContent from reasoning parts)
 *     - one tool row per DynamicToolUIPart in the parts array
 *
 * Round-trip lossiness:
 * - New ids and createdAt are generated for each row (UIMessage carries no Cosmos-level ids).
 *   Callers that need stable ids should supply them separately.
 * - reasoningState is recovered from UIMessage metadata if present.
 * - multiModalImages are recovered from FileUIPart URLs on user messages.
 */
export function chatMessagesFromUIMessages(
  messages: UIMessage[],
  ctx: {
    threadId: string;
    userId: string;
    /** Optional; merged onto user rows when the UIMessage has no file parts */
    multiModalImage?: string | string[];
  }
): ChatMessageModel[] {
  const rows: ChatMessageModel[] = [];

  const baseRow = (): Omit<ChatMessageModel, "role" | "content" | "name"> => ({
    id: generateId(),
    createdAt: new Date(),
    isDeleted: false,
    threadId: ctx.threadId,
    userId: ctx.userId,
    type: MESSAGE_ATTRIBUTE,
  });

  for (const msg of messages) {
    if (msg.role === "user") {
      const textParts = msg.parts.filter((p): p is import("ai").TextUIPart => p.type === "text");
      const fileParts = msg.parts.filter((p): p is import("ai").FileUIPart => p.type === "file");
      const content = textParts.map((p) => p.text).join("");
      const multiModalImages = fileParts.length > 0
        ? fileParts.map((p) => p.url)
        : normalizeImages(ctx.multiModalImage);

      rows.push({
        ...baseRow(),
        role: "user",
        name: "",
        content,
        ...(multiModalImages.length > 0 && { multiModalImages }),
      });
      continue;
    }

    if (msg.role === "system") {
      const textParts = msg.parts.filter((p): p is import("ai").TextUIPart => p.type === "text");
      rows.push({
        ...baseRow(),
        role: "system",
        name: "",
        content: textParts.map((p) => p.text).join(""),
      });
      continue;
    }

    if (msg.role === "assistant") {
      const textParts = msg.parts.filter((p): p is import("ai").TextUIPart => p.type === "text");
      const reasoningParts = msg.parts.filter(
        (p): p is import("ai").ReasoningUIPart => p.type === "reasoning"
      );
      const toolParts = msg.parts.filter(
        (p): p is import("ai").DynamicToolUIPart => p.type === "dynamic-tool"
      );

      const content = textParts.map((p) => p.text).join("");
      const reasoningContent = reasoningParts.map((p) => p.text).join("\n\n") || undefined;
      const meta = (msg.metadata ?? {}) as Record<string, unknown>;
      const reasoningState = meta.reasoningState;
      const reasoningDurationMs =
        typeof meta.reasoningDurationMs === "number" ? meta.reasoningDurationMs : undefined;
      // Step boundaries: derived from the parts when they carry `step-start`
      // markers (the live path and any rehydrated row that had a layout),
      // otherwise carried over from metadata so a re-persist doesn't drop it.
      const stepLayout =
        deriveStepLayout(msg.parts) ??
        (Array.isArray(meta.stepLayout) ? (meta.stepLayout as string[]) : undefined);

      rows.push({
        ...baseRow(),
        role: "assistant",
        name: "",
        content,
        ...(reasoningContent !== undefined && { reasoningContent }),
        ...(reasoningState !== undefined && { reasoningState }),
        ...(reasoningDurationMs !== undefined && { reasoningDurationMs }),
        ...(stepLayout !== undefined && { stepLayout }),
      });

      // Each DynamicToolUIPart → one tool row.
      for (const part of toolParts) {
        const toolContent: PersistedToolContent = {
          name: part.toolName,
          arguments:
            typeof part.input === "string"
              ? part.input
              : JSON.stringify(part.input ?? {}),
          result:
            part.state === "output-available"
              ? typeof part.output === "string"
                ? part.output
                : JSON.stringify(part.output ?? null)
              : undefined,
          call_id: part.toolCallId,
        };
        rows.push({
          ...baseRow(),
          role: "tool",
          name: part.toolName,
          content: JSON.stringify(toolContent),
        });
      }
      continue;
    }
  }

  return rows;
}

// ---------------------------------------------------------------------------
// Internal utilities
// ---------------------------------------------------------------------------

function safeParseJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function normalizeImages(images: string | string[] | undefined): string[] {
  if (!images) return [];
  return Array.isArray(images) ? images : [images];
}
