import { refineFromEmpty } from "@/features/common/schema-validation";
import { z } from "zod";
import {
  GRAPH_DRIVE_ID_PATTERN,
  GRAPH_ITEM_ID_PATTERN,
} from "@/features/common/services/sharepoint/graph-ids";

export const EXTERNAL_SOURCE = "SHAREPOINT";
export const PERSONA_DOCUMENT_ATTRIBUTE = "PERSONA_DOCUMENT";
export const PERSONA_CI_DOCUMENT_ATTRIBUTE = "PERSONA_CI_DOCUMENT"; // Code Interpreter documents

export type PersonaDocument = z.infer<typeof PersonaDocumentSchema>;

export type SharePointFile = {
  id?: string; // PersonaDocument ID
  documentId: string; // SharePoint document ID
  parentReference: {
    driveId: string;
  };
}

export type DocumentMetadata = SharePointFile & {
  name: string;
  createdBy: string;
  createdDateTime: string;
};

export type SharePointFileContent = DocumentMetadata &{
  paragraphs: string[];
  chunks?: string[];
}

// The drive and item id go into Graph URLs (/drives/{drive}/items/{item}):
// only Graph id characters are accepted (graph-ids.ts).
export const SharePointFileSchema = z.object({
  documentId: z.string().regex(GRAPH_ITEM_ID_PATTERN, "Invalid SharePoint item id"), // SharePoint document ID
  parentReference: z.object({
    driveId: z.string().regex(GRAPH_DRIVE_ID_PATTERN, "Invalid SharePoint drive id"),
  }),
});

export const PersonaDocumentSchema = z.object({
  id: z.string(),
  externalFile: SharePointFileSchema,
  userId: z.string(),
  source: z.literal(EXTERNAL_SOURCE),
  type: z.literal(PERSONA_DOCUMENT_ATTRIBUTE),
});

// Code Interpreter document schema - for non-text files that should be uploaded to Code Interpreter
export const PersonaCIDocumentSchema = z.object({
  id: z.string(),
  externalFile: SharePointFileSchema,
  fileName: z.string(), // Original file name from SharePoint
  userId: z.string(),
  source: z.literal(EXTERNAL_SOURCE),
  type: z.literal(PERSONA_CI_DOCUMENT_ATTRIBUTE),
});

export type PersonaCIDocument = z.infer<typeof PersonaCIDocumentSchema>;

export const AccessGroupSchema = z.object({
  id: z.string(),
  source: z.literal(EXTERNAL_SOURCE),
});

export const PERSONA_ATTRIBUTE = "PERSONA";
export type PersonaModel = z.infer<typeof PersonaModelSchema>;

// Trust classification of published agents. "verified" = reviewed by the
// agent-governance Entra ID group; "community" = published by a user,
// unreviewed. Only group members may change it (see agent-trust-service).
export const TRUST_LEVELS = ["verified", "community"] as const;
export type TrustLevel = (typeof TRUST_LEVELS)[number];

/**
 * Effective trust tier of an agent, or null when not published.
 * Legacy rule: agents published before trust tiers existed went through the
 * admin-only publish gate, so a published agent without a stored trustLevel
 * counts as "verified". UpsertPersona materializes the field on save, so the
 * legacy branch shrinks over time.
 */
export const effectiveTrustLevel = (persona: {
  isPublished: boolean;
  trustLevel?: TrustLevel;
}): TrustLevel | null =>
  !persona.isPublished ? null : persona.trustLevel ?? "verified";

export const DefaultToolsSchema = z.object({
  webSearch: z.boolean().optional(),
  imageGeneration: z.boolean().optional(),
  companyContent: z.boolean().optional(),
  codeInterpreter: z.boolean().optional(),
}).optional();

export type DefaultTools = z.infer<typeof DefaultToolsSchema>;

export const PersonaModelSchema = z.object({
  id: z.string(),
  userId: z.string(),
  creatorName: z.string().optional(),
  name: z
    .string({
      error: "Invalid title",
    })
    .min(1)
    .refine(refineFromEmpty, "Title cannot be empty"),
  description: z
    .string({
      error: "Invalid description",
    })
    .min(1)
    .refine(refineFromEmpty, "Description cannot be empty"),
  personaMessage: z
    .string({
      error: "Invalid agent message",
    })
    .min(1)
    .refine(refineFromEmpty, "System message cannot be empty"),
  extensionIds: z.array(z.string()),
  isPublished: z.boolean(),
  // "Anyone in the organization who has the link can use this agent" (see
  // canOpenPersona). ON unless false: undefined (agents saved before the
  // field existed) counts as on. Has no effect while a share group is set.
  linkAccess: z.boolean().optional(),
  type: z.literal(PERSONA_ATTRIBUTE),
  createdAt: z.coerce.date(), // coerce: Cosmos round-trips dates as ISO strings
  updatedAt: z.coerce.date().optional(), // last modification (createdAt is no longer overwritten on update)
  publishedAt: z.coerce.date().optional(), // first false→true publish transition
  trustLevel: z.enum(TRUST_LEVELS).optional(), // see effectiveTrustLevel for the legacy default
  personaDocumentIds: z.array(z.string()).optional(),
  codeInterpreterDocumentIds: z.array(z.string()).optional(), // SharePoint documents for Code Interpreter
  accessGroup: AccessGroupSchema.optional(),
  selectedModel: z.string().optional(), // Specific model to use for this agent
  subAgentIds: z.array(z.string()).optional(), // IDs of sub-agents this agent can call
  defaultTools: DefaultToolsSchema, // Default tool settings for this agent
});


export type AccessGroup = {
  id: string;
  name: string;
  description: string;
};


export const convertDocumentMetadataToSharePointFile = (file: DocumentMetadata): SharePointFile => {
  return {
    id: file.id,
    documentId: file.documentId,
    parentReference: file.parentReference,
  };
}

export const convertPersonaDocumentToSharePointDocument = (file: PersonaDocument): SharePointFile => {
  return {
    id: file.id,
    documentId: file.externalFile.documentId,
    parentReference: file.externalFile.parentReference,
  };
}

export const AGENT_FAVORITE_ATTRIBUTE = "AGENT_FAVORITE";

export type AgentFavoriteModel = {
  id: string;
  userId: string;
  type: typeof AGENT_FAVORITE_ATTRIBUTE;
  agentIds: string[];
};

export const convertPersonaCIDocumentToSharePointDocument = (file: PersonaCIDocument): SharePointFile & { fileName: string } => {
  return {
    id: file.id,
    documentId: file.externalFile.documentId,
    parentReference: file.externalFile.parentReference,
    fileName: file.fileName,
  };
}