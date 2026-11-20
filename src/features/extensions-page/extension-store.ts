import { proxy, useSnapshot } from "valtio";
import { RevalidateCache } from "../common/navigation-helpers";
import { ServerActionError, type ServerActionResponse } from "../common/server-action-response";
import { uniqueId } from "../common/util";
import {
  completeDraftKey,
  NO_TOOL_SELECTED_MESSAGE,
  reconcileSelection,
  selectionFromChecked,
  toggleTool,
  type ToolSelection,
} from "./add-extension/mcp-tool-selection";
import {
  CreateExtension,
  UpdateExtension,
} from "./extension-services/extension-service";
import {
  DiscoverDraftMcpTools,
  DiscoverMcpTools,
} from "./extension-services/mcp/mcp-service";
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

/**
 * The parts of an MCP config that decide the connection. Header values are
 * the mask for saved rows, so a retyped value makes the key differ. Client
 * memory only; never logged or sent anywhere.
 */
const mcpConnectionKey = (mcp: McpConfigModel | undefined): string =>
  mcp
    ? JSON.stringify([
        mcp.url,
        mcp.transport,
        mcp.auth,
        mcp.secrets.map((s) => [s.id, s.name, s.placement, s.target ?? "", s.value]),
      ])
    : "";

const plain = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

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
  /** The user unchecked every MCP tool. Not saved: the save is blocked. */
  public mcpNoToolSelected: boolean = false;
  /** An MCP tool list is being read. */
  public toolsLoading: boolean = false;
  /** Why the last MCP tool list read failed, shown under the tools. */
  public toolsError: string = "";
  /** Draft key (completeDraftKey) of the last tool read, so it is not repeated by itself. */
  public toolsDraftKey: string = "";
  /** Short confirmation after a save that keeps the sheet open. */
  public saveNotice: string = "";
  /** Connection key of the saved MCP config, to tell an unsaved draft apart. */
  private savedConnectionKey: string = "";
  /** Increments per tool read; an older answer is ignored. */
  private toolsRequest: number = 0;
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
    const isMcp = modelToSubmit.kind === "mcp";
    this.saveNotice = "";
    if (isMcp && this.mcpNoToolSelected) {
      // "None checked" has no stored form (empty = all tools): never save it.
      this.setErrors([NO_TOOL_SELECTED_MESSAGE]);
      this.isOpened = true;
      return;
    }

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
      if (isMcp) {
        // MCP: the sheet stays open, so the owner can connect, check the
        // tools and save again (now as an update: the id is set).
        this.applySavedExtension(response.response);
        this.saveNotice = "Saved.";
      }
    }

    this.isLoading = false;
    this.isOpened = isMcp || !this.formState.success;

    const mcp = this.extension.mcp;
    if (isMcp && this.formState.success && mcp && !mcp.tools && mcp.auth === "none") {
      void this.loadMcpTools();
    }
  }

  /** Takes the saved MCP extension as the new form state; keeps a tool list read before the save. */
  private applySavedExtension(saved: ExtensionModel) {
    const draftTools = this.extension.mcp?.tools;
    this.extension = {
      ...saved,
      ...(saved.mcp ? { mcp: { ...saved.mcp, tools: saved.mcp.tools ?? draftTools } } : {}),
    };
    this.rememberSaved(saved);
  }

  /** What the server holds, so masks and the "unchanged" check work. */
  private rememberSaved(saved: ExtensionModel) {
    this.savedSecretIds = saved.mcp?.secrets.map((s) => s.id) ?? [];
    this.savedSecrets = Object.fromEntries(
      (saved.mcp?.secrets ?? []).map((s) => [s.id, { name: s.name, placement: s.placement, target: s.target }])
    );
    this.hasSavedClientSecret = saved.mcp?.oauth?.clientSecret === SECRET_MASK;
    this.savedConnectionKey = saved.id ? mcpConnectionKey(saved.mcp) : "";
  }

  private resetMcpUi() {
    this.mcpNoToolSelected = false;
    this.toolsLoading = false;
    this.toolsError = "";
    this.toolsDraftKey = "";
    this.saveNotice = "";
    this.toolsRequest++;
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
    this.rememberSaved(models);
    this.resetMcpUi();
    this.resetAndOpenSlider();
  }

  public newAndOpenSlider(kind: ExtensionKind = "http") {
    this.extension = this.createDefaultModel();
    this.savedSecretIds = [];
    this.savedSecrets = {};
    this.hasSavedClientSecret = false;
    this.savedConnectionKey = "";
    this.resetMcpUi();
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
    this.saveNotice = "";
    Object.assign(this.mcp, patch);
  }

  public updateMcpOAuth(patch: Partial<NonNullable<McpConfigModel["oauth"]>>) {
    this.saveNotice = "";
    this.mcp.oauth = { ...(this.mcp.oauth ?? {}), ...patch };
  }

  /** Adds an empty header row. New rows are always plain headers. */
  public addMcpHeader() {
    this.saveNotice = "";
    this.mcp.secrets.push({ id: uniqueId(), name: "", value: "", placement: "header", target: "" });
  }

  public setMcpHeaderName(id: string, name: string) {
    this.saveNotice = "";
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
    this.saveNotice = "";
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
    this.saveNotice = "";
    this.mcp.secrets = this.mcp.secrets.filter((s) => s.id !== id);
  }

  private get toolSelection(): ToolSelection {
    return { toolAllowList: [...this.mcp.toolAllowList], noneSelected: this.mcpNoToolSelected };
  }

  private setToolSelection(selection: ToolSelection) {
    this.mcp.toolAllowList = selection.toolAllowList;
    this.mcpNoToolSelected = selection.noneSelected;
    if (!selection.noneSelected && this.formState.errors.some((e) => e.message === NO_TOOL_SELECTED_MESSAGE)) {
      this.setErrors([]);
    }
  }

  private get toolNames(): string[] {
    return (this.mcp.tools ?? []).map((t) => t.name);
  }

  /** One checkbox. Every box checked is stored as an empty list (all tools). */
  public toggleMcpTool(name: string, allowed: boolean) {
    this.saveNotice = "";
    this.setToolSelection(toggleTool(this.toolNames, this.toolSelection, name, allowed));
  }

  public selectAllMcpTools() {
    this.saveNotice = "";
    this.setToolSelection({ toolAllowList: [], noneSelected: false });
  }

  public clearMcpTools() {
    this.saveNotice = "";
    this.setToolSelection(selectionFromChecked(this.toolNames, new Set()));
  }

  /** A new tool list: allowed names the server no longer has are dropped. */
  public setMcpTools(tools: McpToolInfo[] | undefined) {
    this.mcp.tools = tools;
    if (tools) this.setToolSelection(reconcileSelection(this.toolNames, this.toolSelection));
  }

  /** True when the MCP form shows the saved connection unchanged. */
  private get mcpDraftIsSaved(): boolean {
    return !!this.extension.id && mcpConnectionKey(this.extension.mcp) === this.savedConnectionKey;
  }

  /**
   * Reads the tool list. OAuth, or a saved connection without changes: from
   * the saved extension (the server stores the list). Otherwise from the
   * form values (draft discovery, nothing stored; the save stores it).
   */
  public async loadMcpTools() {
    const mcp = this.extension.mcp;
    if (!mcp) return;
    const request = ++this.toolsRequest;
    this.toolsDraftKey = completeDraftKey(mcp);
    this.toolsLoading = true;
    this.toolsError = "";

    let response: ServerActionResponse<McpToolInfo[] | undefined>;
    try {
      if (mcp.auth === "oauth" || this.mcpDraftIsSaved) {
        if (!this.extension.id) {
          response = { status: "ERROR", errors: [{ message: "Save to connect." }] };
        } else {
          const saved = await DiscoverMcpTools(this.extension.id);
          response = saved.status === "OK" ? { status: "OK", response: saved.response.mcp?.tools } : saved;
        }
      } else {
        response = await DiscoverDraftMcpTools({
          extensionId: this.extension.id || undefined,
          url: mcp.url,
          transport: mcp.transport,
          secrets: plain(mcp.secrets),
        });
      }
    } catch {
      response = { status: "ERROR", errors: [{ message: "Could not read the tools of the MCP server." }] };
    }

    if (request !== this.toolsRequest) return;
    this.toolsLoading = false;
    if (response.status !== "OK") {
      this.toolsError = response.errors.map((e) => e.message).join(" ");
      return;
    }
    this.setMcpTools(response.response ?? []);
  }

  public clearSaveNotice() {
    if (this.saveNotice) this.saveNotice = "";
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
