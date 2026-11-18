import { proxy, useSnapshot } from "valtio";
import { RevalidateCache } from "../common/navigation-helpers";
import { ServerActionError } from "../common/server-action-response";
import { uniqueId } from "../common/util";
import {
  CreateExtension,
  UpdateExtension,
} from "./extension-services/extension-service";
import {
  EndpointType,
  ExtensionFunctionModel,
  ExtensionKind,
  ExtensionModel,
  HeaderModel,
  McpConfigModel,
  McpSecretModel,
  McpToolInfo,
} from "./extension-services/models";

/** Mask the server sends for a stored secret; sending it back keeps the value. */
export const SECRET_MASK = "**********";

const createDefaultMcpConfig = (): McpConfigModel => ({
  url: "",
  transport: "auto",
  secrets: [],
  toolAllowList: [],
  auth: "none",
});

interface FormState {
  success: boolean;
  errors: ServerActionError[];
}

class ExtensionState {
  public formState: FormState = {
    success: false,
    errors: [],
  };

  public defaultModel: ExtensionModel = this.createDefaultModel();

  public isLoading: boolean = false;
  /** Ids of MCP header rows stored on the server (their value is the mask). */
  public savedSecretIds: string[] = [];
  /** Header rows as stored, to undo a legacy bearer row's switch to a plain header. */
  private savedSecrets: Record<string, Pick<McpSecretModel, "name" | "placement" | "target">> = {};
  /** True when the server holds an OAuth client secret for this extension. */
  public hasSavedClientSecret: boolean = false;
  public isOpened: boolean = false;
  public extension: ExtensionModel = { ...this.defaultModel };

  private createDefaultModel(): ExtensionModel {
    return {
      id: "",
      name: "",
      description: "",
      executionSteps: "",
      createdAt: new Date(),
      isPublished: false,
      type: "EXTENSION",
      functions: [],
      headers: [
        {
          id: uniqueId(),
          key: "Content-Type",
          value: "application/json",
        },
        {
          id: uniqueId(),
          key: "x-create-embedding",
          value: "true",
        },
      ],
      userId: "",
    };
  }

  private createDefaultFunction(): ExtensionFunctionModel {
    const defaultFunction: ExtensionFunctionModel = {
      id: uniqueId(),
      functionName: "NewFunction",
      code: exampleFunction,
      endpoint: "",
      endpointType: "GET",
      isOpen: false,
    };
    return defaultFunction;
  }

  public async submitForm(modelToSubmit: ExtensionModel) {
    this.isLoading = true;
    this.formState = {
      success: true,
      errors: [],
    };

    const response =
      modelToSubmit.id === ""
        ? await CreateExtension(modelToSubmit)
        : await UpdateExtension(modelToSubmit);

    if (response.status !== "OK") {
      this.formState = {
        success: false,
        errors: response.errors,
      };
    } else {
      RevalidateCache({
        page: "extensions",
      });
    }

    this.isLoading = false;
    this.isOpened = !this.formState.success;
  }

  public updateOpened(value: boolean) {
    this.isOpened = value;
    if (!value) {
      RevalidateCache({
        page: "extensions",
      });
    }
  }
  
  public addFunction() {
    this.extension.functions.push({
      ...this.createDefaultFunction(),
      id: uniqueId(),
    });
  }

  public cloneFunction(functionModel: ExtensionFunctionModel) {
    const clonedFunction = { ...functionModel, id: uniqueId() };
    this.extension.functions.push(clonedFunction);
  }

  public updateFunctionCode(id: string, value: string) {
    const functionToUpdate = this.extension.functions.find((f) => f.id === id);
    if (functionToUpdate) {
      functionToUpdate.code = value;
      // Also update the functionName from the JSON code to keep them in sync
      try {
        const functionSchema = JSON.parse(value);
        if (functionSchema.name) {
          functionToUpdate.functionName = functionSchema.name;
        }
      } catch (e) {
        // If JSON parsing fails, don't update the functionName
      }
    }
  }

  public updateFunctionName(id: string, value: string) {
    const functionToUpdate = this.extension.functions.find((f) => f.id === id);
    if (functionToUpdate) {
      functionToUpdate.functionName = value;
      // Also update the name in the JSON code to keep them in sync
      try {
        const functionSchema = JSON.parse(functionToUpdate.code);
        functionSchema.name = value;
        functionToUpdate.code = JSON.stringify(functionSchema, null, 2);
      } catch (e) {
        // If JSON parsing fails, don't update the code
      }
    }
  }

  public addEndpointHeader(props: { key: string; value: string }) {
    const { key, value } = props;
    this.extension.headers.push({
      id: uniqueId(),
      key,
      value,
    });
  }

  public removeFunction(id: string) {
    this.extension.functions = this.extension.functions.filter(
      (f) => f.id !== id
    );
  }

  public openAndUpdate(models: ExtensionModel) {
    models.functions.forEach((f) => {
      f.isOpen = false;
      // Handle migration: if functionName doesn't exist, extract from JSON code
      if (!f.functionName) {
        try {
          const functionSchema = JSON.parse(f.code);
          f.functionName = functionSchema.name || "Unknown";
        } catch (e) {
          f.functionName = "Unknown";
        }
      }
    });

    this.extension = {
      ...models,
    };
    this.savedSecretIds = models.mcp?.secrets.map((s) => s.id) ?? [];
    this.savedSecrets = Object.fromEntries(
      (models.mcp?.secrets ?? []).map((s) => [s.id, { name: s.name, placement: s.placement, target: s.target }])
    );
    this.hasSavedClientSecret = models.mcp?.oauth?.clientSecret === SECRET_MASK;
    this.resetAndOpenSlider();
  }

  public newAndOpenSlider(kind: ExtensionKind = "http") {
    this.extension = this.createDefaultModel();
    this.savedSecretIds = [];
    this.savedSecrets = {};
    this.hasSavedClientSecret = false;
    if (kind === "mcp") {
      this.extension.kind = "mcp";
      this.extension.headers = [];
      this.extension.mcp = createDefaultMcpConfig();
    }
    this.resetAndOpenSlider();
  }

  // ── Remote MCP server ────────────────────────────────────────────────
  private get mcp(): McpConfigModel {
    if (!this.extension.mcp) this.extension.mcp = createDefaultMcpConfig();
    return this.extension.mcp;
  }

  public updateMcp(patch: Partial<McpConfigModel>) {
    Object.assign(this.mcp, patch);
  }

  public updateMcpOAuth(patch: Partial<NonNullable<McpConfigModel["oauth"]>>) {
    this.mcp.oauth = { ...(this.mcp.oauth ?? {}), ...patch };
  }

  /** Adds an empty header row. New rows are always plain headers. */
  public addMcpHeader() {
    this.mcp.secrets.push({ id: uniqueId(), name: "", value: "", placement: "header", target: "" });
  }

  public setMcpHeaderName(id: string, name: string) {
    const secret = this.mcp.secrets.find((s) => s.id === id);
    // Legacy bearer / query rows keep their name until they get a new value.
    if (!secret || secret.placement !== "header") return;
    secret.name = name;
    secret.target = name;
  }

  /**
   * Sets a header value. Empty on a saved row keeps the saved value (mask).
   * A legacy bearer row with a new value becomes a plain `Authorization`
   * header, sent exactly as typed; clearing the value again restores it.
   */
  public setMcpHeaderValue(id: string, value: string) {
    const secret = this.mcp.secrets.find((s) => s.id === id);
    if (!secret || secret.placement === "query") return;
    const saved = this.savedSecrets[secret.id];
    if (value) {
      if (secret.placement === "bearer") {
        secret.placement = "header";
        secret.name = "Authorization";
        secret.target = "Authorization";
      }
      secret.value = value;
      return;
    }
    if (!saved) {
      secret.value = "";
      return;
    }
    secret.value = SECRET_MASK;
    if (saved.placement === "bearer") {
      secret.placement = "bearer";
      secret.name = saved.name;
      secret.target = saved.target;
    }
  }

  public removeMcpHeader(id: string) {
    this.mcp.secrets = this.mcp.secrets.filter((s) => s.id !== id);
  }

  public toggleMcpTool(name: string, allowed: boolean) {
    const list = new Set(this.mcp.toolAllowList);
    if (allowed) list.add(name);
    else list.delete(name);
    this.mcp.toolAllowList = [...list];
  }

  public setMcpTools(tools: McpToolInfo[] | undefined) {
    this.mcp.tools = tools;
  }

  public setErrors(messages: string[]) {
    this.formState = {
      success: false,
      errors: messages.map((message) => ({ message })),
    };
  }

  public resetAndOpenSlider() {
    this.isOpened = true;
    this.formState = {
      success: false,
      errors: [],
    };
  }

  public toggleFunction(functionId: string) {
    const functionToToggle = this.extension.functions.find(
      (f) => f.id === functionId
    );
    if (functionToToggle) {
      functionToToggle.isOpen = !functionToToggle.isOpen;
    }
  }

  public removeHeader(props: { headerId: string }) {
    const { headerId } = props;
    this.extension.headers = this.extension.headers.filter(
      (h) => h.id !== headerId
    );
  }
}

export const extensionStore = proxy(new ExtensionState());

export const useExtensionState = () => {
  return useSnapshot(extensionStore, {
    sync: true,
  });
};

export const AddOrUpdateExtension = async (
  previous: any,
  formData: FormData
) => {
  const modelToSubmit = FormToExtensionModel(formData);
  await extensionStore.submitForm(modelToSubmit);
};

export const FormToExtensionModel = (formData: FormData): ExtensionModel => {
  const headerKeys = formData.getAll("header-key[]");
  const headerValues = formData.getAll("header-value[]");
  const headerIds = formData.getAll("header-id[]");

  const headers: Array<HeaderModel> = headerKeys.map((k, index) => {
    return {
      id: headerIds[index] as string,
      key: k as string,
      value: headerValues[index] as string,
    };
  });

  const endpointTypes = formData.getAll("endpoint-type[]");
  const endpoints = formData.getAll("endpoint[]");
  const codes = formData.getAll("code[]");
  const functionNames = formData.getAll("function-name[]");
  const functions: Array<ExtensionFunctionModel> = endpointTypes.map(
    (endpointType, index) => {
      return {
        id: uniqueId(),
        functionName: functionNames[index] as string,
        endpointType: endpointType as EndpointType,
        endpoint: endpoints[index] as string,
        code: codes[index] as string,
        isOpen: false,
      };
    }
  );

  const kind = (formData.get("kind") as ExtensionKind | null) ?? "http";
  // MCP settings are controlled inputs held in the store (secret values
  // included, so they are only sent to the server action, never stored).
  const mcp =
    kind === "mcp" && extensionStore.extension.mcp
      ? (JSON.parse(JSON.stringify(extensionStore.extension.mcp)) as McpConfigModel)
      : undefined;

  return {
    id: formData.get("id") as string,
    name: formData.get("name") as string,
    description: formData.get("description") as string,
    executionSteps: formData.get("executionSteps") as string,
    isPublished: formData.get("isPublished") === "on" ? true : false,
    userId: "", // the user id is set on the server once the user is authenticated
    createdAt: new Date(),
    type: "EXTENSION",
    functions: kind === "mcp" ? [] : functions,
    headers: kind === "mcp" ? [] : headers,
    kind,
    ...(mcp ? { mcp } : {}),
  };
};

export const exampleFunction = `{
  "name": "UpdateGitHubIssue",
  "parameters": {
    "type": "object",
    "properties": {
      "query": {
        "type": "object",
        "description": "Query parameters",
        "properties": {
          "ISSUE_NUMBER": {
            "type": "string",
            "description": "Github issue number",
            "example": "123"
          }
        },
        "example": {
          "ISSUE_NUMBER": "123"
        }
      }
    },
    "required": ["query"]
  },
  "description": "Update a GitHub issue with new information"
}`;
