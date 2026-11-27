import "server-only";

/**
 * Production ProviderClients for provider-tools.ts: the app's Azure OpenAI
 * v1 client (same endpoint and auth as the rest of the app), the chat image
 * store, and the code interpreter container helpers of the AI SDK path.
 */
import { AzureOpenAI, toFile } from "openai";
import { OpenAIV1Instance } from "@/features/common/services/openai";
import { getAzureCognitiveServicesTokenProvider } from "@/features/common/services/azure-default-credential";
import { logInfo, logWarn } from "@/features/common/services/logger";
import { FALLBACK_MODEL_CHAIN, MODEL_CONFIGS } from "../models";
import { persistBase64Image } from "../chat-image-persistence-service";
import { ensureCodeInterpreterContainer } from "../code-interpreter-container";
import { ToolUserError } from "../tools/tool-user-error";
import {
  resolveResponsesModel,
  RUN_CODE_MODEL_ENV,
  WEB_SEARCH_MODEL_ENV,
  type CodeRunResult,
  type ContainerFile,
  type ProviderClients,
  type ProviderToolDeps,
  type WebCitation,
} from "./provider-tools";
import { responsesCallUsage } from "./tool-model-usage";

const RUN_CODE_TIMEOUT_MS = 5 * 60 * 1000;
const WEB_SEARCH_TIMEOUT_MS = 90 * 1000;
const IMAGE_TIMEOUT_MS = 3 * 60 * 1000;

/**
 * The image deployment's own images endpoint (deployment-scoped path; the
 * v1 path answers 404 for image deployments, measured). Same auth rule as
 * openai.production.ts: an API key only when the app uses one, else Entra.
 */
function imageClient(deployment: string): AzureOpenAI {
  const apiKey = process.env.AZURE_OPENAI_API_KEY;
  return new AzureOpenAI({
    ...(apiKey ? { apiKey } : { azureADTokenProvider: getAzureCognitiveServicesTokenProvider() }),
    endpoint: `https://${process.env.AZURE_OPENAI_API_INSTANCE_NAME}.openai.azure.com`,
    deployment,
    apiVersion: process.env.COPILOT_IMAGE_API_VERSION?.trim() || "2025-04-01-preview",
    maxRetries: 2,
  });
}

const withTimeout = (signal: AbortSignal | undefined, ms: number) =>
  signal ? AbortSignal.any([signal, AbortSignal.timeout(ms)]) : AbortSignal.timeout(ms);

// One code interpreter container per thread and process. Azure removes an
// idle container after 20 minutes; ensureCodeInterpreterContainer checks a
// known id and replaces it when it has gone. A container holds the thread's
// code interpreter files it was created with (by file id); when that set
// changes, a new container is created (as the AI SDK path does).
type KnownContainer = { id: string; files: string };
const g = globalThis as typeof globalThis & { __copilotRunCodeContainersByFiles?: Map<string, KnownContainer> };
const containers = (g.__copilotRunCodeContainersByFiles ??= new Map<string, KnownContainer>());

/** The container's file set as one string (sorted ids). */
export const containerFilesSignature = (fileIds: ReadonlyArray<string>): string => [...new Set(fileIds)].sort().join(",");

/**
 * The thread's run_code container: the known one while its file set is the
 * same (replaced when Azure removed it), else a new one with `fileIds`.
 */
export async function ensureRunCodeContainer(
  key: string,
  threadId: string,
  fileIds: ReadonlyArray<string>,
  ensure: typeof ensureCodeInterpreterContainer = ensureCodeInterpreterContainer,
): Promise<string> {
  const files = containerFilesSignature(fileIds);
  const known = containers.get(key);
  const existing = known && known.files === files ? known.id : undefined;
  let id = await ensure({ threadId, existingContainerId: existing, fileIds: [...fileIds] });
  if (!id && fileIds.length > 0) {
    // A file the container cannot take (e.g. deleted upstream) must not
    // block every run: run without the files; the next call tries again.
    logWarn("copilot-runtime: run_code container with files failed, running without them", { threadId, fileCount: fileIds.length });
    id = await ensure({ threadId, existingContainerId: undefined, fileIds: [] });
    if (id) return id;
  }
  if (!id) throw new ToolUserError("run_code: the code interpreter is not available here.");
  if (id !== existing) {
    containers.set(key, { id, files });
    logInfo("copilot-runtime: run_code container", { threadId, reused: false, fileCount: fileIds.length });
  }
  return id;
}

type Responses = {
  create(body: Record<string, unknown>, options?: { signal?: AbortSignal }): Promise<{
    output?: Array<Record<string, unknown>>;
    output_text?: string;
    usage?: unknown;
  }>;
};

function textAndCitations(output: Array<Record<string, unknown>> | undefined): { text: string; citations: WebCitation[] } {
  let text = "";
  const citations: WebCitation[] = [];
  for (const item of output ?? []) {
    if (item.type !== "message" || !Array.isArray(item.content)) continue;
    for (const part of item.content as Array<Record<string, unknown>>) {
      if (part.type !== "output_text") continue;
      text += String(part.text ?? "");
      for (const a of (Array.isArray(part.annotations) ? part.annotations : []) as Array<Record<string, unknown>>) {
        if (a.type === "url_citation" && typeof a.url === "string") {
          citations.push({ url: a.url, ...(typeof a.title === "string" && a.title ? { title: a.title } : {}) });
        }
      }
    }
  }
  return { text, citations };
}

export function productionProviderClients(deps: Pick<ProviderToolDeps, "threadId" | "userKey" | "containerFiles">): ProviderClients {
  const containerKey = `${deps.userKey}/${deps.threadId}`;
  const responses = () => (OpenAIV1Instance() as unknown as { responses: Responses }).responses;
  // The env setting when deployed, else the fallback chain (GPT-6 Luna first).
  const responsesModel = (envName: string) => {
    const m = resolveResponsesModel(MODEL_CONFIGS, process.env[envName], FALLBACK_MODEL_CHAIN);
    if (!m) throw new ToolUserError("No model for this tool is deployed here.");
    return m;
  };

  return {
    async generateImage({ prompt, size }, signal) {
      const model = process.env.AZURE_OPENAI_GPT_IMAGE_DEPLOYMENT_NAME?.trim();
      if (!model) throw new ToolUserError("generate_image: image generation is not configured here.");
      const res = await imageClient(model).images.generate(
        { model, prompt, n: 1, ...(size ? { size: size as "1024x1024" } : {}) },
        { signal: withTimeout(signal, IMAGE_TIMEOUT_MS) },
      );
      const first = res.data?.[0];
      return { base64: first?.b64_json ?? "", ...(first?.revised_prompt ? { revisedPrompt: first.revised_prompt } : {}) };
    },

    async webSearch({ query }, signal) {
      const model = responsesModel(WEB_SEARCH_MODEL_ENV);
      const res = await responses().create(
        {
          model: model.deployment,
          instructions:
            "Answer the question with a web search. Be short and factual. Cite every source you use.",
          input: query,
          tools: [{ type: "web_search_preview" }],
          store: false,
          max_output_tokens: 4000,
        },
        { signal: withTimeout(signal, WEB_SEARCH_TIMEOUT_MS) },
      );
      const parsed = textAndCitations(res.output);
      const usage = responsesCallUsage(model.id, res.usage);
      return { text: parsed.text || res.output_text || "", citations: parsed.citations, ...(usage ? { usage } : {}) };
    },

    async ensureContainer() {
      return ensureRunCodeContainer(containerKey, deps.threadId, (deps.containerFiles ?? []).map((f) => f.id));
    },

    async uploadToContainer(containerId, name, data) {
      const created = await OpenAIV1Instance().containers.files.create(containerId, { file: await toFile(data, name) });
      return { path: created.path || `/mnt/data/${name}` };
    },

    async listContainerFiles(containerId) {
      const out: ContainerFile[] = [];
      for await (const f of OpenAIV1Instance().containers.files.list(containerId, { limit: 100 })) {
        out.push({ id: f.id, path: f.path, bytes: f.bytes });
        if (out.length >= 1000) break;
      }
      return out;
    },

    async downloadContainerFile(containerId, fileId) {
      const res = await OpenAIV1Instance().containers.files.content.retrieve(fileId, { container_id: containerId });
      return Buffer.from(await res.arrayBuffer());
    },

    async runCode(containerId, { instructions, input }, signal): Promise<CodeRunResult> {
      const model = responsesModel(RUN_CODE_MODEL_ENV);
      const res = await responses().create(
        {
          model: model.deployment,
          instructions,
          input,
          tools: [{ type: "code_interpreter", container: containerId }],
          tool_choice: "required",
          include: ["code_interpreter_call.outputs"],
          store: false,
          max_output_tokens: 8000,
        },
        { signal: withTimeout(signal, RUN_CODE_TIMEOUT_MS) },
      );
      const result: CodeRunResult = { logs: "", text: "", code: [], images: [] };
      for (const item of res.output ?? []) {
        if (item.type !== "code_interpreter_call") continue;
        if (typeof item.code === "string") result.code.push(item.code);
        for (const o of (Array.isArray(item.outputs) ? item.outputs : []) as Array<Record<string, unknown>>) {
          if (o.type === "logs" && typeof o.logs === "string") result.logs += o.logs;
          if (o.type === "image" && typeof o.url === "string") result.images.push(o.url);
        }
      }
      result.text = textAndCitations(res.output).text || res.output_text || "";
      const usage = responsesCallUsage(model.id, res.usage);
      return usage ? { ...result, usage } : result;
    },

    async persistImage(dataUrl) {
      const stored = await persistBase64Image(deps.threadId, dataUrl);
      if (stored.status !== "OK") throw new Error("Could not store the image for the chat.");
      return stored.response;
    },
  };
}
