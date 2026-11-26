// @vitest-environment node
/**
 * Peak RSS of storing one large upload in the content store, against DEV
 * Blob Storage. Skipped unless CONTENT_STORE_MEMORY_SMOKE is "buffered" or
 * "stream"; run each mode in its own process:
 *
 *   CONTENT_STORE_MEMORY_SMOKE=buffered npx vitest run __tests__/dev-smoke/content-store-memory
 *   CONTENT_STORE_MEMORY_SMOKE=stream   npx vitest run __tests__/dev-smoke/content-store-memory
 *
 * The upload is a File held in memory, as the route gets it from
 * request.formData(). "buffered" copies it into one Buffer and stores that
 * (the first version of the code interpreter upload); "stream" stores the
 * File with putBlob. The blob goes to its own scope and is deleted after.
 * CONTENT_STORE_MEMORY_MB sets the size (default 200).
 */
import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import path from "node:path";

const MODE = process.env.CONTENT_STORE_MEMORY_SMOKE;
const MB = Number(process.env.CONTENT_STORE_MEMORY_MB) || 200;

const loadDevEnv = () => {
  const file = path.resolve(__dirname, "../../.env.local");
  if (!existsSync(file)) throw new Error("src/.env.local is missing");
  for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (m) process.env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, "$2");
  }
};

describe.skipIf(MODE !== "buffered" && MODE !== "stream")("content store memory smoke", () => {
  it(
    `stores a ${MB} MB upload (${MODE})`,
    async () => {
      loadDevEnv();
      const { register, SERVICE_KEYS } = await import("@/features/common/services/service-container");
      const { createAzureContentBlobBackend } = await import(
        "@/features/common/services/content-store/azure-blob-backend"
      );
      const backend = createAzureContentBlobBackend();
      register(SERVICE_KEYS.contentBlobs, () => backend);
      const { createContentStore } = await import("@/features/common/services/content-store/content-store");
      const store = createContentStore({
        blobs: backend,
        openAiFiles: () => {
          throw new Error("not used");
        },
      });

      // The upload as the route holds it. Random bytes: a fresh hash per run.
      const parts: Buffer[] = [];
      for (let i = 0; i < MB; i++) parts.push(randomBytes(1024 * 1024));
      const file = new File(parts, "large.bin", { type: "application/octet-stream" });
      parts.length = 0;
      (globalThis as { gc?: () => void }).gc?.();
      await new Promise((r) => setTimeout(r, 500));

      const scope = `memsmoke-${Date.now()}`;
      const baseline = process.memoryUsage().rss;
      let peak = baseline;
      const timer = setInterval(() => {
        peak = Math.max(peak, process.memoryUsage().rss);
      }, 10);
      const started = Date.now();
      let blobKey = "";
      try {
        if (MODE === "buffered") {
          const bytes = Buffer.from(await file.arrayBuffer());
          blobKey = (await store.put(scope, bytes)).blobKey;
        } else {
          blobKey = (await store.putBlob(scope, file)).blobKey;
        }
      } finally {
        clearInterval(timer);
        peak = Math.max(peak, process.memoryUsage().rss);
        if (blobKey) await backend.delete(blobKey);
      }
      const toMb = (n: number) => Math.round(n / (1024 * 1024));
      console.log(
        `[memory-smoke] mode=${MODE} size=${MB}MB baselineRss=${toMb(baseline)}MB peakRss=${toMb(peak)}MB ` +
          `peakOverBaseline=${toMb(peak - baseline)}MB seconds=${((Date.now() - started) / 1000).toFixed(1)}`
      );
      expect(blobKey).toMatch(/^content\/memsmoke-/);
    },
    600_000
  );
});
