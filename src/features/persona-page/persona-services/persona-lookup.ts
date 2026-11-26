import "server-only";

/**
 * The full persona row for server code: chat start, sub-agent calls and the
 * access rule of agent files need the file lists and the sub-agent ids.
 *
 * Not a "use server" module: the row is never sent to the browser from
 * here. The server action FindPersonaByID returns the same row, but without
 * the editor-only fields for users who cannot edit the agent
 * (personaForViewer).
 */

import { ServerActionResponse } from "@/features/common/server-action-response";
import { withNormalizedSelectedModel } from "@/features/chat-page/chat-services/models";
import { PersonaModel } from "./models";
import {
  canOpenPersona,
  currentPersonaViewer,
  findPersonaDocument,
} from "./persona-access";

// Same answer for "does not exist" and "you may not open it", so an id does
// not reveal that a private agent exists (see persona-access.ts).
const personaNotFound = (): ServerActionResponse<PersonaModel> => ({
  status: "NOT_FOUND",
  errors: [{ message: "Persona not found" }],
});

/**
 * The persona with this id when the current user may open it
 * (canOpenPersona), else NOT_FOUND. The whole row, for server code only.
 */
export const findPersonaForCurrentUser = async (
  id: string
): Promise<ServerActionResponse<PersonaModel>> => {
  try {
    const persona = await findPersonaDocument(id);
    if (!persona || !(await canOpenPersona(await currentPersonaViewer(), persona))) {
      return personaNotFound();
    }
    return { status: "OK", response: withNormalizedSelectedModel(persona) };
  } catch (error) {
    return {
      status: "ERROR",
      errors: [{ message: `Error finding persona: ${error}` }],
    };
  }
};
