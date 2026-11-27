import { describe, it, expect, vi } from "vitest";
import { BlobSessionFs } from "./blob-session-fs";
import { FakeBlobStore } from "./fake-blob-store.test-helper";
import { runAppTool, TOOL_RESULTS_DIR, type ToolCallRecord, type TurnToolBinding } from "./tool-adapter";
import {
  OUTPUTS_DIR,
  RUN_CODE_STDOUT_INLINE_BYTES,
  providerTools,
  resolveResponsesModel,
  type ContainerFile,
  type ProviderClients,
  type ProviderToolToggles,
  type ProviderToolDeps,
} from "./provider-tools";
import { CopilotEventMapper } from "./event-mapper";
import { responsesCallUsage } from "./tool-model-usage";
import { FALLBACK_MODEL_CHAIN } from "../models";
import { stripExtensionKeyPrefix } from "../../tool-display-name";

/** A PNG signature plus some bytes: enough for the type sniffing. */
const png = (rest: string) => Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from(rest)]);
const PNG_BASE64 = png("fake image bytes").toString("base64");
const JPEG_BASE64 = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from("jpeg bytes")]).toString("base64");
const ALL: ProviderToolToggles = { imageGeneration: true, webSearch: true, codeInterpreter: true };

function fakeClients(overrides: Partial<ProviderClients> = {}) {
  const containerFiles: Array<ContainerFile & { data: Buffer }> = [];
  let nextId = 1;
  const persisted: string[] = [];
  const clients: ProviderClients = {
    generateImage: vi.fn(async () => ({ base64: PNG_BASE64, revisedPrompt: "a cat, watercolour" })),
    webSearch: vi.fn(async () => ({
      text: "Answer ([site](https://example.org/a))",
      citations: [
        { url: "https://example.org/a", title: "A" },
        { url: "https://example.org/a", title: "A again" },
        { url: "javascript:alert(1)", title: "bad" },
        { url: "https://example.org/b" },
      ],
    })),
    ensureContainer: vi.fn(async () => "cntr_1"),
    uploadToContainer: vi.fn(async (_c: string, name: string, data: Buffer) => {
      // The container API prefixes uploaded names (measured).
      containerFiles.push({ id: `f${nextId++}`, path: `/mnt/data/0a1b-${name}`, bytes: data.length, data });
      return { path: `/mnt/data/0a1b-${name}` };
    }),
    listContainerFiles: vi.fn(async () => containerFiles.map(({ id, path, bytes }) => ({ id, path, bytes }))),
    downloadContainerFile: vi.fn(async (_c: string, id: string) => containerFiles.find((f) => f.id === id)!.data),
    runCode: vi.fn(async () => {
      // The "code" copies the input to its name, writes a chart and a CSV,
      // and the interpreter keeps a copy of the displayed plot.
      containerFiles.push({ id: `f${nextId++}`, path: "/mnt/data/data.csv", bytes: 8, data: Buffer.from("x,y\n1,2\n") });
      containerFiles.push({ id: `f${nextId++}`, path: "/mnt/data/cfile_6b08a1.png", bytes: 4, data: png("plt!") });
      containerFiles.push({ id: `f${nextId++}`, path: "/mnt/data/chart.png", bytes: 4, data: png("png!") });
      containerFiles.push({ id: `f${nextId++}`, path: "/mnt/data/summary.csv", bytes: 3, data: Buffer.from("a,b") });
      return { logs: "rows: 3\n", text: "Done.", code: ["print('rows: 3')"], images: [] };
    }),
    persistImage: vi.fn(async (dataUrl: string) => {
      persisted.push(dataUrl);
      return `blob://thread-1/img${persisted.length}.png`;
    }),
    ...overrides,
  };
  return { clients, containerFiles, persisted };
}

function setup(toggles: ProviderToolToggles = ALL, overrides: Partial<ProviderClients> = {}, extra: Partial<ProviderToolDeps> = {}) {
  const store = new FakeBlobStore();
  const fs = new BlobSessionFs(store, "user-1/thread-1");
  const fake = fakeClients(overrides);
  const tools = providerTools({ fs, threadId: "thread-1", userKey: "user-1", toggles, clients: fake.clients, ...extra });
  const records: ToolCallRecord[] = [];
  const spills: string[] = [];
  const binding: TurnToolBinding = {
    toolset: tools,
    onResult: (r) => records.push(r),
    spill: async (p, c) => {
      spills.push(p);
      await fs.writeFile(p, c);
    },
  };
  const call = (name: string, args: unknown, id = `call-${name}`) =>
    runAppTool(name, args, { toolCallId: id, signal: undefined as unknown as AbortSignal }, binding);
  return { fs, store, tools, records, spills, call, ...fake };
}

describe("providerTools", () => {
  it("registers only the tools whose toggle is on", () => {
    expect(Object.keys(setup({ imageGeneration: false, webSearch: false, codeInterpreter: false }).tools)).toEqual([]);
    expect(Object.keys(setup({ imageGeneration: true, webSearch: false, codeInterpreter: false }).tools)).toEqual(["generate_image"]);
    expect(Object.keys(setup({ imageGeneration: false, webSearch: true, codeInterpreter: true }).tools)).toEqual([
      "web_search",
      "run_code",
    ]);
  });
});

describe("provider tool names in the chat UI", () => {
  it("are shown as they are (not read as an extension key)", () => {
    for (const name of Object.keys(setup(ALL).tools)) expect(stripExtensionKeyPrefix(name)).toBe(name);
  });
});

describe("generate_image", () => {
  it("saves the PNG in /workspace/images, persists it for the chat, and keeps the ref away from the model", async () => {
    const t = setup();
    const res = await t.call("generate_image", { prompt: "a cat", name: "cat" });
    expect(res.resultType).toBe("success");
    expect(Buffer.from(await t.fs.readFileBytes("/workspace/images/cat.png")).toString("base64")).toBe(PNG_BASE64);
    expect(t.persisted).toEqual([`data:image/png;base64,${PNG_BASE64}`]);
    // UI output: same shape as image_generation (result = blob ref).
    expect(t.records[0].output).toEqual({ result: "blob://thread-1/img1.png", path: "/workspace/images/cat.png", revisedPrompt: "a cat, watercolour" });
    // Model text: the path, no blob ref, no base64.
    expect(res.textResultForLlm).toContain("/workspace/images/cat.png");
    expect(res.textResultForLlm).not.toContain("blob://");
    expect(res.textResultForLlm).not.toContain(PNG_BASE64);
  });

  it("does not overwrite an image with the same name", async () => {
    const t = setup();
    await t.call("generate_image", { prompt: "a", name: "cat" }, "c1");
    await t.call("generate_image", { prompt: "b", name: "cat.png" }, "c2");
    expect((t.records[1].output as { path: string }).path).toBe("/workspace/images/cat (2).png");
  });

  it("fails with a user-safe message when the model returns no image", async () => {
    const t = setup(ALL, { generateImage: vi.fn(async () => ({ base64: "" })) });
    const res = await t.call("generate_image", { prompt: "a cat" });
    expect(res.resultType).toBe("failure");
    expect(t.records[0].uiError).toBe("generate_image: the image model returned no image.");
  });

  it("stores the type the bytes show (what /api/images serves inline)", async () => {
    const t = setup(ALL, { generateImage: vi.fn(async () => ({ base64: JPEG_BASE64 })) });
    await t.call("generate_image", { prompt: "a cat", name: "cat.png" });
    expect(t.persisted).toEqual([`data:image/jpeg;base64,${JPEG_BASE64}`]);
    expect((t.records[0].output as { path: string }).path).toBe("/workspace/images/cat.jpg");
  });

  it("refuses bytes that are no raster image (e.g. SVG) and stores nothing", async () => {
    const svg = Buffer.from("<svg xmlns='http://www.w3.org/2000/svg'/>").toString("base64");
    const t = setup(ALL, { generateImage: vi.fn(async () => ({ base64: svg })) });
    const res = await t.call("generate_image", { prompt: "a cat", name: "cat" });
    expect(res.resultType).toBe("failure");
    expect(t.persisted).toEqual([]);
    expect(await t.fs.listEntries("/workspace/images")).toEqual([]);
  });
});

describe("web_search", () => {
  it("returns the answer and unique http(s) citations", async () => {
    const t = setup();
    const res = await t.call("web_search", { query: "what is new" });
    expect(t.records[0].output).toEqual({
      answer: "Answer ([site](https://example.org/a))",
      citations: [{ url: "https://example.org/a", title: "A" }, { url: "https://example.org/b" }],
    });
    expect(res.textResultForLlm).toContain("https://example.org/b");
  });
});

describe("run_code", () => {
  it("uploads the named files, copies new container files to /workspace/outputs and shows images", async () => {
    const t = setup();
    await t.fs.writeFileBytes("/workspace/uploads/data.csv", Buffer.from("x,y\n1,2\n"));
    const res = await t.call("run_code", { task: "plot it", files: ["/workspace/uploads/data.csv"] });
    expect(res.resultType).toBe("success");
    expect(t.clients.uploadToContainer).toHaveBeenCalledWith("cntr_1", "data.csv", Buffer.from("x,y\n1,2\n"));
    const prompt = (t.clients.runCode as ReturnType<typeof vi.fn>).mock.calls[0][1].input as string;
    expect(prompt).toContain("/mnt/data/data.csv");
    expect(prompt).toContain("Task: plot it");
    expect(prompt).toContain("/mnt/data/0a1b-data.csv -> /mnt/data/data.csv");
    // Neither the input copy nor the plot copy comes back; the two new files do.
    const out = t.records[0].output as { files: string[]; images: string[]; stdout: string; summary: string };
    expect(out.files).toEqual([`${OUTPUTS_DIR}/chart.png`, `${OUTPUTS_DIR}/summary.csv`]);
    expect(Buffer.from(await t.fs.readFileBytes(`${OUTPUTS_DIR}/summary.csv`)).toString()).toBe("a,b");
    expect(out.images).toEqual(["blob://thread-1/img1.png"]);
    expect((t.records[0].output as { inputs: unknown }).inputs).toEqual([
      { workspacePath: "/workspace/uploads/data.csv", containerPath: "/mnt/data/data.csv" },
    ]);
    expect(t.persisted[0]).toBe(`data:image/png;base64,${png("png!").toString("base64")}`);
    expect(out.stdout).toBe("rows: 3\n");
    expect(out.summary).toBe("Done.");
    expect(res.textResultForLlm).not.toContain("blob://");
    expect(res.textResultForLlm).toContain(`${OUTPUTS_DIR}/chart.png`);
  });

  // chat-page.unit.provider-tools.run-code-downloads
  it("returns a download URL of the workspace route for every output file, and says how to link it", async () => {
    const t = setup();
    await t.fs.writeFileBytes("/workspace/uploads/data.csv", Buffer.from("x,y\n1,2\n"));
    const res = await t.call("run_code", { task: "plot it" });
    const out = t.records[0].output as { downloads: Array<{ name: string; path: string; url: string }> };
    expect(out.downloads).toEqual([
      { name: "chart.png", path: `${OUTPUTS_DIR}/chart.png`, url: "/api/workspace/file?t=thread-1&p=outputs%2Fchart.png" },
      { name: "summary.csv", path: `${OUTPUTS_DIR}/summary.csv`, url: "/api/workspace/file?t=thread-1&p=outputs%2Fsummary.csv" },
    ]);
    // The model gets the URLs ...
    expect(res.textResultForLlm).toContain("/api/workspace/file?t=thread-1&p=outputs%2Fsummary.csv");
    // ... and a static description that says to use them.
    const description = String((t.tools.run_code as { description?: string }).description);
    expect(description).toContain("To give the user a file, link it with the url from downloads, e.g. [name](url).");
    expect(description).toContain("Never use /api/images or sandbox: links for these files.");
    expect(description).toContain("can be linked as [name](/workspace/<path>); the chat makes it a download link.");
    expect(description).not.toContain("thread-1");
  });

  it("encodes the thread id and the file name in the download URL", async () => {
    const t = setup(ALL, { runCode: vi.fn(async () => ({ logs: "", text: "", code: [], images: [] })) });
    (t.clients.listContainerFiles as ReturnType<typeof vi.fn>)
      .mockImplementationOnce(async () => [])
      .mockImplementationOnce(async () => [{ id: "d1", path: "/mnt/data/Q3 report&notes.docx", bytes: 3 }]);
    (t.clients.downloadContainerFile as ReturnType<typeof vi.fn>).mockImplementationOnce(async () => Buffer.from("doc"));
    await t.call("run_code", { task: "write" });
    const out = t.records[0].output as { downloads: Array<{ url: string }> };
    expect(out.downloads[0].url).toBe("/api/workspace/file?t=thread-1&p=outputs%2FQ3%20report%26notes.docx");
  });

  it("runs given code as is", async () => {
    const t = setup();
    await t.call("run_code", { code: "print(1)" });
    const prompt = (t.clients.runCode as ReturnType<typeof vi.fn>).mock.calls[0][1].input as string;
    expect(prompt).toContain("exactly as given");
    expect(prompt).toContain("print(1)");
  });

  it("saves a displayed plot that was not written as a file", async () => {
    const t = setup(ALL, {
      runCode: vi.fn(async () => ({ logs: "", text: "", code: [], images: [`data:image/png;base64,${PNG_BASE64}`] })),
    });
    await t.call("run_code", { task: "plot" });
    const out = t.records[0].output as { files: string[]; images: string[] };
    expect(out.files).toEqual([`${OUTPUTS_DIR}/figure-1.png`]);
    expect(out.images).toHaveLength(1);
  });

  it("shows only images whose bytes are a raster image, whatever the declared type or extension", async () => {
    const svg = Buffer.from("<svg xmlns='http://www.w3.org/2000/svg'/>");
    const t = setup(ALL, {
      runCode: vi.fn(async () => ({ logs: "", text: "", code: [], images: [`data:image/png;base64,${svg.toString("base64")}`] })),
    });
    (t.clients.listContainerFiles as ReturnType<typeof vi.fn>)
      .mockImplementationOnce(async () => [])
      .mockImplementationOnce(async () => [{ id: "s1", path: "/mnt/data/chart.png", bytes: svg.length }]);
    (t.clients.downloadContainerFile as ReturnType<typeof vi.fn>).mockImplementationOnce(async () => svg);
    await t.call("run_code", { task: "plot" });
    const out = t.records[0].output as { files: string[]; images: string[] };
    expect(out.files).toEqual([`${OUTPUTS_DIR}/chart.png`]);
    expect(out.images).toEqual([]);
    expect(t.persisted).toEqual([]);
  });

  it("keeps the interpreter's plot copy as a figure when the code saved no image", async () => {
    const t = setup(ALL, { runCode: vi.fn(async () => ({ logs: "", text: "", code: [], images: [] })) });
    (t.clients.listContainerFiles as ReturnType<typeof vi.fn>)
      .mockImplementationOnce(async () => [])
      .mockImplementationOnce(async () => [{ id: "p1", path: "/mnt/data/cfile_6b08a1.png", bytes: 4 }]);
    (t.clients.downloadContainerFile as ReturnType<typeof vi.fn>).mockImplementationOnce(async () => png("plt!"));
    await t.call("run_code", { task: "plot" });
    const out = t.records[0].output as { files: string[]; images: string[] };
    expect(out.files).toEqual([`${OUTPUTS_DIR}/figure-1.png`]);
    expect(out.images).toHaveLength(1);
  });

  it("caps stdout and writes the full text next to the large tool results, not to the outputs", async () => {
    const long = "x".repeat(RUN_CODE_STDOUT_INLINE_BYTES + 500);
    const t = setup(ALL, { runCode: vi.fn(async () => ({ logs: long, text: "", code: [], images: [] })) });
    await t.call("run_code", { code: "print('x'*99999)" }, "call/7");
    const out = t.records[0].output as { stdout: string; stdoutPath: string; downloads: unknown[] };
    expect(out.stdoutPath).toBe(`${TOOL_RESULTS_DIR}/run_code-stdout-call_7.txt`);
    expect(out.downloads).toEqual([]);
    expect(await t.fs.listEntries(OUTPUTS_DIR)).toEqual([]);
    expect(Buffer.from(await t.fs.readFileBytes(out.stdoutPath)).toString()).toBe(long);
    expect(Buffer.byteLength(out.stdout)).toBeLessThan(RUN_CODE_STDOUT_INLINE_BYTES + 200);
  });

  it("rejects paths outside the workspace, missing files and calls without code or task", async () => {
    const t = setup();
    const outside = await t.call("run_code", { code: "1", files: ["/session-state/events.jsonl"] }, "a");
    expect(outside.resultType).toBe("failure");
    expect(t.records[0].uiError).toContain("only files in /workspace");
    const missing = await t.call("run_code", { code: "1", files: ["/workspace/nope.csv"] }, "b");
    expect(t.records[1].uiError).toBe("run_code: file not found: /workspace/nope.csv");
    expect(missing.resultType).toBe("failure");
    const empty = await t.call("run_code", { files: [] }, "c");
    expect(empty.resultType).toBe("failure");
    expect(t.clients.ensureContainer).not.toHaveBeenCalled();
  });
});

describe("run_code inputs: sizes are checked before any download", () => {
  const MB = 1024 * 1024;
  /** Makes the store report `bytes` for a workspace file (pointer and data blob) without holding them. */
  async function inflate(t: ReturnType<typeof setup>, path: string, bytes: number) {
    await t.fs.writeFile(path, "a,b\n1,2\n");
    const pointer = t.store.blobs.get(`user-1/thread-1/f${path}`)!;
    pointer.metadata.size = String(bytes);
    const target = pointer.metadata.target;
    const real = t.store.getProperties.bind(t.store);
    const previous = t.store.getProperties.bind(t.store);
    t.store.getProperties = async (name: string) => {
      const props = await (name === target ? real : previous)(name);
      return props && name === target ? { ...props, contentLength: bytes } : props;
    };
    return target;
  }
  const downloads = (t: ReturnType<typeof setup>, keys: string[]) =>
    t.store.requests.filter((r) => keys.some((k) => r === `download ${k}`));

  it("refuses a file over 50 MB without downloading it or making a container", async () => {
    const t = setup();
    const key = await inflate(t, "/workspace/big.csv", 51 * MB);
    t.store.requests = [];
    const res = await t.call("run_code", { code: "1", files: ["/workspace/big.csv"] }, "a");
    expect(res.resultType).toBe("failure");
    expect(t.records[0].uiError).toBe("run_code: file too large (over 50 MB): /workspace/big.csv");
    expect(downloads(t, [key])).toEqual([]);
    expect(t.clients.ensureContainer).not.toHaveBeenCalled();
  });

  it("refuses inputs over 100 MB in total before any download", async () => {
    const t = setup();
    const keys = [
      await inflate(t, "/workspace/a.csv", 40 * MB),
      await inflate(t, "/workspace/b.csv", 40 * MB),
      await inflate(t, "/workspace/c.csv", 40 * MB),
    ];
    t.store.requests = [];
    const res = await t.call("run_code", { code: "1", files: ["/workspace/a.csv", "/workspace/b.csv", "/workspace/c.csv"] }, "a");
    expect(res.resultType).toBe("failure");
    expect(t.records[0].uiError).toBe("run_code: the input files are too large together (over 100 MB).");
    expect(downloads(t, keys)).toEqual([]);
    expect(t.clients.ensureContainer).not.toHaveBeenCalled();
  });

  it("uploads a file named twice only once", async () => {
    const t = setup();
    await t.fs.writeFile("/workspace/data.csv", "x,y\n1,2\n");
    const res = await t.call("run_code", { code: "1", files: ["/workspace/data.csv", "data.csv", "/workspace/./data.csv"] }, "a");
    expect(res.resultType).toBe("success");
    expect(t.clients.uploadToContainer).toHaveBeenCalledTimes(1);
  });

  it("puts the chat's uploads in without being named and keeps them within the 100 MB cap, newest first", async () => {
    const t = setup();
    // Oldest to newest: a 40 MB, b 40 MB, c 40 MB; c and b fit, a does not.
    const keys = [
      await inflate(t, "/workspace/uploads/a.csv", 40 * MB),
      await inflate(t, "/workspace/uploads/b.csv", 40 * MB),
      await inflate(t, "/workspace/uploads/c.csv", 40 * MB),
    ];
    const entries = await t.fs.listEntries("/workspace/uploads");
    for (const [i, e] of entries.entries()) e.lastModified = new Date(1_000 + i);
    const listEntries = t.fs.listEntries.bind(t.fs);
    t.fs.listEntries = async (dir: string, prefix?: string) =>
      dir === "/workspace/uploads" ? entries : listEntries(dir, prefix);
    t.store.requests = [];
    const res = await t.call("run_code", { code: "1" }, "a");
    expect(res.resultType).toBe("success");
    const out = t.records[0].output as { inputs: Array<{ containerPath: string }>; skipped?: string[] };
    expect(out.inputs.map((i) => i.containerPath)).toEqual(["/mnt/data/c.csv", "/mnt/data/b.csv"]);
    expect(out.skipped).toEqual(["/workspace/uploads/a.csv"]);
    // The file that does not fit is never downloaded.
    expect(downloads(t, [keys[0]])).toEqual([]);
    expect(res.textResultForLlm).toContain("/workspace/uploads/a.csv");
  });
});

describe("run_code: the thread's code interpreter files and uploads", () => {
  const agentFile = {
    id: "assistant-file1",
    name: "Line Overview.xlsx",
    containerPath: "/mnt/data/assistant-file1-Line Overview.xlsx",
  };

  it("a run without inputs gets the uploads and reports the agent's Code file at its container path", async () => {
    const t = setup(ALL, {}, { containerFiles: [agentFile] });
    await t.fs.writeFileBytes("/workspace/uploads/data.csv", Buffer.from("x,y\n1,2\n"));
    const res = await t.call("run_code", { task: "Summarise the workbook" });
    expect(res.resultType).toBe("success");
    expect(t.clients.uploadToContainer).toHaveBeenCalledWith("cntr_1", "data.csv", Buffer.from("x,y\n1,2\n"));
    const out = t.records[0].output as { inputs: unknown };
    expect(out.inputs).toEqual([
      { workspacePath: "/workspace/uploads/data.csv", containerPath: "/mnt/data/data.csv" },
      { name: agentFile.name, containerPath: agentFile.containerPath },
    ]);
    const prompt = (t.clients.runCode as ReturnType<typeof vi.fn>).mock.calls[0][1].input as string;
    expect(prompt).toContain(agentFile.containerPath);
    expect(prompt).toContain("/mnt/data/data.csv");
    // The model gets the paths, the description stays static.
    expect(res.textResultForLlm).toContain(agentFile.containerPath);
    // The description is static: no per-thread path in it.
    const description = String((t.tools.run_code as { description?: string }).description);
    expect(description).toContain("attached automatically");
    expect(description).not.toContain(agentFile.containerPath);
  });

  it("does not upload an input again that is still in the container with the same size", async () => {
    const t = setup();
    await t.fs.writeFileBytes("/workspace/uploads/data.csv", Buffer.from("x,y\n1,2\n"));
    await t.call("run_code", { code: "1" }, "a");
    // The fake run copied it to /mnt/data/data.csv (8 bytes).
    await t.call("run_code", { code: "2" }, "b");
    expect(t.clients.uploadToContainer).toHaveBeenCalledTimes(1);
    expect((t.records[1].output as { inputs: unknown }).inputs).toEqual([
      { workspacePath: "/workspace/uploads/data.csv", containerPath: "/mnt/data/data.csv" },
    ]);
  });

  it("an unpacked skill package is not copied back as output", async () => {
    const t = setup(ALL, {
      runCode: vi.fn(async () => ({ logs: "", text: "", code: [], images: [] })),
    });
    const listed: ContainerFile[] = [];
    (t.clients.listContainerFiles as ReturnType<typeof vi.fn>).mockImplementation(async () => listed);
    (t.clients.runCode as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      listed.push({ id: "s1", path: "/mnt/data/skills/deck/SKILL.md", bytes: 3 });
      return { logs: "", text: "", code: [], images: [] };
    });
    await t.call("run_code", { code: "unpack" });
    expect((t.records[0].output as { files: string[] }).files).toEqual([]);
  });
});

describe("run_code: only the files the code created or changed come back", () => {
  // chat-page.unit.provider-tools.run-code-outputs-only
  it("a run with a skill archive and inputs returns only the new deck and report", async () => {
    const skillZip = {
      id: "assistant-skill1",
      name: "skill-deck.zip",
      containerPath: "/mnt/data/assistant-skill1-skill-deck.zip",
      entries: [
        { name: "SKILL.md", size: 40 },
        { name: "build_deck.py", size: 120 },
        { name: "recipes_process.py", size: 80 },
        { name: "recipes_relations.py", size: 90 },
      ],
    };
    const codeFile = { id: "assistant-code1", name: "Line Overview.xlsx", containerPath: "/mnt/data/assistant-code1-Line Overview.xlsx" };
    const bytes = (n: number) => Buffer.alloc(n, 1);
    const t = setup(ALL, {}, { containerFiles: [skillZip, codeFile] });
    // The container was created with the archive and the Code file.
    t.containerFiles.push(
      { id: "c1", path: skillZip.containerPath, bytes: 500, data: bytes(500) },
      { id: "c2", path: codeFile.containerPath, bytes: 300, data: bytes(300) },
    );
    await t.fs.writeFileBytes("/workspace/uploads/recipes.csv", bytes(64));
    (t.clients.runCode as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      const add = (path: string, n: number) => t.containerFiles.push({ id: `n${t.containerFiles.length}`, path, bytes: n, data: bytes(n) });
      // Unpacked skill (excluded as before), skill scripts copied next to the
      // outputs, Python caches, copies of the inputs ...
      add("/mnt/data/skills/deck/scripts/build_deck.py", 120);
      add("/mnt/data/build_deck.py", 120);
      add("/mnt/data/recipes_process.py", 80);
      add("/mnt/data/work/recipes_relations.py", 90);
      add("/mnt/data/__pycache__/build_deck.cpython-311.pyc", 700);
      add("/mnt/data/recipes_process.cpython-311.pyc", 600);
      add("/mnt/data/Line Overview.xlsx", 300);
      add("/mnt/data/out/recipes.csv", 64);
      // ... and what the code made.
      add("/mnt/data/deck.pptx", 2048);
      add("/mnt/data/recipes_report.docx", 1024);
      add("/mnt/data/relations_report.xlsx", 512);
      return { logs: "done\n", text: "", code: [], images: [] };
    });
    await t.call("run_code", { task: "build the deck" });
    const out = t.records[0].output as { files: string[]; downloads: Array<{ name: string }>; stdoutPath?: string };
    expect(out.files).toEqual([
      `${OUTPUTS_DIR}/deck.pptx`,
      `${OUTPUTS_DIR}/recipes_report.docx`,
      `${OUTPUTS_DIR}/relations_report.xlsx`,
    ]);
    expect(out.downloads.map((d) => d.name)).toEqual(["deck.pptx", "recipes_report.docx", "relations_report.xlsx"]);
    expect((await t.fs.listEntries(OUTPUTS_DIR)).map((e) => e.path).sort()).toEqual(out.files.slice().sort());
    // stdout was not cut: no stdout file anywhere.
    expect(out.stdoutPath).toBeUndefined();
    expect(await t.fs.listEntries(TOOL_RESULTS_DIR)).toEqual([]);
  });

  it("returns an input the code changed (same name, other size)", async () => {
    const t = setup();
    await t.fs.writeFileBytes("/workspace/uploads/recipes.csv", Buffer.alloc(64, 1));
    (t.clients.runCode as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      t.containerFiles.push({ id: "chg", path: "/mnt/data/out/recipes.csv", bytes: 70, data: Buffer.alloc(70, 2) });
      return { logs: "", text: "", code: [], images: [] };
    });
    await t.call("run_code", { task: "fix the csv" });
    expect((t.records[0].output as { files: string[] }).files).toEqual([`${OUTPUTS_DIR}/recipes.csv`]);
  });
});

describe("resolveResponsesModel", () => {
  const configs = {
    "gpt-5.6-luna": { deploymentName: "luna56-dep", supportsResponsesAPI: true },
    "gpt-6-sol": { deploymentName: "sol-dep", supportsResponsesAPI: true },
    "claude-x": { deploymentName: "claude-dep", supportsResponsesAPI: false, provider: "anthropic" },
    "gpt-undeployed": { deploymentName: "", supportsResponsesAPI: true },
  };
  const withLuna6 = { "gpt-6-luna": { deploymentName: "luna6-dep", supportsResponsesAPI: true }, ...configs };

  it("defaults to the first deployed model of the fallback chain: GPT-6 Luna", () => {
    expect(FALLBACK_MODEL_CHAIN[0]).toBe("gpt-6-luna");
    expect(resolveResponsesModel(withLuna6, undefined, FALLBACK_MODEL_CHAIN)).toEqual({ id: "gpt-6-luna", deployment: "luna6-dep" });
  });

  it("falls back to gpt-5.6-luna when GPT-6 Luna is not deployed", () => {
    expect(resolveResponsesModel(configs, undefined, FALLBACK_MODEL_CHAIN)).toEqual({ id: "gpt-5.6-luna", deployment: "luna56-dep" });
    expect(
      resolveResponsesModel({ ...withLuna6, "gpt-6-luna": { deploymentName: "", supportsResponsesAPI: true } }, undefined, FALLBACK_MODEL_CHAIN),
    ).toEqual({ id: "gpt-5.6-luna", deployment: "luna56-dep" });
  });

  it("an env model that is deployed and serves the Responses API wins", () => {
    expect(resolveResponsesModel(withLuna6, "gpt-6-sol", FALLBACK_MODEL_CHAIN)).toEqual({ id: "gpt-6-sol", deployment: "sol-dep" });
    expect(resolveResponsesModel(withLuna6, " gpt-5.6-luna ", FALLBACK_MODEL_CHAIN)?.id).toBe("gpt-5.6-luna");
  });

  it("skips an env model that is not usable, then takes any deployed Responses model (negative)", () => {
    expect(resolveResponsesModel(withLuna6, "claude-x", FALLBACK_MODEL_CHAIN)?.id).toBe("gpt-6-luna");
    expect(resolveResponsesModel(withLuna6, "toString", FALLBACK_MODEL_CHAIN)?.id).toBe("gpt-6-luna");
    expect(resolveResponsesModel({ ...configs, "gpt-5.6-luna": { deploymentName: "" } }, "gpt-undeployed", FALLBACK_MODEL_CHAIN)).toEqual({
      id: "gpt-6-sol",
      deployment: "sol-dep",
    });
    expect(resolveResponsesModel({ "claude-x": configs["claude-x"] }, undefined, FALLBACK_MODEL_CHAIN)).toBeUndefined();
  });
});

describe("tool model usage (web_search, run_code)", () => {
  const lunaUsage = { model: "gpt-6-luna", inputTokens: 5000, outputTokens: 400, cacheReadTokens: 1000 };
  const noSignal = undefined as unknown as AbortSignal;

  it("a web_search call with usage adds a GPT-6 Luna bucket to the turn usage", async () => {
    const mapper = new CopilotEventMapper(() => undefined, { appToolNames: new Set(["web_search"]) });
    const t = setup(ALL, {
      webSearch: vi.fn(async () => ({ text: "Answer", citations: [], usage: lunaUsage })),
    });
    const out = await runAppTool(
      "web_search",
      { query: "q" },
      { toolCallId: "ws-1", signal: noSignal },
      { toolset: t.tools, onModelUsage: (u) => mapper.addToolModelUsage(u) },
    );
    expect(out.resultType).toBe("success");
    // The main model's own call, as the runtime reports it.
    mapper.handle({ type: "assistant.usage", data: { model: "openai/gpt-6.2-sol", inputTokens: 100, outputTokens: 10 } });
    const usage = mapper.turnUsage;
    expect(usage.byModel["gpt-6-luna"]).toEqual({ inputTokens: 5000, outputTokens: 400, cacheReadTokens: 1000, cacheWriteTokens: 0, calls: 1 });
    expect(usage.inputTokens).toBe(5100);
    expect(usage.outputTokens).toBe(410);
    expect(usage.cacheReadTokens).toBe(1000);
    // Not a call of the main agent: no step, no context size.
    expect(usage.calls).toBe(1);
    expect(usage.lastInputTokens).toBe(100);
  });

  it("a run_code call reports its usage the same way", async () => {
    const reported: unknown[] = [];
    const t = setup(ALL, {
      runCode: vi.fn(async () => ({ logs: "ok", text: "", code: [], images: [], usage: lunaUsage })),
    });
    await runAppTool("run_code", { code: "print(1)" }, { toolCallId: "rc-1", signal: noSignal }, { toolset: t.tools, onModelUsage: (u) => reported.push(u) });
    expect(reported).toEqual([lunaUsage]);
  });

  it("reports nothing without usage, and drops usage outside a turn (negative)", async () => {
    const reported: unknown[] = [];
    const t = setup(ALL, { webSearch: vi.fn(async () => ({ text: "Answer", citations: [] })) });
    await runAppTool("web_search", { query: "q" }, { toolCallId: "ws-2", signal: noSignal }, { toolset: t.tools, onModelUsage: (u) => reported.push(u) });
    const withUsage = setup(ALL, { webSearch: vi.fn(async () => ({ text: "Answer", citations: [], usage: lunaUsage })) });
    const out = await runAppTool("web_search", { query: "q" }, { toolCallId: "ws-3", signal: noSignal }, { toolset: withUsage.tools });
    expect(out.resultType).toBe("success");
    expect(reported).toEqual([]);
  });

  it("the mapper ignores tool usage after the turn is over (negative)", () => {
    const mapper = new CopilotEventMapper(() => undefined, { appToolNames: new Set() });
    mapper.handle({ type: "session.idle", data: {} });
    mapper.addToolModelUsage(lunaUsage);
    expect(mapper.turnUsage.byModel).toEqual({});
    expect(mapper.turnUsage.inputTokens).toBe(0);
  });
});

describe("responsesCallUsage", () => {
  it("maps the Responses usage (input incl. cached, output, cached, reasoning) under the model id", () => {
    expect(
      responsesCallUsage("gpt-6-luna", {
        input_tokens: 1200,
        output_tokens: 80,
        input_tokens_details: { cached_tokens: 1024 },
        output_tokens_details: { reasoning_tokens: 30 },
      }),
    ).toEqual({ model: "gpt-6-luna", inputTokens: 1200, outputTokens: 80, cacheReadTokens: 1024, cacheWriteTokens: 0, reasoningTokens: 30 });
  });

  it("is undefined without usage or with zero tokens (negative)", () => {
    expect(responsesCallUsage("gpt-6-luna", undefined)).toBeUndefined();
    expect(responsesCallUsage("gpt-6-luna", { input_tokens: 0, output_tokens: 0 })).toBeUndefined();
    expect(responsesCallUsage("gpt-6-luna", { input_tokens: "12" })).toBeUndefined();
  });
});
