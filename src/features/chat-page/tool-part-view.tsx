"use client";

/**
 * tool-part-view.tsx
 *
 * Typed renderer for the AI SDK UIMessage tool parts. Replaces the
 * ad-hoc `as any` + `JSON.stringify` chain that previously lived
 * inline in chat-page.tsx (architect smells audit S1.6 / task #43).
 *
 * Rendering strategy:
 *   - Strings/numbers/booleans: pass straight through to ToolOutput.
 *   - Arrays of primitives: a compact bullet list.
 *   - Objects-of-primitives: a key/value table.
 *   - Anything nested or unknown: pretty-printed JSON, which is the
 *     same fallback the old inline code used.
 *
 * Per-tool special-cases live in `renderToolBody` (currently empty —
 * RAG / sub-agent results get the generic object renderer; the named
 * cases hook is wired so future per-tool UIs can be added without
 * touching this file's plumbing).
 */
import type { UIMessage } from "ai";
import {
  Tool,
  ToolHeader,
  ToolContent,
  ToolInput,
  ToolOutput,
} from "@/components/ai-elements/tool";
import type { ReactNode } from "react";
import { McpConnectButton } from "@/features/extensions-page/mcp-connect-button";
import {
  isImageReference,
  resolveBlobReferenceToPath,
} from "./chat-services/chat-image-persistence-utils";
import { appToolLabel, stripExtensionKeyPrefix } from "./tool-display-name";

// ---------------------------------------------------------------------------
// Typed view over UIMessage parts
// ---------------------------------------------------------------------------

type UIMessagePart = UIMessage["parts"][number];

interface NormalizedToolPart {
  /** Stable per-message id for React keys. */
  id: string;
  /** Tool name (e.g. "search_documents", "call_sub_agent"). */
  toolName: string;
  /** The tool's input (JSON parsed/inflated by AI SDK). */
  input: unknown;
  /** Tool result if present (provider-executed inline or local execute). */
  output: unknown;
  /**
   * The Tool component's state input. Mapped from AI SDK part type +
   * presence of `output` so we never show a "Running" widget for a part
   * that already has a result — including failed parts, which carry
   * `errorText` but no `output` and must surface as "Error", not an
   * eternally-running widget.
   */
  state: "input-available" | "output-available" | "output-error";
  /** Error message when the tool call failed (AI SDK `output-error` parts). */
  errorText: string | undefined;
}

/**
 * AI SDK v6 emits typed tool parts as `tool-<toolName>` and dynamic
 * (untyped) tools as `dynamic-tool`. Raw stream-event types
 * `tool-call` / `tool-result` occasionally surface during live
 * streaming. Cover all four forms so the widget renders regardless of
 * how the model chose to express the call.
 */
export function isToolPart(part: UIMessagePart): boolean {
  if (part.type === "dynamic-tool") return true;
  if (part.type === "tool-call") return true;
  if (part.type === "tool-result") return true;
  if (part.type.startsWith("tool-")) return true;
  return false;
}

export function normalizeToolPart(
  part: UIMessagePart,
  index: number,
): NormalizedToolPart {
  // The AI SDK's UIMessagePart union is wide; the tool variants share a
  // structural shape but the type system doesn't surface that as a
  // single interface. A narrow inline shape keeps the rest of this
  // module fully typed; only this one cast is needed and is documented.
  const p = part as {
    type: string;
    toolCallId?: string;
    toolName?: string;
    input?: unknown;
    output?: unknown;
    state?: string;
    errorText?: string;
  };

  // For `tool-<name>` parts the toolName isn't a separate field — derive
  // it from the type discriminant.
  const rawToolName =
    p.toolName ??
    (p.type.startsWith("tool-") && p.type !== "tool-call" && p.type !== "tool-result"
      ? p.type.slice("tool-".length)
      : "tool");
  // Extension tool names carry an id-prefix namespace on the wire (see
  // buildExtensionToolKey) — strip it for display so users see the
  // authored function name, not the internal dispatch key.
  const toolName = stripExtensionKeyPrefix(rawToolName);

  const hasOutput = p.output !== undefined && p.output !== null;
  const hasError = p.state === "output-error" || p.errorText !== undefined;
  const state: NormalizedToolPart["state"] = hasError
    ? "output-error"
    : hasOutput
      ? "output-available"
      : p.state === "output-available"
        ? "output-available"
        : "input-available";

  return {
    id: p.toolCallId ?? `idx-${index}`,
    toolName,
    input: p.input,
    output: p.output ?? null,
    state,
    errorText: hasError ? (p.errorText ?? "Tool call failed") : undefined,
  };
}

// ---------------------------------------------------------------------------
// Output body rendering
// ---------------------------------------------------------------------------

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    (value.constructor === Object || value.constructor === undefined)
  );
}

function isPrimitive(value: unknown): value is string | number | boolean {
  const t = typeof value;
  return t === "string" || t === "number" || t === "boolean";
}

function isPrimitiveOrNullArray(value: unknown): value is Array<unknown> {
  return (
    Array.isArray(value) &&
    value.every((v) => v === null || isPrimitive(v))
  );
}

function isObjectOfPrimitives(
  value: unknown,
): value is Record<string, string | number | boolean | null> {
  return (
    isPlainObject(value) &&
    Object.values(value).every((v) => v === null || isPrimitive(v))
  );
}

function KeyValueTable({
  data,
}: {
  data: Record<string, string | number | boolean | null>;
}) {
  return (
    <table className="w-full text-xs">
      <tbody>
        {Object.entries(data).map(([k, v]) => (
          <tr key={k} className="border-b border-border/30 last:border-0">
            <td className="py-1 pr-2 font-medium text-muted-foreground align-top">
              {k}
            </td>
            <td className="py-1 break-words">
              {v === null ? <span className="text-muted-foreground">null</span> : String(v)}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function PrimitiveList({ items }: { items: Array<unknown> }) {
  return (
    <ul className="list-disc pl-4 space-y-0.5 text-xs">
      {items.map((item, i) => (
        <li key={i}>
          {item === null ? (
            <span className="text-muted-foreground">null</span>
          ) : (
            String(item)
          )}
        </li>
      ))}
    </ul>
  );
}

/**
 * Resolves an image_generation `output.result` value to an <img> src.
 * `blob://...` references come from server-side persistence (the image
 * service's canonical storage token) and get resolved to a same-origin
 * `/api/images?…` URL here at the last mile — the renderer is the only
 * place blob refs ever become URLs. Already-resolved forms (`/api/...`,
 * `data:`, `http(s):`) pass through. Anything else returns null so the
 * generic key/value renderer kicks in.
 */
function extractImageGenSrc(output: unknown): string | null {
  if (!output || typeof output !== "object") return null;
  const result = (output as { result?: unknown }).result;
  if (typeof result !== "string" || result.length === 0) return null;
  if (isImageReference(result)) return resolveBlobReferenceToPath(result);
  if (result.startsWith("/api/images?")) return result;
  if (result.startsWith("data:image/")) return result;
  if (/^https?:\/\//.test(result)) return result;
  return null;
}

/** Same-origin image URLs from an output's `images` array of blob:// refs. */
function extractImageRefs(output: unknown): string[] {
  if (!isPlainObject(output) || !Array.isArray(output.images)) return [];
  return output.images.flatMap((ref) =>
    typeof ref === "string" && isImageReference(ref) ? [resolveBlobReferenceToPath(ref)].filter((u): u is string => !!u) : [],
  );
}

/**
 * Renders a tool's output body. The five cases cover the common shapes
 * tool results take in this codebase:
 *   - undefined / null  → caller suppresses the output section entirely
 *   - image_generation result with a renderable image → inline <img>
 *   - primitive          → pass through (Markdown won't render but the
 *                          existing ToolOutput frame will)
 *   - object-of-primitives → KeyValueTable
 *   - array-of-primitives  → PrimitiveList
 *   - everything else      → pretty-printed JSON (deeply-nested objects,
 *                          search-document hit arrays, etc.)
 *
 * Image-rendering rule: the tool widget is the ONE place that renders
 * a generated image. The server never resolves blob refs to URLs in
 * either the model context or the assistant text, so the model never
 * echoes a renderable URL — no duplicate render with Streamdown.
 */
/**
 * `mcpConnect` marks the result of an OAuth MCP tool the user has not
 * signed in to (mcp-tool.ts mcpConnectRequired): show why, and the
 * "Connect <extension>" action that starts the user's own sign-in.
 */
function extractMcpConnect(
  output: unknown
): { text: string; extensionId: string; extensionName: string; personaId?: string } | null {
  if (!isPlainObject(output)) return null;
  const connect = output.mcpConnect;
  if (!isPlainObject(connect)) return null;
  const { extensionId, extensionName, personaId } = connect;
  if (typeof extensionId !== "string" || typeof extensionName !== "string") return null;
  return {
    text: typeof output.text === "string" ? output.text : "",
    extensionId,
    extensionName,
    personaId: typeof personaId === "string" ? personaId : undefined,
  };
}

export function renderToolOutput(output: unknown, toolName?: string): ReactNode {
  if (output === null || output === undefined) return undefined;
  const mcpConnect = extractMcpConnect(output);
  if (mcpConnect) {
    return (
      <div className="flex flex-col gap-2 items-start">
        <span className="text-sm">Sign in to {mcpConnect.extensionName} to use its tools.</span>
        <McpConnectButton
          extensionId={mcpConnect.extensionId}
          extensionName={mcpConnect.extensionName}
          personaId={mcpConnect.personaId}
        />
      </div>
    );
  }
  // generate_image: the Copilot path's own image tool, same output shape.
  if (toolName === "image_generation" || toolName === "generate_image") {
    const src = extractImageGenSrc(output);
    if (src) {
      return (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={src}
          alt="Generated image"
          className="max-w-full rounded-md border border-border/40"
        />
      );
    }
  }
  // run_code (Copilot path): image outputs as blob refs in `images`.
  const codeImages = toolName === "run_code" ? extractImageRefs(output) : [];
  if (codeImages.length > 0) {
    const rest = Object.fromEntries(Object.entries(output as Record<string, unknown>).filter(([k]) => k !== "images"));
    return (
      <div className="flex flex-col gap-2">
        {codeImages.map((src) => (
          // eslint-disable-next-line @next/next/no-img-element
          <img key={src} src={src} alt="Code output" className="max-w-full rounded-md border border-border/40" />
        ))}
        <pre className="whitespace-pre-wrap break-words text-xs">{JSON.stringify(rest, null, 2)}</pre>
      </div>
    );
  }
  if (isPrimitive(output)) return String(output);
  if (isObjectOfPrimitives(output)) return <KeyValueTable data={output} />;
  if (isPrimitiveOrNullArray(output)) return <PrimitiveList items={output} />;
  return (
    <pre className="whitespace-pre-wrap break-words text-xs">
      {JSON.stringify(output, null, 2)}
    </pre>
  );
}

// ---------------------------------------------------------------------------
// Public component
// ---------------------------------------------------------------------------

/**
 * Header label of a tool part, when it is not the tool name: a sub-agent run
 * on the Copilot path (`sub_agent`, input.agent = its display name) reads
 * "Sub-agent <name>".
 */
export function toolPartLabel(toolName: string, input: unknown): string | undefined {
  // The Copilot path image tool reads as on the AI SDK path (image_generation).
  if (toolName === "generate_image") return "Image generation";
  if (toolName !== "sub_agent") return appToolLabel(toolName);
  const agent = (input as { agent?: unknown } | null | undefined)?.agent;
  return typeof agent === "string" && agent.length > 0 ? `Sub-agent ${agent}` : "Sub-agent";
}

export function ToolPartView({ part, index }: { part: UIMessagePart; index: number }) {
  const normalized = normalizeToolPart(part, index);
  const label = toolPartLabel(normalized.toolName, normalized.input);
  return (
    // Failed calls open expanded so the error message is visible without a
    // click; successful calls stay collapsed as before.
    <Tool defaultOpen={normalized.state === "output-error"}>
      <ToolHeader
        type={`tool-${normalized.toolName}` as `tool-${string}`}
        state={normalized.state}
        {...(label ? { label } : {})}
      />
      <ToolContent>
        <ToolInput input={normalized.input} />
        <ToolOutput
          output={renderToolOutput(normalized.output, normalized.toolName)}
          errorText={normalized.errorText}
        />
      </ToolContent>
    </Tool>
  );
}
