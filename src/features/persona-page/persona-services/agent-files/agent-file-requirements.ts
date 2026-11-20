import "server-only";

import type { PersonaModel } from "../models";
import { querySkillsByPersonaId } from "../skills/persona-skill-store";
import { queryFileSourcesByPersonaId } from "../sharepoint-files/sharepoint-file-store";

/**
 * True when the agent has a file whose use needs the code interpreter:
 * a Code file, a skill or an On-demand file or folder (see
 * USES_THAT_NEED_CODE_INTERPRETER). The agent save keeps the code
 * interpreter default tool on while this is true.
 */
export async function agentFilesNeedCodeInterpreter(
  persona: Pick<PersonaModel, "id" | "codeInterpreterDocumentIds">,
): Promise<boolean> {
  if ((persona.codeInterpreterDocumentIds?.length ?? 0) > 0) return true;
  const [skills, sources] = await Promise.all([
    querySkillsByPersonaId(persona.id),
    queryFileSourcesByPersonaId(persona.id),
  ]);
  return skills.length > 0 || sources.length > 0;
}
