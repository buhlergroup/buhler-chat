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

export const isPreconditionFailed = (error: unknown) =>
  ((error as { code?: number })?.code ?? (error as { statusCode?: number })?.statusCode) === 412;

/** Attempts of an etag-checked write (agent files add up to 4 at a time). */
export const ETAG_MAX_ATTEMPTS = 10;

/** Wait before the next attempt: 20 to 200 ms, random, so racing writers spread out. */
export const etagRetryDelayMs = (random: () => number = Math.random): number =>
  Math.round(20 + random() * 180);

/** The wait; tests replace it. */
export const etagRetryClock = {
  sleep: (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
};

/**
 * Runs `attempt` (read the row, change it, replace it with If-Match) again
 * on a 412 (the row changed meanwhile), at most 10 times, with a short random
 * wait in between. Other errors pass through. The one retry rule for the
 * persona row (agent files, skill upload, the editor's save).
 */
export async function retryOnEtagConflict<T>(attempt: (n: number) => Promise<T>): Promise<T> {
  for (let n = 0; ; n++) {
    try {
      return await attempt(n);
    } catch (error) {
      if (!isPreconditionFailed(error)) throw error;
      if (n + 1 >= ETAG_MAX_ATTEMPTS) throw new Error("The agent changed while saving. Try again.");
      await etagRetryClock.sleep(etagRetryDelayMs());
    }
  }
}

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
  return retryOnEtagConflict(async () => {
    const current = (await readPersonaRow(personaId)) as StoredPersona | undefined;
    if (!current) return undefined;
    const next = mutate(current);
    if (!next) return current;
    const { resource } = await HistoryContainer()
      .item(current.id, current.userId)
      .replace<PersonaModel>(
        next,
        current._etag ? { accessCondition: { type: "IfMatch", condition: current._etag } } : undefined,
      );
    return resource ?? next;
  });
}

/** Switches the code interpreter on; null when it is on already. */
export const withCodeInterpreterOn = (p: PersonaModel): PersonaModel | null =>
  p.defaultTools?.codeInterpreter === true
    ? null
    : { ...p, defaultTools: { ...(p.defaultTools ?? {}), codeInterpreter: true } };
