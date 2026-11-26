import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/features/common/services/logger", () => ({
  logInfo: vi.fn(),
  logDebug: vi.fn(),
  logError: vi.fn(),
  logWarn: vi.fn(),
}));

vi.mock("../chat-image-service", () => ({
  UploadImageToStore: vi.fn(),
  GetImageUrlPath: vi.fn(),
  GetImageUrl: vi.fn(),
}));

vi.mock("../code-interpreter-service", () => ({
  DownloadContainerFile: vi.fn(),
}));

// The ingest now delegates ALL blob-storage upload + reference building to
// persistBase64Image (the image service), so mocks live here. No URL or
// `blob://` string construction in the test itself — the helper hands the
// reference back, and we assert on what it returned.
const mockPersist = vi.fn();
vi.mock("../chat-image-persistence-service", () => ({
  persistBase64Image: (...a: unknown[]) => mockPersist(...a),
}));

import {
  ingestContainerFileSourceToChatStore,
  ingestImageGenerationResults,
} from "../chat-file-store-ingest";
import { GetImageUrlPath, UploadImageToStore } from "../chat-image-service";
import { DownloadContainerFile } from "../code-interpreter-service";
import { sandboxFallbackUrl } from "../chat-api/sandbox-rewrite-core";

const TINY_BASE64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==";
const BIG_BASE64 = "A".repeat(4096);

const FAKE_BLOB_REF = "blob://t1/fake-ref.png";

describe("ingestImageGenerationResults", () => {
  beforeEach(() => {
    mockPersist.mockReset();
    mockPersist.mockResolvedValue({ status: "OK", response: FAKE_BLOB_REF });
  });

  it("hands a bare-base64 image_generation result to persistBase64Image and uses the returned blob ref", async () => {
    const out = await ingestImageGenerationResults("t1", [
      {
        toolName: "image_generation",
        toolCallId: "call-1",
        output: { result: BIG_BASE64 },
      },
    ]);

    expect(mockPersist).toHaveBeenCalledTimes(1);
    const [threadId, dataUrl] = mockPersist.mock.calls[0];
    expect(threadId).toBe("t1");
    expect(dataUrl).toMatch(/^data:image\/png;base64,/);
    expect(out[0].output).toEqual({ result: FAKE_BLOB_REF });
  });

  it("passes a `data:image/jpeg;base64,...` result through to persistBase64Image untouched", async () => {
    const dataUrl = `data:image/jpeg;base64,${BIG_BASE64}`;
    await ingestImageGenerationResults("t1", [
      {
        toolName: "image_generation",
        toolCallId: "call-2",
        output: { result: dataUrl },
      },
    ]);
    expect(mockPersist).toHaveBeenCalledWith("t1", dataUrl);
  });

  it("passes existing `blob://...` references through without re-uploading", async () => {
    const original = {
      toolName: "image_generation",
      toolCallId: "call-3",
      output: { result: "blob://t1/already-persisted.png" },
    };
    const out = await ingestImageGenerationResults("t1", [original]);
    expect(mockPersist).not.toHaveBeenCalled();
    expect(out[0]).toBe(original);
  });

  it("leaves non-image_generation tool results untouched", async () => {
    const original = {
      toolName: "search_documents",
      toolCallId: "call-4",
      output: { result: BIG_BASE64 },
    };
    const out = await ingestImageGenerationResults("t1", [original]);
    expect(mockPersist).not.toHaveBeenCalled();
    expect(out[0]).toBe(original);
  });

  it("preserves results without a recognisable base64 payload", async () => {
    const out = await ingestImageGenerationResults("t1", [
      { toolName: "image_generation", toolCallId: "call-5", output: { result: TINY_BASE64 } },
      { toolName: "image_generation", toolCallId: "call-6", output: "not an object" },
      { toolName: "image_generation", toolCallId: "call-7", output: undefined },
    ]);
    expect(mockPersist).not.toHaveBeenCalled();
    expect(out).toHaveLength(3);
  });

  it("returns the original result when persistBase64Image fails", async () => {
    mockPersist.mockResolvedValueOnce({
      status: "ERROR",
      errors: [{ message: "blob storage down" }],
    });
    const original = {
      toolName: "image_generation",
      toolCallId: "call-8",
      output: { result: BIG_BASE64 },
    };
    const out = await ingestImageGenerationResults("t1", [original]);
    expect(out[0]).toBe(original);
  });

  it("processes multiple results in one call and preserves order", async () => {
    mockPersist
      .mockResolvedValueOnce({ status: "OK", response: "blob://t1/a.png" })
      .mockResolvedValueOnce({ status: "OK", response: "blob://t1/c.png" });
    const inputs = [
      { toolName: "image_generation", toolCallId: "a", output: { result: BIG_BASE64 } },
      { toolName: "search_documents", toolCallId: "b", output: { result: "doc" } },
      { toolName: "image_generation", toolCallId: "c", output: { result: BIG_BASE64 } },
    ];
    const out = await ingestImageGenerationResults("t1", inputs);
    expect(out).toHaveLength(3);
    expect((out[0].output as { result: string }).result).toBe("blob://t1/a.png");
    expect(out[1]).toBe(inputs[1]);
    expect((out[2].output as { result: string }).result).toBe("blob://t1/c.png");
  });

  it("the swapped result is small enough to fit comfortably in a Cosmos row", async () => {
    const out = await ingestImageGenerationResults("t1", [
      {
        toolName: "image_generation",
        toolCallId: "call-size",
        output: { result: BIG_BASE64 },
      },
    ]);
    const serialized = JSON.stringify(out[0]);
    expect(serialized.length).toBeLessThan(1024);
  });
});

describe("ingestContainerFileSourceToChatStore — blob name from the code interpreter", () => {
  const download = DownloadContainerFile as unknown as ReturnType<typeof vi.fn>;
  const upload = UploadImageToStore as unknown as ReturnType<typeof vi.fn>;
  const urlPath = GetImageUrlPath as unknown as ReturnType<typeof vi.fn>;

  const source = (filename: string) => ({
    type: "source" as const,
    sourceType: "document",
    id: "s1",
    mediaType: "application/octet-stream",
    title: filename,
    filename,
    providerMetadata: {
      openai: { type: "container_file_citation", fileId: "cfile_1", containerId: "cntr_1" },
    },
  });

  beforeEach(() => {
    download.mockReset();
    upload.mockReset();
    urlPath.mockReset();
    upload.mockResolvedValue({ status: "OK", response: "u" });
    urlPath.mockImplementation(async (t: string, n: string) => sandboxFallbackUrl(t, n));
  });

  it("stores a file whose name has .. and / under a safe single name, keeps the original as download name", async () => {
    const evil = "../../agent-skills/p1/s.svg";
    download.mockResolvedValue({
      status: "OK",
      response: { data: Buffer.from("<svg/>"), name: evil, contentType: "application/octet-stream" },
    });
    const res = await ingestContainerFileSourceToChatStore("t1", source(evil));
    expect(upload).toHaveBeenCalledTimes(1);
    const [threadId, blobName, , options] = upload.mock.calls[0];
    expect(threadId).toBe("t1");
    expect(blobName).toBe("s.svg");
    expect(options).toEqual({ contentType: "application/octet-stream", originalFileName: evil });
    // The map key stays the citation name; the URL matches the fallback URL.
    expect(res).toEqual({ filename: evil, url: sandboxFallbackUrl("t1", evil) });
    expect(res?.url).toBe("/api/images?t=t1&img=s.svg");
  });

  it("keeps a normal name unchanged", async () => {
    download.mockResolvedValue({
      status: "OK",
      response: { data: Buffer.from("a,b"), name: "chart.png", contentType: "image/png" },
    });
    const res = await ingestContainerFileSourceToChatStore("t1", source("chart.png"));
    expect(upload.mock.calls[0][1]).toBe("chart.png");
    expect(res?.url).toBe("/api/images?t=t1&img=chart.png");
  });
});
