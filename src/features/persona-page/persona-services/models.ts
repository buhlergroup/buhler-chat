import { refineFromEmpty } from "@/features/common/schema-validation";
import { z } from "zod";

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

export const SharePointFileSchema = z.object({
  documentId: z.string(), // SharePoint document ID
  parentReference: z.object({
    driveId: z.string(),
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

export const PersonaModelSchema = z.object({
  id: z.string(),
  userId: z.string(),
  name: z
    .string({
      invalid_type_error: "Invalid title",
    })
    .min(1)
    .refine(refineFromEmpty, "Title cannot be empty"),
  description: z
    .string({
      invalid_type_error: "Invalid description",
    })
    .min(1)
    .refine(refineFromEmpty, "Description cannot be empty"),
  personaMessage: z
    .string({
      invalid_type_error: "Invalid agent message",
    })
    .min(1)
    .refine(refineFromEmpty, "System message cannot be empty"),
  extensionIds: z.array(z.string()),
  isPublished: z.boolean(),
  type: z.literal(PERSONA_ATTRIBUTE),
  createdAt: z.date(),
  personaDocumentIds: z.array(z.string()).optional(),
  codeInterpreterDocumentIds: z.array(z.string()).optional(), // SharePoint documents for Code Interpreter
  accessGroup: AccessGroupSchema.optional(),
  selectedModel: z.string().optional(), // Specific model to use for this agent
  subAgentIds: z.array(z.string()).optional(), // IDs of sub-agents this agent can call
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