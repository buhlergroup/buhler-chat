/**
 * Provider built-ins as our own tools (Copilot path).
 *
 * The Copilot runtime runs with BYOK models, so the provider-hosted tools of
 * the Responses API (image_generation, web_search, code_interpreter) are not
 * available to it. These three tools call the provider directly instead:
 *
 *   generate_image  the image deployment (AZURE_OPENAI_GPT_IMAGE_DEPLOYMENT_NAME).
 *                   The PNG goes to /workspace/images/ AND to the chat image
 *                   store (blob:// ref), so the chat shows it like the
 *                   image_generation tool on the AI SDK path.
 *   web_search      one short Responses call on a fast model with the
 *                   provider's web search tool; answer text plus the source
 *                   URLs (url_citation annotations).
 *   run_code        one Responses call with code_interpreter on a container:
 *                   named workspace files go in, new files come back to
 *                   /workspace/outputs/, stdout is returned (capped).
 *
 * Each tool is registered only when its chat toggle (or the agent's default
 * tool) is on. They are AI SDK tools, so tool-adapter.ts gives them schema
 * validation, the turn's request context, large-result spill and the
 * ToolUserError rule like every other app tool.
 *
 * The provider calls sit behind ProviderClients (production:
 * provider-clients.ts, loaded on first use), so this file stays free of
 * server-only imports and the tests use fakes.
 */
import { tool } from "ai";
import type { Tool as AiTool } from "@ai-sdk/provider-utils";
import { z } from "zod";
import { ToolUserError } from "../tools/tool-user-error";
import type { WorkspaceEntry } from "./blob-session-fs";
import { normalizeSessionPath, WORKSPACE_ROOT } from "./session-path";
import { sanitizeUploadName, uniqueUploadName } from "./workspace-uploads";

export const IMAGES_DIR = "/workspace/images";
export const OUTPUTS_DIR = "/workspace/outputs";
/** stdout the model gets inline; the full text goes to a workspace file. */
export const RUN_CODE_STDOUT_INLINE_BYTES = 12 * 1024;
const MAX_INPUT_FILES = 20;
const MAX_INPUT_FILE_BYTES = 50 * 1024 * 1024;
const MAX_OUTPUT_FILES = 20;
const MAX_OUTPUT_FILE_BYTES = 50 * 1024 * 1024;
const IMAGE_MIME: Record<string, string> = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp" };
const LF = String.fromCharCode(10);

export interface ProviderToolToggles {
  imageGeneration: boolean;
  webSearch: boolean;
  codeInterpreter: boolean;
}

export interface WebCitation {
  url: string;
  title?: string;
}

export interface ContainerFile {
  id: string;
  path: string;
  bytes?: number;
}

export interface CodeRunResult {
  /** Text of the code interpreter's log outputs (stdout / stderr). */
  logs: string;
  /** The model's closing message. */
  text: string;
  /** The code that ran. */
  code: string[];
  /** Inline image outputs (data: URLs), e.g. a displayed plot. */
  images: string[];
}

/** The provider calls the tools need (production: provider-clients.ts). */
export interface ProviderClients {
  generateImage(args: { prompt: string; size?: string }, signal?: AbortSignal): Promise<{ base64: string; revisedPrompt?: string }>;
  webSearch(args: { query: string }, signal?: AbortSignal): Promise<{ text: string; citations: WebCitation[] }>;
  /** The thread's code interpreter container (created or reused). */
  ensureContainer(signal?: AbortSignal): Promise<string>;
  uploadToContainer(containerId: string, name: string, data: Buffer): Promise<{ path: string }>;
  listContainerFiles(containerId: string): Promise<ContainerFile[]>;
  downloadContainerFile(containerId: string, fileId: string): Promise<Buffer>;
  runCode(containerId: string, args: { instructions: string; input: string }, signal?: AbortSignal): Promise<CodeRunResult>;
  /** Puts an image into the chat image store; returns its blob:// reference. */
  persistImage(dataUrl: string): Promise<string>;
}

export interface ProviderToolDeps {
  /** The thread's workspace (BlobSessionFs). */
  fs: {
    listEntries(dir: string, literalPrefix?: string): Promise<WorkspaceEntry[]>;
    readFileBytes(path: string): Promise<Uint8Array>;
    writeFileBytes(path: string, content: Uint8Array): Promise<void>;
  };
  threadId: string;
  userKey: string;
  toggles: ProviderToolToggles;
  /** Tests: fakes. Default: the production clients, loaded on first use. */
  clients?: ProviderClients;
}

/** A model config as far as the model choice needs it. */
export interface ModelChoice {
  deploymentName?: string;
  supportsResponsesAPI?: boolean;
  provider?: string;
}

/**
 * Deployment for web_search / run_code: the model named in `envValue` when
 * it is deployed and serves the Responses API, else `defaultId` (the fast
 * model), else any deployed Responses model. Undefined when none is deployed.
 */
export function resolveResponsesDeployment(
  configs: Readonly<Record<string, ModelChoice>>,
  envValue: string | undefined,
  defaultId = "gpt-5.6-luna",
): string | undefined {
  const usable = (c: ModelChoice | undefined) =>
    !!c && c.supportsResponsesAPI === true && c.provider !== "anthropic" && !!c.deploymentName?.trim();
  for (const id of [envValue?.trim(), defaultId]) {
    if (id && usable(configs[id])) return configs[id].deploymentName!.trim();
  }
  for (const c of Object.values(configs)) if (usable(c)) return c.deploymentName!.trim();
  return undefined;
}

const extOf = (name: string) => name.split(".").pop()?.toLowerCase() ?? "";

/** A file name in `dir` that is not taken yet ("a.png", "a (2).png", ...). */
async function freeName(fs: ProviderToolDeps["fs"], dir: string, raw: string): Promise<string> {
  const name = sanitizeUploadName(raw);
  const taken = new Set((await fs.listEntries(dir)).map((e) => e.path.slice(dir.length + 1)));
  return uniqueUploadName(name, taken, false);
}

/** First bytes of a text, cut on a character boundary. */
function utf8Head(text: string, bytes: number): string {
  const buf = Buffer.from(text, "utf8");
  if (buf.length <= bytes) return text;
  let end = bytes;
  while (end > 0 && (buf[end] & 0xc0) === 0x80) end--;
  return buf.subarray(0, end).toString("utf8");
}

const modelJson = (value: unknown) => ({ type: "text" as const, value: JSON.stringify(value) });

// ── generate_image ─────────────────────────────────────────────────────────

export interface GenerateImageOutput {
  /** blob:// reference in the chat image store: the chat renders it (tool-part-view). */
  result: string;
  /** Where the PNG is in the workspace. */
  path: string;
  revisedPrompt?: string;
}

function generateImageTool(deps: ProviderToolDeps, clients: () => Promise<ProviderClients>) {
  return tool({
    description:
      "Generate an image from a text description with the image model. " +
      `The PNG is saved in ${IMAGES_DIR}/ and shown to the user in the chat automatically; ` +
      "do not repeat it as a markdown image. Returns the workspace path.",
    inputSchema: z.object({
      prompt: z.string().min(1).max(8000).describe("Detailed description of the image."),
      name: z.string().max(80).optional().describe("Short file name without extension, e.g. 'factory-sketch'."),
      size: z.enum(["1024x1024", "1536x1024", "1024x1536"]).optional().describe("Image size; default 1024x1024."),
    }),
    execute: async (
      { prompt, name, size }: { prompt: string; name?: string; size?: string },
      { abortSignal }: { abortSignal?: AbortSignal },
    ): Promise<GenerateImageOutput> => {
      const c = await clients();
      const image = await c.generateImage({ prompt, size }, abortSignal);
      const base64 = image.base64.replace(/^data:[^,]*,/, "");
      if (!base64) throw new ToolUserError("generate_image: the image model returned no image.");
      const data = Buffer.from(base64, "base64");
      const file = await freeName(deps.fs, IMAGES_DIR, `${(name ?? "").trim() || "image"}.png`.replace(/\.png\.png$/i, ".png"));
      const path = `${IMAGES_DIR}/${file}`;
      await deps.fs.writeFileBytes(path, data);
      const result = await c.persistImage(`data:image/png;base64,${base64}`);
      return { result, path, ...(image.revisedPrompt ? { revisedPrompt: image.revisedPrompt } : {}) };
    },
    // The model gets the path, not the blob ref: the chat already shows the
    // image, and a ref echoed into the reply would show it twice.
    toModelOutput: ({ output }: { output: GenerateImageOutput }) =>
      modelJson({
        path: output.path,
        shownToUser: true,
        note: "The image is shown to the user in the chat. Do not embed it again.",
        ...(output.revisedPrompt ? { revisedPrompt: output.revisedPrompt } : {}),
      }),
  });
}

// ── web_search ─────────────────────────────────────────────────────────────

export interface WebSearchOutput {
  answer: string;
  citations: WebCitation[];
}

function webSearchTool(clients: () => Promise<ProviderClients>) {
  return tool({
    description:
      "Search the web for current or public information. Returns a short answer and its source URLs. " +
      "Cite the sources in your reply as markdown links [title](url).",
    inputSchema: z.object({
      query: z.string().min(1).max(2000).describe("What to find out, as a full question or search query."),
    }),
    execute: async ({ query }: { query: string }, { abortSignal }: { abortSignal?: AbortSignal }): Promise<WebSearchOutput> => {
      const res = await (await clients()).webSearch({ query }, abortSignal);
      const seen = new Set<string>();
      const citations = res.citations.filter((c) => {
        if (!/^https?:\/\//i.test(c.url) || seen.has(c.url)) return false;
        seen.add(c.url);
        return true;
      });
      return { answer: res.text, citations };
    },
  });
}

// ── run_code ───────────────────────────────────────────────────────────────

export interface RunCodeOutput {
  stdout: string;
  /** Set when stdout was longer than the inline cap: the full text is here. */
  stdoutPath?: string;
  /** New files the code wrote, copied into the workspace. */
  files: string[];
  /** blob:// references of the image outputs: the chat renders them (tool-part-view). */
  images: string[];
  /** Where the input files were in the container. */
  inputs: Array<{ workspacePath: string; containerPath: string }>;
  /** The model's closing note. */
  summary?: string;
}

export const RUN_CODE_INSTRUCTIONS =
  "You run Python in the code interpreter for another agent. Input files are in /mnt/data. " +
  "Save every file the task produces (charts as PNG, tables as CSV/XLSX, ...) under /mnt/data. " +
  "Print the results the caller needs to stdout. Reply with one short sentence when done.";

interface UploadedInput {
  workspacePath: string;
  /** Where the code expects the file: /mnt/data/<name>. */
  containerPath: string;
  /** Where the container API put it (it may add a prefix to the name). */
  uploadedPath: string;
}

function runCodeInput(args: { code?: string; task?: string }, inputs: UploadedInput[]): string {
  const moves = inputs.filter((i) => i.uploadedPath !== i.containerPath);
  const files = inputs.length
    ? `Input files:${LF}${inputs.map((i) => `- ${i.containerPath} (from ${i.workspacePath})`).join(LF)}${LF}` +
      (moves.length
        ? `Before anything else, copy the uploaded files to those paths: ${moves.map((i) => `${i.uploadedPath} -> ${i.containerPath}`).join("; ")}.${LF}`
        : "") +
      LF
    : "";
  if (args.code) {
    return `${files}Run this Python code exactly as given, without changes:${LF}\`\`\`python${LF}${args.code}${LF}\`\`\``;
  }
  return `${files}Task: ${args.task}`;
}

function runCodeTool(deps: ProviderToolDeps, clients: () => Promise<ProviderClients>) {
  return tool({
    description:
      "Run Python code in a sandbox (code interpreter) for data analysis, charts, file conversion or scripts (also skill scripts in the workspace). " +
      "Give `code` to run exactly, or `task` to have the code written for you. " +
      "List the workspace files the code needs in `files`; they appear in /mnt/data/<name>. " +
      `Files the code saves in /mnt/data come back to ${OUTPUTS_DIR}/; images among them are shown to the user automatically. ` +
      "Returns stdout and the output paths.",
    inputSchema: z
      .object({
        code: z.string().max(100_000).optional().describe("Python code to run as given."),
        task: z.string().max(8000).optional().describe("What to do, when no code is given."),
        files: z
          .array(z.string().max(500))
          .max(MAX_INPUT_FILES)
          .optional()
          .describe("Workspace files the code needs, e.g. /workspace/uploads/data.csv"),
      })
      .refine((v) => !!v.code?.trim() || !!v.task?.trim(), { message: "Give code or task." }),
    execute: async (
      args: { code?: string; task?: string; files?: string[] },
      { abortSignal, toolCallId }: { abortSignal?: AbortSignal; toolCallId?: string },
    ): Promise<RunCodeOutput> => {
      const c = await clients();
      // Read the inputs first: a wrong path fails before a container is made.
      const wanted: Array<{ workspacePath: string; data: Buffer }> = [];
      for (const raw of args.files ?? []) {
        let p: string;
        try {
          p = normalizeSessionPath(raw);
        } catch (err) {
          throw new ToolUserError(`run_code: ${(err as Error).message}`);
        }
        if (!p.startsWith(`${WORKSPACE_ROOT}/`)) throw new ToolUserError(`run_code: only files in ${WORKSPACE_ROOT} can be used: ${raw}`);
        let data: Buffer;
        try {
          data = Buffer.from(await deps.fs.readFileBytes(p));
        } catch {
          throw new ToolUserError(`run_code: file not found: ${p}`);
        }
        if (data.length > MAX_INPUT_FILE_BYTES) throw new ToolUserError(`run_code: file too large (over 50 MB): ${p}`);
        wanted.push({ workspacePath: p, data });
      }

      const containerId = await c.ensureContainer(abortSignal);
      const uploaded: UploadedInput[] = [];
      const usedNames = new Set<string>();
      for (const w of wanted) {
        const name = uniqueUploadName(sanitizeUploadName(w.workspacePath), usedNames, false);
        usedNames.add(name);
        const up = await c.uploadToContainer(containerId, name, w.data);
        uploaded.push({ workspacePath: w.workspacePath, containerPath: `/mnt/data/${name}`, uploadedPath: up.path });
      }
      const inputs = uploaded.map(({ workspacePath, containerPath }) => ({ workspacePath, containerPath }));
      const before = new Set((await c.listContainerFiles(containerId)).map((f) => f.id));

      const run = await c.runCode(containerId, { instructions: RUN_CODE_INSTRUCTIONS, input: runCodeInput(args, uploaded) }, abortSignal);

      // New files in the container come back to /workspace/outputs/, except
      // the copies of the inputs. "cfile_<id>" files are the interpreter's
      // own copies of displayed plots: kept only when the code saved no image.
      const isPlotCopy = (p: string) => /^cfile_[0-9a-f]+\.[a-z]+$/i.test(p.split("/").pop() ?? "");
      const created = (await c.listContainerFiles(containerId))
        .filter((f) => !before.has(f.id) && f.path.startsWith("/mnt/data/") && !usedNames.has(f.path.split("/").pop() ?? ""))
        .sort((a, b) => Number(isPlotCopy(a.path)) - Number(isPlotCopy(b.path)))
        .slice(0, MAX_OUTPUT_FILES);
      const files: string[] = [];
      const images: string[] = [];
      let figures = 0;
      for (const f of created) {
        if (f.bytes !== undefined && f.bytes > MAX_OUTPUT_FILE_BYTES) continue;
        const plotCopy = isPlotCopy(f.path);
        if (plotCopy && images.length > 0) continue;
        const data = await c.downloadContainerFile(containerId, f.id);
        if (data.length > MAX_OUTPUT_FILE_BYTES) continue;
        const name = plotCopy ? `figure-${++figures}.${extOf(f.path)}` : (f.path.split("/").pop() ?? "output");
        const path = `${OUTPUTS_DIR}/${await freeName(deps.fs, OUTPUTS_DIR, name)}`;
        await deps.fs.writeFileBytes(path, data);
        files.push(path);
        const mime = IMAGE_MIME[extOf(path)];
        if (mime) images.push(await c.persistImage(`data:${mime};base64,${data.toString("base64")}`));
      }
      // Displayed plots that were not saved as files.
      if (images.length === 0) {
        for (const [i, url] of run.images.entries()) {
          const m = /^data:(image\/(png|jpeg|gif|webp));base64,(.*)$/s.exec(url);
          if (!m) continue;
          const path = `${OUTPUTS_DIR}/${await freeName(deps.fs, OUTPUTS_DIR, `figure-${i + 1}.${m[2] === "jpeg" ? "jpg" : m[2]}`)}`;
          await deps.fs.writeFileBytes(path, Buffer.from(m[3], "base64"));
          files.push(path);
          images.push(await c.persistImage(url));
        }
      }

      let stdout = run.logs;
      let stdoutPath: string | undefined;
      if (Buffer.byteLength(stdout, "utf8") > RUN_CODE_STDOUT_INLINE_BYTES) {
        const id = String(toolCallId ?? Date.now()).replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 60);
        stdoutPath = `${OUTPUTS_DIR}/${await freeName(deps.fs, OUTPUTS_DIR, `stdout-${id}.txt`)}`;
        await deps.fs.writeFileBytes(stdoutPath, Buffer.from(stdout, "utf8"));
        stdout = `${utf8Head(stdout, RUN_CODE_STDOUT_INLINE_BYTES)}${LF}[... full output in ${stdoutPath}]`;
      }
      return {
        stdout,
        ...(stdoutPath ? { stdoutPath } : {}),
        files,
        images,
        inputs,
        ...(run.text.trim() ? { summary: run.text.trim() } : {}),
      };
    },
    // As for generate_image: no blob refs for the model; the chat shows the images.
    toModelOutput: ({ output }: { output: RunCodeOutput }) =>
      modelJson({
        stdout: output.stdout,
        ...(output.stdoutPath ? { stdoutPath: output.stdoutPath } : {}),
        files: output.files,
        ...(output.images.length ? { note: "Images among the files are shown to the user in the chat. Do not embed them again." } : {}),
        ...(output.summary ? { summary: output.summary } : {}),
      }),
  });
}

// ── assembly ───────────────────────────────────────────────────────────────

/** The provider built-in tools whose toggles are on. */
export function providerTools(deps: ProviderToolDeps): Record<string, AiTool> {
  let loaded: Promise<ProviderClients> | undefined;
  const clients = () =>
    deps.clients
      ? Promise.resolve(deps.clients)
      : (loaded ??= import("./provider-clients").then((m) => m.productionProviderClients(deps)));
  const tools: Record<string, AiTool> = {};
  if (deps.toggles.imageGeneration) tools.generate_image = generateImageTool(deps, clients) as AiTool;
  if (deps.toggles.webSearch) tools.web_search = webSearchTool(clients) as AiTool;
  if (deps.toggles.codeInterpreter) tools.run_code = runCodeTool(deps, clients) as AiTool;
  return tools;
}
