// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from "vitest";
import { createHash } from "crypto";

const hashedEmail = createHash("sha256").update("test@example.com").digest("hex");

let historyItems: any[] = [];
let queryCapture: any = null;
let threadRow: any = null;

const historyContainer = {
  items: {
    query: vi.fn((q: any) => {
      queryCapture = q;
      return { fetchAll: async () => ({ resources: historyItems }) };
    }),
  },
  item: vi.fn(() => ({ read: async () => ({ resource: threadRow }) })),
};

vi.mock("@/features/common/services/cosmos", () => ({
  HistoryContainer: () => historyContainer,
}));
vi.mock("@/features/auth-page/auth-api", () => ({ authOptions: {}, options: {} }));
vi.mock("@/features/common/services/logger", () => ({
  logDebug: vi.fn(),
  logInfo: vi.fn(),
  logError: vi.fn(),
  logWarn: vi.fn(),
}));
vi.mock("@/features/common/navigation-helpers", () => ({ RevalidateCache: vi.fn() }));

const ingest = vi.fn(async (_args: any): Promise<any> => ({
  status: "OK",
  response: { name: "a.pdf", sha256: "x", extracted: true, indexing: "indexed", chunks: 1 },
}));
vi.mock("./chat-document-ingest", () => ({
  ingestChatDocument: (args: any) => ingest(args),
}));

import * as service from "./chat-document-service";
import { FindAllChatDocuments } from "./chat-document-store";
import { CHAT_DOCUMENT_ATTRIBUTE, CHAT_THREAD_ATTRIBUTE } from "./models";

const form = (file: File | null, id: string | null = "thread1") => {
  const fd = new FormData();
  if (file) fd.set("file", file);
  if (id !== null) fd.set("id", id);
  return fd;
};
const pdf = (size = 10) => new File([new Uint8Array(size)], "a.pdf", { type: "application/pdf" });

beforeEach(() => {
  historyItems = [];
  queryCapture = null;
  threadRow = { id: "thread1", type: CHAT_THREAD_ATTRIBUTE, userId: hashedEmail, isDeleted: false };
  ingest.mockClear();
});

describe("chat-page.unit.document-service.pin — browser-callable surface", () => {
  // Every export of a "use server" module is a Server Action any signed-in
  // browser can call. The module exports only the upload, which checks the
  // session and the thread itself.
  it("exports only UploadChatDocument", () => {
    expect(Object.keys(service).sort()).toEqual(["UploadChatDocument"]);
  });
});

describe("chat-page.unit.document-service.upload — UploadChatDocument", () => {
  it("passes the file of the caller's own thread to the content store pipeline", async () => {
    const res = await service.UploadChatDocument(form(pdf()));
    expect(res.status).toBe("OK");
    expect(ingest).toHaveBeenCalledTimes(1);
    const args = ingest.mock.calls[0][0];
    expect(args).toMatchObject({ userId: hashedEmail, threadId: "thread1", fileName: "a.pdf" });
    expect(args.file).toBeInstanceOf(Blob);
  });

  it("refuses a thread of another user, a deleted thread and an id that is not ours", async () => {
    threadRow = { ...threadRow, userId: "someone-else" };
    expect((await service.UploadChatDocument(form(pdf()))).status).toBe("ERROR");
    threadRow = { ...threadRow, userId: hashedEmail, isDeleted: true };
    expect((await service.UploadChatDocument(form(pdf()))).status).toBe("ERROR");
    expect((await service.UploadChatDocument(form(pdf(), "t1' or 'x"))).status).toBe("ERROR");
    expect(ingest).not.toHaveBeenCalled();
  });

  it("refuses a request without a file", async () => {
    expect((await service.UploadChatDocument(form(null))).status).toBe("ERROR");
  });

  it("shows the configured MAX_UPLOAD_DOCUMENT_SIZE in MB", async () => {
    vi.stubEnv("MAX_UPLOAD_DOCUMENT_SIZE", "1048576");
    try {
      const res = await service.UploadChatDocument(form(pdf(1048577)));
      expect(res.status).toBe("ERROR");
      if (res.status !== "ERROR") return;
      expect(res.errors[0].message).toBe("File is too large and must be less than 1 MB.");
      expect(ingest).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

describe("chat-page.unit.document-service.004 — FindAllChatDocuments filters by type, threadId and isDeleted only", () => {
  it("scopes documents by thread (intentionally not by userId — documents can be assigned to an agent and shared)", async () => {
    await FindAllChatDocuments("t1");
    expect(queryCapture.parameters).toEqual(
      expect.arrayContaining([
        { name: "@type", value: CHAT_DOCUMENT_ATTRIBUTE },
        { name: "@threadId", value: "t1" },
        { name: "@isDeleted", value: false },
      ])
    );
    expect(queryCapture.parameters?.some((p: any) => p.name === "@userId")).toBe(false);
  });

  it("orders deterministically, so the document names in the prompt cannot reshuffle", async () => {
    await FindAllChatDocuments("t1");
    expect(queryCapture.query).toMatch(/ORDER BY r\.createdAt ASC/i);
  });
});
