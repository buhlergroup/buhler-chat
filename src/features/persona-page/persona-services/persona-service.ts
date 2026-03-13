"use server";
import "server-only";

import { getCurrentUser, userHashedId } from "@/features/auth-page/helpers";
import { UpsertChatThread } from "@/features/chat-page/chat-services/chat-thread-service";
import {
  CHAT_THREAD_ATTRIBUTE,
  ChatThreadModel,
  ChatModel,
  AttachedFileModel,
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
import { AccessGroupById, UserAccessGroups } from "./access-group-service";
import { RevalidateCache } from "@/features/common/navigation-helpers";
import { logInfo, logError } from "@/features/common/services/logger";

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
}

export const FindPersonaByID = async (
  id: string
): Promise<ServerActionResponse<PersonaModel>> => {
  try {
    const querySpec: SqlQuerySpec = {
      query: "SELECT * FROM root r WHERE r.type=@type AND r.id=@id",
      parameters: [
        {
          name: "@type",
          value: PERSONA_ATTRIBUTE,
        },
        {
          name: "@id",
          value: id,
        },
      ],
    };

    const { resources } = await HistoryContainer()
      .items.query<PersonaModel>(querySpec)
      .fetchAll();

    if (resources.length === 0) {
      return {
        status: "NOT_FOUND",
        errors: [
          {
            message: "Persona not found",
          },
        ],
      };
    }

    if (resources[0].accessGroup && resources[0].accessGroup.id != "") {
      const access = await CheckPersonaAccess(resources[0].accessGroup.id);
      if (!access) {
        return {
          status: "UNAUTHORIZED",
          errors: [
            {
              message: `You don't have access to this persona`,
            },
          ],
        };
      }
    }

    return {
      status: "OK",
      response: resources[0],
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
    const user = await getCurrentUser();

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
      isPublished: user.isAdmin ? props.isPublished : false,
      userId: await userHashedId(),
      createdAt: new Date(),
      extensionIds: props.extensionIds,
      type: "PERSONA",
      personaDocumentIds: personaDocumentIds.response,
      accessGroup: props.accessGroup,
      codeInterpreterDocumentIds: props.codeInterpreterDocumentIds || [],
      selectedModel: props.selectedModel,
      subAgentIds: props.subAgentIds || [],
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
  const personaResponse = await FindPersonaByID(personaId);
  const currentUser = await getCurrentUser();
  const hashedId = await userHashedId();

  if (personaResponse.status === "OK") {
    if (currentUser.isAdmin || personaResponse.response.userId === hashedId) {
      return personaResponse;
    }
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
      await DeletePersonaDocumentsByPersonaId(personaId);

      const { resource: deletedPersona } = await HistoryContainer()
        .item(personaId, personaResponse.response.userId)
        .delete();

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
      const user = await getCurrentUser();

      const personaDocumentIdsResponse = await AddOrUpdatePersonaDocuments(
        sharePointFiles,
        personaInput.personaDocumentIds || []
      );

      let personaDocumentIds: string[] = [];

      if (personaDocumentIdsResponse.status == "OK") {
        personaDocumentIds = personaDocumentIdsResponse.response;
      }

      const modelToUpdate: PersonaModel = {
        ...persona,
        name: personaInput.name,
        description: personaInput.description,
        personaMessage: personaInput.personaMessage,
        isPublished: user.isAdmin
          ? personaInput.isPublished
          : persona.isPublished,
        createdAt: new Date(),
        extensionIds: personaInput.extensionIds,
        accessGroup: personaInput.accessGroup,
        personaDocumentIds: personaDocumentIds,
        codeInterpreterDocumentIds: personaInput.codeInterpreterDocumentIds || [],
        selectedModel: personaInput.selectedModel,
        subAgentIds: personaInput.subAgentIds || [],
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

    const personasWithAccess = (
      await Promise.all(
        resources.map(async (e) => {
          if (e.accessGroup && e.accessGroup.id != "") {
            const access = await CheckPersonaAccess(e.accessGroup.id);
            if (!access) {
              return null;
            }
          }
          return e;
        })
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
  const personaResponse = await FindPersonaByID(personaId);
  const user = await getCurrentUser();

  if (personaResponse.status === "OK") {
    const persona = personaResponse.response;

    // check if user has access to the persona
    if (persona.accessGroup && persona.accessGroup.id != "") {
      const access = await CheckPersonaAccess(persona.accessGroup.id);
      if (!access) {
        return {
          status: "UNAUTHORIZED",
          errors: [
            {
              message: `You don't have access to this persona`,
            },
          ],
        };
      }
    }

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

    const response = await UpsertChatThread({
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
      extension: persona.extensionIds || [],
      personaDocumentIds: persona.personaDocumentIds || [],
      attachedFiles: attachedFiles.length > 0 ? attachedFiles : undefined,
      selectedModel: persona.selectedModel as ChatModel | undefined,
      subAgentIds: persona.subAgentIds || [],
    });

    return response;
  }
  return personaResponse;
};

const ValidateSchema = (model: PersonaModel): ServerActionResponse => {
  const validatedFields = PersonaModelSchema.safeParse(model);

  if (!validatedFields.success) {
    return {
      status: "ERROR",
      errors: zodErrorsToServerActionErrors(validatedFields.error.errors),
    };
  }

  return {
    status: "OK",
    response: model,
  };
};

const CheckPersonaAccess = async (groupId: string): Promise<boolean> => {
  const accessGroupResponse = await AccessGroupById(groupId);

  if (accessGroupResponse.status === "OK") {
    return true;
  }

  return false;
};
