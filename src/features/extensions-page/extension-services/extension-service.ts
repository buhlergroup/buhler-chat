"use server";
import "server-only";

// Every export of this file is a server action a browser can call: only
// async functions, no re-exports, and no function that returns a secret
// value (those live in extension-secrets.ts / extension-runtime.ts).

import {
  getCurrentUser,
  userHashedId,
  userSession,
} from "@/features/auth-page/helpers";
import { saveChatThread } from "@/features/chat-page/chat-services/chat-thread-write";
import { canUseExtension } from "./extension-access";
import {
  CHAT_THREAD_ATTRIBUTE,
  ChatThreadModel,
} from "@/features/chat-page/chat-services/models";
import {
  ServerActionResponse,
  zodErrorsToServerActionErrors,
} from "@/features/common/server-action-response";
import { HistoryContainer } from "@/features/common/services/cosmos";
import { logWarn } from "@/features/common/services/logger";
import { uniqueId } from "@/features/common/util";
import { AI_NAME, CHAT_DEFAULT_PERSONA } from "@/features/theme/theme-config";
import { SqlQuerySpec } from "@azure/cosmos";
import { keyVaultSecretStore, MCP_EXTENSION_TAG, type SecretStore } from "./extension-secrets";
import {
  extensionSecretNames,
  planHeaders,
  planMcpConfig,
  type SecretPlan,
} from "./extension-save";
import { discoverMcpTools } from "./mcp/mcp-discovery";
import { hasMcpUserTokens } from "./mcp/mcp-oauth";
import {
  EXTENSION_ATTRIBUTE,
  ExtensionModel,
  ExtensionModelSchema,
  extensionKind,
} from "./models";

const queryById = async (id: string): Promise<ExtensionModel | undefined> => {
  const querySpec: SqlQuerySpec = {
    query: "SELECT * FROM root r WHERE r.type=@type AND r.id=@id",
    parameters: [
      { name: "@type", value: EXTENSION_ATTRIBUTE },
      { name: "@id", value: id },
    ],
  };
  const { resources } = await HistoryContainer()
    .items.query<ExtensionModel>(querySpec)
    .fetchAll();
  return resources[0];
};

/**
 * What a user who does not own an extension may see of it: name and
 * description. No endpoints, function code, headers, MCP URL or secret
 * names. Used where extensions of others reach the browser (a chat with a
 * shared agent, published extensions for non-admins).
 */
const toPublicView = (extension: ExtensionModel): ExtensionModel => ({
  id: extension.id,
  name: extension.name,
  description: extension.description,
  executionSteps: "",
  headers: [],
  functions: [],
  userId: extension.userId,
  isPublished: extension.isPublished,
  createdAt: extension.createdAt,
  type: extension.type,
  kind: extension.kind,
});

const notFound = (id: string): ServerActionResponse<never> => ({
  status: "NOT_FOUND",
  errors: [{ message: `Extension not found with id: ${id}` }],
});

/**
 * One extension for its owner, an admin, or anyone when it is published.
 * Everyone else gets NOT_FOUND (also when it exists), so ids cannot be
 * probed for configuration.
 */
export const FindExtensionByID = async (
  id: string
): Promise<ServerActionResponse<ExtensionModel>> => {
  try {
    const extension = await queryById(id);
    if (!extension) return notFound(id);

    const [user, hashedId] = await Promise.all([getCurrentUser(), userHashedId()]);
    if (extension.userId === hashedId || user.isAdmin) {
      return { status: "OK", response: extension };
    }
    if (extension.isPublished) {
      return { status: "OK", response: toPublicView(extension) };
    }
    return notFound(id);
  } catch (error) {
    return {
      status: "ERROR",
      errors: [{ message: `Error finding Extension: ${error}` }],
    };
  }
};

const applySecretPlan = async (plan: SecretPlan, store: SecretStore) => {
  for (const write of plan.writes) {
    await store.set(write.name, write.value);
  }
  for (const name of plan.deletes) {
    await store.remove(name).catch((error) =>
      logWarn("extension-service: secret delete failed", { name, error: String(error) })
    );
  }
};

const mergePlans = (...plans: SecretPlan[]): SecretPlan => ({
  writes: plans.flatMap((p) => p.writes),
  deletes: plans.flatMap((p) => p.deletes),
  errors: plans.flatMap((p) => p.errors),
});

/**
 * Best effort: read the tool list right after a save so the owner sees it
 * and chats do not have to ask the server each turn. A failure (server
 * down, OAuth not connected yet) keeps the save; the owner can retry with
 * "Refresh tools".
 */
const discoverAfterSave = async (
  extension: ExtensionModel,
  store: SecretStore
): Promise<ExtensionModel> => {
  if (extensionKind(extension) !== "mcp" || !extension.mcp) return extension;
  // OAuth servers: the stored list is the owner's, so it needs the owner's sign-in.
  if (
    extension.mcp.auth === "oauth" &&
    !(await hasMcpUserTokens(store, extension.id, extension.mcp.url, extension.userId))
  ) {
    return extension;
  }
  const result = await discoverMcpTools(extension, store);
  if (!result.ok) return extension;
  const updated: ExtensionModel = {
    ...extension,
    mcp: { ...extension.mcp, tools: result.tools, toolsDiscoveredAt: new Date() },
  };
  const { resource } = await HistoryContainer().items.upsert<ExtensionModel>(updated);
  return resource ?? updated;
};

export const CreateExtension = async (
  inputModel: ExtensionModel
): Promise<ServerActionResponse<ExtensionModel>> => {
  try {
    const user = await getCurrentUser();
    const id = uniqueId();
    const kind = extensionKind(inputModel);

    // ensure to reset the id's since they are generated on the client
    const headerResult = planHeaders(
      kind === "mcp" ? [] : inputModel.headers.map((h) => ({ ...h, id: "" })),
      [],
      uniqueId
    );
    // A mask on a new header has nothing to point at; keep the old
    // behaviour (no value written) instead of failing the save.
    headerResult.plan.errors = [];

    inputModel.functions.map((f) => {
      f.id = uniqueId();
    });

    const mcpResult =
      kind === "mcp" && inputModel.mcp
        ? planMcpConfig(id, inputModel.mcp, undefined, uniqueId)
        : undefined;

    const modelToSave: ExtensionModel = {
      id,
      name: inputModel.name,
      executionSteps: inputModel.executionSteps,
      description: inputModel.description,
      isPublished: user.isAdmin ? inputModel.isPublished : false,
      userId: await userHashedId(),
      createdAt: new Date(),
      type: "EXTENSION",
      functions: kind === "mcp" ? [] : inputModel.functions,
      headers: headerResult.headers,
      kind,
      ...(mcpResult ? { mcp: mcpResult.config } : {}),
    };

    const plan = mergePlans(headerResult.plan, mcpResult?.plan ?? mergePlans());
    if (plan.errors.length > 0) {
      return { status: "ERROR", errors: plan.errors.map((message) => ({ message })) };
    }

    const validatedFields = validateSchema(modelToSave);

    if (validatedFields.status === "OK") {
      const store = keyVaultSecretStore();
      await applySecretPlan(plan, store);

      const { resource } =
        await HistoryContainer().items.create<ExtensionModel>(modelToSave);

      if (resource) {
        return {
          status: "OK",
          response: await discoverAfterSave(resource, store),
        };
      } else {
        return {
          status: "ERROR",
          errors: [
            {
              message: `Error adding Extension: ${resource}`,
            },
          ],
        };
      }
    } else {
      return validatedFields;
    }
  } catch (error) {
    return {
      status: "ERROR",
      errors: [
        {
          message: `Error adding Extension: ${error}`,
        },
      ],
    };
  }
};

/**
 * Edit, delete and the MCP sign-in are for the extension OWNER (and admins,
 * who moderate published extensions). Access through a shared or published
 * agent never passes this check: such users may use the tools in a chat,
 * nothing more.
 */
export const EnsureExtensionOperation = async (
  id: string
): Promise<ServerActionResponse<ExtensionModel>> => {
  const extension = await queryById(id).catch(() => undefined);
  const currentUser = await getCurrentUser();
  const hashedId = await userHashedId();

  if (extension) {
    if (currentUser.isAdmin || extension.userId === hashedId) {
      return { status: "OK", response: extension };
    }
  }

  return {
    status: "UNAUTHORIZED",
    errors: [
      {
        message: `Extension not found with id: ${id}`,
      },
    ],
  };
};

export const DeleteExtension = async (
  id: string
): Promise<ServerActionResponse<ExtensionModel>> => {
  try {
    const extensionResponse = await EnsureExtensionOperation(id);

    if (extensionResponse.status === "OK") {
      const store = keyVaultSecretStore();
      // Agents that still list this id keep working: the access rule skips
      // ids that no longer exist, and the agent editor shows a notice.
      await Promise.all(
        extensionSecretNames(extensionResponse.response).map((name) =>
          store.remove(name).catch(() => undefined)
        )
      );
      // Per-user OAuth tokens and pending sign-ins of every user, found by
      // their extension tag. Best effort: a failure (e.g. no "list"
      // permission on the vault) must not block the delete; the records are
      // useless without the extension and are logged for cleanup.
      if (extensionResponse.response.kind === "mcp") {
        await store.removeTagged(MCP_EXTENSION_TAG, id).catch((error) =>
          logWarn("DeleteExtension: per-user MCP sign-ins not removed", {
            extensionId: id,
            error: String(error),
          })
        );
      }

      const { resource } = await HistoryContainer()
        .item(id, extensionResponse.response.userId)
        .delete<ExtensionModel>();

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
              message: `Error deleting Extension: ${resource}`,
            },
          ],
        };
      }
    }

    return extensionResponse;
  } catch (error) {
    return {
      status: "ERROR",
      errors: [
        {
          message: `Error deleting Extension: ${error}`,
        },
      ],
    };
  }
};

export const UpdateExtension = async (
  inputModel: ExtensionModel
): Promise<ServerActionResponse<ExtensionModel>> => {
  try {
    const extensionResponse = await EnsureExtensionOperation(inputModel.id);
    const user = await getCurrentUser();

    if (extensionResponse.status === "OK") {
      const stored = extensionResponse.response;
      // The kind is fixed at creation.
      const kind = extensionKind(stored);

      inputModel.isPublished = user.isAdmin
        ? inputModel.isPublished
        : stored.isPublished;

      inputModel.userId = stored.userId;
      inputModel.createdAt = new Date();
      inputModel.type = "EXTENSION";
      inputModel.kind = kind;

      const headerResult = planHeaders(
        kind === "mcp" ? [] : inputModel.headers,
        stored.headers,
        uniqueId
      );
      inputModel.headers = headerResult.headers;

      inputModel.functions.map((f) => {
        if (!f.id) {
          f.id = uniqueId();
        }
      });

      let mcpPlan: SecretPlan = mergePlans();
      if (kind === "mcp") {
        inputModel.functions = [];
        if (!inputModel.mcp) {
          return { status: "ERROR", errors: [{ message: "Server URL cannot be empty" }] };
        }
        const mcpResult = planMcpConfig(stored.id, inputModel.mcp, stored.mcp, uniqueId);
        inputModel.mcp = mcpResult.config;
        mcpPlan = mcpResult.plan;
      } else {
        delete inputModel.mcp;
      }

      const plan = mergePlans(headerResult.plan, mcpPlan);
      if (plan.errors.length > 0) {
        return { status: "ERROR", errors: plan.errors.map((message) => ({ message })) };
      }

      // schema validation
      const validatedFields = validateSchema(inputModel);

      if (validatedFields.status === "OK") {
        const store = keyVaultSecretStore();
        await applySecretPlan(plan, store);

        const { resource } =
          await HistoryContainer().items.upsert<ExtensionModel>(inputModel);

        if (resource) {
          return {
            status: "OK",
            response: await discoverAfterSave(resource, store),
          };
        } else {
          return {
            status: "ERROR",
            errors: [
              {
                message: `Error updating Extension: ${resource}`,
              },
            ],
          };
        }
      } else {
        return validatedFields;
      }
    } else {
      return extensionResponse;
    }
  } catch (error) {
    return {
      status: "ERROR",
      errors: [
        {
          message: `Error updating Extension: ${error}`,
        },
      ],
    };
  }
};

export const FindAllExtensionForCurrentUser = async (): Promise<
  ServerActionResponse<Array<ExtensionModel>>
> => {
  try {
    const hashedId = await userHashedId();
    const querySpec: SqlQuerySpec = {
      query:
        "SELECT * FROM root r WHERE r.type=@type AND (r.isPublished=@isPublished OR r.userId=@userId) ORDER BY r.createdAt DESC",
      parameters: [
        {
          name: "@type",
          value: EXTENSION_ATTRIBUTE,
        },
        {
          name: "@isPublished",
          value: true,
        },
        {
          name: "@userId",
          value: hashedId,
        },
      ],
    };

    const { resources } = await HistoryContainer()
      .items.query<ExtensionModel>(querySpec)
      .fetchAll();

    // Admins edit published extensions, so they get the full config (secret
    // values are always masks). Other users only see what they need to pick
    // an extension of someone else.
    const user = await getCurrentUser();
    return {
      status: "OK",
      response: user.isAdmin
        ? resources
        : resources.map((e) => (e.userId === hashedId ? e : toPublicView(e))),
    };
  } catch (error) {
    return {
      status: "ERROR",
      errors: [
        {
          message: `Error finding Extension: ${error}`,
        },
      ],
    };
  }
};

/**
 * Extensions shown in a chat (header menu): the user's own, published ones,
 * and the ids configured on the thread. This list is for DISPLAY only and
 * extensions of other users come as a public view. Which tools a chat may
 * use is decided per turn by resolveExtensionsForChat (extension-access.ts).
 */
export const FindAllExtensionForCurrentUserAndIds = async (extensionIds:string[]): Promise<
  ServerActionResponse<Array<ExtensionModel>>
> => {
  try {
    const hashedId = await userHashedId();
    const querySpec: SqlQuerySpec = {
      query:
        "SELECT * FROM root r WHERE r.type=@type AND (r.isPublished=@isPublished OR r.userId=@userId OR ARRAY_CONTAINS(@ids, r.id,false) ) ORDER BY r.createdAt DESC",
      parameters: [
        {
          name: "@type",
          value: EXTENSION_ATTRIBUTE,
        },
        {
          name: "@isPublished",
          value: true,
        },
        {
          name: "@userId",
          value: hashedId,
        },
        {
          name: "@ids",
          value: extensionIds || [],
        },
      ],
    };

    const { resources } = await HistoryContainer()
      .items.query<ExtensionModel>(querySpec)
      .fetchAll();

    return {
      status: "OK",
      response: resources.map((e) => (e.userId === hashedId ? e : toPublicView(e))),
    };
  } catch (error) {
    return {
      status: "ERROR",
      errors: [
        {
          message: `Error finding Extension: ${error}`,
        },
      ],
    };
  }
};

/**
 * Of the given extension ids, the ones that no longer exist (deleted by
 * their owner). The agent editor uses this for its notice. Reveals only
 * existence, no content.
 */
export const FindMissingExtensionIds = async (
  extensionIds: string[]
): Promise<ServerActionResponse<string[]>> => {
  try {
    const ids = [...new Set((extensionIds ?? []).filter((id) => typeof id === "string"))].slice(0, 100);
    if (ids.length === 0) return { status: "OK", response: [] };
    const querySpec: SqlQuerySpec = {
      query: "SELECT VALUE r.id FROM root r WHERE r.type=@type AND ARRAY_CONTAINS(@ids, r.id)",
      parameters: [
        { name: "@type", value: EXTENSION_ATTRIBUTE },
        { name: "@ids", value: ids },
      ],
    };
    const { resources } = await HistoryContainer().items.query<string>(querySpec).fetchAll();
    const existing = new Set(resources);
    return { status: "OK", response: ids.filter((id) => !existing.has(id)) };
  } catch (error) {
    return {
      status: "ERROR",
      errors: [{ message: `Error finding Extension: ${error}` }],
    };
  }
};

export const CreateChatWithExtension = async (
  extensionId: string
): Promise<ServerActionResponse<ChatThreadModel>> => {
  const extensionResponse = await FindExtensionByID(extensionId);

  if (
    extensionResponse.status === "OK" &&
    !canUseExtension(await userHashedId(), extensionResponse.response)
  ) {
    // Same answer as for an unknown id (see below): a private extension of
    // another user stays hidden, and its header secrets never reach this
    // user's chat.
    return {
      status: "ERROR",
      errors: [{ message: `Extension not found with id: ${extensionId}` }],
    };
  }

  if (extensionResponse.status === "OK") {
    const extension = extensionResponse.response;

    const response = await saveChatThread({
      name: extension.name,
      useName: (await userSession())!.name,
      userId: await userHashedId(),
      id: uniqueId(),
      createdAt: new Date(),
      lastMessageAt: new Date(),
      bookmarked: false,
      isDeleted: false,
      type: CHAT_THREAD_ATTRIBUTE,
      personaMessage: "",
      personaMessageTitle: CHAT_DEFAULT_PERSONA,
      extension: [extension.id],
      personaDocumentIds: []
    });

    return response;
  } else {
    return {
      status: "ERROR",
      errors: extensionResponse.errors,
    };
  }
};

const validateSchema = (model: ExtensionModel): ServerActionResponse => {
  const validatedFields = ExtensionModelSchema.safeParse(model);

  if (!validatedFields.success) {
    return {
      status: "ERROR",
      errors: zodErrorsToServerActionErrors(validatedFields.error.issues),
    };
  }

  if (extensionKind(model) === "mcp") {
    if (!model.mcp) {
      return { status: "ERROR", errors: [{ message: "Server URL cannot be empty" }] };
    }
    const names = model.mcp.secrets.map((s) => s.name);
    const duplicate = names.find((n, i) => names.indexOf(n) !== i);
    if (duplicate) {
      return {
        status: "ERROR",
        errors: [{ message: `Secret name ${duplicate} is already used.` }],
      };
    }
    return { status: "OK", response: model };
  }

  return validateFunctionSchema(model);
};

const validateFunctionSchema = (
  model: ExtensionModel
): ServerActionResponse => {
  let functionNames: string[] = [];

  for (let i = 0; i < model.functions.length; i++) {
    const f = model.functions[i];

    // Validate function name from the dedicated field
    const name = f.functionName;
    const findName = functionNames.find((n) => n === name);

    if (name === undefined || name === null || name === "") {
      return {
        status: "ERROR",
        errors: [
          {
            message: `Function name is required.`,
          },
        ],
      };
    }

    if (name.includes(" ")) {
      return {
        status: "ERROR",
        errors: [
          {
            message: `Function name ${name} cannot contain spaces.`,
          },
        ],
      };
    }

    if (findName) {
      return {
        status: "ERROR",
        errors: [
          {
            message: `Function name ${name} is already used. Please use a different name.`,
          },
        ],
      };
    } else {
      functionNames.push(name);
    }

    // Validate JSON code structure
    try {
      const functionSchema = JSON.parse(f.code);
      if (!functionSchema.name) {
        return {
          status: "ERROR",
          errors: [
            {
              message: `Function JSON must contain a 'name' field.`,
            },
          ],
        };
      }
    } catch (error) {
      return {
        status: "ERROR",
        errors: [
          {
            message: `Error validating function schema: ${error}. You can use ${AI_NAME} to generate a valid schema for your function.`,
          },
        ],
      };
    }
  }

  if (functionNames.length === 0) {
    return {
      status: "ERROR",
      errors: [
        {
          message: `At least one function is required.`,
        },
      ],
    };
  }

  return {
    status: "OK",
    response: model,
  };
};
