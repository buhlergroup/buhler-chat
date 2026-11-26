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

// The read with the access rule is server code only now (it returns whole
// rows: file name, drive and item id).
import { personaCodeDocumentsByIds as PersonaCIDocumentsByIds } from "./persona-document-access";
import {
  CODE_FILE_NOT_VISIBLE,
  addCodeDocument,
  deleteCodeDocument,
  downloadCodeInterpreterFile,
} from "./persona-ci-documents-store";

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

  // 004 – deleteCodeDocument deletes in the row's own partition
  it("004 deleteCodeDocument deletes the row in its own partition, not the caller's", async () => {
    const deleteSpy = vi.fn().mockResolvedValue({ resource: undefined });
    historyContainer.item.mockImplementationOnce((_id: string) => ({
      read: vi.fn(),
      delete: deleteSpy,
    }));

    const result = await deleteCodeDocument({ id: "ci-del", userId: "owner-hash" });
    expect(result.status).toBe("OK");
    expect(deleteSpy).toHaveBeenCalledTimes(1);
    expect(historyContainer.item).toHaveBeenCalledWith("ci-del", "owner-hash");
  });

  // 005 – deleteCodeDocument ERROR on Cosmos throw, OK when already gone
  it("005 deleteCodeDocument returns ERROR on a Cosmos error", async () => {
    historyContainer.item.mockImplementationOnce(() => ({
      read: vi.fn(),
      delete: vi.fn().mockRejectedValue(new Error("cosmos boom")),
    }));

    const result = await deleteCodeDocument({ id: "ci-err", userId: "owner-hash" });
    expect(result.status).toBe("ERROR");
  });

  it("005b deleteCodeDocument: a row that is already gone is OK", async () => {
    historyContainer.item.mockImplementationOnce(() => ({
      read: vi.fn(),
      delete: vi.fn().mockRejectedValue(Object.assign(new Error("Not found"), { code: 404 })),
    }));

    expect((await deleteCodeDocument({ id: "ci-gone", userId: "owner-hash" })).status).toBe("OK");
  });

  // 007 – addCodeDocument writes one row in the agent owner's partition
  it("007 addCodeDocument writes the row with the owner's id, not the caller's", async () => {
    const result = await addCodeDocument(
      {
        documentId: "sp-1",
        name: "file1.csv",
        createdBy: "user",
        createdDateTime: "2024-01-01",
        parentReference: { driveId: "d1" },
      },
      "owner-hash"
    );
    expect(result.status).toBe("OK");
    expect(historyContainer.items.upsert).toHaveBeenCalledTimes(1);
    const row = historyContainer.items.upsert.mock.calls[0][0];
    expect(row).toMatchObject({
      id: result.status === "OK" ? result.response : "",
      userId: "owner-hash",
      type: "PERSONA_CI_DOCUMENT",
      fileName: "file1.csv",
      externalFile: { documentId: "sp-1", parentReference: { driveId: "d1" } },
    });
    expect(row.userId).not.toBe(USER_HASH);
  });

  it("008 no Code file row is readable through a Server Action (the use-server module is gone)", async () => {
    const { existsSync } = await import("fs");
    const { join } = await import("path");
    expect(existsSync(join(__dirname, "persona-ci-documents-service.ts"))).toBe(false);
  });
});

// ── downloadCodeInterpreterFile: bounded download (size limit + timeout) ────
describe("downloadCodeInterpreterFile bounds the download", () => {
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
    delete process.env.MAX_PERSONA_CI_DOCUMENT_SIZE;
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("downloads a file with its name and MIME type", async () => {
    const res = await downloadCodeInterpreterFile("b!drive_1", "01ITEM");
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
    const res = await downloadCodeInterpreterFile("b!drive_1", "01ITEM");
    expect(res.status).toBe("ERROR");
    if (res.status === "ERROR") expect(res.errors[0].message).toMatch(/larger than 512 MB/);
    expect(contentCalls()).toHaveLength(0);
  });

  it("accepts a file of exactly 512 MB by its metadata", async () => {
    meta.size = 512 * MB;
    const res = await downloadCodeInterpreterFile("b!drive_1", "01ITEM");
    expect(res.status).toBe("OK");
  });

  it("takes the size limit from MAX_PERSONA_CI_DOCUMENT_SIZE first, like the editor", async () => {
    process.env.MAX_PERSONA_CI_DOCUMENT_SIZE = String(2 * MB);
    process.env.NEXT_PUBLIC_MAX_PERSONA_CI_DOCUMENT_SIZE = String(600 * MB);
    meta.size = 3 * MB;
    const res = await downloadCodeInterpreterFile("b!drive_1", "01ITEM");
    expect(res.status === "ERROR" && res.errors[0].message).toMatch(/larger than 2 MB/);
    expect(contentCalls()).toHaveLength(0);
  });

  it("stops a download that is larger than its metadata said", async () => {
    process.env.NEXT_PUBLIC_MAX_PERSONA_CI_DOCUMENT_SIZE = "3";
    meta.size = 2;
    const res = await downloadCodeInterpreterFile("b!drive_1", "01ITEM");
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
    const pending = downloadCodeInterpreterFile("b!drive_1", "01ITEM");
    await vi.waitFor(() => expect(contentCalls()).toHaveLength(1));
    // Metadata 5 s, download 60 s.
    expect(timeoutSpy.mock.calls.map((c) => c[0])).toEqual([5_000, 60_000]);
    controllers[controllers.length - 1].abort();
    const res = await pending;
    expect(res.status).toBe("ERROR");
  });

  it.each([401, 403, 404, 500])("fails on Graph %i as 'not visible to the user' (no name may be told)", async (status) => {
    meta.status = status;
    const res = await downloadCodeInterpreterFile("b!drive_1", "01ITEM");
    expect(res.status).toBe("ERROR");
    expect(res.status === "ERROR" && res.errors[0].code).toBe(CODE_FILE_NOT_VISIBLE);
  });

  it("a file the user can see but that is too large is not 'not visible'", async () => {
    meta.size = 512 * MB + 1;
    const res = await downloadCodeInterpreterFile("b!drive_1", "01ITEM");
    expect(res.status === "ERROR" && res.errors[0].code).toBeUndefined();
  });
});
