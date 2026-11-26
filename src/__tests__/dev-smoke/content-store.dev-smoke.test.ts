// @vitest-environment node
/**
 * Dev smoke of the content store against real (DEV) resources: Blob
 * Storage, Document Intelligence, AI Search, Cosmos DB and Azure OpenAI.
 * Skipped unless CONTENT_STORE_DEV_SMOKE=1. It reads src/.env.local
 * (never committed) and uses the developer's Azure CLI login.
 *
 *   CONTENT_STORE_DEV_SMOKE=1 npx vitest run __tests__/dev-smoke
 *
 * It uploads one generated PDF twice to one thread and once to a second
 * thread through UploadChatDocument (the real server action), puts one CSV
 * twice through UploadFileForCodeInterpreterOnce, prints the counts
 * (Document Intelligence calls, blob writes, indexing runs, OpenAI uploads)
 * and removes everything it wrote. The session is the test setup's fixed
 * test user.
 */
import { describe, it, expect, vi, afterAll } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

const RUN = process.env.CONTENT_STORE_DEV_SMOKE === "1";

// Real service settings from src/.env.local; the unit-test placeholders of
// __tests__/setup.ts are removed when .env.local has no such key.
const loadDevEnv = () => {
  const file = path.resolve(__dirname, "../../.env.local");
  if (!existsSync(file)) throw new Error("src/.env.local is missing");
  const values: Record<string, string> = {};
  for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (!m) continue;
    values[m[1]] = m[2].replace(/^(['"])(.*)\1$/, "$2");
  }
  for (const key of [
    "AZURE_COSMOSDB_KEY",
    "AZURE_SEARCH_API_KEY",
    "AZURE_OPENAI_API_KEY",
    "AZURE_STORAGE_ACCOUNT_KEY",
  ]) {
    if (!(key in values)) delete process.env[key];
  }
  Object.assign(process.env, values);
};

const counts = { documentIntelligence: 0, blobWrites: 0, indexRuns: 0 };

vi.mock("@/features/auth-page/auth-api", () => ({ options: {}, authOptions: {} }));

vi.mock("@/features/common/services/document-intelligence", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/features/common/services/document-intelligence")>();
  return {
    DocumentIntelligenceInstance: () => {
      const client = real.DocumentIntelligenceInstance();
      return {
        beginAnalyzeDocument: (...args: Parameters<typeof client.beginAnalyzeDocument>) => {
          counts.documentIntelligence++;
          return client.beginAnalyzeDocument(...args);
        },
      };
    },
  };
});

vi.mock("@/features/chat-page/chat-services/azure-ai-search/azure-ai-search", async (importOriginal) => {
  const real =
    await importOriginal<typeof import("@/features/chat-page/chat-services/azure-ai-search/azure-ai-search")>();
  return {
    ...real,
    IndexDocuments: (...args: Parameters<typeof real.IndexDocuments>) => {
      counts.indexRuns++;
      return real.IndexDocuments(...args);
    },
  };
});

/** A one-page PDF with one line of text (offsets computed). */
const makePdf = (text: string): Buffer => {
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    "",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  const stream = `BT /F1 18 Tf 72 700 Td (${text}) Tj ET`;
  objects[3] = `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`;
  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((body, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const o of offsets) out += `${String(o).padStart(10, "0")} 00000 n \n`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, "latin1");
};

describe.skipIf(!RUN)("content store dev smoke", () => {
  const cleanups: Array<() => Promise<unknown>> = [];

  afterAll(async () => {
    for (const run of cleanups.reverse()) {
      await run().catch((e) => console.log("cleanup failed:", e instanceof Error ? e.message : e));
    }
  });

  it(
    "uploads one PDF twice through the real services and counts the work",
    async () => {
      loadDevEnv();
      const { register, SERVICE_KEYS } = await import("@/features/common/services/service-container");
      const { createAzureContentBlobBackend } = await import(
        "@/features/common/services/content-store/azure-blob-backend"
      );
      const real = createAzureContentBlobBackend();
      const written: string[] = [];
      register(SERVICE_KEYS.contentBlobs, () => ({
        ...real,
        createIfAbsent: async (key: string, data: Buffer, options: any) => {
          const result = await real.createIfAbsent(key, data, options);
          if (result === "created") {
            counts.blobWrites++;
            written.push(key);
          }
          return result;
        },
      }));

      const { userHashedId } = await import("@/features/auth-page/helpers");
      const { HistoryContainer } = await import("@/features/common/services/cosmos");
      const { uniqueId } = await import("@/features/common/util");
      const { UploadChatDocument } = await import(
        "@/features/chat-page/chat-services/chat-document-service"
      );
      const { DeleteDocumentsOfChatThread } = await import(
        "@/features/chat-page/chat-services/azure-ai-search/azure-ai-search"
      );
      const { UploadFileForCodeInterpreterOnce, DeleteFileFromCodeInterpreter } = await import(
        "@/features/chat-page/chat-services/code-interpreter-service"
      );

      const userId = await userHashedId();
      const container = HistoryContainer();
      const newThread = async () => {
        const id = uniqueId();
        await container.items.create({
          id,
          userId,
          type: "CHAT_THREAD",
          name: "content store smoke",
          isDeleted: false,
          createdAt: new Date(),
          lastMessageAt: new Date(),
          bookmarked: false,
        });
        cleanups.push(async () => {
          await DeleteDocumentsOfChatThread(id);
          const { resources } = await container.items
            .query({
              query: "SELECT r.id FROM r WHERE r.userId = @u AND (r.id = @t OR r.chatThreadId = @t)",
              parameters: [
                { name: "@u", value: userId },
                { name: "@t", value: id },
              ],
            })
            .fetchAll();
          for (const r of resources) await container.item(r.id, userId).delete();
        });
        return id;
      };
      cleanups.push(async () => {
        for (const key of written) await real.delete(key);
      });

      const nonce = uniqueId();
      const pdf = makePdf(`Content store smoke ${nonce}`);
      const upload = async (threadId: string) => {
        const form = new FormData();
        form.set("file", new File([new Uint8Array(pdf)], "smoke.pdf", { type: "application/pdf" }));
        form.set("id", threadId);
        const before = { ...counts };
        const res = await UploadChatDocument(form);
        const delta = Object.fromEntries(
          Object.entries(counts).map(([k, v]) => [k, v - before[k as keyof typeof counts]])
        );
        return { res, delta };
      };

      const thread1 = await newThread();
      const thread2 = await newThread();
      const a = await upload(thread1);
      const b = await upload(thread1);
      const c = await upload(thread2);
      console.log("[smoke] PDF 1st upload, thread 1:", JSON.stringify(a.delta), a.res.status === "OK" ? a.res.response : a.res);
      console.log("[smoke] PDF 2nd upload, thread 1:", JSON.stringify(b.delta), b.res.status === "OK" ? b.res.response : b.res);
      console.log("[smoke] PDF upload, thread 2:   ", JSON.stringify(c.delta), c.res.status === "OK" ? c.res.response : c.res);

      expect(a.res.status).toBe("OK");
      expect(a.delta).toMatchObject({ documentIntelligence: 1, blobWrites: 2, indexRuns: 1 });
      expect(b.delta).toMatchObject({ documentIntelligence: 0, blobWrites: 0, indexRuns: 0 });
      expect(c.delta).toMatchObject({ documentIntelligence: 0, blobWrites: 0, indexRuns: 1 });

      // Code interpreter: one OpenAI upload for the same bytes.
      const csv = Buffer.from(`col,nonce\n1,${nonce}\n`);
      const ci1 = await UploadFileForCodeInterpreterOnce(userId, { name: "smoke.csv", contentType: "text/csv", bytes: csv });
      const ci2 = await UploadFileForCodeInterpreterOnce(userId, { name: "smoke.csv", contentType: "text/csv", bytes: csv });
      if (ci1.status === "OK") {
        cleanups.push(() => DeleteFileFromCodeInterpreter(ci1.response.id));
      }
      console.log("[smoke] CSV 1st:", ci1.status === "OK" ? ci1.response : ci1);
      console.log("[smoke] CSV 2nd:", ci2.status === "OK" ? ci2.response : ci2);
      expect(ci1.status === "OK" && ci1.response.uploaded).toBe(true);
      expect(ci2.status === "OK" && ci2.response.uploaded).toBe(false);
      expect(ci2.status === "OK" && ci1.status === "OK" && ci2.response.id).toBe(
        ci1.status === "OK" ? ci1.response.id : ""
      );

      // Does this deployment take an OpenAI file id for a container file?
      if (ci1.status === "OK") {
        const { OpenAIV1Instance } = await import("@/features/common/services/openai");
        const openai = OpenAIV1Instance() as any;
        try {
          const created = await openai.containers.create({ name: `smoke-${nonce}` });
          cleanups.push(() => openai.containers.delete(created.id));
          const cf = await openai.containers.files.create(created.id, { file_id: ci1.response.id });
          console.log("[smoke] container file from file_id:", { id: cf?.id, path: cf?.path });
          // Paths of the files a container is created with (chat start).
          const withFiles = await openai.containers.create({
            name: `smoke-files-${nonce}`,
            file_ids: [ci1.response.id],
          });
          cleanups.push(() => openai.containers.delete(withFiles.id));
          const listed: Array<{ id?: string; path?: string }> = [];
          for await (const f of openai.containers.files.list(withFiles.id)) listed.push(f);
          console.log("[smoke] container created with file_ids:", listed.map((f) => f.path));
        } catch (e: any) {
          console.log("[smoke] container file from file_id failed:", e?.status, e?.message);
        }
      }

      console.log("[smoke] totals:", JSON.stringify(counts));
    },
    240_000
  );
});
