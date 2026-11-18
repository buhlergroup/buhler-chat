"use server";
import "server-only";

import { getCurrentUser, userHashedId } from "@/features/auth-page/helpers";
import { saveChatThread } from "@/features/chat-page/chat-services/chat-thread-write";
import {
  CHAT_THREAD_ATTRIBUTE,
  ChatThreadModel,
  ChatModel,
  AttachedFileModel,
  withNormalizedSelectedModel,
} from "@/features/chat-page/chat-services/models";
import {
  ServerActionResponse,
  zodErrorsToServerActionErrors,
} from "@/features/common/server-action-response";
import { HistoryContainer } from "@/features/common/services/cosmos";
import { uniqueId } from "@/features/common/util";
import { SqlQuerySpec } from "@azure/cosmos";
import {
  AccessGroup,
  DefaultTools,
  DocumentMetadata,
  PERSONA_ATTRIBUTE,
  PersonaModel,
  PersonaModelSchema,
  SharePointFile,
} from "./models";
import {
  DeletePersonaDocumentsByPersonaId,
  UpdateOrAddPersonaDocuments as AddOrUpdatePersonaDocuments,
} from "./persona-documents-service";
import { 
  PersonaCIDocumentsByIds, 
  DownloadSharePointFile 
} from "./persona-ci-documents-service";
import { UploadFileForCodeInterpreter } from "@/features/chat-page/chat-services/code-interpreter-service";
import { UserAccessGroups } from "./access-group-service";
import {
  canOpenPersona,
  checkPersonaEdit,
  currentPersonaViewer,
  findPersonaDocument,
} from "./persona-access";
import { RevalidateCache } from "@/features/common/navigation-helpers";
import {
  DeleteAgentStats,
  RecordAgentChatStarted,
} from "@/features/common/services/agent-stats-service";
import { logInfo, logError, logWarn } from "@/features/common/services/logger";
import {
  deleteSkillsForPersona,
  loadUsableSkills,
  uploadSkillArchivesForCodeInterpreter,
} from "./skills/persona-skill-store";
import { getCodeInterpreterFileLimit } from "@/features/chat-page/chat-services/code-interpreter-constants";

interface PersonaInput {
  name: string;
  description: string;
  personaMessage: string;
  isPublished: boolean;
  extensionIds: string[];
  accessGroup?: {
    id: string;
    source: "SHAREPOINT";
  };
  codeInterpreterDocumentIds?: string[];
  selectedModel?: string;
  subAgentIds?: string[];
  defaultTools?: DefaultTools;
}

// Same answer for "does not exist" and "you may not open it", so an id does
// not reveal that a private agent exists (see persona-access.ts).
const personaNotFound = (): ServerActionResponse<PersonaModel> => ({
  status: "NOT_FOUND",
  errors: [
    {
      message: "Persona not found",
    },
  ],
});

export const FindPersonaByID = async (
  id: string
): Promise<ServerActionResponse<PersonaModel>> => {
  try {
    const persona = await findPersonaDocument(id);

    if (!persona) {
      return personaNotFound();
    }

    if (!(await canOpenPersona(await currentPersonaViewer(), persona))) {
      return personaNotFound();
    }

    return {
      status: "OK",
      response: withNormalizedSelectedModel(persona),
    };
  } catch (error) {
    return {
      status: "ERROR",
      errors: [
        {
          message: `Error creating persona: ${error}`,
        },
      ],
    };
  }
};

export const CreatePersona = async (
  props: PersonaInput,
  sharePointFiles: DocumentMetadata[]
): Promise<ServerActionResponse<PersonaModel>> => {
  try {
    // TODO: check if the user is part of the access group

    const personaDocumentIds = await AddOrUpdatePersonaDocuments(
      sharePointFiles,
      []
    );
    if (personaDocumentIds.status !== "OK") {
      return {
        status: "ERROR",
        errors: personaDocumentIds.errors,
      };
    }

    const modelToSave: PersonaModel = {
      id: uniqueId(),
      name: props.name,
      description: props.description,
      personaMessage: props.personaMessage,
      // Any user may publish their agent to the marketplace; fresh publishes
      // start as "community" until the governance group verifies them.
      isPublished: props.isPublished,
      trustLevel: props.isPublished ? "community" : undefined,
      publishedAt: props.isPublished ? new Date() : undefined,
      userId: await userHashedId(),
      creatorName: (await getCurrentUser()).name,
      createdAt: new Date(),
      updatedAt: new Date(),
      extensionIds: props.extensionIds,
      type: "PERSONA",
      personaDocumentIds: personaDocumentIds.response,
      accessGroup: props.accessGroup,
      codeInterpreterDocumentIds: props.codeInterpreterDocumentIds || [],
      selectedModel: props.selectedModel,
      subAgentIds: props.subAgentIds || [],
      defaultTools: props.defaultTools,
    };

    const valid = ValidateSchema(modelToSave);

    if (valid.status !== "OK") {
      return valid;
    }

    const { resource } = await HistoryContainer().items.create<PersonaModel>(
      modelToSave
    );

    if (resource) {
      return {
        status: "OK",
        response: resource,
      };
    } else {
      return {
        status: "ERROR",
        errors: [
          {
            message: "Error creating persona",
          },
        ],
      };
    }
  } catch (error) {
    return {
      status: "ERROR",
      errors: [
        {
          message: `Error creating persona: ${error}`,
        },
      ],
    };
  }
};

export const EnsurePersonaOperation = async (
  personaId: string
): Promise<ServerActionResponse<PersonaModel>> => {
  // checkPersonaEdit: owner or admin may edit (canEditPersona). A user who
  // can only open the agent gets "not allowed"; for an agent the user cannot
  // open, the answer stays the same as for an unknown id.
  const editCheck = await checkPersonaEdit(personaId);

  if (editCheck.status === "OK" || editCheck.status === "UNAUTHORIZED") {
    return editCheck;
  }

  return {
    status: "UNAUTHORIZED",
    errors: [
      {
        message: `Persona not found with id: ${personaId}`,
      },
    ],
  };
};

export const DeletePersona = async (
  personaId: string
): Promise<ServerActionResponse<PersonaModel>> => {
  try {
    const personaResponse = await EnsurePersonaOperation(personaId);

    if (personaResponse.status === "OK") {
      const documentsResponse = await DeletePersonaDocumentsByPersonaId(
        personaId
      );
      if (documentsResponse.status !== "OK") {
        return documentsResponse;
      }
      await deleteSkillsForPersona(personaId);

      const { resource: deletedPersona } = await HistoryContainer()
        .item(personaId, personaResponse.response.userId)
        .delete();

      // Best-effort cleanup of the agent's usage counters.
      await DeleteAgentStats(personaId);

      return {
        status: "OK",
        response: deletedPersona,
      };
    }

    return personaResponse;
  } catch (error) {
    return {
      status: "ERROR",
      errors: [
        {
          message: `Error deleting persona: ${error}`,
        },
      ],
    };
  }
};

export const UpsertPersona = async (
  personaInput: PersonaModel,
  sharePointFiles: DocumentMetadata[]
): Promise<ServerActionResponse<PersonaModel>> => {
  try {
    const personaResponse = await EnsurePersonaOperation(personaInput.id);

    // TODO: check if the user is part of the access group

    if (personaResponse.status === "OK") {
      const { response: persona } = personaResponse;

      // The documents to remove are computed from the STORED list, not from
      // the ids the client sends, so a save can only remove documents of
      // this agent.
      const personaDocumentIdsResponse = await AddOrUpdatePersonaDocuments(
        sharePointFiles,
        persona.personaDocumentIds || []
      );

      let personaDocumentIds: string[] = [];

      if (personaDocumentIdsResponse.status == "OK") {
        personaDocumentIds = personaDocumentIdsResponse.response;
      }

      const wasPublished = persona.isPublished;
      const willPublish = personaInput.isPublished;

      // Trust stamping: a published agent without a stored trustLevel is a
      // legacy admin-published one (effectively "verified") — materialize
      // that on save. A fresh publish (or republish) starts as "community";
      // only the governance group can raise it (agent-trust-service).
      const trustLevel =
        willPublish && !persona.trustLevel
          ? wasPublished
            ? ("verified" as const)
            : ("community" as const)
          : persona.trustLevel;

      const modelToUpdate: PersonaModel = {
        ...persona,
        name: personaInput.name,
        description: personaInput.description,
        personaMessage: personaInput.personaMessage,
        // Owners publish their own agents to the marketplace themselves
        // (EnsurePersonaOperation already restricts edits to owner/admin).
        isPublished: willPublish,
        trustLevel,
        publishedAt:
          willPublish && !wasPublished
            ? new Date()
            : persona.publishedAt
              ? new Date(persona.publishedAt)
              : undefined,
        // Preserve the original creation time (Cosmos round-trips it as an
        // ISO string, hence the coercion); track modifications in updatedAt.
        createdAt: new Date(persona.createdAt),
        updatedAt: new Date(),
        extensionIds: personaInput.extensionIds,
        accessGroup: personaInput.accessGroup,
        personaDocumentIds: personaDocumentIds,
        codeInterpreterDocumentIds: personaInput.codeInterpreterDocumentIds || [],
        selectedModel: personaInput.selectedModel,
        subAgentIds: personaInput.subAgentIds || [],
        defaultTools: personaInput.defaultTools,
      };

      const validationResponse = ValidateSchema(modelToUpdate);
      if (validationResponse.status !== "OK") {
        return validationResponse;
      }

      const { resource } = await HistoryContainer().items.upsert<PersonaModel>(
        modelToUpdate
      );

      // the check is here so that we are sure that a [] is saved for the personaDocumentIds
      if (personaDocumentIdsResponse.status !== "OK") {
        RevalidateCache({
          page: "persona",
        });
        RevalidateCache({
          page: "agent",
        });

        return {
          status: "ERROR",
          errors: personaDocumentIdsResponse.errors,
        };
      }

      if (resource) {
        return {
          status: "OK",
          response: resource,
        };
      }

      return {
        status: "ERROR",
        errors: [
          {
            message: "Error updating persona",
          },
        ],
      };
    }

    return personaResponse;
  } catch (error) {
    return {
      status: "ERROR",
      errors: [
        {
          message: `Error updating persona: ${error}`,
        },
      ],
    };
  }
};

export const FindAllPersonaForCurrentUser = async (): Promise<
  ServerActionResponse<Array<PersonaModel>>
> => {
  try {
    const response = await UserAccessGroups();
    const groupIds = [];
    if (response.status == "OK") {
      groupIds.push(...response.response.map((g: AccessGroup) => g.id));
    }
    
    const querySpec: SqlQuerySpec = {
      query:
        "SELECT * FROM root r WHERE r.type=@type AND (r.isPublished=@isPublished OR r.userId=@userId OR ARRAY_CONTAINS(@groupIds, r.accessGroup.id)) ORDER BY r.createdAt DESC",
      parameters: [
        {
          name: "@type",
          value: PERSONA_ATTRIBUTE,
        },
        {
          name: "@isPublished",
          value: true,
        },
        {
          name: "@userId",
          value: await userHashedId(),
        },
        {
          name: "@groupIds",
          value: groupIds,
        },
      ],
    };

    const { resources } = await HistoryContainer()
      .items.query<PersonaModel>(querySpec)
      .fetchAll();

    // The query is a pre-filter (it only knows the M365 groups of the user);
    // canOpenPersona is the rule.
    const viewer = await currentPersonaViewer();
    const personasWithAccess = (
      await Promise.all(
        resources.map(async (e) =>
          (await canOpenPersona(viewer, e))
            ? withNormalizedSelectedModel(e)
            : null
        )
      )
    ).filter((e) => e !== null);

    return {
      status: "OK",
      response: personasWithAccess,
    };
  } catch (error) {
    return {
      status: "ERROR",
      errors: [
        {
          message: `Error finding persona: ${error}`,
        },
      ],
    };
  }
};

export const CreatePersonaChat = async (
  personaId: string
): Promise<ServerActionResponse<ChatThreadModel>> => {
  // FindPersonaByID applies canOpenPersona: a denied agent is NOT_FOUND.
  const personaResponse = await FindPersonaByID(personaId);
  const user = await getCurrentUser();

  if (personaResponse.status === "OK") {
    const persona = personaResponse.response;

    // Download and upload Code Interpreter documents from SharePoint
    let attachedFiles: AttachedFileModel[] = [];
    const ciDocumentIds = persona.codeInterpreterDocumentIds || [];
    
    if (ciDocumentIds.length > 0) {
      logInfo("Loading Code Interpreter documents for persona chat", {
        personaId,
        ciDocumentCount: ciDocumentIds.length
      });

      const ciDocsResponse = await PersonaCIDocumentsByIds(ciDocumentIds);
      
      if (ciDocsResponse.status === "OK" && ciDocsResponse.response.length > 0) {
        const ciDocs = ciDocsResponse.response;
        
        for (const doc of ciDocs) {
          try {
            // Download file from SharePoint
            const downloadResult = await DownloadSharePointFile(
              doc.externalFile.parentReference.driveId,
              doc.externalFile.documentId
            );
            
            if (downloadResult.status !== "OK") {
              logError("Failed to download CI document from SharePoint", {
                documentId: doc.id,
                fileName: doc.fileName,
                error: downloadResult.errors
              });
              continue;
            }

            const { buffer, name, contentType } = downloadResult.response;
            
            // Create a File object from the buffer
            const file = new File([new Uint8Array(buffer)], name, { type: contentType });
            
            // Upload to OpenAI for Code Interpreter
            const uploadResult = await UploadFileForCodeInterpreter(file);
            
            if (uploadResult.status === "OK") {
              attachedFiles.push({
                id: uploadResult.response.id,
                name: uploadResult.response.name,
                type: "code-interpreter",
                uploadedAt: new Date()
              });
              
              logInfo("Successfully uploaded CI document to OpenAI", {
                documentId: doc.id,
                fileName: name,
                openaiFileId: uploadResult.response.id
              });
            } else {
              logError("Failed to upload CI document to OpenAI", {
                documentId: doc.id,
                fileName: name,
                error: uploadResult.errors
              });
            }
          } catch (error) {
            logError("Error processing CI document", {
              documentId: doc.id,
              fileName: doc.fileName,
              error: error instanceof Error ? error.message : String(error)
            });
          }
        }
      }
    }

    // Agent skills: each skill zip becomes one code interpreter file, so the
    // model can unpack it and run the skill's scripts (see load_skill). Only
    // up to the per-chat code interpreter file limit, after the agent's own
    // documents; a skill without its archive still works through load_skill.
    const skills = await loadUsableSkills(persona.id);
    if (skills.length > 0) {
      const room =
        getCodeInterpreterFileLimit(process.env.MAX_PERSONA_CI_DOCUMENT_LIMIT) -
        attachedFiles.length;
      if (room < skills.length) {
        logWarn("Agent skills exceed the code interpreter file limit", {
          personaId,
          skills: skills.length,
          room,
        });
      }
      const skillFiles = await uploadSkillArchivesForCodeInterpreter(
        skills.slice(0, Math.max(0, room)),
      );
      attachedFiles = [...attachedFiles, ...skillFiles];
    }

    // Server-built thread: saveChatThread, not the client-facing
    // UpsertChatThread (which takes only the title and the bookmark).
    const response = await saveChatThread({
      name: persona.name,
      useName: user.name,
      userId: await userHashedId(),
      id: uniqueId(),
      createdAt: new Date(),
      lastMessageAt: new Date(),
      bookmarked: false,
      isDeleted: false,
      type: CHAT_THREAD_ATTRIBUTE,
      personaMessage: persona.personaMessage,
      personaMessageTitle: persona.name,
      personaId: persona.id,
      extension: persona.extensionIds || [],
      personaDocumentIds: persona.personaDocumentIds || [],
      attachedFiles: attachedFiles.length > 0 ? attachedFiles : undefined,
      selectedModel: persona.selectedModel as ChatModel | undefined,
      subAgentIds: persona.subAgentIds || [],
      defaultTools: persona.defaultTools,
    });

    if (response.status === "OK") {
      // Fire-and-forget: stats must never block or fail chat creation.
      RecordAgentChatStarted(persona.id).catch(() => {});
    }

    return response;
  }
  return personaResponse;
};

const ValidateSchema = (model: PersonaModel): ServerActionResponse => {
  const validatedFields = PersonaModelSchema.safeParse(model);

  if (!validatedFields.success) {
    return {
      status: "ERROR",
      errors: zodErrorsToServerActionErrors(validatedFields.error.issues),
    };
  }

  return {
    status: "OK",
    response: model,
  };
};
