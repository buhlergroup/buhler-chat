import "server-only";

import { NoSuchToolError, type ToolCallRepairFunction, type ToolSet } from "ai";
import type { Tool } from "@ai-sdk/provider-utils";
import { logInfo, logWarn, logError } from "@/features/common/services/logger";
import { searchDocumentsTool } from "./search-documents";
import { searchCompanyContentTool } from "./search-company-content";
import { callSubAgentTool } from "./call-sub-agent";
import { searchSubAgentTool } from "./search-sub-agent";
import { getCurrentTimeTool } from "./get-current-time";
import { extensionTool } from "./extension-tool";
import type { ToolContext } from "./tool-context";
import { compareByCodepoint } from "./stabilize-toolset";

/**
 * Provider tool-name cap (OpenAI/Azure/Anthropic all reject function names
 * longer than this).
 */
const MAX_TOOL_NAME_LENGTH = 64;

/**
 * Namespaces an extension function's tool key with a short prefix of the
 * owning extension's id.
 *
 * Prod has 82 extensions of which 43 all share `functionName: "aisearch"`.
 * Keying the toolset purely by `parsedFunction.name` (pre-fix behavior)
 * meant every extension after the first with a given name silently
 * overwrote the previous one in the `Record<string, Tool>` — the model
 * only ever saw one "aisearch" tool, wired to whichever extension's
 * function happened to be inserted last.
 *
 * The prefix is the first 8 characters of the extension id rather than
 * the full id to avoid wasting tokens on the wire; ids are 36-char
 * nanoids drawn from a 62-character alphanumeric alphabet
 * (`features/common/util.ts` `uniqueId`), so an 8-char prefix already
 * carries ~2.2e14 possible values — a same-prefix collision between the
 * handful of extensions configured on one thread is negligible, and the
 * prefix itself is already alphanumeric so it never needs sanitizing.
 *
 * `functionName` is externally authored (extension config), so it is
 * defensively sanitized to the character set every provider accepts
 * (alphanumeric/underscore/hyphen) and the combined key is truncated to
 * MAX_TOOL_NAME_LENGTH so it always stays a valid tool identifier.
 *
 * IMPORTANT — load-bearing, silent invariant: every key produced here has
 * an underscore as its 9th character (8 alphanumeric prefix chars, then
 * `_`), because the nanoid alphabet in `uniqueId` is strictly
 * alphanumeric. None of the fixed built-in tool keys registered below
 * ("search_documents", "search_company_content", "get_current_time",
 * "call_sub_agent", "search_sub_agent") have an underscore at that
 * position, so extension keys never collide with them *today* — but
 * nothing enforces that structurally. `buildToolset`'s final assembly
 * loop asserts it at runtime instead of letting a future collision
 * silently shadow one tool with another. This same 8-alphanumeric-then-
 * underscore shape is also what lets the UI (tool-part-view.tsx) and
 * `repairExtensionToolCall` below recognize a namespaced key without
 * importing this server-only module.
 */
export function buildExtensionToolKey(
  extensionId: string,
  functionName: string
): string {
  const prefix = extensionId.slice(0, 8);
  const safeName = functionName.replace(/[^a-zA-Z0-9_-]/g, "_");
  const key = `${prefix}_${safeName}`;
  return key.length > MAX_TOOL_NAME_LENGTH
    ? key.slice(0, MAX_TOOL_NAME_LENGTH)
    : key;
}

/**
 * Builds the toolset for a given ToolContext.
 *
 * Keys are inserted in the canonical order defined by stabilize-toolset.ts
 * (codepoint, never locale) so that the wire representation is byte-identical
 * across requests AND across pods with different locales — this is the
 * prompt-cache stability invariant locked by the snapshot test in task 3.
 *
 * Never modifies function-registry.ts; runs in parallel with the old
 * dispatcher until task-12 cutover.
 */
export async function buildToolset(
  ctx: ToolContext
): Promise<Record<string, Tool>> {
  const entries: [string, Tool][] = [];

  // RAG search — include when the thread or persona has documents
  const hasDocuments =
    (ctx.threadDocumentIds?.length ?? 0) > 0 ||
    (ctx.personaDocumentIds?.length ?? 0) > 0;

  if (hasDocuments) {
    entries.push(["search_documents", searchDocumentsTool(ctx)]);
  }

  // Company content — controlled by defaultTools toggle
  if (ctx.defaultTools?.companyContent) {
    entries.push(["search_company_content", searchCompanyContentTool(ctx)]);
  }

  // Current time — always available. Lets the model fetch the user's local
  // datetime on demand instead of baking it into the (cache-sensitive) prompt.
  entries.push(["get_current_time", getCurrentTimeTool(ctx)]);

  // Sub-agent tools are always available (subject to the recursion
  // guard). There is no "fixed assignment" — any persona the user has
  // access to can be called as a sub-agent. `search_sub_agent` lets
  // the model discover candidates via `FindAllPersonaForCurrentUser`;
  // `call_sub_agent` resolves the chosen id via `FindPersonaByID`,
  // which enforces access control. Hiding the tools when the thread
  // doesn't pre-declare `subAgentIds` was a #37 regression — it
  // prevented discovery entirely. The #37 root cause was a test-fake
  // race (inline-emitted tool result fighting a local `execute`); in
  // production these are pure custom tools owned only by us.
  const includeSubAgentTools = (ctx.depth ?? 0) < 2;

  if (includeSubAgentTools) {
    entries.push(["call_sub_agent", callSubAgentTool(ctx)]);
    entries.push(["search_sub_agent", searchSubAgentTool(ctx)]);
  }

  // Dynamic extension tools — keyed by `${extensionId prefix}_${functionName}`
  // (see buildExtensionToolKey) so extensions sharing a functionName don't
  // overwrite each other's toolset entry.
  const usedExtensionKeys = new Set<string>();
  for (const { extension, headerSecrets } of ctx.extensions ?? []) {
    for (const functionDef of extension.functions) {
      try {
        const parsedFunction = JSON.parse(functionDef.code) as {
          name?: string;
          description: string;
          parameters: any;
        };

        // The code parsed as JSON, but that doesn't guarantee it has the
        // shape we need — a malformed/hand-edited extension can produce
        // valid JSON with a missing or non-string "name". Check for that
        // explicitly instead of letting buildExtensionToolKey throw into
        // the catch below, which would mislabel a schema problem as a
        // JSON parse failure.
        if (typeof parsedFunction?.name !== "string" || parsedFunction.name.length === 0) {
          logError("buildToolset: extension function code has no valid \"name\"", {
            extensionId: extension.id,
            functionDefId: functionDef.id,
          });
          continue;
        }

        const key = buildExtensionToolKey(extension.id, parsedFunction.name);
        if (usedExtensionKeys.has(key)) {
          // Only reachable if two extensions share both the same 8-char id
          // prefix AND the same function name (negligible per the id-space
          // argument on buildExtensionToolKey above), or one extension
          // defines the same function name twice — a config-time authoring
          // mistake, not a per-request incident. Keep the first
          // registration deterministically instead of silently
          // overwriting it.
          logWarn("buildToolset: duplicate extension tool key, keeping first registration", {
            key,
            extensionId: extension.id,
            functionName: parsedFunction.name,
          });
          continue;
        }
        usedExtensionKeys.add(key);
        const t = extensionTool(functionDef, parsedFunction as { name: string; description: string; parameters: any }, {
          extension,
          headerSecrets,
        });
        entries.push([key, t]);
      } catch (error) {
        logError("buildToolset: failed to parse extension function", {
          extensionId: extension.id,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  // Codepoint order for prompt-cache stability. localeCompare would make the
  // tool order depend on the pod's locale/ICU build — see stabilize-toolset.ts.
  entries.sort(([a], [b]) => compareByCodepoint(a, b));

  const toolset: Record<string, Tool> = {};
  for (const [name, t] of entries) {
    // Cheap runtime guard for the load-bearing, otherwise-silent invariant
    // documented on buildExtensionToolKey: no extension key should ever
    // collide with a built-in tool key (or, in principle, another
    // extension key that slipped past the usedExtensionKeys dedupe
    // above). Log instead of silently letting the later entry shadow the
    // earlier one.
    if (Object.prototype.hasOwnProperty.call(toolset, name)) {
      logWarn("buildToolset: tool key collision at final assembly, later registration wins", {
        key: name,
        depth: ctx.depth ?? 0,
      });
    }
    toolset[name] = t;
  }

  logInfo("buildToolset: built", {
    keys: Object.keys(toolset),
    depth: ctx.depth ?? 0,
  });

  return toolset;
}

/**
 * Repairs a bare, pre-namespacing extension tool name — as persisted in
 * thread history from before this file started keying extension tools as
 * `${8-char-id-prefix}_${functionName}` (see buildExtensionToolKey) — into
 * the namespaced key currently registered for it.
 *
 * When a user resumes an old thread and the model echoes a tool name from
 * that history (e.g. plain "aisearch"), the AI SDK looks it up in the
 * current toolset, finds nothing, and throws NoSuchToolError — killing the
 * turn. This only repairs the call when EXACTLY ONE currently active tool
 * key matches `^[A-Za-z0-9]{8}_<bareName>$`; with zero or multiple matches
 * there's no safe unique target, so it returns null and lets the AI SDK
 * surface its normal error instead of guessing which extension the model
 * meant.
 *
 * MIGRATION-SCOPED: extension tool keys started being namespaced on
 * 2026-08-24. Every turn from that point on persists a namespaced name, so
 * this only earns its keep for threads with tool-call history from before
 * that date. Safe to delete once those pre-namespacing threads have aged
 * out of practical relevance (retention policy / thread archival, not a
 * fixed date — check before removing that no such history is still live).
 */
export const repairExtensionToolCall: ToolCallRepairFunction<ToolSet> = async ({
  toolCall,
  tools,
  error,
}) => {
  if (!NoSuchToolError.isInstance(error)) return null;

  const bareName = toolCall.toolName;
  const escapedName = bareName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`^[A-Za-z0-9]{8}_${escapedName}$`);
  const matches = Object.keys(tools).filter((key) => pattern.test(key));

  if (matches.length !== 1) return null;

  logInfo("repairExtensionToolCall: repaired bare pre-namespacing extension tool name", {
    bareName,
    repairedTo: matches[0],
  });

  return { ...toolCall, toolName: matches[0] };
};
