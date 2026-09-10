import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/features/common/services/logger", () => ({
  logError: vi.fn(),
  logInfo: vi.fn(),
  logWarn: vi.fn(),
  logDebug: vi.fn(),
}));

const mockCreate = vi.fn();
let clientOverride: unknown = undefined;
vi.mock("@/features/common/services/openai", () => ({
  OpenAIV1Instance: () =>
    clientOverride ?? { containers: { create: (...a: unknown[]) => mockCreate(...(a as [])) } },
}));

import { ensureCodeInterpreterContainer } from "./code-interpreter-container";

describe("ensureCodeInterpreterContainer", () => {
  beforeEach(() => {
    mockCreate.mockReset();
    clientOverride = undefined;
  });

  it("returns the existing container without calling the API", async () => {
    const id = await ensureCodeInterpreterContainer({
      threadId: "t1",
      existingContainerId: "cntr_existing",
      fileIds: ["file-1"],
    });
    expect(id).toBe("cntr_existing");
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it("creates a container named after the thread with an explicit idle window", async () => {
    mockCreate.mockResolvedValue({ id: "cntr_new" });
    const id = await ensureCodeInterpreterContainer({
      threadId: "t1",
      fileIds: [],
    });
    expect(id).toBe("cntr_new");
    expect(mockCreate).toHaveBeenCalledWith({
      name: "chat-t1",
      expires_after: { anchor: "last_active_at", minutes: 20 },
    });
  });

  it("attaches the turn's files, deduped and sorted so the call is deterministic", async () => {
    mockCreate.mockResolvedValue({ id: "cntr_new" });
    await ensureCodeInterpreterContainer({
      threadId: "t1",
      fileIds: ["file-b", "file-a", "file-b"],
    });
    expect(mockCreate).toHaveBeenCalledWith(
      expect.objectContaining({ file_ids: ["file-a", "file-b"] }),
    );
  });

  it("returns undefined when the create call rejects, so the caller can fall back (negative)", async () => {
    mockCreate.mockRejectedValue(new Error("containers unavailable"));
    await expect(
      ensureCodeInterpreterContainer({ threadId: "t1", fileIds: [] }),
    ).resolves.toBeUndefined();
  });

  it("returns undefined when the API answers without an id (negative)", async () => {
    mockCreate.mockResolvedValue({});
    await expect(
      ensureCodeInterpreterContainer({ threadId: "t1", fileIds: [] }),
    ).resolves.toBeUndefined();
  });

  it("returns undefined when the client has no containers API at all (negative)", async () => {
    clientOverride = {};
    await expect(
      ensureCodeInterpreterContainer({ threadId: "t1", fileIds: [] }),
    ).resolves.toBeUndefined();
  });
});
