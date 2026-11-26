// @vitest-environment node
import { describe, it, expect, vi } from "vitest";
import { contentBlobPath } from "@/features/common/blob-path";
import { createContentStore, sha256Hex, type ContentOpenAiFiles } from "./content-store";
import { createMemoryContentBlobBackend } from "./memory-backend";

const userA = "a".repeat(64);
const userB = "b".repeat(64);
const DAY = 24 * 60 * 60 * 1000;

const setup = (start = new Date("2026-01-01T00:00:00Z")) => {
  let clock = start.getTime();
  const now = () => new Date(clock);
  const blobs = createMemoryContentBlobBackend(now);
  const known = new Set<string>();
  let next = 1;
  const openAi = {
    exists: vi.fn(async (id: string) => known.has(id)),
    upload: vi.fn(async () => {
      const id = `file-${next++}`;
      known.add(id);
      return id;
    }),
  } satisfies ContentOpenAiFiles;
  const store = createContentStore({ blobs, openAiFiles: () => openAi, now });
  return {
    store,
    blobs,
    openAi,
    known,
    advance: (ms: number) => {
      clock += ms;
    },
  };
};

const bytes = (text: string) => Buffer.from(text, "utf8");

describe("common.unit.content-store.put", () => {
  it("stores the same bytes once and computes the hash on the server", async () => {
    const { store, blobs } = setup();
    const first = await store.put(userA, bytes("hello"), { contentType: "text/plain" });
    const second = await store.put(userA, bytes("hello"));
    expect(first.sha256).toBe(sha256Hex(bytes("hello")));
    expect(first.blobKey).toBe(contentBlobPath(userA, first.sha256));
    expect(first.blobKey).toBe(`content/${userA}/sha256/${first.sha256}`);
    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.sha256).toBe(first.sha256);
    expect(blobs.stats.writes).toBe(1);
  });

  it("keeps scopes apart: the same bytes of another user are a new blob", async () => {
    const { store, blobs } = setup();
    const a = await store.put(userA, bytes("same"));
    const b = await store.put(userB, bytes("same"));
    expect(a.sha256).toBe(b.sha256);
    expect(a.blobKey).not.toBe(b.blobKey);
    expect(b.created).toBe(true);
    expect(blobs.stats.writes).toBe(2);
  });

  it("two puts racing write one blob (If-None-Match: *)", async () => {
    const { store, blobs } = setup();
    const [x, y] = await Promise.all([
      store.put(userA, bytes("race")),
      store.put(userA, bytes("race")),
    ]);
    expect(blobs.stats.writes).toBe(1);
    expect(blobs.stats.writeConflicts).toBe(1);
    expect([x.created, y.created].sort()).toEqual([false, true]);
    expect(blobs.keys()).toEqual([x.blobKey]);
  });

  it("fails when a stored blob has another size than the bytes", async () => {
    const { store, blobs } = setup();
    const hash = sha256Hex(bytes("real"));
    await blobs.createIfAbsent(contentBlobPath(userA, hash), bytes("other content"), {});
    await expect(store.put(userA, bytes("real"))).rejects.toThrow(/does not match/);
  });

  it("refuses a scope that is not an id", async () => {
    const { store } = setup();
    await expect(store.put("../x", bytes("a"))).rejects.toThrow(/scope/);
  });
});

describe("common.unit.content-store.markdown", () => {
  it("extracts once per scope and hash; later calls read the cached Markdown", async () => {
    const { store, blobs } = setup();
    const { sha256 } = await store.put(userA, bytes("pdf"));
    const extract = vi.fn(async () => "# text");
    const first = await store.markdown(userA, sha256, extract);
    const second = await store.markdown(userA, sha256, extract);
    expect(first).toEqual({ markdown: "# text", cached: false });
    expect(second).toEqual({ markdown: "# text", cached: true });
    expect(extract).toHaveBeenCalledTimes(1);
    expect(blobs.keys()).toContain(contentBlobPath(userA, sha256, ".md"));
  });

  it("concurrent calls share one extraction", async () => {
    const { store } = setup();
    const { sha256 } = await store.put(userA, bytes("pdf"));
    const extract = vi.fn(async () => "text");
    await Promise.all([1, 2, 3].map(() => store.markdown(userA, sha256, extract)));
    expect(extract).toHaveBeenCalledTimes(1);
  });

  it("another user extracts again (no reuse across scopes)", async () => {
    const { store } = setup();
    const a = await store.put(userA, bytes("pdf"));
    const b = await store.put(userB, bytes("pdf"));
    const extract = vi.fn(async () => "text");
    await store.markdown(userA, a.sha256, extract);
    const other = await store.markdown(userB, b.sha256, extract);
    expect(other.cached).toBe(false);
    expect(extract).toHaveBeenCalledTimes(2);
  });
});

describe("common.unit.content-store.openAiFile", () => {
  it("uploads once per hash and scope and caches the id in the blob metadata", async () => {
    const { store, blobs, openAi } = setup();
    const { sha256, blobKey } = await store.put(userA, bytes("csv"));
    const first = await store.openAiFile(userA, sha256, { name: "a.csv" });
    const second = await store.openAiFile(userA, sha256, { name: "a.csv" });
    expect(first).toEqual({ fileId: "file-1", uploaded: true });
    expect(second).toEqual({ fileId: "file-1", uploaded: false });
    expect(openAi.upload).toHaveBeenCalledTimes(1);
    expect((await blobs.head(blobKey))?.metadata.openaifileid).toBe("file-1");
  });

  it("uploads again when OpenAI no longer has the file (404) and updates the metadata", async () => {
    const { store, blobs, openAi, known } = setup();
    const { sha256, blobKey } = await store.put(userA, bytes("csv"));
    await store.openAiFile(userA, sha256, { name: "a.csv" });
    known.delete("file-1");
    const again = await store.openAiFile(userA, sha256, { name: "a.csv" });
    expect(again).toEqual({ fileId: "file-2", uploaded: true });
    expect(openAi.upload).toHaveBeenCalledTimes(2);
    expect((await blobs.head(blobKey))?.metadata.openaifileid).toBe("file-2");
  });

  it("does not reuse the file of another user", async () => {
    const { store, openAi } = setup();
    const a = await store.put(userA, bytes("csv"));
    const b = await store.put(userB, bytes("csv"));
    await store.openAiFile(userA, a.sha256, { name: "a.csv" });
    const other = await store.openAiFile(userB, b.sha256, { name: "a.csv" });
    expect(other.uploaded).toBe(true);
    expect(openAi.upload).toHaveBeenCalledTimes(2);
  });

  it("refuses bytes that do not hash to the given hash", async () => {
    const { store } = setup();
    const { sha256 } = await store.put(userA, bytes("csv"));
    await expect(
      store.openAiFile(userA, sha256, { name: "a.csv", bytes: bytes("other") })
    ).rejects.toThrow(/does not match/);
  });
});

describe("common.unit.content-store.ensureIndexed", () => {
  it("indexes once per hash and target", async () => {
    const { store } = setup();
    const { sha256 } = await store.put(userA, bytes("doc"));
    const indexedTargets = new Set<string>();
    const target = (key: string) => ({
      key,
      isIndexed: async () => indexedTargets.has(key),
    });
    const index = (key: string) =>
      vi.fn(async () => {
        indexedTargets.add(key);
      });
    const i1 = index("thread:1");
    expect(await store.ensureIndexed(userA, sha256, target("thread:1"), i1)).toBe("indexed");
    expect(await store.ensureIndexed(userA, sha256, target("thread:1"), i1)).toBe(
      "already-indexed"
    );
    const i2 = index("thread:2");
    expect(await store.ensureIndexed(userA, sha256, target("thread:2"), i2)).toBe("indexed");
    expect(i1).toHaveBeenCalledTimes(1);
    expect(i2).toHaveBeenCalledTimes(1);
  });

  it("concurrent calls for the same target index once", async () => {
    const { store } = setup();
    const { sha256 } = await store.put(userA, bytes("doc"));
    let done = false;
    const index = vi.fn(async () => {
      await new Promise((r) => setTimeout(r, 5));
      done = true;
    });
    const target = { key: "thread:1", isIndexed: async () => done };
    await Promise.all([1, 2].map(() => store.ensureIndexed(userA, sha256, target, index)));
    expect(index).toHaveBeenCalledTimes(1);
  });
});

describe("common.unit.content-store.cleanup", () => {
  it("deletes only unreferenced content older than the grace period", async () => {
    const { store, blobs, advance } = setup();
    const kept = await store.put(userA, bytes("referenced"));
    const old = await store.put(userA, bytes("orphan"));
    await store.markdown(userA, old.sha256, async () => "orphan text");
    advance(8 * DAY);
    const fresh = await store.put(userA, bytes("fresh orphan"));

    const isReferenced = vi.fn(async (_scope: string, hash: string) => hash === kept.sha256);
    const result = await store.cleanup({ isReferenced });

    expect(result.deleted).toEqual([{ scope: userA, sha256: old.sha256 }]);
    expect(result.keptReferenced).toBe(1);
    expect(result.keptRecent).toBe(1);
    expect(blobs.keys()).toEqual([kept.blobKey, fresh.blobKey].sort());
  });

  it("keeps content that put reused during the grace period", async () => {
    const { store, blobs, advance } = setup();
    const old = await store.put(userA, bytes("reused"));
    advance(30 * DAY);
    await store.put(userA, bytes("reused")); // touches the blob
    const result = await store.cleanup({ isReferenced: async () => false });
    expect(result.deleted).toEqual([]);
    expect(blobs.keys()).toEqual([old.blobKey]);
  });

  it("dry run deletes nothing", async () => {
    const { store, blobs, advance } = setup();
    await store.put(userA, bytes("orphan"));
    advance(8 * DAY);
    const result = await store.cleanup({ isReferenced: async () => false, dryRun: true });
    expect(result.deleted).toHaveLength(1);
    expect(blobs.stats.deletes).toBe(0);
  });
});

describe("common.unit.content-store.putBlob (streamed uploads)", () => {
  it("stores a Blob under the same key as the same bytes, once", async () => {
    const { store, blobs } = setup();
    const viaBlob = await store.putBlob(userA, new Blob([bytes("upload")]));
    const viaBytes = await store.put(userA, bytes("upload"));
    expect(viaBlob.sha256).toBe(sha256Hex(bytes("upload")));
    expect(viaBlob.blobKey).toBe(viaBytes.blobKey);
    expect(viaBlob.created).toBe(true);
    expect(viaBytes.created).toBe(false);
    expect(blobs.stats.writes).toBe(1);
    expect((await blobs.read(viaBlob.blobKey))?.toString()).toBe("upload");
  });

  it("two streamed puts racing write one blob", async () => {
    const { store, blobs } = setup();
    await Promise.all([
      store.putBlob(userA, new Blob([bytes("race")])),
      store.putBlob(userA, new Blob([bytes("race")])),
    ]);
    expect(blobs.stats.writes).toBe(1);
  });

  it("openAiFile uploads the Blob itself (no copy into a buffer)", async () => {
    const { store, openAi } = setup();
    const blob = new Blob([bytes("csv")]);
    const { sha256 } = await store.putBlob(userA, blob);
    await store.openAiFile(userA, sha256, { name: "a.csv", blob });
    expect((openAi.upload.mock.calls[0] as unknown[])[0]).toBe(blob);
  });
});
