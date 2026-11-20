import "server-only";

/**
 * Storage of the SharePoint sources of an agent (Cosmos history container,
 * one PERSONA_SHAREPOINT_FILE_SOURCE row per source, partition = the agent
 * owner's hashed id). Not a "use server" module: reached only from server
 * code. The client-callable surface is sharepoint-file-service.ts.
 */

import { SqlQuerySpec } from "@azure/cosmos";
import { getCurrentUser } from "@/features/auth-page/helpers";
import { HistoryContainer } from "@/features/common/services/cosmos";
import { logError, logWarn } from "@/features/common/services/logger";
import { resolveSkillAccess } from "../skills/persona-skill-store";
import {
  PERSONA_FILE_SOURCE_ATTRIBUTE,
  PersonaFileSourceModelSchema,
  type PersonaFileSourceModel,
} from "./sharepoint-file-models";

const byCreated = (a: PersonaFileSourceModel, b: PersonaFileSourceModel) =>
  new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime() ||
  (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/** All valid source rows of an agent, oldest first. No access check. */
export async function queryFileSourcesByPersonaId(
  personaId: string,
): Promise<PersonaFileSourceModel[]> {
  const querySpec: SqlQuerySpec = {
    query: "SELECT * FROM root r WHERE r.type=@type AND r.personaId=@personaId",
    parameters: [
      { name: "@type", value: PERSONA_FILE_SOURCE_ATTRIBUTE },
      { name: "@personaId", value: personaId },
    ],
  };
  const { resources } = await HistoryContainer()
    .items.query<PersonaFileSourceModel>(querySpec)
    .fetchAll();
  const rows: PersonaFileSourceModel[] = [];
  for (const r of resources) {
    const parsed = PersonaFileSourceModelSchema.safeParse(r);
    if (parsed.success) rows.push(parsed.data);
    else logWarn("sharepoint files: invalid source row ignored", { personaId, id: r?.id });
  }
  return rows.sort(byCreated);
}

export interface UsableFileSources {
  sources: PersonaFileSourceModel[];
  /** The chatting user's delegated Graph token. */
  accessToken: string;
  /** The chatting user's hashed id (cache key). */
  userId: string;
}

/**
 * The sources of an agent for the CURRENT user: all of them when the user
 * can open the agent (same rule as skills), none otherwise. What the user
 * may read inside them is decided by SharePoint at fetch time, with the
 * user's token. Never throws: a failure means "no sources", so a broken
 * store cannot break a chat.
 */
export async function loadUsableFileSources(
  personaId: string | undefined,
): Promise<UsableFileSources | undefined> {
  if (!personaId) return undefined;
  try {
    const sources = await queryFileSourcesByPersonaId(personaId);
    if (sources.length === 0) return undefined;
    const access = await resolveSkillAccess(personaId);
    if (!access?.canUse) {
      logWarn("sharepoint files: user may not use this agent", { personaId });
      return undefined;
    }
    const { token } = await getCurrentUser();
    if (!token) return undefined;
    return { sources, accessToken: token, userId: access.currentUserId };
  } catch (error) {
    logError("sharepoint files: failed to load the sources", {
      personaId,
      error: error instanceof Error ? error.message : String(error),
    });
    return undefined;
  }
}

/** Deletes every source row of an agent. Best effort. */
export async function deleteFileSourcesForPersona(personaId: string): Promise<void> {
  try {
    for (const source of await queryFileSourcesByPersonaId(personaId)) {
      await HistoryContainer().item(source.id, source.userId).delete();
    }
  } catch (error) {
    logError("sharepoint files: cleanup after agent delete failed", {
      personaId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
