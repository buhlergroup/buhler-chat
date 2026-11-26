import { describe, it, expect, vi, beforeEach } from "vitest";

// Hoist blob storage mocks
const {
  mockUploadData,
  mockDownload,
  mockGetBlockBlobClient,
  mockGetContainerClient,
  MockBlobServiceClient,
  MockRestError,
} = vi.hoisted(() => {
  const mockUploadData = vi.fn();
  const mockDownload = vi.fn();
  const mockUrl = "https://teststorage.blob.core.windows.net/container/blob";
  const mockGetBlockBlobClient = vi.fn(() => ({
    uploadData: mockUploadData,
    download: mockDownload,
    url: mockUrl,
  }));
  const mockGetContainerClient = vi.fn(() => ({
    getBlockBlobClient: mockGetBlockBlobClient,
  }));
  const MockBlobServiceClient = vi.fn().mockImplementation(function () {
    return { getContainerClient: mockGetContainerClient };
  });

  class MockRestError extends Error {
    statusCode: number;
    constructor(message: string, statusCode: number) {
      super(message);
      this.name = "RestError";
      this.statusCode = statusCode;
    }
  }

  return { mockUploadData, mockDownload, mockGetBlockBlobClient, mockGetContainerClient, MockBlobServiceClient, MockRestError };
});

vi.mock("@azure/storage-blob", () => ({
  BlobServiceClient: MockBlobServiceClient,
  RestError: MockRestError,
}));

vi.mock("@/features/common/services/azure-default-credential", () => ({
  getAzureDefaultCredential: vi.fn(() => ({})),
}));

// Logger mock
vi.mock("./logger", () => ({
  logInfo: vi.fn(),
  logError: vi.fn(),
  logWarn: vi.fn(),
  logDebug: vi.fn(),
}));

describe("common.unit.azure-storage — UploadBlob", () => {
  beforeEach(() => {
    vi.resetModules();
    mockUploadData.mockReset();
    mockDownload.mockReset();
    vi.stubEnv("AZURE_STORAGE_ACCOUNT_NAME", "teststorage");
  });

  it("common.unit.azure-storage.001: returns OK with blob URL on success", async () => {
    mockUploadData.mockResolvedValue({ errorCode: undefined });
    const { UploadBlob } = await import("./azure-storage");
    const result = await UploadBlob("container", "blob.txt", Buffer.from("hello"));
    expect(result.status).toBe("OK");
    if (result.status === "OK") {
      expect(result.response).toContain("teststorage.blob.core.windows.net");
    }
  });

  it("common.unit.azure-storage.002: returns ERROR when response has errorCode set", async () => {
    mockUploadData.mockResolvedValue({ errorCode: "BlobNotFound" });
    const { UploadBlob } = await import("./azure-storage");
    const result = await UploadBlob("container", "blob.txt", Buffer.from("hello"));
    expect(result.status).toBe("ERROR");
    if (result.status === "ERROR") {
      expect(result.errors[0].message).toContain("BlobNotFound");
    }
  });

  it("common.unit.azure-storage.003: throws (rethrows) when uploadData throws", async () => {
    mockUploadData.mockRejectedValue(new Error("network error"));
    const { UploadBlob } = await import("./azure-storage");
    await expect(UploadBlob("container", "blob.txt", Buffer.from("hello"))).rejects.toThrow("network error");
  });

  it("common.unit.azure-storage.004: passes contentType as blobHTTPHeaders when provided", async () => {
    mockUploadData.mockResolvedValue({ errorCode: undefined });
    const { UploadBlob } = await import("./azure-storage");
    await UploadBlob("container", "image.png", Buffer.from("img"), { contentType: "image/png" });
    expect(mockUploadData).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        blobHTTPHeaders: { blobContentType: "image/png" },
      })
    );
  });

  it("common.unit.azure-storage.005: throws when AZURE_STORAGE_ACCOUNT_NAME is not set", async () => {
    vi.stubEnv("AZURE_STORAGE_ACCOUNT_NAME", "");
    const { UploadBlob } = await import("./azure-storage");
    await expect(UploadBlob("c", "b", Buffer.from("x"))).rejects.toThrow(
      "Azure Storage Account not configured correctly"
    );
  });
});

describe("common.unit.azure-storage — GetBlob", () => {
  beforeEach(() => {
    vi.resetModules();
    mockDownload.mockReset();
    vi.stubEnv("AZURE_STORAGE_ACCOUNT_NAME", "teststorage");
  });

  it("common.unit.azure-storage.006: returns OK with stream when download succeeds", async () => {
    const fakeStream = {};
    mockDownload.mockResolvedValue({
      readableStreamBody: fakeStream,
      contentType: "text/plain",
      metadata: { foo: "bar" },
    });
    const { GetBlob } = await import("./azure-storage");
    const result = await GetBlob("container", "blob.txt");
    expect(result.status).toBe("OK");
    if (result.status === "OK") {
      expect(result.response.stream).toBe(fakeStream);
      expect(result.response.contentType).toBe("text/plain");
    }
  });

  it("common.unit.azure-storage.007: returns ERROR when readableStreamBody is null", async () => {
    mockDownload.mockResolvedValue({ readableStreamBody: null });
    const { GetBlob } = await import("./azure-storage");
    const result = await GetBlob("container", "blob.txt");
    expect(result.status).toBe("ERROR");
  });

  it("common.unit.azure-storage.008: returns NOT_FOUND when download throws RestError 404", async () => {
    mockDownload.mockRejectedValue(new MockRestError("blob not found", 404));
    const { GetBlob } = await import("./azure-storage");
    const result = await GetBlob("container", "missing.txt");
    expect(result.status).toBe("NOT_FOUND");
    if (result.status === "NOT_FOUND") {
      expect(result.errors[0].message).toContain("missing.txt");
    }
  });

  it("common.unit.azure-storage.009: returns ERROR for non-404 RestError", async () => {
    mockDownload.mockRejectedValue(new MockRestError("server error", 500));
    const { GetBlob } = await import("./azure-storage");
    const result = await GetBlob("container", "blob.txt");
    expect(result.status).toBe("ERROR");
  });

  it("common.unit.azure-storage.010: returns ERROR for non-RestError exceptions", async () => {
    mockDownload.mockRejectedValue(new Error("unexpected error"));
    const { GetBlob } = await import("./azure-storage");
    const result = await GetBlob("container", "blob.txt");
    expect(result.status).toBe("ERROR");
  });
});

describe("common.unit.azure-storage — blob name guard", () => {
  beforeEach(() => {
    vi.resetModules();
    mockUploadData.mockReset();
    mockDownload.mockReset();
    mockGetBlockBlobClient.mockClear();
    vi.stubEnv("AZURE_STORAGE_ACCOUNT_NAME", "teststorage");
  });

  const UNSAFE = ["t/../agent-skills/p1/s.zip", "../x", "t/./x", "/t/x", "t\..\x", "t//x", "t/x\u0000", ""];

  it("UploadBlob refuses names with dot segments, backslashes or control characters", async () => {
    const { UploadBlob } = await import("./azure-storage");
    for (const name of UNSAFE) {
      const result = await UploadBlob("images", name, Buffer.from("x"));
      expect(result.status).toBe("ERROR");
    }
    expect(mockGetBlockBlobClient).not.toHaveBeenCalled();
    expect(mockUploadData).not.toHaveBeenCalled();
  });

  it("GetBlob and DeleteBlob refuse the same names", async () => {
    const { GetBlob, DeleteBlob } = await import("./azure-storage");
    for (const name of UNSAFE) {
      expect((await GetBlob("images", name)).status).toBe("ERROR");
      expect((await DeleteBlob("images", name)).status).toBe("ERROR");
    }
    expect(mockGetBlockBlobClient).not.toHaveBeenCalled();
  });

  it("still accepts multi-segment names such as skill packages", async () => {
    mockUploadData.mockResolvedValue({ errorCode: undefined });
    const { UploadBlob } = await import("./azure-storage");
    const result = await UploadBlob("images", "agent-skills/p1/s1-1.zip", Buffer.from("x"));
    expect(result.status).toBe("OK");
  });
});
