"use server";
import "server-only";

import { getCurrentUser } from "@/features/auth-page/helpers";
import { ServerActionResponse } from "@/features/common/server-action-response";
import { HistoryContainer } from "@/features/common/services/cosmos";
import { logError } from "@/features/common/services/logger";
import { getGraphClient } from "@/features/common/services/microsoft-graph-client";
import { RevalidateCache } from "@/features/common/navigation-helpers";
import { SqlQuerySpec } from "@azure/cosmos";
import { PERSONA_ATTRIBUTE, PersonaModel, TrustLevel } from "./models";
import { currentPersonaViewer, personaForViewer } from "./persona-access";

/**
 * Whether the current user may classify marketplace agents (verify/downgrade/
 * unpublish). Membership in the Entra ID group configured via
 * AGENT_VERIFIER_GROUP_ID — checked with Graph `/me/checkMemberGroups`, which
 * (unlike the Unified-filtered /me/memberOf used for access groups) also
 * covers security groups and transitive membership. `Group.Read.All` in the
 * requested scopes already covers this call.
 *
 * Fails closed: unset group id, missing token, or Graph errors → false.
 */
export const IsAgentVerifier = async (): Promise<boolean> => {
  try {
    const groupId = process.env.AGENT_VERIFIER_GROUP_ID?.trim();
    if (!groupId) return false;

    const user = await getCurrentUser();
    // Dev short-circuit, consistent with access-group-service's placeholder.
    if (user.isLocalDevUser) return true;
    if (!user.token) return false;

    const result = await getGraphClient(user.token)
      .api("/me/checkMemberGroups")
      .post({ groupIds: [groupId] });

    return Array.isArray(result?.value) && result.value.includes(groupId);
  } catch (error) {
    logError("agent-trust: checkMemberGroups failed", {
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
};

/**
 * Raw persona lookup for verifier actions. Deliberately does NOT reuse
 * FindPersonaByID: its accessGroup gate would block verifiers who aren't
 * members of an agent's share group.
 */
const findPersonaRaw = async (id: string): Promise<PersonaModel | null> => {
  const querySpec: SqlQuerySpec = {
    query: "SELECT * FROM root r WHERE r.type=@type AND r.id=@id",
    parameters: [
      { name: "@type", value: PERSONA_ATTRIBUTE },
      { name: "@id", value: id },
    ],
  };
  const { resources } = await HistoryContainer()
    .items.query<PersonaModel>(querySpec)
    .fetchAll();
  return resources[0] ?? null;
};

const revalidateAgentPages = () => {
  RevalidateCache({ page: "chat" });
  RevalidateCache({ page: "agent" });
  RevalidateCache({ page: "persona" });
};

const UNAUTHORIZED_RESPONSE: ServerActionResponse<PersonaModel> = {
  status: "UNAUTHORIZED",
  errors: [{ message: "Only agent verifiers may change trust classification" }],
};

/**
 * Sets the trust classification of a published agent. Verifier-group only —
 * membership is re-checked server-side on every call.
 */
export const SetAgentTrustLevel = async (
  personaId: string,
  trustLevel: TrustLevel
): Promise<ServerActionResponse<PersonaModel>> => {
  try {
    if (!(await IsAgentVerifier())) return UNAUTHORIZED_RESPONSE;

    const persona = await findPersonaRaw(personaId);
    if (!persona) {
      return {
        status: "NOT_FOUND",
        errors: [{ message: `Agent not found with id: ${personaId}` }],
      };
    }

    const { resource } = await HistoryContainer()
      .item(personaId, persona.userId)
      .patch<PersonaModel>([
        { op: "set", path: "/trustLevel", value: trustLevel },
      ]);

    revalidateAgentPages();
    // A verifier who cannot edit the agent gets it without the editor-only
    // fields (personaForViewer).
    return { status: "OK", response: personaForViewer(await currentPersonaViewer(), resource!) };
  } catch (error) {
    return {
      status: "ERROR",
      errors: [{ message: `Error setting trust level: ${error}` }],
    };
  }
};

/**
 * Removes an agent from the marketplace (governance action; owners unpublish
 * via their edit sheet). Also stamps trustLevel="community" so a legacy
 * agent unpublished by a verifier cannot resurface as auto-Verified when the
 * owner re-publishes it.
 */
export const UnpublishAgent = async (
  personaId: string
): Promise<ServerActionResponse<PersonaModel>> => {
  try {
    if (!(await IsAgentVerifier())) return UNAUTHORIZED_RESPONSE;

    const persona = await findPersonaRaw(personaId);
    if (!persona) {
      return {
        status: "NOT_FOUND",
        errors: [{ message: `Agent not found with id: ${personaId}` }],
      };
    }

    const { resource } = await HistoryContainer()
      .item(personaId, persona.userId)
      .patch<PersonaModel>([
        { op: "set", path: "/isPublished", value: false },
        { op: "set", path: "/trustLevel", value: "community" },
      ]);

    revalidateAgentPages();
    // A verifier who cannot edit the agent gets it without the editor-only
    // fields (personaForViewer).
    return { status: "OK", response: personaForViewer(await currentPersonaViewer(), resource!) };
  } catch (error) {
    return {
      status: "ERROR",
      errors: [{ message: `Error unpublishing agent: ${error}` }],
    };
  }
};
