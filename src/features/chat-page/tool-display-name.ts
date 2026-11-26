/**
 * tool-display-name.ts
 *
 * Extension tool keys are namespaced as
 * `${8-char-alphanumeric-extension-id-prefix}_${functionName}` (see
 * `buildExtensionToolKey` in
 * `chat-services/tools/registry.ts` — not imported here since that module
 * is `server-only`) so extensions sharing a `functionName` don't overwrite
 * each other in the toolset. That namespacing is plumbing for the model
 * and tool-call dispatch only; strip it back off before showing a tool
 * name to a user, so "Kj3nQ8xz_aisearch" reads as "aisearch" again.
 *
 * The regex matches the key's SHAPE only (8 alphanumeric chars + "_") — a
 * client component can't verify a prefix actually belongs to a real
 * extension id. It's safe against the fixed built-in tool names
 * ("search_documents", "get_current_time", "call_sub_agent", …) because
 * none of them have an underscore as their 9th character — the same
 * load-bearing invariant documented on `buildExtensionToolKey`.
 */
const EXTENSION_KEY_PREFIX_RE = /^[A-Za-z0-9]{8}_/;

/**
 * App tool names that have the key shape all the same and are shown as they
 * are. `generate_image` (the Copilot path image tool) would read "image" and
 * lose its image rendering in tool-part-view.
 */
export const APP_TOOL_NAMES_WITH_KEY_SHAPE: ReadonlySet<string> = new Set(["generate_image"]);

export function stripExtensionKeyPrefix(name: string): string {
  if (APP_TOOL_NAMES_WITH_KEY_SHAPE.has(name)) return name;
  return name.replace(EXTENSION_KEY_PREFIX_RE, "");
}
