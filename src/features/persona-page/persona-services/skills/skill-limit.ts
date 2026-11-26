import "server-only";

/**
 * The skill limit of an agent, checked again after an insert.
 *
 * Adds of several requests at the same time each check the count before
 * their insert and can all see room (the slots of one AddAgentFiles call
 * only cover that call). Counting again after the insert finds the excess:
 * when the agent now has more than SKILL_LIMITS.maxSkillsPerAgent skills, the
 * just inserted skill is undone (row and blob). Two adds at the limit can
 * then both be undone; the agent never keeps more than the limit.
 *
 * Not a "use server" module: the skill actions call it after their own
 * permission check.
 */

import { HistoryContainer } from "@/features/common/services/cosmos";
import { DeleteBlob } from "@/features/common/services/azure-storage";
import { logInfo } from "@/features/common/services/logger";
import { querySkillsByPersonaId, skillBlobContainer } from "./persona-skill-store";
import { SKILL_LIMITS, type PersonaSkillModel } from "./skill-models";

/** False (and the insert undone) when the agent is over the skill limit now. */
export async function withinSkillLimit(
  personaId: string,
  inserted: Pick<PersonaSkillModel, "id" | "userId" | "blobName">,
): Promise<boolean> {
  const after = await querySkillsByPersonaId(personaId);
  if (after.length <= SKILL_LIMITS.maxSkillsPerAgent) return true;
  await HistoryContainer().item(inserted.id, inserted.userId).delete();
  await DeleteBlob(skillBlobContainer(), inserted.blobName);
  logInfo("agent skills: add undone, limit reached by a concurrent add", {
    personaId,
    skills: after.length,
    max: SKILL_LIMITS.maxSkillsPerAgent,
  });
  return false;
}
