// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/features/common/services/logger", () => ({
  logDebug: vi.fn(),
  logInfo: vi.fn(),
  logError: vi.fn(),
  logWarn: vi.fn(),
}));
vi.mock("@/features/common/services/openai", () => ({
  OpenAIEmbeddingInstance: vi.fn(),
  OpenAIV1Instance: vi.fn(),
  OpenAIV1ReasoningInstance: vi.fn(),
}));
vi.mock("@/features/auth-page/helpers", () => ({ userHashedId: async () => "user1" }));

// In-memory CHAT_DOCUMENT rows: the query parameters are applied as the SQL says.
type Row = Record<string, unknown> & { id: string; name: string };
const cosmos = vi.hoisted(() => ({
  rows: [] as Row[],
  upserts: [] as Row[],
  failUpsert: false,
  queries: 0,
}));
vi.mock("@/features/common/services/cosmos", () => ({
  HistoryContainer: () => ({
    items: {
      query: (spec: { parameters: { name: string; value: unknown }[] }, options: { partitionKey?: string }) => ({
        fetchAll: async () => {
          cosmos.queries++;
          const p = Object.fromEntries(spec.parameters.map((x) => [x.name, x.value]));
          const resources = cosmos.rows.filter(
            (r) =>
              r.type === p["@type"] &&
              r.chatThreadId === p["@threadId"] &&
              r.userId === p["@userId"] &&
              r.userId === options.partitionKey &&
              r.isDeleted === false &&
              ((p["@names"] as string[]).includes(r.name) ||
                (p["@workspacePaths"] as string[]).includes(r.workspacePath as string)),
          );
          return { resources: resources.map((r) => ({ ...r })) };
        },
      }),
      upsert: async (row: Row) => {
        if (cosmos.failUpsert) throw new Error("cosmos down");
        cosmos.upserts.push(row);
        const i = cosmos.rows.findIndex((r) => r.id === row.id);
        cosmos.rows[i] = row;
        return { resource: row };
      },
    },
  }),
}));

// In-memory AI Search index: the thread and user filter is applied as OData says.
type Chunk = { id: string; chatThreadId: string; user: string; metadata: string };
const search = vi.hoisted(() => ({ chunks: [] as Chunk[], failDelete: false, searches: 0 }));
vi.mock("@/features/common/services/ai-search", () => ({
  AzureAISearchInstance: () => ({
    search: async (_text: string, options: { filter: string }) => {
      search.searches++;
      const m = /^chatThreadId eq '([^']*)' and user eq '([^']*)'$/.exec(options.filter);
      if (!m) throw new Error(`unexpected filter ${options.filter}`);
      const hits = search.chunks.filter((c) => c.chatThreadId === m[1] && c.user === m[2]);
      return {
        results: (async function* () {
          for (const c of hits) yield { score: 1, document: { id: c.id, metadata: c.metadata } };
        })(),
      };
    },
    deleteDocuments: async (_key: string, ids: string[]) => {
      if (search.failDelete) throw new Error("search down");
      search.chunks = search.chunks.filter((c) => !ids.includes(c.id));
      return { results: ids.map(() => ({ succeeded: true })) };
    },
  }),
  AzureAISearchIndexClientInstance: vi.fn(),
}));

import { BlobSessionFs } from "./blob-session-fs";
import { FakeBlobStore } from "./fake-blob-store.test-helper";
import { removeWorkspaceFile } from "./workspace-listing";
import { removeWorkspaceIndexEntries, WorkspaceIndexRemovalError } from "./workspace-index-removal";

const row = (id: string, name: string, threadId = "thread1", userId = "user1"): Row => ({
  id,
  name,
  chatThreadId: threadId,
  userId,
  isDeleted: false,
  type: "CHAT_DOCUMENT",
  workspacePath: `/workspace/${name}`,
  chunkCount: 2,
});
const chunk = (id: string, metadata: string, chatThreadId = "thread1", user = "user1"): Chunk => ({
  id,
  metadata,
  chatThreadId,
  user,
});

let store: FakeBlobStore;
let fs: BlobSessionFs;
const deps = () => ({
  fs,
  removeIndexEntries: (paths: string[]) => removeWorkspaceIndexEntries({ threadId: "thread1", userKey: "user1", paths }),
});

describe("deleting an indexed workspace file removes its index entries", () => {
  beforeEach(async () => {
    cosmos.rows = [
      row("r1", "uploads/report.pdf"),
      row("r2", "uploads/report.pdf (2).pdf"),
      row("r3", "uploads/report.pdf", "thread2"),
      row("r4", "uploads/report.pdf", "thread1", "user2"),
      row("r5", "out/notes.txt"),
    ];
    cosmos.upserts = [];
    cosmos.failUpsert = false;
    cosmos.queries = 0;
    search.chunks = [
      chunk("c1", "uploads/report.pdf"),
      chunk("c2", "uploads/report.pdf"),
      chunk("c3", "uploads/report.pdf (2).pdf"),
      chunk("c4", "uploads/report.pdf.md"),
      chunk("c5", "report.pdf"),
      chunk("c6", "uploads/report.pdf", "thread2"),
      chunk("c7", "uploads/report.pdf", "thread1", "user2"),
      chunk("c8", "out/notes.txt"),
    ];
    search.failDelete = false;
    search.searches = 0;
    store = new FakeBlobStore();
    fs = new BlobSessionFs(store, "user1/thread1", undefined, undefined);
    await fs.writeFileBytes("/workspace/uploads/report.pdf", Buffer.from("%PDF"));
    await fs.writeFileBytes("/workspace/uploads/report.pdf.md", Buffer.from("text"));
    await fs.writeFileBytes("/workspace/uploads/report.pdf (2).pdf", Buffer.from("%PDF"));
    await fs.writeFileBytes("/workspace/out/notes.txt", Buffer.from("notes"));
  });

  it("an upload: exactly its chunks and its row go, other files, threads and users keep theirs", async () => {
    const removed = await removeWorkspaceFile(deps(), "uploads/report.pdf");

    expect(removed.sort()).toEqual(["uploads/report.pdf", "uploads/report.pdf.md"]);
    expect(search.chunks.map((c) => c.id).sort()).toEqual(["c3", "c4", "c5", "c6", "c7", "c8"]);
    expect(cosmos.upserts.map((r) => [r.id, r.isDeleted])).toEqual([["r1", true]]);
    expect(cosmos.rows.filter((r) => r.isDeleted).map((r) => r.id)).toEqual(["r1"]);
  });

  it("a created file: its chunks and row go too", async () => {
    await removeWorkspaceFile(deps(), "out/notes.txt");
    expect(search.chunks.map((c) => c.id)).not.toContain("c8");
    expect(search.chunks).toHaveLength(7);
    expect(cosmos.upserts.map((r) => r.id)).toEqual(["r5"]);
    expect(await fs.exists("/workspace/out/notes.txt")).toBe(false);
  });

  it("a file that was never indexed: no AI Search call, no row change", async () => {
    await fs.writeFileBytes("/workspace/out/plain.csv", Buffer.from("a,b"));
    await removeWorkspaceFile(deps(), "out/plain.csv");
    expect(search.searches).toBe(0);
    expect(cosmos.upserts).toEqual([]);
  });

  it("when the chunk delete fails: the file, its extract and the row are kept, and the error says so", async () => {
    search.failDelete = true;
    await expect(removeWorkspaceFile(deps(), "uploads/report.pdf")).rejects.toBeInstanceOf(WorkspaceIndexRemovalError);
    expect(await fs.exists("/workspace/uploads/report.pdf")).toBe(true);
    expect(await fs.exists("/workspace/uploads/report.pdf.md")).toBe(true);
    expect(cosmos.upserts).toEqual([]);
    expect(search.chunks).toHaveLength(8);
  });

  it("when the row update fails: the file is kept", async () => {
    cosmos.failUpsert = true;
    await expect(removeWorkspaceFile(deps(), "uploads/report.pdf")).rejects.toBeInstanceOf(WorkspaceIndexRemovalError);
    expect(await fs.exists("/workspace/uploads/report.pdf")).toBe(true);
  });

  it("matches a row by its workspace path too", async () => {
    cosmos.rows = [{ ...row("r9", "renamed"), workspacePath: "/workspace/out/notes.txt" }];
    search.chunks = [chunk("c9", "renamed"), chunk("c10", "out/notes.txt")];
    expect(await removeWorkspaceIndexEntries({ threadId: "thread1", userKey: "user1", paths: ["out/notes.txt"] })).toBe(1);
    expect(search.chunks.map((c) => c.id)).toEqual(["c10"]);
  });
});
