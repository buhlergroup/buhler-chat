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
 *                   named workspace files go in, the files the code created
 *                   or changed come back to /workspace/outputs/ (never the
 *                   inputs, skill files or Python caches), each with its
 *                   download URL; stdout is returned (capped).
 *
 * Each tool is registered only when its toggle in `deps.toggles` is on: the
 * chat toggle (or the agent's default tool). The Web and Code toggles are on
 * by default (tool-defaults.ts); run_code is also on for a chat whose files
 * need it (agent-code-interpreter.ts). They are AI SDK tools, so tool-adapter.ts gives them schema
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
import { sniffRasterImageType } from "@/features/common/safe-content-type";
import { ToolUserError } from "../tools/tool-user-error";
import type { WorkspaceEntry } from "./blob-session-fs";
import { normalizeSessionPath, WORKSPACE_ROOT } from "./session-path";
import type { ModelCallUsage } from "./event-mapper";
import { TOOL_RESULTS_DIR } from "./tool-adapter";
import { reportToolModelUsage } from "./tool-model-usage";
import { workspaceFileUrl } from "./workspace-file-url";
import { sanitizeUploadName, uniqueUploadName, UPLOADS_DIR } from "./workspace-uploads";

export const IMAGES_DIR = "/workspace/images";
export const OUTPUTS_DIR = "/workspace/outputs";
/** stdout the model gets inline; the full text goes to a workspace file. */
export const RUN_CODE_STDOUT_INLINE_BYTES = 12 * 1024;
const MAX_INPUT_FILES = 20;
/** Where load_skill unpacks a skill package in the container. */
export const SKILLS_DIR_IN_CONTAINER = "/mnt/data/skills/";
const MAX_INPUT_FILE_BYTES = 50 * 1024 * 1024;
/** All input files of one run_code call together. */
const MAX_INPUT_TOTAL_BYTES = 100 * 1024 * 1024;
const MAX_OUTPUT_FILES = 20;
const MAX_OUTPUT_FILE_BYTES = 50 * 1024 * 1024;
const IMAGE_EXTS: ReadonlySet<string> = new Set(["png", "jpg", "jpeg", "gif", "webp"]);
const RASTER_EXT: Record<string, string> = { "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif", "image/webp": "webp" };
const LF = String.fromCharCode(10);

/**
 * A PNG, JPEG, GIF or WebP image as a data: URL with the type its bytes show
 * (what /api/images serves inline); undefined for anything else.
 */
function rasterImage(data: Uint8Array): { ext: string; dataUrl: string } | undefined {
  const type = sniffRasterImageType(data);
  if (!type || !RASTER_EXT[type]) return undefined;
  return { ext: RASTER_EXT[type], dataUrl: `data:${type};base64,${Buffer.from(data).toString("base64")}` };
}

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
  /** Tokens of the Responses call, under the model that served it. */
  usage?: ModelCallUsage;
}

/** The provider calls the tools need (production: provider-clients.ts). */
export interface ProviderClients {
  generateImage(args: { prompt: string; size?: string }, signal?: AbortSignal): Promise<{ base64: string; revisedPrompt?: string }>;
  /** `usage`: tokens of the Responses call, under the model that served it. */
  webSearch(args: { query: string }, signal?: AbortSignal): Promise<{ text: string; citations: WebCitation[]; usage?: ModelCallUsage }>;
  /** The thread's code interpreter container (created or reused). */
  ensureContainer(signal?: AbortSignal): Promise<string>;
  uploadToContainer(containerId: string, name: string, data: Buffer): Promise<{ path: string }>;
  listContainerFiles(containerId: string): Promise<ContainerFile[]>;
  downloadContainerFile(containerId: string, fileId: string): Promise<Buffer>;
  runCode(containerId: string, args: { instructions: string; input: string }, signal?: AbortSignal): Promise<CodeRunResult>;
  /** Puts an image into the chat image store; returns its blob:// reference. */
  persistImage(dataUrl: string): Promise<string>;
}

/** A file the run_code container is created with. */
export interface ContainerInput {
  id: string;
  name: string;
  containerPath: string;
  /**
   * The files inside it when it is an archive (a skill package): base name
   * and size. A copy of one of them is an input, not an output.
   */
  entries?: ReadonlyArray<{ name: string; size: number }>;
}

export interface ProviderToolDeps {
  /** The thread's workspace (BlobSessionFs). */
  fs: {
    listEntries(dir: string, literalPrefix?: string): Promise<WorkspaceEntry[]>;
    /** Size of a file without reading it (run_code checks its inputs first). */
    stat(path: string): Promise<{ isFile: boolean; size: number }>;
    /** At most `length` bytes from `offset` (one ranged read). */
    readFileRange(path: string, offset: number, length?: number): Promise<{ content: Uint8Array; byteLength: number }>;
    writeFileBytes(path: string, content: Uint8Array): Promise<void>;
  };
  threadId: string;
  userKey: string;
  toggles: ProviderToolToggles;
  /**
   * The files the run_code container is created with (by OpenAI file id):
   * the thread's code interpreter files, i.e. the agent's Code files and
   * skill archives and the user's code interpreter uploads
   * (agent-code-interpreter.ts). They are at /mnt/data/<file id>-<name>, as
   * on the AI SDK path.
   */
  containerFiles?: ReadonlyArray<ContainerInput>;
  /** Tests: fakes. Default: the production clients, loaded on first use. */
  clients?: ProviderClients;
}

/** A model config as far as the model choice needs it. */
export interface ModelChoice {
  deploymentName?: string;
  supportsResponsesAPI?: boolean;
  provider?: string;
}

/** The setting that names the web_search tool's model. */
export const WEB_SEARCH_MODEL_ENV = "COPILOT_WEB_SEARCH_MODEL";
/** The setting that names the run_code tool's model. */
export const RUN_CODE_MODEL_ENV = "COPILOT_RUN_CODE_MODEL";

/**
 * Model for web_search / run_code: the model named in `envValue` when it is
 * deployed and serves the Responses API, else the first such model of
 * `defaultIds` (the app passes FALLBACK_MODEL_CHAIN), else any deployed
 * Responses model. `id` is the MODEL_CONFIGS id (usage and price),
 * `deployment` the name the call uses. Undefined when none is deployed.
 */
export function resolveResponsesModel(
  configs: Readonly<Record<string, ModelChoice>>,
  envValue: string | undefined,
  defaultIds: ReadonlyArray<string>,
): { id: string; deployment: string } | undefined {
  const usable = (c: ModelChoice | undefined) =>
    !!c && c.supportsResponsesAPI === true && c.provider !== "anthropic" && !!c.deploymentName?.trim();
  for (const id of [envValue?.trim(), ...defaultIds]) {
    if (id && Object.prototype.hasOwnProperty.call(configs, id) && usable(configs[id])) return { id, deployment: configs[id].deploymentName!.trim() };
  }
  for (const [id, c] of Object.entries(configs)) if (usable(c)) return { id, deployment: c.deploymentName!.trim() };
  return undefined;
}

const extOf = (name: string) => name.split(".").pop()?.toLowerCase() ?? "";
const baseName = (path: string) => path.split("/").pop() ?? "";
/** Base name + size: what a copy of a file looks like in the container listing. */
const copyKey = (name: string, size: number) => `${size}:${baseName(name)}`;
/** Python byte code and its cache folders: never an output. */
const isPythonCache = (path: string) => path.split("/").includes("__pycache__") || /\.py[co]$/i.test(path);

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
      // Stored with the type its bytes show: /api/images serves it inline only then.
      const raster = rasterImage(data);
      if (!raster) throw new ToolUserError("generate_image: the image model returned no PNG, JPEG, GIF or WebP image.");
      const base = (name ?? "").trim().replace(/\.(png|jpe?g|gif|webp)$/i, "") || "image";
      const file = await freeName(deps.fs, IMAGES_DIR, `${base}.${raster.ext}`);
      const path = `${IMAGES_DIR}/${file}`;
      await deps.fs.writeFileBytes(path, data);
      const result = await c.persistImage(raster.dataUrl);
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
      "Search the web for current or public information. Each search has a cost: use it only when the answer needs " +
      "recent facts or sources that are not in the chat, its files or your own knowledge. " +
      "Returns a short answer and its source URLs. " +
      "Cite the sources in your reply as markdown links [title](url).",
    inputSchema: z.object({
      query: z.string().min(1).max(2000).describe("What to find out, as a full question or search query."),
    }),
    execute: async ({ query }: { query: string }, { abortSignal }: { abortSignal?: AbortSignal }): Promise<WebSearchOutput> => {
      const res = await (await clients()).webSearch({ query }, abortSignal);
      reportToolModelUsage(res.usage);
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
  /** Files the code created or changed, copied into the workspace. */
  files: string[];
  /** The same files with their download URL (GET /api/workspace/file). */
  downloads: Array<{ name: string; path: string; url: string }>;
  /** blob:// references of the image outputs: the chat renders them (tool-part-view). */
  images: string[];
  /**
   * Where the input files were in the container: workspace files (named and
   * the chat's uploads) and the files the container was created with (name).
   */
  inputs: Array<{ containerPath: string; workspacePath?: string; name?: string }>;
  /** Uploads left out because they did not fit the input caps. */
  skipped?: string[];
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

function runCodeInput(
  args: { code?: string; task?: string },
  inputs: UploadedInput[],
  containerFiles: ReadonlyArray<{ name: string; containerPath: string }> = [],
): string {
  const moves = inputs.filter((i) => i.uploadedPath !== i.containerPath);
  const lines = [
    ...inputs.map((i) => `- ${i.containerPath} (from ${i.workspacePath})`),
    ...containerFiles.map((f) => `- ${f.containerPath} (${f.name})`),
  ];
  const files = lines.length
    ? `Input files:${LF}${lines.join(LF)}${LF}` +
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
    // Static text (the same on every turn and thread): the paths are in the result.
    description:
      `Run Python code in a sandbox (code interpreter) for data analysis, charts, file conversion or scripts (also skill scripts). The sandbox does not see ${WORKSPACE_ROOT}. ` +
      "Give `code` to run exactly, or `task` to have the code written for you. " +
      `All files of this chat and of its agent (uploads in ${UPLOADS_DIR}/, agent files, skills) are attached automatically; ` +
      "the result lists their paths in /mnt/data under `inputs`. " +
      "List other workspace files the code needs in `files`; they appear in /mnt/data/<name>. " +
      `Files the code creates in /mnt/data come back to ${OUTPUTS_DIR}/; images among them are shown to the user automatically. ` +
      "Returns stdout, the output paths and `downloads`. " +
      "To give the user a file, link it with the url from downloads, e.g. [name](url). " +
      "Never use /api/images or sandbox: links for these files. " +
      `Any other file in ${WORKSPACE_ROOT} can be linked as [name](${WORKSPACE_ROOT}/<path>); the chat makes it a download link.`,
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
      // Check the inputs first, by their size only (no download): a wrong path
      // or a file that is too big fails before a container is made.
      const wanted: string[] = [];
      const sizes = new Map<string, number>();
      let totalBytes = 0;
      for (const raw of args.files ?? []) {
        let p: string;
        try {
          p = normalizeSessionPath(raw);
        } catch (err) {
          throw new ToolUserError(`run_code: ${(err as Error).message}`);
        }
        if (!p.startsWith(`${WORKSPACE_ROOT}/`)) throw new ToolUserError(`run_code: only files in ${WORKSPACE_ROOT} can be used: ${raw}`);
        if (wanted.includes(p)) continue; // named twice: uploaded once
        let size: number;
        try {
          const info = await deps.fs.stat(p);
          if (!info.isFile) throw new Error("not a file");
          size = info.size;
        } catch {
          throw new ToolUserError(`run_code: file not found: ${p}`);
        }
        if (size > MAX_INPUT_FILE_BYTES) throw new ToolUserError(`run_code: file too large (over 50 MB): ${p}`);
        totalBytes += size;
        if (totalBytes > MAX_INPUT_TOTAL_BYTES) throw new ToolUserError("run_code: the input files are too large together (over 100 MB).");
        wanted.push(p);
        sizes.set(p, size);
      }
      // The chat's uploads go in on every run (the sandbox does not see the
      // workspace), newest first, within the same caps; what does not fit is
      // named in the result. Sizes come from the listing: nothing is
      // downloaded before it is known to fit.
      const skipped: string[] = [];
      const uploads = await deps.fs.listEntries(UPLOADS_DIR).catch(() => [] as WorkspaceEntry[]);
      const newestFirst = [...uploads].sort(
        (a, b) => b.lastModified.getTime() - a.lastModified.getTime() || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0),
      );
      const optional = new Set<string>();
      for (const e of newestFirst) {
        if (wanted.includes(e.path)) continue;
        let size = e.size;
        if (size === undefined) {
          try {
            const info = await deps.fs.stat(e.path);
            if (!info.isFile) continue;
            size = info.size;
          } catch {
            continue;
          }
        }
        if (wanted.length >= MAX_INPUT_FILES || size > MAX_INPUT_FILE_BYTES || totalBytes + size > MAX_INPUT_TOTAL_BYTES) {
          skipped.push(e.path);
          continue;
        }
        totalBytes += size;
        wanted.push(e.path);
        sizes.set(e.path, size);
        optional.add(e.path);
      }

      const containerId = await c.ensureContainer(abortSignal);
      // A file of an earlier run that is still at its path with the same size
      // is not uploaded again.
      const present = new Map(
        wanted.length > 0 ? (await c.listContainerFiles(containerId)).map((f) => [f.path, f.bytes]) : [],
      );
      const uploaded: UploadedInput[] = [];
      const usedNames = new Set<string>();
      // One file in memory at a time: read, upload, let go.
      for (const workspacePath of wanted) {
        const name = uniqueUploadName(sanitizeUploadName(workspacePath), usedNames, false);
        usedNames.add(name);
        const containerPath = `/mnt/data/${name}`;
        if (present.get(containerPath) === sizes.get(workspacePath)) {
          uploaded.push({ workspacePath, containerPath, uploadedPath: containerPath });
          continue;
        }
        let data: Buffer;
        try {
          // At most one byte over the limit, also when the file grew since the check.
          const read = await deps.fs.readFileRange(workspacePath, 0, MAX_INPUT_FILE_BYTES + 1);
          data = Buffer.from(read.content.buffer, read.content.byteOffset, read.content.byteLength);
        } catch {
          if (optional.has(workspacePath)) continue;
          throw new ToolUserError(`run_code: file not found: ${workspacePath}`);
        }
        if (data.length > MAX_INPUT_FILE_BYTES) {
          if (optional.has(workspacePath)) {
            skipped.push(workspacePath);
            continue;
          }
          throw new ToolUserError(`run_code: file too large (over 50 MB): ${workspacePath}`);
        }
        const up = await c.uploadToContainer(containerId, name, data);
        uploaded.push({ workspacePath, containerPath, uploadedPath: up.path });
      }
      const inputs: RunCodeOutput["inputs"] = [
        ...uploaded.map(({ workspacePath, containerPath }) => ({ workspacePath, containerPath })),
        // Created with the container (by file id): the thread's code interpreter files.
        ...(deps.containerFiles ?? []).map((f) => ({ name: f.name, containerPath: f.containerPath })),
      ];
      const beforeList = await c.listContainerFiles(containerId);
      const before = new Set(beforeList.map((f) => f.id));
      // What a copy of an input looks like (base name + size): the workspace
      // inputs, the files the container was created with and the files in
      // their archives (skill packages), and what is unpacked under
      // /mnt/data/skills/. A new file that matches one is not an output.
      const sizeAt = new Map(beforeList.flatMap((f) => (f.bytes === undefined ? [] : [[f.path, f.bytes] as const])));
      const inputCopies = new Set<string>();
      for (const i of uploaded) {
        const size = sizes.get(i.workspacePath);
        if (size !== undefined) inputCopies.add(copyKey(i.containerPath, size));
      }
      for (const f of deps.containerFiles ?? []) {
        const size = sizeAt.get(f.containerPath);
        if (size !== undefined) inputCopies.add(copyKey(f.name, size)).add(copyKey(f.containerPath, size));
        for (const e of f.entries ?? []) inputCopies.add(copyKey(e.name, e.size));
      }
      for (const [path, size] of sizeAt) if (path.startsWith(SKILLS_DIR_IN_CONTAINER)) inputCopies.add(copyKey(path, size));
      const isInputCopy = (path: string, size: number | undefined) => size !== undefined && inputCopies.has(copyKey(path, size));

      const run = await c.runCode(containerId, { instructions: RUN_CODE_INSTRUCTIONS, input: runCodeInput(args, uploaded, deps.containerFiles) }, abortSignal);
      reportToolModelUsage(run.usage);

      // Files the code created or changed come back to /workspace/outputs/,
      // except the inputs and their copies (same base name and size; also
      // skill scripts copied out of the skill folder) and Python caches.
      // "cfile_<id>" files are the interpreter's own copies of displayed
      // plots: kept only when the code saved no image.
      const isPlotCopy = (p: string) => /^cfile_[0-9a-f]+\.[a-z]+$/i.test(p.split("/").pop() ?? "");
      const created = (await c.listContainerFiles(containerId))
        .filter(
          (f) =>
            !before.has(f.id) &&
            f.path.startsWith("/mnt/data/") &&
            // An unpacked skill package (load_skill) is not an output.
            !f.path.startsWith(SKILLS_DIR_IN_CONTAINER) &&
            !isPythonCache(f.path) &&
            !isInputCopy(f.path, f.bytes),
        )
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
        if (f.bytes === undefined && isInputCopy(f.path, data.length)) continue;
        const name = plotCopy ? `figure-${++figures}.${extOf(f.path)}` : (f.path.split("/").pop() ?? "output");
        const path = `${OUTPUTS_DIR}/${await freeName(deps.fs, OUTPUTS_DIR, name)}`;
        await deps.fs.writeFileBytes(path, data);
        files.push(path);
        // Shown in the chat only when the bytes are a raster image too.
        const raster = IMAGE_EXTS.has(extOf(path)) ? rasterImage(data) : undefined;
        if (raster) images.push(await c.persistImage(raster.dataUrl));
      }
      // Displayed plots that were not saved as files.
      if (images.length === 0) {
        for (const [i, url] of run.images.entries()) {
          const m = /^data:image\/[a-z.+-]+;base64,(.*)$/is.exec(url);
          if (!m) continue;
          const data = Buffer.from(m[1], "base64");
          // The declared type is not trusted: the bytes decide.
          const raster = rasterImage(data);
          if (!raster) continue;
          const path = `${OUTPUTS_DIR}/${await freeName(deps.fs, OUTPUTS_DIR, `figure-${i + 1}.${raster.ext}`)}`;
          await deps.fs.writeFileBytes(path, data);
          files.push(path);
          images.push(await c.persistImage(raster.dataUrl));
        }
      }

      // Only a cut stdout is written, next to the other large tool results:
      // it is the full text, not an output of the code.
      let stdout = run.logs;
      let stdoutPath: string | undefined;
      if (Buffer.byteLength(stdout, "utf8") > RUN_CODE_STDOUT_INLINE_BYTES) {
        const id = String(toolCallId ?? Date.now()).replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 60);
        stdoutPath = `${TOOL_RESULTS_DIR}/${await freeName(deps.fs, TOOL_RESULTS_DIR, `run_code-stdout-${id}.txt`)}`;
        await deps.fs.writeFileBytes(stdoutPath, Buffer.from(stdout, "utf8"));
        stdout = `${utf8Head(stdout, RUN_CODE_STDOUT_INLINE_BYTES)}${LF}[... full output in ${stdoutPath}]`;
      }
      const downloads = files.map((path) => ({ name: baseName(path), path, url: workspaceFileUrl(deps.threadId, path) }));
      return {
        stdout,
        ...(stdoutPath ? { stdoutPath } : {}),
        files,
        downloads,
        images,
        inputs,
        ...(skipped.length ? { skipped } : {}),
        ...(run.text.trim() ? { summary: run.text.trim() } : {}),
      };
    },
    // As for generate_image: no blob refs for the model; the chat shows the images.
    toModelOutput: ({ output }: { output: RunCodeOutput }) =>
      modelJson({
        stdout: output.stdout,
        ...(output.stdoutPath ? { stdoutPath: output.stdoutPath } : {}),
        files: output.files,
        downloads: output.downloads,
        inputs: output.inputs.map((i) => (i.workspacePath ? `${i.containerPath} (from ${i.workspacePath})` : i.containerPath)),
        ...(output.skipped?.length
          ? { skipped: `Not in the sandbox (over the input limit of ${MAX_INPUT_FILES} files or 100 MB): ${output.skipped.join(", ")}. Name the one you need in \`files\`.` }
          : {}),
        ...(output.images.length ? { note: "Images among the files are shown to the user in the chat. Do not embed them again." } : {}),
        ...(output.summary ? { summary: output.summary } : {}),
      }),
  });
}

// ── assembly ───────────────────────────────────────────────────────────────

/** The provider built-in tools whose toggles are on (web_search: see tool-defaults.ts). */
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
