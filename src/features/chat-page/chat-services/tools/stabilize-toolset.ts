/**
 * stabilize-toolset.ts
 *
 * One comparator, one place, for the order of the tools array on the wire.
 *
 * The Responses API treats the tool list as part of the cached prompt prefix,
 * so its order has to be identical on every turn of every thread — including
 * across pods with different locales. Two things used to threaten that:
 *
 *   - the registry sorted with String.prototype.localeCompare, which is
 *     locale-dependent: it orders "a_tool" before "B_tool" under en-US but by
 *     codepoint "B_tool" comes first, and ICU-less or differently-configured
 *     runtimes can disagree with each other;
 *   - built-in provider tools were merged onto the custom toolset AFTER that
 *     sort, so their position depended on object insertion order.
 *
 * The rule here is total and locale-free:
 *   1. built-in provider tools first, in the fixed precedence order
 *      code_interpreter, image_generation, web_search_preview;
 *   2. any other built-in, by codepoint;
 *   3. everything else, by codepoint.
 *
 * Built-ins go first because they are the most stable part of the prefix —
 * they change only when the user flips a toggle, whereas custom tools come
 * and go with the thread's extensions and documents.
 */

/** Fixed head of the built-in ordering. Anything not listed sorts after. */
export const BUILT_IN_TOOL_PRECEDENCE: readonly string[] = [
  "code_interpreter",
  "image_generation",
  "web_search_preview",
];

/**
 * Provider-native tools we know about but do not pin a position for: they
 * follow the precedence list in codepoint order. Callers that know their own
 * built-in names should pass them instead of relying on this.
 */
export const KNOWN_BUILT_IN_TOOL_NAMES: readonly string[] = [
  ...BUILT_IN_TOOL_PRECEDENCE,
  // Anthropic's server-side tools (see the anthropic provider seam).
  "web_fetch",
  "web_search",
];

/** Codepoint comparison. Deliberately NOT localeCompare. */
export function compareByCodepoint(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Rank a tool name: lower sorts earlier. Built-ins occupy ranks 0..n, with the
 * precedence list pinned at the front; everything else shares the last rank
 * and is separated by codepoint.
 */
function rankOf(name: string, builtIns: ReadonlySet<string>): number {
  const pinned = BUILT_IN_TOOL_PRECEDENCE.indexOf(name);
  if (pinned !== -1) return pinned;
  if (builtIns.has(name)) return BUILT_IN_TOOL_PRECEDENCE.length;
  return BUILT_IN_TOOL_PRECEDENCE.length + 1;
}

/**
 * Return a new toolset whose keys are in the canonical order. String keys
 * keep insertion order in JS objects, so the returned object serialises
 * byte-identically for the same input set regardless of how it was assembled.
 *
 * @param builtInNames names the caller knows to be provider-native. Defaults
 *   to KNOWN_BUILT_IN_TOOL_NAMES; the chat route passes the actual keys the
 *   provider seam produced, so a newly-wired built-in needs no change here.
 */
export function stabilizeToolset<T>(
  tools: Record<string, T>,
  builtInNames: Iterable<string> = KNOWN_BUILT_IN_TOOL_NAMES,
): Record<string, T> {
  const builtIns = new Set(builtInNames);
  const ordered: Record<string, T> = {};
  for (const name of Object.keys(tools).sort((a, b) => {
    const byRank = rankOf(a, builtIns) - rankOf(b, builtIns);
    return byRank !== 0 ? byRank : compareByCodepoint(a, b);
  })) {
    ordered[name] = tools[name];
  }
  return ordered;
}
