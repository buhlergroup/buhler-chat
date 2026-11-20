import "server-only";

/**
 * Etag-checked change of a persona row, for the server code that changes the
 * file lists or the code interpreter switch of an agent (agent files, skill
 * upload). Not a "use server" module: the callers check the edit permission.
 */

import { HistoryContainer } from "@/features/common/services/cosmos";
import type { PersonaModel } from "./models";
import { readPersonaRow } from "./skills/persona-skill-store";

type StoredPersona = PersonaModel & { _etag?: string };

const isPreconditionFailed = (error: unknown) =>
  ((error as { code?: number })?.code ?? (error as { statusCode?: number })?.statusCode) === 412;

/** Writers that may race for one row (agent files add up to 4 at a time). */
const MAX_ATTEMPTS = 10;

/**
 * Reads the persona row, applies `mutate` and writes it back only when the
 * row did not change meanwhile (If-Match etag); on a conflict it reads the
 * row again and retries. `mutate` returns null for "nothing to change".
 * Returns the stored row, or undefined when the agent is gone.
 */
export async function updatePersonaRow(
  personaId: string,
  mutate: (persona: PersonaModel) => PersonaModel | null,
): Promise<PersonaModel | undefined> {
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const current = (await readPersonaRow(personaId)) as StoredPersona | undefined;
    if (!current) return undefined;
    const next = mutate(current);
    if (!next) return current;
    try {
      const { resource } = await HistoryContainer()
        .item(current.id, current.userId)
        .replace<PersonaModel>(
          next,
          current._etag ? { accessCondition: { type: "IfMatch", condition: current._etag } } : undefined,
        );
      return resource ?? next;
    } catch (error) {
      if (isPreconditionFailed(error)) continue;
      throw error;
    }
  }
  throw new Error("The agent changed while saving. Try again.");
}

/** Switches the code interpreter on; null when it is on already. */
export const withCodeInterpreterOn = (p: PersonaModel): PersonaModel | null =>
  p.defaultTools?.codeInterpreter === true
    ? null
    : { ...p, defaultTools: { ...(p.defaultTools ?? {}), codeInterpreter: true } };
