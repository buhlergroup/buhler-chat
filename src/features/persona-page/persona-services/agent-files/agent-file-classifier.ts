import {
  SupportedFileExtensionsDocumentIntellicence,
  SupportedFileExtensionsTextFiles,
} from "@/features/chat-page/chat-services/models";
import { CODE_INTERPRETER_SUPPORTED_EXTENSIONS } from "@/features/chat-page/chat-services/code-interpreter-constants";
import { fileExtension, fileTypeRule } from "../sharepoint-files/sharepoint-file-models";
import type { AgentFileUse } from "./agent-file-models";

/**
 * Which uses a SharePoint item allows, and which use the app picks when the
 * item is added. Decided from Graph metadata only (name, folder facet,
 * size); the server reads it with the editor's token. Pure functions.
 *
 * Automatic use:
 *   1. folder                                  -> on-demand
 *   2. .zip that is a valid skill              -> skill; other .zip -> code
 *   3. typical document the index can read     -> search
 *      (pdf, docx, doc, pptx, txt, md, html, htm)
 *   4. code interpreter type                   -> code
 *   5. a type the on-demand tools can fetch    -> on-demand
 *   6. anything else                           -> rejected, with a reason
 * A use whose size limit the item exceeds is not allowed; the next rule
 * applies.
 */

export interface AgentFileSizeLimits {
  /** Largest file the index copies (MAX_PERSONA_DOCUMENT_SIZE). */
  searchMaxBytes: number;
  /** Largest code interpreter file (MAX_PERSONA_CI_DOCUMENT_SIZE). */
  codeMaxBytes: number;
  /** Largest file the on-demand tools fetch (images come as previews). */
  onDemandMaxBytes: number;
}

export interface AgentFileCandidate {
  name: string;
  isFolder: boolean;
  /** Unknown size: no size limit applies. */
  sizeBytes?: number;
  /**
   * Only for a .zip: true = passes the skill validation, false = does not,
   * undefined = not checked (the change of use checks it).
   */
  validSkillZip?: boolean;
}

/** Typical documents that go to the search index by default. */
export const SEARCH_DOCUMENT_EXTENSIONS = ["pdf", "docx", "doc", "pptx", "txt", "md", "html", "htm"] as const;

const upper = (ext: string) => ext.toUpperCase();

/** The index reads text files directly and everything else with Document Intelligence. */
export const isIndexableExtension = (ext: string): boolean =>
  !!ext &&
  ((Object.values(SupportedFileExtensionsDocumentIntellicence) as string[]).includes(upper(ext)) ||
    (Object.values(SupportedFileExtensionsTextFiles) as string[]).includes(upper(ext)));

export const isCodeInterpreterExtension = (ext: string): boolean =>
  !!ext && CODE_INTERPRETER_SUPPORTED_EXTENSIONS.includes(upper(ext));

const fits = (size: number | undefined, max: number) => size === undefined || size <= max;

const mb = (bytes: number) => `${Math.round((bytes / 1_000_000) * 10) / 10} MB`;

/** Search: a type the index reads, within the index size limit. */
function searchAllowed(c: AgentFileCandidate, limits: AgentFileSizeLimits): boolean {
  return !c.isFolder && isIndexableExtension(fileExtension(c.name)) && fits(c.sizeBytes, limits.searchMaxBytes);
}

/** Code: a code interpreter type, within its size limit. */
function codeAllowed(c: AgentFileCandidate, limits: AgentFileSizeLimits): boolean {
  return !c.isFolder && isCodeInterpreterExtension(fileExtension(c.name)) && fits(c.sizeBytes, limits.codeMaxBytes);
}

/** On demand: every folder; a file the fetch tool takes (images come as a preview). */
function onDemandAllowed(c: AgentFileCandidate, limits: AgentFileSizeLimits): boolean {
  if (c.isFolder) return true;
  const rule = fileTypeRule(c.name);
  if (rule.kind === "refused") return false;
  return rule.kind === "image" || fits(c.sizeBytes, limits.onDemandMaxBytes);
}

const isZip = (c: AgentFileCandidate) => !c.isFolder && fileExtension(c.name) === "zip";

/**
 * The uses the editor may choose for this item.
 *   folder: on-demand only
 *   zip:    skill (unless known invalid), code
 *   file:   search if indexable, code if a code interpreter type, on-demand
 *           if the fetch tool takes it
 */
export function allowedUses(c: AgentFileCandidate, limits: AgentFileSizeLimits): AgentFileUse[] {
  if (c.isFolder) return ["on-demand"];
  if (isZip(c)) {
    const uses: AgentFileUse[] = [];
    if (c.validSkillZip !== false) uses.push("skill");
    if (codeAllowed(c, limits)) uses.push("code");
    return uses;
  }
  const uses: AgentFileUse[] = [];
  if (searchAllowed(c, limits)) uses.push("search");
  if (codeAllowed(c, limits)) uses.push("code");
  if (onDemandAllowed(c, limits)) uses.push("on-demand");
  return uses;
}

export type AutomaticUse = { use: AgentFileUse } | { rejected: string };

/** The use the app picks when the item is added (rules 1-6 above). */
export function automaticUse(c: AgentFileCandidate, limits: AgentFileSizeLimits): AutomaticUse {
  if (c.isFolder) return { use: "on-demand" };
  const ext = fileExtension(c.name);

  if (isZip(c)) {
    if (c.validSkillZip === true) return { use: "skill" };
    if (codeAllowed(c, limits)) return { use: "code" };
    return {
      rejected: `The zip is larger than ${mb(limits.codeMaxBytes)}, the limit for code interpreter files.`,
    };
  }

  if ((SEARCH_DOCUMENT_EXTENSIONS as readonly string[]).includes(ext) && searchAllowed(c, limits)) {
    return { use: "search" };
  }
  if (codeAllowed(c, limits)) return { use: "code" };
  if (onDemandAllowed(c, limits)) return { use: "on-demand" };

  // Rejected: say whether the type or the size is the reason.
  const typeKnown =
    isIndexableExtension(ext) || isCodeInterpreterExtension(ext) || fileTypeRule(c.name).kind !== "refused";
  if (typeKnown && c.sizeBytes !== undefined) {
    return {
      rejected: `The file is too large (${mb(c.sizeBytes)}). Use a smaller file or add its folder.`,
    };
  }
  return {
    rejected: ext
      ? `Files of type .${ext} cannot be added. Add documents (PDF, Word, PowerPoint, text), data files, images, code, skill zips or folders.`
      : "Files without an extension cannot be added.",
  };
}
