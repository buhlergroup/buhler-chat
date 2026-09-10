import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/features/common/services/logger", () => ({
  logError: vi.fn(),
  logInfo: vi.fn(),
  logWarn: vi.fn(),
  logDebug: vi.fn(),
}));

const mockCreate = vi.fn();
const mockRetrieve = vi.fn();
let clientOverride: unknown = undefined;
vi.mock("@/features/common/services/openai", () => ({
  OpenAIV1Instance: () =>
    clientOverride ?? {
      containers: {
        create: (...a: unknown[]) => mockCreate(...(a as [])),
        retrieve: (...a: unknown[]) => mockRetrieve(...(a as [])),
      },
    },
}));

import { ensureCodeInterpreterContainer } from "./code-interpreter-container";

describe("ensureCodeInterpreterContainer", () => {
  beforeEach(() => {
    mockCreate.mockReset();
    mockRetrieve.mockReset();
    mockRetrieve.mockResolvedValue({ id: "cntr_existing", status: "running" });
    clientOverride = undefined;
  });

  it("reuses a stored container that is still alive, and mints nothing", async () => {
    const id = await ensureCodeInterpreterContainer({
      threadId: "t1",
      existingContainerId: "cntr_existing",
      fileIds: ["file-1"],
    });
    expect(id).toBe("cntr_existing");
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it("replaces a stored container that Azure has reclaimed", async () => {
    // The live defect: the id outlives the container, so a thread idle past
    // the window came back holding a dead id and every later turn failed on
    // "Container is expired." — for good, because nothing replaced it.
    mockRetrieve.mockRejectedValue(
      Object.assign(new Error("Container is expired."), { status: 404 }),
    );
    mockCreate.mockResolvedValue({ id: "cntr_fresh" });

    const id = await ensureCodeInterpreterContainer({
      threadId: "t1",
      existingContainerId: "cntr_dead",
      fileIds: [],
    });

    expect(id).toBe("cntr_fresh");
    expect(mockCreate).toHaveBeenCalledTimes(1);
  });

  it("replaces a container that answers with status expired", async () => {
    mockRetrieve.mockResolvedValue({ id: "cntr_dead", status: "expired" });
    mockCreate.mockResolvedValue({ id: "cntr_fresh" });

    const id = await ensureCodeInterpreterContainer({
      threadId: "t1",
      existingContainerId: "cntr_dead",
      fileIds: [],
    });

    expect(id).toBe("cntr_fresh");
  });

  it("keeps the stored id when the probe fails for any reason but absence", async () => {
    // A 500 or a network blip is not evidence the container is gone. Minting
    // on a transient error would churn the tool definition — the very prefix
    // instability this module exists to prevent — and bin a live working
    // directory.
    for (const err of [
      Object.assign(new Error("boom"), { status: 500 }),
      new Error("socket hang up"),
    ]) {
      mockCreate.mockReset();
      mockRetrieve.mockReset();
      mockRetrieve.mockRejectedValue(err);

      const id = await ensureCodeInterpreterContainer({
        threadId: "t1",
        existingContainerId: "cntr_maybe",
        fileIds: [],
      });

      expect(id).toBe("cntr_maybe");
      expect(mockCreate).not.toHaveBeenCalled();
    }
  });

  it("keeps the stored id on a surface with no retrieve method", async () => {
    clientOverride = {
      containers: { create: (...a: unknown[]) => mockCreate(...(a as [])) },
    };

    const id = await ensureCodeInterpreterContainer({
      threadId: "t1",
      existingContainerId: "cntr_unknowable",
      fileIds: [],
    });

    expect(id).toBe("cntr_unknowable");
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
