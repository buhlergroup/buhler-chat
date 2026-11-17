import { z } from "zod";

/**
 * Agent skills — data model, limits and the access rule.
 *
 * Pure module (no server imports): the editor reads the limits and the types,
 * the server reads everything.
 *
 * Format: Agent Skills (https://agentskills.io/specification). A skill is a
 * folder with SKILL.md (YAML front matter: name, description) plus optional
 * scripts/, references/ and assets/. Uploaded as one .zip per skill.
 */

export const PERSONA_SKILL_ATTRIBUTE = "PERSONA_SKILL";

/** Spec: 1-64 chars, a-z 0-9 and single hyphens, no leading/trailing hyphen. */
export const SKILL_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export interface SkillLimits {
  /** Max size of the uploaded zip. */
  maxZipBytes: number;
  /** Max number of files (folders and archiver junk do not count). */
  maxFiles: number;
  /** Max folder levels below the skill root. */
  maxDepth: number;
  /** Max sum of the unpacked file sizes (zip bomb guard). */
  maxUncompressedBytes: number;
  /** Max uncompressed/compressed ratio, per file and for the whole zip. */
  maxCompressionRatio: number;
  /** Files below this size skip the ratio check (tiny text compresses well). */
  ratioCheckMinBytes: number;
  /** SKILL.md is stored in Cosmos next to the metadata, so it is capped. */
  maxSkillMdBytes: number;
  /** Max skills on one agent. Each one is one code interpreter file. */
  maxSkillsPerAgent: number;
}

/**
 * Zip size, file count and depth follow the Microsoft 365 Agent Builder skill
 * upload limits (50 MB, 350 files, depth 3). The 50 MB zip also matches the
 * server action body limit in next.config.js. The unpacked cap and the ratio
 * are the zip-bomb guard: 200 MB is ~10x the largest real package we have
 * (the brand slides skill: 18.4 MB zip, 20.4 MB unpacked), and text rarely
 * compresses better than 1:20, so 1:100 only trips on crafted input.
 */
export const SKILL_LIMITS: SkillLimits = {
  maxZipBytes: 50_000_000,
  maxFiles: 350,
  maxDepth: 3,
  maxUncompressedBytes: 200_000_000,
  maxCompressionRatio: 100,
  ratioCheckMinBytes: 1_000_000,
  maxSkillMdBytes: 256 * 1024,
  maxSkillsPerAgent: 10,
};

export const SkillFileEntrySchema = z.object({
  path: z.string(),
  size: z.number().int().nonnegative(),
});
export type SkillFileEntry = z.infer<typeof SkillFileEntrySchema>;

export const PersonaSkillModelSchema = z.object({
  id: z.string(),
  type: z.literal(PERSONA_SKILL_ATTRIBUTE),
  /** Partition key: the agent OWNER's hashed id (same as the persona row). */
  userId: z.string(),
  personaId: z.string(),
  name: z.string().regex(SKILL_NAME_PATTERN).max(64),
  description: z.string().min(1).max(1024),
  /** Full SKILL.md, returned by load_skill without a blob read. */
  skillMd: z.string(),
  /** "" or "<top-folder>/" inside the zip. */
  rootPrefix: z.string(),
  files: z.array(SkillFileEntrySchema),
  zipFileName: z.string(),
  zipBytes: z.number().int().nonnegative(),
  uncompressedBytes: z.number().int().nonnegative(),
  blobName: z.string(),
  /**
   * Azure OpenAI file id of this skill version's zip (purpose "assistants"),
   * uploaded once on first use and reused by every chat. A new version (new
   * blobName) clears it; a missing file is re-uploaded.
   */
  openAiFileId: z.string().optional(),
  createdAt: z.coerce.date(),
  updatedAt: z.coerce.date(),
});
export type PersonaSkillModel = z.infer<typeof PersonaSkillModelSchema>;

/** What the editor shows. No SKILL.md body, no blob name. */
export interface PersonaSkillSummary {
  id: string;
  name: string;
  description: string;
  zipFileName: string;
  zipBytes: number;
  fileCount: number;
  updatedAt: string;
}

export const toSkillSummary = (s: PersonaSkillModel): PersonaSkillSummary => ({
  id: s.id,
  name: s.name,
  description: s.description,
  zipFileName: s.zipFileName,
  zipBytes: s.zipBytes,
  fileCount: s.files.length,
  updatedAt: new Date(s.updatedAt).toISOString(),
});

// ---------------------------------------------------------------------------
// Access rule
// ---------------------------------------------------------------------------

export interface PersonaAccessFacts {
  userId: string;
  isPublished: boolean;
  accessGroup?: { id: string } | undefined;
}

/**
 * "Can this user open the agent?" — the rule of the agent list
 * (FindAllPersonaForCurrentUser) and of the extensions an agent carries:
 *   - the owner, always;
 *   - an agent shared with a group: members of that group (the group wins
 *     over "published", as in the agent list filter);
 *   - otherwise: everyone when the agent is published.
 *
 * Local stand-in for the central `canOpenPersona` of the access fix; when
 * that lands, canUsePersonaSkills below calls it instead (one-line swap).
 */
function canOpenPersonaRule(
  persona: PersonaAccessFacts,
  currentUserId: string,
  isAccessGroupMember: boolean,
): boolean {
  if (persona.userId === currentUserId) return true;
  if (persona.accessGroup && persona.accessGroup.id !== "") return isAccessGroupMember;
  return persona.isPublished;
}

/** Who may USE an agent's skills: everyone who can open the agent. */
export function canUsePersonaSkills(
  persona: PersonaAccessFacts,
  currentUserId: string,
  isAccessGroupMember: boolean,
): boolean {
  return canOpenPersonaRule(persona, currentUserId, isAccessGroupMember);
}

/**
 * Who may ADD, REPLACE or DELETE skills: the agent owner and admins — the
 * same rule as editing the agent itself (EnsurePersonaOperation) and as
 * extensions (EnsureExtensionOperation).
 */
export function canEditPersonaSkills(
  persona: Pick<PersonaAccessFacts, "userId">,
  currentUserId: string,
  isAdmin: boolean,
): boolean {
  return isAdmin || persona.userId === currentUserId;
}

// ---------------------------------------------------------------------------
// Code interpreter naming
// ---------------------------------------------------------------------------

/** File name of the skill archive inside the code interpreter. */
export const skillArchiveFileName = (skillName: string): string =>
  `skill-${skillName}.zip`;

/**
 * The skill catalog for the system prompt. Only names and descriptions
 * (progressive disclosure, level 1). Sorted by name so the text is stable
 * across turns and replicas (prompt cache).
 */
export function buildSkillCatalogPrompt(
  skills: ReadonlyArray<{ name: string; description: string }>,
): string {
  if (skills.length === 0) return "";
  const sorted = [...skills].sort((a, b) =>
    a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
  );
  const lines = sorted.map((s) => `- ${s.name}: ${s.description.replace(/\s+/g, " ")}`);
  return (
    "\n\n## Skills\n" +
    "You have these skills. When a task matches a skill, call `load_skill` with its name BEFORE you start, " +
    "then follow its instructions. Load files of the skill with `load_skill` and `path`, or use them in the code interpreter as `load_skill` explains.\n" +
    lines.join("\n")
  );
}

/**
 * Maps the code interpreter files a chat turn asks for onto the CURRENT
 * skill archives of the agent.
 *
 * A thread keeps the attached-file list it got at chat start. When the
 * owner replaces a skill, the old OpenAI file is deleted, so the stored id
 * would make the container creation fail. Here every attached file whose
 * name is a skill archive (`skill-<name>.zip`) is swapped for the current
 * file id of that skill, and dropped when the skill no longer exists or the
 * user may no longer use it. Other files pass through unchanged. The result
 * keeps the request order, so the signature stays stable across turns.
 */
export function resolveSkillCodeInterpreterFiles(input: {
  skills: ReadonlyArray<Pick<PersonaSkillModel, "name" | "openAiFileId">>;
  attachedFiles: ReadonlyArray<{ id: string; name: string }>;
  requestedFileIds: ReadonlyArray<string>;
}): { fileIds: string[]; skillsInCodeInterpreter: string[] } {
  const nameById = new Map(input.attachedFiles.map((f) => [f.id, f.name]));
  const skillByArchive = new Map(
    input.skills.map((s) => [skillArchiveFileName(s.name), s]),
  );
  const fileIds: string[] = [];
  const inCi = new Set<string>();
  for (const id of input.requestedFileIds) {
    const name = nameById.get(id);
    if (!name || !/^skill-[a-z0-9-]+\.zip$/.test(name)) {
      fileIds.push(id);
      continue;
    }
    const skill = skillByArchive.get(name);
    if (!skill) continue; // skill deleted or no longer usable: drop the stale file
    const current = skill.openAiFileId ?? id;
    if (!fileIds.includes(current)) fileIds.push(current);
    inCi.add(skill.name);
  }
  return { fileIds, skillsInCodeInterpreter: [...inCi].sort() };
}
