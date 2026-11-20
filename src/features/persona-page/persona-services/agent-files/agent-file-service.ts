"use server";
import "server-only";

/**
 * Server actions for the Files section of the agent editor.
 *
 * Every action checks the edit permission first (resolveSkillAccess: owner
 * or admin, the rule of the skill and SharePoint source actions); the list
 * also answers users who can only use the agent, with the count alone.
 *
 * Rules for this file: every export is an async function and nothing is
 * re-exported (a re-export in a "use server" file resolves to undefined in
 * the production build — see scripts/check-server-actions.mjs). Types and
 * helpers are in agent-file-models.ts and agent-file-store.ts.
 */

import { ServerActionResponse } from "@/features/common/server-action-response";
import { RevalidateCache } from "@/features/common/navigation-helpers";
import { logError } from "@/features/common/services/logger";
import { resolveSkillAccess, type SkillAccess } from "../skills/persona-skill-store";
import {
  MAX_ITEMS_PER_ADD,
  isAgentFileRef,
  isAgentFileUse,
  type AddAgentFileResult,
  type AgentFilePick,
  type AgentFileRef,
  type AgentFilesList,
  type AgentFileUse,
} from "./agent-file-models";
import {
  addAgentFiles,
  changeAgentFileUse,
  listAgentFiles,
  removeAgentFile,
} from "./agent-file-store";

const notFound = <T,>(): ServerActionResponse<T> => ({
  status: "NOT_FOUND",
  errors: [{ message: "Agent not found." }],
});

const notAllowed = <T,>(): ServerActionResponse<T> => ({
  status: "UNAUTHORIZED",
  errors: [{ message: "Only the owner of the agent or an admin can change its files." }],
});

const failed = <T,>(message: string): ServerActionResponse<T> => ({
  status: "ERROR",
  errors: [{ message }],
});

/** Edit access, or the answer to send. Unknown and hidden agents look the same. */
async function editAccess<T>(personaId: unknown): Promise<SkillAccess | ServerActionResponse<T>> {
  if (typeof personaId !== "string" || !personaId) return failed("Save the agent first.");
  const access = await resolveSkillAccess(personaId);
  if (!access || !access.canUse) return notFound();
  if (!access.canEdit) return notAllowed();
  return access;
}

const isAccess = (v: unknown): v is SkillAccess =>
  !!v && typeof v === "object" && "persona" in v && "canEdit" in v;

const refreshAgentPages = async () => {
  await RevalidateCache({ page: "persona" });
  await RevalidateCache({ page: "agent" });
};

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

/**
 * The files of an agent. Editors get every item; users who can only use
 * the agent get the number of files (no names, no links).
 */
export async function ListAgentFiles(personaId: string): Promise<ServerActionResponse<AgentFilesList>> {
  try {
    if (typeof personaId !== "string" || !personaId) return failed("Save the agent first.");
    const access = await resolveSkillAccess(personaId);
    if (!access || !access.canUse) return notFound();
    return { status: "OK", response: await listAgentFiles(access) };
  } catch (error) {
    logError("agent files: list failed", { personaId, error: errorText(error) });
    return failed("The files could not be loaded.");
  }
}

/**
 * Adds SharePoint files and folders. The client sends ids only; the server
 * reads name, type and size from Graph and picks the use of each item.
 * One result per item: added (with its use) or rejected (with the reason).
 */
export async function AddAgentFiles(
  personaId: string,
  items: AgentFilePick[],
): Promise<ServerActionResponse<AddAgentFileResult[]>> {
  try {
    const access = await editAccess<AddAgentFileResult[]>(personaId);
    if (!isAccess(access)) return access;
    if (!Array.isArray(items) || items.length === 0) return failed("Choose files or folders.");
    if (items.length > MAX_ITEMS_PER_ADD) {
      return failed(`Choose up to ${MAX_ITEMS_PER_ADD} items at a time.`);
    }
    const picks: AgentFilePick[] = [];
    const seen = new Set<string>();
    for (const i of items) {
      const driveId = typeof i?.driveId === "string" ? i.driveId : "";
      const itemId = typeof i?.itemId === "string" ? i.itemId : "";
      const key = `${driveId}|${itemId}`;
      if (seen.has(key)) continue;
      seen.add(key);
      picks.push({ driveId, itemId });
    }
    const results = await addAgentFiles(access, picks);
    if (results.some((r) => r.status === "added")) await refreshAgentPages();
    return { status: "OK", response: results };
  } catch (error) {
    logError("agent files: add failed", { personaId, error: errorText(error) });
    return failed("The files could not be added.");
  }
}

/** Removes one file or folder from the agent. */
export async function RemoveAgentFile(
  personaId: string,
  ref: AgentFileRef,
): Promise<ServerActionResponse<true>> {
  try {
    const access = await editAccess<true>(personaId);
    if (!isAccess(access)) return access;
    if (!isAgentFileRef(ref)) return failed("Choose a file of this agent.");
    const res = await removeAgentFile(access, { kind: ref.kind, id: ref.id });
    if (res.status === "OK") await refreshAgentPages();
    return res;
  } catch (error) {
    logError("agent files: remove failed", { personaId, error: errorText(error) });
    return failed("The file could not be removed.");
  }
}

/**
 * Changes how the agent uses an item. Only a use from the item's allowed
 * set (checked again here with Graph metadata) is accepted.
 */
export async function ChangeAgentFileUse(
  personaId: string,
  ref: AgentFileRef,
  use: AgentFileUse,
): Promise<ServerActionResponse<{ ref: AgentFileRef; use: AgentFileUse }>> {
  try {
    const access = await editAccess<{ ref: AgentFileRef; use: AgentFileUse }>(personaId);
    if (!isAccess(access)) return access;
    if (!isAgentFileRef(ref)) return failed("Choose a file of this agent.");
    if (!isAgentFileUse(use)) return failed("Choose a use.");
    const res = await changeAgentFileUse(access, { kind: ref.kind, id: ref.id }, use);
    if (res.status === "OK") await refreshAgentPages();
    return res;
  } catch (error) {
    logError("agent files: change of use failed", { personaId, error: errorText(error) });
    return failed("The use could not be changed.");
  }
}
