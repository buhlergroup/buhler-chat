"use server";
import "server-only";

import { getCurrentUser, userHashedId } from "@/features/auth-page/helpers";
import { createChatThreadWithServerFiles } from "@/features/chat-page/chat-services/code-interpreter-file-access";
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
  PERSONA_ATTRIBUTE,
  PersonaModel,
  PersonaModelSchema,
  SharePointFile,
} from "./models";
import { deleteAgentFileRows } from "./persona-file-rows";
import { retryOnEtagConflict } from "./persona-row";
import { personaCodeDocumentsByIds } from "./persona-document-access";
import {
  CODE_FILE_NOT_VISIBLE,
  downloadCodeInterpreterFile,
  recordCodeDocumentHash,
} from "./persona-ci-documents-store";
import { UploadFileForCodeInterpreterOnce } from "@/features/chat-page/chat-services/code-interpreter-service";
import { UserAccessGroups } from "./access-group-service";
import {
  canOpenPersona,
  checkPersonaEdit,
  currentPersonaViewer,
  isListedForViewer,
  personaForViewer,
} from "./persona-access";
import { findPersonaForCurrentUser } from "./persona-lookup";
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
import { deleteFileSourcesForPersona } from "./sharepoint-files/sharepoint-file-store";
import { agentFilesNeedCodeInterpreter } from "./agent-files/agent-file-requirements";
import { getCodeInterpreterFileLimit } from "@/features/chat-page/chat-services/code-interpreter-constants";
import { unavailableAgentFileNames } from "@/features/chat-page/chat-services/chat-api/unavailable-agent-files";
import {
  extensionIdsForAgentSave,
  usableExtensionIdsForAgent,
} from "@/features/extensions-page/extension-services/extension-runtime";

interface PersonaInput {
  name: string;
  description: string;
  personaMessage: string;
  isPublished: boolean;
  linkAccess?: boolean;
  extensionIds: string[];
  accessGroup?: {
    id: string;
    source: "SHAREPOINT";
  };
  selectedModel?: string;
  subAgentIds?: string[];
  defaultTools?: DefaultTools;
}

/**
 * The agent for the current user, when the user may open it (canOpenPersona;
 * NOT_FOUND otherwise, also for a private agent). A user who cannot edit the
 * agent gets it without the ids of its files and sub-agents
 * (personaForViewer). Server code that needs them uses
 * findPersonaForCurrentUser (persona-lookup.ts).
 */
export const FindPersonaByID = async (
  id: string
): Promise<ServerActionResponse<PersonaModel>> => {
  const found = await findPersonaForCurrentUser(id);
  if (found.status !== "OK") return found;
  return {
    status: "OK",
    response: personaForViewer(await currentPersonaViewer(), found.response),
  };
};

export const CreatePersona = async (
  props: PersonaInput
): Promise<ServerActionResponse<PersonaModel>> => {
  try {
    // TODO: check if the user is part of the access group

    // A new agent has no stored extension ids: only published extensions and
    // the user's own are stored (extensionIdsForAgentSave).
    const userId = await userHashedId();
    const { kept: extensionIds } = await extensionIdsForAgentSave({
      requestedIds: props.extensionIds,
      storedIds: [],
      agentOwnerId: userId,
    });

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
      // Link access is on by default (see canOpenPersona).
      linkAccess: props.linkAccess !== false,
      userId,
      creatorName: (await getCurrentUser()).name,
      createdAt: new Date(),
      updatedAt: new Date(),
      extensionIds,
      type: "PERSONA",
      // A new agent has no files; the Files section adds them after the
      // first save (agent-file-service).
      personaDocumentIds: [],
      accessGroup: props.accessGroup,
      codeInterpreterDocumentIds: [],
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
      // The agent's files: Search and Code rows (in the owner's partition,
      // or an old row in the caller's or an admin's, with the Search index
      // chunks), skills and SharePoint sources. A failure is logged and
      // does not stop the agent delete.
      await deleteAgentFileRows(personaResponse.response, await userHashedId());
      await deleteSkillsForPersona(personaId);
      await deleteFileSourcesForPersona(personaId);

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

/**
 * Saves the form of the agent editor. The file lists (personaDocumentIds,
 * codeInterpreterDocumentIds) are NOT part of the form: they stay as stored
 * and only the agent file actions change them (agent-file-store). The write
 * is etag-checked, so a file added a moment before the save is never
 * dropped: on a conflict the row is read again and the form applied anew.
 */
export const UpsertPersona = async (
  personaInput: PersonaModel
): Promise<ServerActionResponse<PersonaModel>> => {
  try {
    // On a 412 (a file was added or removed since the read) the row is read
    // again and the form applied once more (retryOnEtagConflict).
    return await retryOnEtagConflict(async (): Promise<ServerActionResponse<PersonaModel>> => {
      const personaResponse = await EnsurePersonaOperation(personaInput.id);

      // TODO: check if the user is part of the access group

      if (personaResponse.status !== "OK") {
        return personaResponse;
      }

      const persona = personaResponse.response as PersonaModel & { _etag?: string };

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

      // Extension ids already on the stored agent stay (also another user's,
      // the temporary "legacy" rule); a NEW id must be published or owned by
      // the agent's owner (extensionIdsForAgentSave).
      const { kept: extensionIds } = await extensionIdsForAgentSave({
        requestedIds: personaInput.extensionIds,
        storedIds: persona.extensionIds,
        agentOwnerId: persona.userId,
        agentId: persona.id,
      });

      // Code, skill and On-demand files need the code interpreter: while the
      // agent has one, the default tool stays on (the editor shows it locked).
      const defaultTools: DefaultTools =
        (await agentFilesNeedCodeInterpreter(persona))
          ? { ...(personaInput.defaultTools ?? {}), codeInterpreter: true }
          : personaInput.defaultTools;

      const modelToUpdate: PersonaModel = {
        ...persona,
        name: personaInput.name,
        description: personaInput.description,
        personaMessage: personaInput.personaMessage,
        // Owners publish their own agents to the marketplace themselves
        // (EnsurePersonaOperation already restricts edits to owner/admin).
        isPublished: willPublish,
        trustLevel,
        linkAccess: personaInput.linkAccess ?? persona.linkAccess,
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
        extensionIds,
        accessGroup: personaInput.accessGroup,
        // The stored file lists, never the client's (see above).
        personaDocumentIds: persona.personaDocumentIds || [],
        codeInterpreterDocumentIds: persona.codeInterpreterDocumentIds || [],
        selectedModel: personaInput.selectedModel,
        subAgentIds: personaInput.subAgentIds || [],
        defaultTools,
      };

      const validationResponse = ValidateSchema(modelToUpdate);
      if (validationResponse.status !== "OK") {
        return validationResponse;
      }

      const { resource } = await HistoryContainer()
        .item(persona.id, persona.userId)
        .replace<PersonaModel>(
          modelToUpdate,
          persona._etag
            ? { accessCondition: { type: "IfMatch", condition: persona._etag } }
            : undefined
        );

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
    });
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
    // canOpenPersona is the rule. Agents of other users that only link access
    // opens are not listed (isListedForViewer).
    const viewer = await currentPersonaViewer();
    const personasWithAccess = (
      await Promise.all(
        resources.map(async (e) =>
          isListedForViewer(viewer, e) && (await canOpenPersona(viewer, e))
            ? personaForViewer(viewer, withNormalizedSelectedModel(e))
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
  // canOpenPersona applies: a denied agent is NOT_FOUND. The whole row (the
  // file lists), the thread is built on the server.
  const personaResponse = await findPersonaForCurrentUser(personaId);
  const user = await getCurrentUser();

  if (personaResponse.status === "OK") {
    const persona = personaResponse.response;

    // Download and upload Code Interpreter documents from SharePoint
    let attachedFiles: AttachedFileModel[] = [];
    // Names of the documents that could not be loaded although SharePoint
    // showed them to the user (too large, upload failed); the model is told
    // about them (thread.unavailableAgentFiles).
    const notLoadedFileNames: string[] = [];
    // Documents SharePoint did not show to the user (no access, moved,
    // deleted, no answer): only the number is kept, never the name, so a
    // user does not learn the names of files SharePoint denies them.
    let notAvailableFileCount = 0;
    // Listed ids whose row the user cannot get (deleted, or not readable by
    // the access rule): no name to tell, only the number.
    let notFoundFileCount = 0;
    const ciDocumentIds = [...new Set(persona.codeInterpreterDocumentIds || [])];
    
    if (ciDocumentIds.length > 0) {
      logInfo("Loading Code Interpreter documents for persona chat", {
        personaId,
        ciDocumentCount: ciDocumentIds.length
      });

      const ciDocsResponse = await personaCodeDocumentsByIds(ciDocumentIds);
      notFoundFileCount =
        ciDocsResponse.status === "OK"
          ? ciDocumentIds.length - new Set(ciDocsResponse.response.map((d) => d.id)).size
          : ciDocumentIds.length;
      if (notFoundFileCount > 0) {
        logWarn("Agent code interpreter files not found", {
          personaId,
          notFound: notFoundFileCount,
        });
      }

      if (ciDocsResponse.status === "OK" && ciDocsResponse.response.length > 0) {
        const ciDocs = ciDocsResponse.response;
        
        for (const doc of ciDocs) {
          // True once SharePoint answered the download for this user.
          let visible = false;
          try {
            // Download file from SharePoint
            const downloadResult = await downloadCodeInterpreterFile(
              doc.externalFile.parentReference.driveId,
              doc.externalFile.documentId
            );
            
            if (downloadResult.status !== "OK") {
              logError("Failed to download CI document from SharePoint", {
                documentId: doc.id,
                error: downloadResult.errors
              });
              if (downloadResult.errors.some((e) => e.code === CODE_FILE_NOT_VISIBLE)) {
                notAvailableFileCount++;
              } else {
                notLoadedFileNames.push(doc.fileName);
              }
              continue;
            }
            visible = true;

            const { buffer, name, contentType } = downloadResult.response;
            
            // Upload to OpenAI for Code Interpreter once per content: the
            // agent owner's scope (the row's partition) caches the file id,
            // so the next chat with the same file version reuses it.
            const uploadResult = await UploadFileForCodeInterpreterOnce(doc.userId, {
              name,
              contentType,
              bytes: buffer,
            });
            if (uploadResult.status === "OK" && doc.sha256 !== uploadResult.response.sha256) {
              await recordCodeDocumentHash(doc, uploadResult.response.sha256);
            }
            
            if (uploadResult.status === "OK") {
              attachedFiles.push({
                id: uploadResult.response.id,
                name: uploadResult.response.name,
                type: "code-interpreter",
                uploadedAt: new Date(),
                source: "agent-document",
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
              notLoadedFileNames.push(doc.fileName);
            }
          } catch (error) {
            logError("Error processing CI document", {
              documentId: doc.id,
              error: error instanceof Error ? error.message : String(error)
            });
            // A name only when SharePoint showed the file to the user.
            if (visible) notLoadedFileNames.push(doc.fileName);
            else notAvailableFileCount++;
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

    // The agent's extensions, checked against the chatting user with the
    // extension access rule (decideExtensionAccess): only ids this user may
    // use enter the thread.
    const chatUserId = await userHashedId();
    const extensionIds = await usableExtensionIdsForAgent(persona, chatUserId);
    const unavailableAgentFiles = unavailableAgentFileNames(notLoadedFileNames);

    // The attached files are built here on the server (agent documents and
    // skill archives), so the thread is created directly; the UpsertChatThread
    // action would drop code interpreter files it did not record itself.
    const created = await createChatThreadWithServerFiles({
      name: persona.name,
      useName: user.name,
      userId: chatUserId,
      id: uniqueId(),
      createdAt: new Date(),
      lastMessageAt: new Date(),
      bookmarked: false,
      isDeleted: false,
      type: CHAT_THREAD_ATTRIBUTE,
      personaMessage: persona.personaMessage,
      personaMessageTitle: persona.name,
      personaId: persona.id,
      extension: extensionIds,
      personaDocumentIds: persona.personaDocumentIds || [],
      attachedFiles: attachedFiles.length > 0 ? attachedFiles : undefined,
      selectedModel: persona.selectedModel as ChatModel | undefined,
      subAgentIds: persona.subAgentIds || [],
      defaultTools: persona.defaultTools,
      ...(unavailableAgentFiles.length > 0 ? { unavailableAgentFiles } : {}),
      ...(notFoundFileCount > 0 ? { notFoundAgentFileCount: notFoundFileCount } : {}),
      ...(notAvailableFileCount > 0 ? { notAvailableAgentFileCount: notAvailableFileCount } : {}),
    }).catch((error) => {
      logError("Failed to create the agent chat", {
        personaId,
        error: error instanceof Error ? error.message : String(error),
      });
      return undefined;
    });
    const response: ServerActionResponse<ChatThreadModel> = created
      ? { status: "OK", response: created }
      : { status: "ERROR", errors: [{ message: "The chat could not be created." }] };

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
