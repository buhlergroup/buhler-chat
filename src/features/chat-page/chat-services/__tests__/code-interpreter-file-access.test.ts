import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/features/auth-page/helpers", () => ({
  userHashedId: vi.fn(async () => "me"),
}));
vi.mock("@/features/common/services/logger", () => ({
  logWarn: vi.fn(),
  logError: vi.fn(),
  logInfo: vi.fn(),
}));

let threads: Record<string, any> = {};
const upsert = vi.fn();
const create = vi.fn(async (doc: any) => ({ resource: doc }));
const query = vi.fn();
vi.mock("@/features/common/services/cosmos", () => ({
  HistoryContainer: () => ({
    item: (id: string, pk: string) => ({
      read: async () => ({
        resource: threads[id] && threads[id].userId === pk ? threads[id] : undefined,
      }),
    }),
    items: { upsert, create, query },
  }),
}));

import {
  createChatThreadWithServerFiles,
  findCodeInterpreterFileOfCurrentUser,
  mayDeleteCodeInterpreterFile,
  mergeClientAttachedFiles,
  recordCodeInterpreterUpload,
} from "../code-interpreter-file-access";
import { CHAT_THREAD_ATTRIBUTE } from "../models";

const thread = (over: Record<string, unknown> = {}) => ({
  id: "t1",
  userId: "me",
  type: CHAT_THREAD_ATTRIBUTE,
  isDeleted: false,
  attachedFiles: [],
  ...over,
});

beforeEach(() => {
  threads = {};
  upsert.mockReset();
  upsert.mockImplementation(async (doc: any) => ({ resource: doc }));
  create.mockClear();
  query.mockReset();
});

describe("mergeClientAttachedFiles", () => {
  const up = { id: "f-up", name: "a.csv", type: "code-interpreter" as const, source: "upload" as const };

  it("keeps recorded code interpreter files with the stored data, in request order", () => {
    const skill = { id: "f-skill", name: "skill-demo.zip", type: "code-interpreter" as const, source: "skill" as const };
    const out = mergeClientAttachedFiles([up, skill], [
      { ...skill },
      { ...up, source: "skill" },
    ]);
    expect(out).toEqual([skill, up]);
  });

  it("drops code interpreter files the server did not record", () => {
    expect(
      mergeClientAttachedFiles([up], [{ id: "f-foreign", name: "x", type: "code-interpreter" }]),
    ).toEqual([]);
    expect(
      mergeClientAttachedFiles(undefined, [{ id: "f-foreign", name: "x", type: "code-interpreter" }]),
    ).toEqual([]);
  });

  it("passes search-indexed documents through and keeps undefined as undefined", () => {
    const doc = { id: "d1", name: "n.pdf", type: "search-indexed" as const };
    expect(mergeClientAttachedFiles([], [doc])).toEqual([doc]);
    expect(mergeClientAttachedFiles([up], undefined)).toBeUndefined();
  });
});

describe("mayDeleteCodeInterpreterFile", () => {
  it("only the caller's own uploads", () => {
    expect(mayDeleteCodeInterpreterFile({ source: "upload" })).toBe(true);
    expect(mayDeleteCodeInterpreterFile({ source: "agent-document" })).toBe(false);
    expect(mayDeleteCodeInterpreterFile({ source: "skill" })).toBe(false);
    expect(mayDeleteCodeInterpreterFile({})).toBe(false);
  });
});

describe("findCodeInterpreterFileOfCurrentUser", () => {
  const rows = (resources: unknown[]) => ({ fetchAll: async () => ({ resources }) });

  it("queries only the caller's partition and threads", async () => {
    query.mockReturnValue(rows([]));
    expect(await findCodeInterpreterFileOfCurrentUser("f1")).toBeUndefined();
    const [spec, options] = query.mock.calls[0];
    expect(options).toEqual({ partitionKey: "me" });
    expect(spec.parameters).toEqual(
      expect.arrayContaining([
        { name: "@userId", value: "me" },
        { name: "@fileId", value: "f1" },
        { name: "@isDeleted", value: false },
      ]),
    );
  });

  it("verifies the id itself and prefers the entry the caller uploaded", async () => {
    query.mockReturnValue(
      rows([
        { id: "t-agent", attachedFiles: [{ id: "f1", name: "a", type: "code-interpreter", source: "agent-document" }] },
        { id: "t-other", attachedFiles: [{ id: "f2", name: "b", type: "code-interpreter", source: "upload" }] },
        { id: "t-up", attachedFiles: [{ id: "f1", name: "a", type: "code-interpreter", source: "upload" }] },
      ]),
    );
    const found = await findCodeInterpreterFileOfCurrentUser("f1");
    expect(found?.threadId).toBe("t-up");
    expect(found?.file.source).toBe("upload");
  });

  it("ignores search-indexed entries with the same id", async () => {
    query.mockReturnValue(
      rows([{ id: "t1", attachedFiles: [{ id: "f1", name: "a", type: "search-indexed" }] }]),
    );
    expect(await findCodeInterpreterFileOfCurrentUser("f1")).toBeUndefined();
  });
});

describe("recordCodeInterpreterUpload", () => {
  it("appends the file to the caller's thread as an upload", async () => {
    threads.t1 = thread({ attachedFiles: [{ id: "f0", name: "z", type: "code-interpreter" }] });
    expect(await recordCodeInterpreterUpload("t1", { id: "f1", name: "a.csv" })).toBe(true);
    const doc = upsert.mock.calls[0][0];
    expect(doc.userId).toBe("me");
    expect(doc.attachedFiles.map((f: any) => [f.id, f.source])).toEqual([
      ["f0", undefined],
      ["f1", "upload"],
    ]);
  });

  it("refuses a thread outside the caller's partition or a deleted one", async () => {
    threads.t2 = thread({ id: "t2", userId: "someone-else" });
    threads.t3 = thread({ id: "t3", isDeleted: true });
    expect(await recordCodeInterpreterUpload("t2", { id: "f1", name: "a" })).toBe(false);
    expect(await recordCodeInterpreterUpload("t3", { id: "f1", name: "a" })).toBe(false);
    expect(upsert).not.toHaveBeenCalled();
  });

  it("reads again when the thread changed meanwhile (etag)", async () => {
    threads.t1 = thread({ _etag: "e1" });
    upsert.mockRejectedValueOnce(Object.assign(new Error("precondition"), { code: 412 }));
    expect(await recordCodeInterpreterUpload("t1", { id: "f1", name: "a" })).toBe(true);
    expect(upsert).toHaveBeenCalledTimes(2);
    expect(upsert.mock.calls[0][1]).toEqual({ accessCondition: { type: "IfMatch", condition: "e1" } });
  });
});

describe("createChatThreadWithServerFiles", () => {
  it("creates the thread in the caller's partition", async () => {
    await createChatThreadWithServerFiles(thread({ userId: "someone-else" }) as any);
    expect(create.mock.calls[0][0].userId).toBe("me");
  });
});
