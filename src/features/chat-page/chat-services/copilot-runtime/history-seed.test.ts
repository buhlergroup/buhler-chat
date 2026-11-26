import { describe, it, expect, vi } from "vitest";
import type { UIMessage } from "ai";
import { BlobSessionFs, WorkspaceQuota } from "./blob-session-fs";
import { FakeBlobStore } from "./fake-blob-store.test-helper";
import {
  HISTORY_IMAGES_DIR,
  historyToImportEvents,
  prepareHistoryImages,
  readCapped,
  type SeedImageDeps,
} from "./history-seed";

const THREAD = "thread-1";
/** A PNG signature plus some bytes: enough for the type sniffing. */
const png = (rest: string) => Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from(rest)]);
const UPLOAD = png("the user's photo");
const GENERATED = png("a generated cat");

const userWithImage = (text: string, bytes: Buffer): UIMessage => ({
  id: `u-${text}`,
  role: "user",
  parts: [
    { type: "text", text },
    // thread-context inlines the stored blob:// ref as a data: URL.
    { type: "file", mediaType: "image/png", url: `data:image/png;base64,${bytes.toString("base64")}` },
  ],
});

const generatedImage = (toolCallId: string, ref: string, extra: Record<string, unknown> = {}): UIMessage => ({
  id: `a-${toolCallId}`,
  role: "assistant",
  parts: [
    {
      type: "dynamic-tool",
      toolName: "image_generation",
      toolCallId,
      state: "output-available",
      input: { prompt: "a cat" },
      output: { result: ref, ...extra },
    },
    { type: "text", text: "Here is the cat." },
  ] as UIMessage["parts"],
});

function setup(opts: { vision: boolean; store?: Record<string, Buffer>; quota?: WorkspaceQuota } = { vision: true }) {
  const blobs = new FakeBlobStore();
  const fs = new BlobSessionFs(blobs, `user-a/${THREAD}`, undefined, undefined, opts.quota ?? new WorkspaceQuota(500 * 1024 * 1024, 2000));
  const images: Record<string, Buffer> = { "gen1.png": GENERATED, ...opts.store };
  const readThreadImage = vi.fn(async (fileName: string, maxBytes: number) => {
    const data = images[fileName];
    return data && data.length <= maxBytes ? new Uint8Array(data) : undefined;
  });
  const deps: SeedImageDeps = { threadId: THREAD, vision: opts.vision, fs, readThreadImage };
  return { fs, deps, readThreadImage };
}

const history = (): UIMessage[] => [
  userWithImage("What is in this photo?", UPLOAD),
  { id: "a1", role: "assistant", parts: [{ type: "text", text: "A dog." }] },
  { id: "u2", role: "user", parts: [{ type: "text", text: "Draw a cat." }] },
  generatedImage("call-1", `blob://${THREAD}/gen1.png`),
];

describe("history seeding with earlier images", () => {
  it("attaches the user image and puts the generated image in the workspace (vision model)", async () => {
    const { fs, deps } = setup({ vision: true });
    const h = history();
    const images = await prepareHistoryImages(h, deps);
    const events = historyToImportEvents(h, images, { vision: true });

    const user = events[0] as { type: string; data: { content: string; attachments?: unknown[] } };
    expect(user.type).toBe("user.message");
    expect(user.data.content).toBe("What is in this photo?");
    expect(user.data.attachments).toEqual([
      { type: "blob", mimeType: "image/png", displayName: expect.stringMatching(/\.png$/), data: UPLOAD.toString("base64") },
    ]);

    const complete = events.find((e) => e.type === "tool.execution_complete") as {
      data: { result: { content: string } };
    };
    const path = /saved in the workspace: (\S+)/.exec(complete.data.result.content)?.[1];
    expect(path).toMatch(new RegExp(`^${HISTORY_IMAGES_DIR}/[0-9a-f]{32}\\.png$`));
    expect(complete.data.result.content).toContain("view tool");
    expect(Buffer.from(await fs.readFileBytes(path!))).toEqual(GENERATED);
    // The marker comes first: a long output text is cut at the end.
    expect(complete.data.result.content.startsWith("[Image from this tool call")).toBe(true);
  });

  it("gives a model without image input no attachments, only workspace paths", async () => {
    const { fs, deps } = setup({ vision: false });
    const h = history();
    const events = historyToImportEvents(h, await prepareHistoryImages(h, deps), { vision: false });

    for (const e of events) {
      expect((e.data as { attachments?: unknown }).attachments).toBeUndefined();
    }
    const user = events[0] as { data: { content: string } };
    expect(user.data.content).toMatch(/^What is in this photo\?\n\n\[Image the user attached here, saved in the workspace: \/workspace\/images\/earlier\/[0-9a-f]{32}\.png\]$/);
    expect(user.data.content).not.toContain("view tool");
    const path = /saved in the workspace: (\S+)\]/.exec(user.data.content)![1];
    expect(Buffer.from(await fs.readFileBytes(path))).toEqual(UPLOAD);
  });

  it("writes the same image once (path from its SHA-256)", async () => {
    const { fs, deps } = setup({ vision: false });
    const h = [userWithImage("one", UPLOAD), userWithImage("two", UPLOAD)];
    const writes = vi.spyOn(fs, "writeFileBytes");
    const events = historyToImportEvents(h, await prepareHistoryImages(h, deps), { vision: false });
    const paths = events.map((e) => /saved in the workspace: (\S+)\]/.exec((e.data as { content: string }).content)?.[1]);
    expect(paths[0]).toBeDefined();
    expect(paths[0]).toBe(paths[1]);
    expect(writes).toHaveBeenCalledTimes(1);
  });

  it("carries over only the newest images within the count cap", async () => {
    const { deps } = setup({ vision: true });
    const h = [1, 2, 3, 4, 5].map((i) => userWithImage(`photo ${i}`, png(`photo ${i}`)));
    const events = historyToImportEvents(h, await prepareHistoryImages(h, { ...deps, limits: { maxImages: 2 } }), {
      vision: true,
    });
    const attached = events.map((e) => ((e.data as { attachments?: unknown[] }).attachments ?? []).length);
    expect(attached).toEqual([0, 0, 0, 1, 1]);
    expect((events[0].data as { content: string }).content).toContain("not available any more");
    expect((events[4].data as { content: string }).content).toBe("photo 5");
  });

  it("skips an image over the per-image cap without reading all of it", async () => {
    const big = png("x".repeat(2000));
    const { deps, readThreadImage } = setup({ vision: true, store: { "big.png": big } });
    const h = [generatedImage("call-big", `blob://${THREAD}/big.png`)];
    const images = await prepareHistoryImages(h, { ...deps, limits: { maxImageBytes: 1000 } });
    // The store read is capped at the per-image limit.
    expect(readThreadImage).toHaveBeenCalledWith("big.png", 1000);
    expect(images.get("t:0:call-big")).toEqual([{ kind: "omitted" }]);
  });

  it("stops at the total byte cap, newest first", async () => {
    const { deps } = setup({ vision: true });
    const h: UIMessage[] = [userWithImage("small old", png("s1")), userWithImage("small new", png("s2"))];
    const images = await prepareHistoryImages(h, { ...deps, limits: { maxTotalBytes: png("s2").length + 5 } });
    expect(images.get("u:0:1")).toEqual([{ kind: "omitted" }]);
    expect(images.get("u:1:1")?.map((s) => s.kind)).toEqual(["attachment"]);
  });

  it("never reads an image of another thread", async () => {
    const { deps, readThreadImage } = setup({ vision: true, store: { "theirs.png": png("not yours") } });
    const h: UIMessage[] = [
      generatedImage("call-x", "blob://other-thread/theirs.png"),
      generatedImage("call-y", "/api/images?t=other-thread&img=theirs.png"),
      generatedImage("call-z", "https://chat.example.com/api/images/?t=other-thread&img=theirs.png"),
    ];
    const events = historyToImportEvents(h, await prepareHistoryImages(h, deps), { vision: true });
    expect(readThreadImage).not.toHaveBeenCalled();
    const results = events
      .filter((e) => e.type === "tool.execution_complete")
      .map((e) => (e.data as { result: { content: string } }).result.content);
    expect(results).toHaveLength(3);
    for (const r of results) expect(r).toMatch(/^\[An image from this tool call is not available any more\.\]/);
  });

  it("reads an /api/images URL of this thread", async () => {
    const { deps, readThreadImage } = setup({ vision: true });
    const h = [generatedImage("call-1", `/api/images?t=${THREAD}&img=gen1.png`)];
    const images = await prepareHistoryImages(h, deps);
    expect(readThreadImage).toHaveBeenCalledWith("gen1.png", expect.any(Number));
    expect(images.get("t:0:call-1")?.[0].kind).toBe("workspace");
  });

  it("keeps the workspace path of a generate_image result that still exists", async () => {
    const { fs, deps, readThreadImage } = setup({ vision: true });
    await fs.writeFileBytes("/workspace/images/cat.png", GENERATED);
    const h = [generatedImage("call-1", `blob://${THREAD}/gen1.png`, { path: "/workspace/images/cat.png" })];
    const images = await prepareHistoryImages(h, deps);
    expect(images.get("t:0:call-1")).toEqual([{ kind: "workspace", path: "/workspace/images/cat.png" }]);
    expect(readThreadImage).not.toHaveBeenCalled();
  });

  it("ignores a tool path outside the workspace", async () => {
    const { deps } = setup({ vision: true });
    const h = [generatedImage("call-1", `blob://${THREAD}/gen1.png`, { path: "/session-state/events.jsonl" })];
    const images = await prepareHistoryImages(h, deps);
    expect(images.get("t:0:call-1")?.[0]).toMatchObject({ kind: "workspace", path: expect.stringContaining(HISTORY_IMAGES_DIR) });
  });

  it("marks an image as omitted when the workspace quota is full", async () => {
    const { deps } = setup({ vision: false, quota: new WorkspaceQuota(500 * 1024 * 1024, 0) });
    const h = history();
    const onSkip = vi.fn();
    const images = await prepareHistoryImages(h, { ...deps, onSkip });
    expect([...images.values()].flat().map((s) => s.kind)).toEqual(["omitted", "omitted"]);
    expect(onSkip).toHaveBeenCalledWith("workspace quota");
  });

  it("skips bytes that are not a raster image", async () => {
    const { deps } = setup({ vision: true });
    const h: UIMessage[] = [
      {
        id: "u",
        role: "user",
        parts: [{ type: "file", mediaType: "image/png", url: `data:image/png;base64,${Buffer.from("<svg/>").toString("base64")}` }],
      },
    ];
    const events = historyToImportEvents(h, await prepareHistoryImages(h, deps), { vision: true });
    expect(events).toHaveLength(1);
    expect((events[0].data as { attachments?: unknown }).attachments).toBeUndefined();
    expect((events[0].data as { content: string }).content).toContain("not available any more");
  });

  it("gives an image-only user message a text", async () => {
    const { deps } = setup({ vision: true });
    const h: UIMessage[] = [
      { id: "u", role: "user", parts: [{ type: "file", mediaType: "image/png", url: `data:image/png;base64,${UPLOAD.toString("base64")}` }] },
    ];
    const events = historyToImportEvents(h, await prepareHistoryImages(h, deps), { vision: true });
    expect(events[0].data).toMatchObject({ content: "(image)", attachments: [expect.objectContaining({ type: "blob" })] });
  });

  it("imports text and tool calls as before without images", () => {
    const events = historyToImportEvents(history());
    expect(events.map((e) => e.type)).toEqual([
      "user.message",
      "assistant.message",
      "user.message",
      "assistant.message",
      "tool.execution_start",
      "tool.execution_complete",
      "assistant.message",
    ]);
    expect((events[0].data as { attachments?: unknown }).attachments).toBeUndefined();
  });
});

describe("readCapped", () => {
  async function* chunks(...parts: string[]) {
    for (const p of parts) yield Buffer.from(p);
  }

  it("returns the bytes within the cap", async () => {
    expect(Buffer.from((await readCapped(chunks("ab", "cd"), 4))!).toString()).toBe("abcd");
  });

  it("stops past the cap", async () => {
    let pulled = 0;
    async function* counting() {
      for (const p of ["ab", "cd", "ef", "gh"]) {
        pulled++;
        yield Buffer.from(p);
      }
    }
    expect(await readCapped(counting(), 3)).toBeUndefined();
    expect(pulled).toBe(2);
  });
});
