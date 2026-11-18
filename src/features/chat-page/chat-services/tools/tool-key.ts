// Shared by the HTTP and MCP extension tools. No server imports, so the
// key shape can be tested and reused anywhere.

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
