import { describe, it, expect, vi } from "vitest";
import { BlobSessionFs } from "./blob-session-fs";
import { FakeBlobStore } from "./fake-blob-store.test-helper";
import { runAppTool, type ToolCallRecord, type TurnToolBinding } from "./tool-adapter";
import {
  OUTPUTS_DIR,
  RUN_CODE_STDOUT_INLINE_BYTES,
  providerTools,
  resolveResponsesDeployment,
  type ContainerFile,
  type ProviderClients,
  type ProviderToolToggles,
} from "./provider-tools";

const PNG_BASE64 = Buffer.from("\x89PNG fake image bytes").toString("base64");
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
      containerFiles.push({ id: `f${nextId++}`, path: "/mnt/data/cfile_6b08a1.png", bytes: 4, data: Buffer.from("plt!") });
      containerFiles.push({ id: `f${nextId++}`, path: "/mnt/data/chart.png", bytes: 4, data: Buffer.from("png!") });
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

function setup(toggles: ProviderToolToggles = ALL, overrides: Partial<ProviderClients> = {}) {
  const store = new FakeBlobStore();
  const fs = new BlobSessionFs(store, "user-1/thread-1");
  const fake = fakeClients(overrides);
  const tools = providerTools({ fs, threadId: "thread-1", userKey: "user-1", toggles, clients: fake.clients });
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
  return { fs, tools, records, spills, call, ...fake };
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
    expect(t.persisted[0]).toBe(`data:image/png;base64,${Buffer.from("png!").toString("base64")}`);
    expect(out.stdout).toBe("rows: 3\n");
    expect(out.summary).toBe("Done.");
    expect(res.textResultForLlm).not.toContain("blob://");
    expect(res.textResultForLlm).toContain(`${OUTPUTS_DIR}/chart.png`);
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

  it("keeps the interpreter's plot copy as a figure when the code saved no image", async () => {
    const t = setup(ALL, { runCode: vi.fn(async () => ({ logs: "", text: "", code: [], images: [] })) });
    (t.clients.listContainerFiles as ReturnType<typeof vi.fn>)
      .mockImplementationOnce(async () => [])
      .mockImplementationOnce(async () => [{ id: "p1", path: "/mnt/data/cfile_6b08a1.png", bytes: 4 }]);
    (t.clients.downloadContainerFile as ReturnType<typeof vi.fn>).mockImplementationOnce(async () => Buffer.from("plt!"));
    await t.call("run_code", { task: "plot" });
    const out = t.records[0].output as { files: string[]; images: string[] };
    expect(out.files).toEqual([`${OUTPUTS_DIR}/figure-1.png`]);
    expect(out.images).toHaveLength(1);
  });

  it("caps stdout and writes the full text to the workspace", async () => {
    const long = "x".repeat(RUN_CODE_STDOUT_INLINE_BYTES + 500);
    const t = setup(ALL, { runCode: vi.fn(async () => ({ logs: long, text: "", code: [], images: [] })) });
    await t.call("run_code", { code: "print('x'*99999)" }, "call/7");
    const out = t.records[0].output as { stdout: string; stdoutPath: string };
    expect(out.stdoutPath).toBe(`${OUTPUTS_DIR}/stdout-call_7.txt`);
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

describe("resolveResponsesDeployment", () => {
  const configs = {
    "gpt-5.6-luna": { deploymentName: "luna-dep", supportsResponsesAPI: true },
    "gpt-6-sol": { deploymentName: "sol-dep", supportsResponsesAPI: true },
    "claude-x": { deploymentName: "claude-dep", supportsResponsesAPI: false, provider: "anthropic" },
    "gpt-undeployed": { deploymentName: "", supportsResponsesAPI: true },
  };
  it("prefers the env model, then the fast default, then any deployed Responses model", () => {
    expect(resolveResponsesDeployment(configs, "gpt-6-sol")).toBe("sol-dep");
    expect(resolveResponsesDeployment(configs, undefined)).toBe("luna-dep");
    expect(resolveResponsesDeployment(configs, "claude-x")).toBe("luna-dep");
    expect(resolveResponsesDeployment({ ...configs, "gpt-5.6-luna": { deploymentName: "" } }, "gpt-undeployed")).toBe("sol-dep");
    expect(resolveResponsesDeployment({ "claude-x": configs["claude-x"] }, undefined)).toBeUndefined();
  });
});
