// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/features/common/services/logger", () => ({
  logError: vi.fn(),
  logInfo: vi.fn(),
  logWarn: vi.fn(),
  logDebug: vi.fn(),
}));

const filesCreate = vi.fn(async (_body: unknown) => ({ id: `file-${filesCreate.mock.calls.length}` }));
vi.mock("@/features/common/services/openai", () => ({
  OpenAIV1Instance: () => ({
    files: { create: (body: unknown) => filesCreate(body), retrieve: async () => ({}) },
  }),
}));

import { UploadFileForCodeInterpreterOnce } from "../code-interpreter-service";
import { register, resolve, SERVICE_KEYS } from "@/features/common/services/service-container";
import {
  createMemoryContentBlobBackend,
  type MemoryContentBlobBackend,
} from "@/features/common/services/content-store/memory-backend";

const owner = "d".repeat(64);
const blobs = () => resolve<MemoryContentBlobBackend>(SERVICE_KEYS.contentBlobs);

beforeEach(() => {
  filesCreate.mockClear();
  register(SERVICE_KEYS.contentBlobs, createMemoryContentBlobBackend);
  vi.stubEnv("CONTENT_STORE_MAX_BUFFERED_BYTES", "16");
});

describe("chat-page.unit.ci-upload-once — buffer limit", () => {
  it("a buffer over CONTENT_STORE_MAX_BUFFERED_BYTES skips the content store", async () => {
    const res = await UploadFileForCodeInterpreterOnce(owner, {
      name: "big.csv",
      contentType: "text/csv",
      bytes: Buffer.alloc(17, 1),
    });
    expect(res.status).toBe("OK");
    expect(res.status === "OK" && res.response).toMatchObject({ uploaded: true });
    expect(res.status === "OK" && res.response.sha256).toBeUndefined();
    expect(blobs().stats.writes).toBe(0);
    expect(filesCreate).toHaveBeenCalledTimes(1);
  });

  it("a small buffer goes through the store: the second call reuses the file", async () => {
    const small = { name: "s.csv", contentType: "text/csv", bytes: Buffer.from("a,b\n") };
    const first = await UploadFileForCodeInterpreterOnce(owner, small);
    const second = await UploadFileForCodeInterpreterOnce(owner, small);
    expect(first.status === "OK" && first.response.uploaded).toBe(true);
    expect(second.status === "OK" && second.response.uploaded).toBe(false);
    expect(filesCreate).toHaveBeenCalledTimes(1);
  });

  it("an upload (Blob) of any size is streamed into the store", async () => {
    const res = await UploadFileForCodeInterpreterOnce(owner, {
      name: "big.csv",
      contentType: "text/csv",
      blob: new Blob([Buffer.alloc(64, 2)]),
    });
    expect(res.status === "OK" && res.response.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(blobs().stats.writes).toBe(1);
  });
});
