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

describe("chat-page.unit.ci-upload-once — content store failure falls back", () => {
  const small = { name: "s.csv", contentType: "text/csv", bytes: Buffer.from("a,b\n") };

  async function withStore(patch: Record<string, unknown>) {
    const { contentStore } = await import("@/features/common/services/content-store");
    const store = contentStore() as unknown as Record<string, unknown>;
    const originals: Record<string, unknown> = {};
    for (const k of Object.keys(patch)) originals[k] = store[k];
    Object.assign(store, patch);
    return () => Object.assign(store, originals);
  }

  it("put throws: the bytes are uploaded directly and OK is returned without sha256", async () => {
    const restore = await withStore({ put: async () => { throw new Error("store down"); } });
    try {
      const res = await UploadFileForCodeInterpreterOnce(owner, small);
      expect(res.status).toBe("OK");
      expect(res.status === "OK" && res.response).toMatchObject({ name: "s.csv", uploaded: true });
      expect(res.status === "OK" && res.response.sha256).toBeUndefined();
      expect(filesCreate).toHaveBeenCalledTimes(1);
    } finally {
      restore();
    }
  });

  it("putBlob throws: the Blob is uploaded directly (not buffered)", async () => {
    const restore = await withStore({ putBlob: async () => { throw new Error("store down"); } });
    try {
      const res = await UploadFileForCodeInterpreterOnce(owner, {
        name: "b.csv",
        contentType: "text/csv",
        blob: new Blob(["a,b\n"]),
      });
      expect(res.status).toBe("OK");
      expect(res.status === "OK" && res.response.sha256).toBeUndefined();
      expect(filesCreate).toHaveBeenCalledTimes(1);
    } finally {
      restore();
    }
  });

  it("openAiFile throws: same fallback", async () => {
    const restore = await withStore({ openAiFile: async () => { throw new Error("blob metadata"); } });
    try {
      const res = await UploadFileForCodeInterpreterOnce(owner, small);
      expect(res.status).toBe("OK");
      expect(res.status === "OK" && res.response).toMatchObject({ uploaded: true });
      expect(filesCreate).toHaveBeenCalledTimes(1);
    } finally {
      restore();
    }
  });

  it("the direct upload throws too: ERROR", async () => {
    const restore = await withStore({ put: async () => { throw new Error("store down"); } });
    filesCreate.mockRejectedValueOnce(new Error("openai down"));
    try {
      const res = await UploadFileForCodeInterpreterOnce(owner, small);
      expect(res.status).toBe("ERROR");
    } finally {
      restore();
    }
  });

  it("normal path: the store is used and sha256 is returned", async () => {
    const res = await UploadFileForCodeInterpreterOnce(owner, small);
    expect(res.status === "OK" && res.response.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(blobs().stats.writes).toBe(1);
  });
});

describe("chat-page.unit.ci-upload-once — agent files and orphans", () => {
  const nameOf = (call: unknown[]) => ((call[0] as { file: File }).file as File).name;

  it("an agent file gets its own OpenAI file, never the one of the same upload", async () => {
    const bytes = Buffer.from("x,y\n");
    const upload = await UploadFileForCodeInterpreterOnce(owner, { name: "d.csv", bytes });
    const agent = await UploadFileForCodeInterpreterOnce(owner, { name: "d.csv", bytes, use: "agent" });
    const agentAgain = await UploadFileForCodeInterpreterOnce(owner, { name: "d.csv", bytes, use: "agent" });
    expect(upload.status === "OK" && agent.status === "OK").toBe(true);
    if (upload.status !== "OK" || agent.status !== "OK" || agentAgain.status !== "OK") return;
    expect(agent.response.id).not.toBe(upload.response.id);
    expect(agentAgain.response).toMatchObject({ id: agent.response.id, uploaded: false });
    expect(filesCreate).toHaveBeenCalledTimes(2);
  });

  it("a long file name is capped before the upload and in the answer", async () => {
    const res = await UploadFileForCodeInterpreterOnce(owner, {
      name: `${"n".repeat(9000)}.csv`,
      contentType: "text/csv",
      blob: new Blob(["a,b\n"]),
    });
    expect(res.status).toBe("OK");
    if (res.status !== "OK") return;
    expect(res.response.name).toHaveLength(255);
    expect(res.response.name.endsWith(".csv")).toBe(true);
    expect(nameOf(filesCreate.mock.calls[0])).toBe(res.response.name);
  });

  it("the metadata write fails after the upload: the id is used, no second upload", async () => {
    const setMetadata = vi
      .spyOn(blobs(), "setMetadata")
      .mockRejectedValue(Object.assign(new Error("metadata too large"), { statusCode: 400 }));
    try {
      const res = await UploadFileForCodeInterpreterOnce(owner, {
        name: "m.csv",
        contentType: "text/csv",
        bytes: Buffer.from("m\n"),
      });
      expect(res.status).toBe("OK");
      if (res.status !== "OK") return;
      expect(filesCreate).toHaveBeenCalledTimes(1);
      const created = await filesCreate.mock.results[0].value;
      expect(res.response).toMatchObject({ id: created.id, uploaded: true });
      expect(res.response.sha256).toMatch(/^[0-9a-f]{64}$/);
    } finally {
      setMetadata.mockRestore();
    }
  });
});
