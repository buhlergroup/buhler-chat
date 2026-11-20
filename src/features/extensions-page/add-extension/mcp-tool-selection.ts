// Pure helpers for the tool list of a Remote MCP extension form.
//
// Stored model: an empty `toolAllowList` means ALL tools of the server,
// also tools the server adds later. The form shows that as every box
// checked. "None checked" has no stored form: the form blocks the save.

import { mcpSecretTargetName, type McpConfigModel } from "../extension-services/models";

/**
 * Key of a draft (sign-in None) that is complete enough to read the tools:
 * an https URL and every header row with a name and a value (a saved row's
 * mask counts as a value). Empty when incomplete. Client memory only.
 */
export function completeDraftKey(mcp: McpConfigModel | undefined): string {
  if (!mcp || mcp.auth !== "none") return "";
  try {
    if (new URL(mcp.url).protocol !== "https:") return "";
  } catch {
    return "";
  }
  if (mcp.secrets.some((s) => !mcpSecretTargetName(s).trim() || !s.value)) return "";
  return JSON.stringify([mcp.url, mcp.transport, mcp.secrets.map((s) => [s.id, mcpSecretTargetName(s), s.value])]);
}

export interface ToolSelection {
  toolAllowList: string[];
  /** True when the user unchecked every tool. Not saved; blocks the save. */
  noneSelected: boolean;
}

export const NO_TOOL_SELECTED_MESSAGE = "Select at least one tool.";

/** Names checked in the form. */
export function checkedToolNames(
  toolNames: readonly string[],
  selection: ToolSelection
): Set<string> {
  if (selection.noneSelected) return new Set();
  if (selection.toolAllowList.length === 0) return new Set(toolNames);
  const allowed = new Set(selection.toolAllowList);
  return new Set(toolNames.filter((name) => allowed.has(name)));
}

/** The stored form of a set of checked names: all checked → empty list. */
export function selectionFromChecked(
  toolNames: readonly string[],
  checked: ReadonlySet<string>
): ToolSelection {
  const kept = toolNames.filter((name) => checked.has(name));
  if (kept.length === 0) return { toolAllowList: [], noneSelected: true };
  if (kept.length === toolNames.length) return { toolAllowList: [], noneSelected: false };
  return { toolAllowList: kept, noneSelected: false };
}

/** One box changed. */
export function toggleTool(
  toolNames: readonly string[],
  selection: ToolSelection,
  name: string,
  checked: boolean
): ToolSelection {
  const next = checkedToolNames(toolNames, selection);
  if (checked) next.add(name);
  else next.delete(name);
  return selectionFromChecked(toolNames, next);
}

/**
 * After a new tool list: drop allowed names the server no longer has. If
 * that leaves nothing of a real selection, the form shows no tool checked
 * (and blocks the save) instead of silently allowing every tool.
 */
export function reconcileSelection(
  toolNames: readonly string[],
  selection: ToolSelection
): ToolSelection {
  if (selection.noneSelected || selection.toolAllowList.length === 0) return selection;
  const names = new Set(toolNames);
  const kept = selection.toolAllowList.filter((name) => names.has(name));
  if (kept.length === 0) return { toolAllowList: [], noneSelected: true };
  if (kept.length === toolNames.length) return { toolAllowList: [], noneSelected: false };
  return { toolAllowList: kept, noneSelected: false };
}

/** The line under the tool list. */
export function selectionSummary(toolNames: readonly string[], selection: ToolSelection): string {
  if (selection.noneSelected) return NO_TOOL_SELECTED_MESSAGE;
  if (selection.toolAllowList.length === 0) return "All tools are available.";
  const count = checkedToolNames(toolNames, selection).size;
  return `${count} of ${toolNames.length} tools are available.`;
}
