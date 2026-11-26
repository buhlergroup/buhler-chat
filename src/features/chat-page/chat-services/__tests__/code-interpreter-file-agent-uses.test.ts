// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from "vitest";

const owner = vi.hoisted(() => "e".repeat(64));

vi.mock("@/features/auth-page/helpers", () => ({
  userHashedId: vi.fn(async () => owner),
}));
vi.mock("@/features/common/services/logger", () => ({
  logWarn: vi.fn(),
  logError: vi.fn(),
  logInfo: vi.fn(),
  logDebug: vi.fn(),
}));

// The caller's threads and Code rows that list the file: one (the thread
// that asks for the delete).
const query = vi.fn();
vi.mock("@/features/common/services/cosmos", () => ({
  HistoryContainer: () => ({ items: { query } }),
}));

let nextId = 0;
vi.mock("@/features/common/services/openai", () => ({
  OpenAIV1Instance: () => ({
    files: {
      create: async () => ({ id: `file-${++nextId}` }),
      retrieve: async () => ({}),
    },
  }),
}));

import { countUsesOfCodeInterpreterFile } from "../code-interpreter-file-access";
import { UploadFileForCodeInterpreterOnce } from "../code-interpreter-service";
import { register, resolve, SERVICE_KEYS } from "@/features/common/services/service-container";
import {
  createMemoryContentBlobBackend,
  type MemoryContentBlobBackend,
} from "@/features/common/services/content-store/memory-backend";

const blobs = () => resolve<MemoryContentBlobBackend>(SERVICE_KEYS.contentBlobs);
const bytes = Buffer.from("a,b\n1,2\n");

const idOf = (res: Awaited<ReturnType<typeof UploadFileForCodeInterpreterOnce>>) => {
  if (res.status !== "OK" || !res.response.sha256) throw new Error("upload failed");
  return { id: res.response.id, sha256: res.response.sha256 };
};

beforeEach(() => {
  register(SERVICE_KEYS.contentBlobs, createMemoryContentBlobBackend);
  query.mockReset().mockReturnValue({ fetchAll: async () => ({ resources: [1] }) });
});

describe("chat-page.unit.ci-file-uses — agent files are never deleted for an upload", () => {
  it("the owner's upload and the agent file of the same bytes have different ids", async () => {
    const upload = idOf(await UploadFileForCodeInterpreterOnce(owner, { name: "n.csv", bytes }));
    const agent = idOf(
      await UploadFileForCodeInterpreterOnce(owner, { name: "n.csv", bytes, use: "agent" })
    );
    expect(agent.id).not.toBe(upload.id);
    // The upload's last thread may delete it; the agent file is never its own.
    expect(await countUsesOfCodeInterpreterFile(upload.id, upload.sha256)).toBe(1);
  });

  it("an id that is the agent file of the content counts one more use (kept)", async () => {
    const agent = idOf(
      await UploadFileForCodeInterpreterOnce(owner, { name: "n.csv", bytes, use: "agent" })
    );
    expect(await countUsesOfCodeInterpreterFile(agent.id, agent.sha256)).toBe(2);
  });

  it("older content (one id for both, no agent key): Code rows with the hash still count", async () => {
    const legacy = idOf(await UploadFileForCodeInterpreterOnce(owner, { name: "n.csv", bytes }));
    await countUsesOfCodeInterpreterFile(legacy.id, legacy.sha256);
    const spec = query.mock.calls[0][0] as { query: string; parameters: Array<{ name: string; value: string }> };
    expect(spec.query).toContain("r.type = @codeFileType AND r.sha256 = @sha256");
    expect(spec.parameters).toContainEqual({ name: "@sha256", value: legacy.sha256 });
  });

  it("a storage error while checking keeps the file", async () => {
    const upload = idOf(await UploadFileForCodeInterpreterOnce(owner, { name: "n.csv", bytes }));
    const head = vi.spyOn(blobs(), "head").mockRejectedValueOnce(new Error("storage down"));
    try {
      expect(await countUsesOfCodeInterpreterFile(upload.id, upload.sha256)).toBe(2);
    } finally {
      head.mockRestore();
    }
  });

  it("an entry without a hash (direct upload) is counted as before", async () => {
    expect(await countUsesOfCodeInterpreterFile("file-direct")).toBe(1);
  });
});
