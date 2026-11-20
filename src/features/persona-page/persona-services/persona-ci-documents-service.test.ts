import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createHash } from "crypto";
import { setSession, defaultSession } from "@/__tests__/helpers/session-mock";

const hashEmail = (e: string) => createHash("sha256").update(e).digest("hex");
const USER_HASH = hashEmail(defaultSession!.user.email);

// ── Cosmos mock ───────────────────────────────────────────────────────────────
let historyItems: any[] = [];

const historyContainer = {
  items: {
    upsert: vi.fn(async (doc: any) => ({ resource: { ...doc }, item: { id: doc.id } })),
    query: vi.fn((_q: any) => ({
      fetchAll: async () => ({ resources: historyItems }),
    })),
  },
  item: vi.fn((id: string, _pk?: string) => ({
    read: vi.fn(async () => ({ resource: historyItems.find((i: any) => i.id === id) })),
    delete: vi.fn(async () => {
      const idx = historyItems.findIndex((i: any) => i.id === id);
      if (idx >= 0) historyItems.splice(idx, 1);
      return { resource: undefined };
    }),
  })),
};

vi.mock("@/features/common/services/cosmos", () => ({
  HistoryContainer: () => historyContainer,
  ConfigContainer: () => historyContainer,
}));

vi.mock("@/features/auth-page/auth-api", () => ({ options: {}, authOptions: {} }));

vi.mock("@/features/common/services/logger", () => ({
  logInfo: vi.fn(),
  logError: vi.fn(),
  logDebug: vi.fn(),
}));

vi.mock("@/features/common/services/microsoft-graph-client", () => ({
  getGraphClient: vi.fn(() => ({
    api: vi.fn(() => ({
      select: vi.fn().mockReturnThis(),
      get: vi.fn().mockResolvedValue({ name: "file.csv", file: { mimeType: "text/csv" } }),
      responseType: vi.fn().mockReturnThis(),
    })),
  })),
}));

import {
  PersonaCIDocumentsByIds,
  DeletePersonaCIDocumentById,
  DeletePersonaCIDocumentsByPersonaId,
  UpdateOrAddPersonaCIDocuments,
  DownloadSharePointFile,
} from "./persona-ci-documents-service";

const makeCIDoc = (id: string) => ({
  id,
  fileName: `${id}.csv`,
  userId: USER_HASH,
  source: "SHAREPOINT" as const,
  type: "PERSONA_CI_DOCUMENT" as const,
  externalFile: {
    documentId: `sp-${id}`,
    parentReference: { driveId: "drive-1" },
  },
});

beforeEach(() => {
  historyItems.length = 0;
  vi.clearAllMocks();
  setSession(defaultSession);
  process.env.MAX_PERSONA_CI_DOCUMENT_LIMIT = "20";
  historyContainer.items.upsert.mockImplementation(async (doc: any) => ({
    resource: { ...doc },
    item: { id: doc.id },
  }));
  historyContainer.items.query.mockImplementation((_q: any) => ({
    fetchAll: async () => ({ resources: historyItems }),
  }));
  historyContainer.item.mockImplementation((id: string, _pk?: string) => ({
    read: vi.fn(async () => ({ resource: historyItems.find((i: any) => i.id === id) })),
    delete: vi.fn(async () => {
      const idx = historyItems.findIndex((i: any) => i.id === id);
      if (idx >= 0) historyItems.splice(idx, 1);
      return { resource: undefined };
    }),
  }));
});

describe("persona-ci-documents-service.ts", () => {
  // 001 – PersonaCIDocumentsByIds OK when doc exists
  it("001 PersonaCIDocumentsByIds returns the doc when it exists", async () => {
    const doc = makeCIDoc("ci-1");
    historyItems.push(doc);

    const result = await PersonaCIDocumentsByIds(["ci-1"]);
    expect(result.status).toBe("OK");
    if (result.status === "OK") {
      expect(result.response.map((d) => d.id)).toEqual(["ci-1"]);
    }
  });

  // 002 – PersonaCIDocumentsByIds without a missing doc
  it("002 PersonaCIDocumentsByIds leaves out a missing doc", async () => {
    const result = await PersonaCIDocumentsByIds(["missing"]);
    expect(result.status === "OK" && result.response).toEqual([]);
  });

  // 003 – PersonaCIDocumentsByIds returns filtered list
  it("003 PersonaCIDocumentsByIds returns 2 docs", async () => {
    historyItems.push(makeCIDoc("ci-a"), makeCIDoc("ci-b"));

    const result = await PersonaCIDocumentsByIds(["ci-a", "ci-b"]);
    expect(result.status).toBe("OK");
    if (result.status === "OK") {
      expect(result.response.length).toBe(2);
    }
  });

  // 004 – DeletePersonaCIDocumentById deletes via partition key
  it("004 DeletePersonaCIDocumentById deletes the doc", async () => {
    historyItems.push(makeCIDoc("ci-del"));

    const deleteSpy = vi.fn().mockResolvedValue({ resource: undefined });
    historyContainer.item.mockImplementationOnce((_id: string) => ({
      read: vi.fn(),
      delete: deleteSpy,
    }));

    const result = await DeletePersonaCIDocumentById("ci-del");
    expect(result.status).toBe("OK");
    expect(deleteSpy).toHaveBeenCalledTimes(1);
    // The delete runs in the caller's own partition, so only own docs go.
    expect(historyContainer.item).toHaveBeenCalledWith("ci-del", USER_HASH);
  });

  // 005 – DeletePersonaCIDocumentById ERROR on Cosmos throw
  it("005 DeletePersonaCIDocumentById returns ERROR on Cosmos throw", async () => {
    historyContainer.item.mockImplementationOnce(() => ({
      read: vi.fn(),
      delete: vi.fn().mockRejectedValue(new Error("cosmos boom")),
    }));

    const result = await DeletePersonaCIDocumentById("ci-err");
    expect(result.status).toBe("ERROR");
  });

  // 006 – DeletePersonaCIDocumentsByPersonaId deletes every owned CI doc
  it("006 DeletePersonaCIDocumentsByPersonaId deletes 3 docs (owner, allowed)", async () => {
    const ids = ["ci-1", "ci-2", "ci-3"];
    historyItems.push({
      id: "persona-1",
      type: "PERSONA",
      userId: USER_HASH,
      isPublished: false,
      codeInterpreterDocumentIds: ids,
    });

    const deleteSpy = vi.fn().mockResolvedValue({ resource: undefined });
    historyContainer.item.mockImplementation((_id: string) => ({
      read: vi.fn(),
      delete: deleteSpy,
    }));

    const result = await DeletePersonaCIDocumentsByPersonaId("persona-1", ids);
    expect(result.status).toBe("OK");
    expect(deleteSpy).toHaveBeenCalledTimes(3);
  });

  it("006b DeletePersonaCIDocumentsByPersonaId: a user who can only use a published agent is not allowed (denied)", async () => {
    historyItems.push({
      id: "persona-pub",
      type: "PERSONA",
      userId: "other-hash",
      isPublished: true,
      codeInterpreterDocumentIds: ["ci-x"],
    });
    const deleteSpy = vi.fn().mockResolvedValue({ resource: undefined });
    historyContainer.item.mockImplementation(() => ({ read: vi.fn(), delete: deleteSpy }));

    const result = await DeletePersonaCIDocumentsByPersonaId("persona-pub", ["ci-x"]);
    expect(result.status).toBe("UNAUTHORIZED");
    if (result.status === "UNAUTHORIZED") {
      expect(result.errors[0].message).toMatch(/not allowed/);
    }
    expect(deleteSpy).not.toHaveBeenCalled();
  });

  it("006c DeletePersonaCIDocumentsByPersonaId deletes only ids the persona references", async () => {
    historyItems.push({
      id: "persona-2",
      type: "PERSONA",
      userId: USER_HASH,
      isPublished: false,
      codeInterpreterDocumentIds: ["ci-own"],
    });
    const deleteSpy = vi.fn().mockResolvedValue({ resource: undefined });
    historyContainer.item.mockImplementation(() => ({ read: vi.fn(), delete: deleteSpy }));

    const result = await DeletePersonaCIDocumentsByPersonaId("persona-2", ["ci-own", "ci-foreign"]);
    expect(result.status).toBe("OK");
    expect(deleteSpy).toHaveBeenCalledTimes(1);
    expect(historyContainer.item).toHaveBeenCalledWith("ci-own", USER_HASH);
    expect(historyContainer.item).not.toHaveBeenCalledWith("ci-foreign", expect.anything());
  });

  // 007 – UpdateOrAddPersonaCIDocuments upserts each doc
  it("007 UpdateOrAddPersonaCIDocuments upserts each input doc", async () => {
    const files = [
      {
        documentId: "sp-1",
        name: "file1.csv",
        createdBy: "user",
        createdDateTime: "2024-01-01",
        parentReference: { driveId: "d1" },
      },
      {
        documentId: "sp-2",
        name: "file2.csv",
        createdBy: "user",
        createdDateTime: "2024-01-01",
        parentReference: { driveId: "d1" },
      },
    ];

    const result = await UpdateOrAddPersonaCIDocuments(files as any, []);
    expect(result.status).toBe("OK");
    expect(historyContainer.items.upsert).toHaveBeenCalledTimes(2);

    const firstUpserted = historyContainer.items.upsert.mock.calls[0][0];
    expect(firstUpserted.userId).toBe(USER_HASH);
    expect(firstUpserted.type).toBe("PERSONA_CI_DOCUMENT");
  });

  it("008 accepts exactly 20 Code Interpreter documents", async () => {
    const files = Array.from({ length: 20 }, (_, index) => ({
      documentId: `sp-${index}`,
      name: `file${index}.csv`,
      createdBy: "user",
      createdDateTime: "2024-01-01",
      parentReference: { driveId: "d1" },
    }));

    const result = await UpdateOrAddPersonaCIDocuments(files as any, []);
    expect(result.status).toBe("OK");
    expect(historyContainer.items.upsert).toHaveBeenCalledTimes(20);
  });

  it("009 rejects more than 20 Code Interpreter documents", async () => {
    const files = Array.from({ length: 21 }, (_, index) => ({
      documentId: `sp-${index}`,
      name: `file${index}.csv`,
      createdBy: "user",
      createdDateTime: "2024-01-01",
      parentReference: { driveId: "d1" },
    }));

    const result = await UpdateOrAddPersonaCIDocuments(files as any, []);
    expect(result.status).toBe("ERROR");
    if (result.status === "ERROR") {
      expect(result.errors[0].message).toMatch(/maximum is 20/i);
    }
    expect(historyContainer.items.upsert).not.toHaveBeenCalled();
  });
});

// ── DownloadSharePointFile: bounded download (size limit + timeout) ─────────
describe("DownloadSharePointFile bounds the download", () => {
  const MB = 1024 * 1024;
  let meta: { status?: number; size: number; mimeType?: string };
  let content: { status?: number; body: Uint8Array; hang?: boolean };
  const fetchMock = vi.fn(async (input: string, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    if (url.includes("/content")) {
      if (content.hang) {
        return new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () =>
            reject(Object.assign(new Error("aborted"), { name: "TimeoutError" }))
          );
        });
      }
      if (content.status) return new Response("x", { status: content.status });
      return new Response(content.body, { status: 200 });
    }
    if (meta.status) return new Response("{}", { status: meta.status });
    return new Response(
      JSON.stringify({
        name: "data.csv",
        cTag: "c1",
        eTag: "e1",
        size: meta.size,
        file: meta.mimeType ? { mimeType: meta.mimeType } : {},
      }),
      { status: 200 }
    );
  });
  const contentCalls = () => fetchMock.mock.calls.filter((c) => String(c[0]).includes("/content"));

  beforeEach(() => {
    fetchMock.mockClear();
    vi.stubGlobal("fetch", fetchMock);
    meta = { size: 4, mimeType: "text/csv" };
    content = { body: new Uint8Array([1, 2, 3, 4]) };
    delete process.env.NEXT_PUBLIC_MAX_PERSONA_CI_DOCUMENT_SIZE;
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("downloads a file with its name and MIME type", async () => {
    const res = await DownloadSharePointFile("b!drive_1", "01ITEM");
    expect(res.status).toBe("OK");
    if (res.status === "OK") {
      expect(res.response.name).toBe("data.csv");
      expect(res.response.contentType).toBe("text/csv");
      expect([...res.response.buffer]).toEqual([1, 2, 3, 4]);
    }
    expect(String(fetchMock.mock.calls[0][0]).startsWith("https://graph.microsoft.com/v1.0/")).toBe(true);
  });

  it("refuses a file above 512 MB from its metadata, before any download", async () => {
    meta.size = 512 * MB + 1;
    const res = await DownloadSharePointFile("b!drive_1", "01ITEM");
    expect(res.status).toBe("ERROR");
    if (res.status === "ERROR") expect(res.errors[0].message).toMatch(/larger than 512 MB/);
    expect(contentCalls()).toHaveLength(0);
  });

  it("accepts a file of exactly 512 MB by its metadata", async () => {
    meta.size = 512 * MB;
    const res = await DownloadSharePointFile("b!drive_1", "01ITEM");
    expect(res.status).toBe("OK");
  });

  it("stops a download that is larger than its metadata said", async () => {
    process.env.NEXT_PUBLIC_MAX_PERSONA_CI_DOCUMENT_SIZE = "3";
    meta.size = 2;
    const res = await DownloadSharePointFile("b!drive_1", "01ITEM");
    expect(res.status).toBe("ERROR");
  });

  it("gives the download 60 s and fails when it times out", async () => {
    const controllers: AbortController[] = [];
    const timeoutSpy = vi.spyOn(AbortSignal, "timeout").mockImplementation(() => {
      const c = new AbortController();
      controllers.push(c);
      return c.signal;
    });
    content.hang = true;
    const pending = DownloadSharePointFile("b!drive_1", "01ITEM");
    await vi.waitFor(() => expect(contentCalls()).toHaveLength(1));
    expect(timeoutSpy).toHaveBeenLastCalledWith(60_000);
    controllers[controllers.length - 1].abort();
    const res = await pending;
    expect(res.status).toBe("ERROR");
  });

  it.each([403, 404, 500])("fails on Graph %i", async (status) => {
    meta.status = status;
    expect((await DownloadSharePointFile("b!drive_1", "01ITEM")).status).toBe("ERROR");
  });
});
