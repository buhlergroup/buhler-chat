/**
 * Files of an agent — one list for the agent editor.
 *
 * An agent can use a SharePoint file or folder in one of four ways. Each way
 * is an existing mechanism with its own Cosmos rows; this module only gives
 * them one name ("use") and one shape for the editor. No data migration:
 * the rows stay as they are.
 *
 *   use        | rows                            | needs the code interpreter
 *   -----------|---------------------------------|---------------------------
 *   search     | PERSONA_DOCUMENT (AI Search)    | no
 *   code       | PERSONA_CI_DOCUMENT             | yes
 *   skill      | PERSONA_SKILL                   | yes
 *   on-demand  | PERSONA_SHAREPOINT_FILE_SOURCE  | yes
 *
 * Pure module (no server-only import): the editor imports the types and the
 * labels.
 */

export const AGENT_FILE_USES = ["search", "code", "skill", "on-demand"] as const;
export type AgentFileUse = (typeof AGENT_FILE_USES)[number];

export const isAgentFileUse = (v: unknown): v is AgentFileUse =>
  typeof v === "string" && (AGENT_FILE_USES as readonly string[]).includes(v);

/** Label and one-line help of each use, as the editor shows them. */
export const AGENT_FILE_USE_TEXT: Record<AgentFileUse, { label: string; help: string }> = {
  search: {
    label: "Search",
    help: "The model searches the text. The app copies the text when you add the file.",
  },
  code: {
    label: "Code",
    help: "The file is in the code interpreter when a chat starts.",
  },
  skill: {
    label: "Skill",
    help: "Skill instructions. Uses the latest file from SharePoint.",
  },
  "on-demand": {
    label: "On demand",
    help: "The model finds and opens files when it needs them. Always the current version.",
  },
};

/** The row behind an item. The id is the row id of that kind. */
export const AGENT_FILE_REF_KINDS = ["document", "ci-document", "skill", "file-source"] as const;
export type AgentFileRefKind = (typeof AGENT_FILE_REF_KINDS)[number];

export interface AgentFileRef {
  kind: AgentFileRefKind;
  id: string;
}

export const isAgentFileRef = (v: unknown): v is AgentFileRef => {
  const r = v as { kind?: unknown; id?: unknown };
  return (
    !!r &&
    typeof r === "object" &&
    typeof r.kind === "string" &&
    (AGENT_FILE_REF_KINDS as readonly string[]).includes(r.kind) &&
    typeof r.id === "string" &&
    r.id.length > 0 &&
    r.id.length <= 256
  );
};

/** The use of each kind of row. */
export const USE_OF_REF_KIND: Record<AgentFileRefKind, AgentFileUse> = {
  document: "search",
  "ci-document": "code",
  skill: "skill",
  "file-source": "on-demand",
};

/**
 * ok: in use. no-access: the editor cannot open the SharePoint item.
 * unavailable: SharePoint did not answer. sync-error: a linked skill whose
 * newest file is not valid (chats use the last good version). missing: the
 * agent lists the item, but its row is gone.
 */
export type AgentFileStatus = "ok" | "no-access" | "unavailable" | "sync-error" | "missing";

/** One file or folder of an agent, as the editor shows it. */
export interface AgentFileItem {
  ref: AgentFileRef;
  name: string;
  /** https link to the item in SharePoint; absent for an uploaded skill. */
  webUrl?: string;
  isFolder: boolean;
  use: AgentFileUse;
  status: AgentFileStatus;
  /** Short text for the status (for example the sync error of a skill). */
  statusMessage?: string;
  sizeBytes?: number;
  /** Uses the editor may switch this item to (always includes `use`). */
  allowedUses: AgentFileUse[];
  /** A skill uploaded as a zip (not linked to SharePoint). */
  uploadedSkill?: boolean;
  /** A skill linked to SharePoint ("Check now"). */
  linkedSkill?: boolean;
}

/**
 * ListAgentFiles: an editor gets the items; everyone else who can use the
 * agent gets only the count (no names, no links).
 */
export type AgentFilesList =
  | {
      canEdit: true;
      count: number;
      items: AgentFileItem[];
      needsCodeInterpreter: boolean;
    }
  | {
      canEdit: false;
      count: number;
      items: [];
      needsCodeInterpreter: boolean;
    };

/** A SharePoint item from the picker: ids only, everything else from Graph. */
export interface AgentFilePick {
  driveId: string;
  itemId: string;
}

export type AddAgentFileResult =
  | {
      driveId: string;
      itemId: string;
      status: "added";
      name: string;
      use: AgentFileUse;
      ref: AgentFileRef;
    }
  | {
      driveId: string;
      itemId: string;
      status: "rejected";
      /** Empty when Graph gave no name (no access, unknown item). */
      name: string;
      reason: string;
    };

/** Most items one AddAgentFiles call takes (the limits of all uses together). */
export const MAX_ITEMS_PER_ADD = 70;
