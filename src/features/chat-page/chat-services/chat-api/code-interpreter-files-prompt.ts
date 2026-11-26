/**
 * The system prompt note that tells the model where the attached files are
 * in the code interpreter. A file the container gets by OpenAI file id is
 * at `/mnt/data/<file id>-<file name>`, not at `/mnt/data/<file name>`
 * (verified on the deployment: a container created with file ids, and a
 * container file added by file id). The content store reuses one OpenAI
 * file per content, so instructions that name a file by its name need the
 * exact path.
 *
 * Skill archives are left out (load_skill finds them). Sorted, so the text is
 * the same on every turn with the same files (prompt cache).
 */

import { cleanFileNameForPrompt } from "./unavailable-agent-files";

const MAX_FILES = 25;
const FILE_ID = /^[A-Za-z0-9_-]{1,128}$/;

export interface CodeInterpreterFileForPrompt {
  id: string;
  name: string;
  source?: string;
}

/** `/mnt/data/<file id>-<name>`: where a file attached by id is. */
export const codeInterpreterPathOf = (file: { id: string; name: string }): string =>
  `/mnt/data/${file.id}-${file.name}`;

/**
 * "" when no file is listed; else a short section that maps each file name
 * to its exact path. `inContainer` are the file ids this turn puts into the
 * container.
 */
export function buildCodeInterpreterFilesPrompt(
  files: ReadonlyArray<CodeInterpreterFileForPrompt>,
  inContainer: ReadonlyArray<string>,
): string {
  const ids = new Set(inContainer);
  const listed = files
    .filter((f) => f.source !== "skill" && ids.has(f.id) && FILE_ID.test(f.id) && f.name)
    .map((f) => ({ label: cleanFileNameForPrompt(f.name), path: codeInterpreterPathOf(f) }))
    .sort((a, b) => a.label.localeCompare(b.label) || a.path.localeCompare(b.path))
    .slice(0, MAX_FILES);
  if (listed.length === 0) return "";
  return (
    "\n\n## Files in the code interpreter\n" +
    "Each attached file is at the path after its name. Use this exact path in code " +
    "(/mnt/data/<name> alone does not exist):\n" +
    listed.map((f) => `- ${JSON.stringify(f.label)}: ${JSON.stringify(f.path)}`).join("\n")
  );
}
