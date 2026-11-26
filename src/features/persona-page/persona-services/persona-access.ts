import "server-only";

/**
 * Who may open an agent (persona): the one server-side rule.
 *
 * Every path that hands a persona to a user, or starts or continues a chat
 * with one, asks `canOpenPersona` (findPersonaForCurrentUser and FindPersonaByID, FindAllPersonaForCurrentUser,
 * CreatePersonaChat, call_sub_agent through findPersonaForCurrentUser, and /api/chat for
 * threads that were started from an agent).
 *
 * Access model, in order:
 *   1. The owner (persona.userId === hashed e-mail of the viewer) can open it.
 *   2. An admin (session isAdmin) can open it. EnsurePersonaOperation already
 *      lets admins edit and delete any agent, so they must be able to read it.
 *   3. When a share group is set (accessGroup.id), only direct members of that
 *      Entra group can open it. This holds also when the agent is published:
 *      it is the rule the code enforced before this module existed, and this
 *      module does not widen access. Membership is checked with Graph
 *      `/me/memberOf` (AccessGroupById), so any group type counts, but not
 *      transitive membership. A Graph error counts as "not a member".
 *   4. With no share group, a published agent (isPublished, "Publish to the
 *      whole organization") can be opened by everyone.
 *   5. With no share group, link access ("Anyone with the link can use this
 *      agent") is ON unless linkAccess === false: every signed-in user who
 *      has the agent id (the /agent/<id>/chat or /embed/agent/<id> link) can
 *      open it. undefined counts as on, so agents saved before the field
 *      existed keep working by link. Such an agent is NOT listed for other
 *      users (FindAllPersonaForCurrentUser does not query it). A share group
 *      wins over linkAccess: it does not widen a group agent.
 *   6. Anything else (linkAccess === false, not published, no group) is
 *      private: only the owner and admins.
 *
 * Callers return NOT_FOUND for a denied access, never "forbidden", so a
 * persona id does not tell a user that the agent exists.
 *
 * No `"use server"` here on purpose: this module is called only from other
 * server modules. As a server action it would become an RPC endpoint and every
 * export would have to be an async function.
 */

import { getCurrentUser, userHashedId } from "@/features/auth-page/helpers";
import { ServerActionResponse } from "@/features/common/server-action-response";
import { HistoryContainer } from "@/features/common/services/cosmos";
import { SqlQuerySpec } from "@azure/cosmos";
import { AccessGroupById } from "./access-group-service";
import { PERSONA_ATTRIBUTE, PersonaModel } from "./models";

export type PersonaViewer = {
  /** Hashed e-mail, the same value persona.userId stores. */
  userId: string;
  isAdmin: boolean;
};

export type PersonaAccessFields = Pick<
  PersonaModel,
  "userId" | "isPublished" | "accessGroup" | "linkAccess"
>;

/** The share group of a persona, or undefined when it has none. */
export const personaShareGroupId = (
  persona: PersonaAccessFields
): string | undefined => {
  const id = persona.accessGroup?.id;
  return id ? id : undefined;
};

/** True when the signed-in user is a direct member of the group. */
export const isAccessGroupMember = async (groupId: string): Promise<boolean> => {
  const response = await AccessGroupById(groupId);
  return response.status === "OK";
};

export const currentPersonaViewer = async (): Promise<PersonaViewer> => {
  const user = await getCurrentUser();
  return { userId: await userHashedId(), isAdmin: user.isAdmin === true };
};

export const canOpenPersona = async (
  viewer: PersonaViewer,
  persona: PersonaAccessFields,
  isGroupMember: (groupId: string) => Promise<boolean> = isAccessGroupMember
): Promise<boolean> => {
  if (persona.userId === viewer.userId) return true;
  if (viewer.isAdmin) return true;

  const groupId = personaShareGroupId(persona);
  if (groupId) return isGroupMember(groupId);

  return persona.isPublished === true || persona.linkAccess !== false;
};

/**
 * Is the agent LISTED for the viewer (agent list, sub-agent search)? Only the
 * viewer's own agents, published agents and group agents. Link access opens
 * an agent but never lists it: other users reach it only through its link.
 * FindAllPersonaForCurrentUser queries the same set; this keeps the rule in
 * code too.
 */
export const isListedForViewer = (
  viewer: PersonaViewer,
  persona: PersonaAccessFields
): boolean =>
  persona.userId === viewer.userId ||
  persona.isPublished === true ||
  personaShareGroupId(persona) !== undefined;

/**
 * Who may CHANGE an agent and its documents: the owner or an admin. Being
 * able to open (use) a shared or published agent does not give edit rights.
 */
export const canEditPersona = (
  viewer: PersonaViewer,
  persona: Pick<PersonaAccessFields, "userId">
): boolean => viewer.isAdmin || persona.userId === viewer.userId;

/**
 * Fields of a persona row that only its editors (owner, admin) get: the ids
 * of its Search and Code file rows and of its sub-agents. The server keeps
 * using them (chat start, sub-agent calls, file access rule); a user who can
 * only open the agent does not need them, and the ids would tell more about
 * the agent than its card does.
 */
export const PERSONA_EDITOR_ONLY_FIELDS = [
  "personaDocumentIds",
  "codeInterpreterDocumentIds",
  "subAgentIds",
] as const;

/**
 * The persona as it may be sent to this viewer: the whole row for an editor
 * (canEditPersona), else the row without PERSONA_EDITOR_ONLY_FIELDS. Every
 * server action or route that returns a persona row uses this.
 */
export const personaForViewer = <T extends Pick<PersonaModel, "userId">>(
  viewer: PersonaViewer,
  persona: T
): T => {
  if (canEditPersona(viewer, persona)) return persona;
  const copy: Record<string, unknown> = { ...persona };
  for (const field of PERSONA_EDITOR_ONLY_FIELDS) delete copy[field];
  return copy as T;
};

export const PERSONA_EDIT_NOT_ALLOWED =
  "You are not allowed to change this agent. Only its owner or an admin can change it.";

/**
 * The edit check for every mutating persona action:
 *   - OK with the stored persona when the user may edit it,
 *   - UNAUTHORIZED ("not allowed") when the user can open it but not edit it,
 *   - NOT_FOUND when it does not exist or the user cannot open it, so the
 *     answer does not tell that a private agent exists.
 */
export const checkPersonaEdit = async (
  personaId: string,
  isGroupMember: (groupId: string) => Promise<boolean> = isAccessGroupMember
): Promise<ServerActionResponse<PersonaModel>> => {
  const persona = await findPersonaDocument(personaId);
  if (persona) {
    const viewer = await currentPersonaViewer();
    if (canEditPersona(viewer, persona)) {
      return { status: "OK", response: persona };
    }
    if (await canOpenPersona(viewer, persona, isGroupMember)) {
      return {
        status: "UNAUTHORIZED",
        errors: [{ message: PERSONA_EDIT_NOT_ALLOWED }],
      };
    }
  }
  return { status: "NOT_FOUND", errors: [{ message: "Persona not found" }] };
};

/**
 * Raw lookup by id, WITHOUT an access check. Use it only together with
 * `canOpenPersona`, or for a governance action that has its own check.
 */
export const findPersonaDocument = async (
  id: string
): Promise<PersonaModel | undefined> => {
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
  return resources[0];
};

/**
 * For a chat thread that was started from an agent: may the current user
 * send a NEW message in it? The thread itself stays readable (it belongs to
 * the user); only further turns with the agent are refused once the user can
 * no longer open the agent. A deleted agent does not block the thread: the
 * thread keeps the snapshot it was created with, as before.
 */
export const canContinuePersonaThread = async (
  personaId: string | undefined
): Promise<boolean> => {
  if (!personaId) return true;
  const persona = await findPersonaDocument(personaId);
  if (!persona) return true;
  return canOpenPersona(await currentPersonaViewer(), persona);
};
