import { describe, it, expect, vi } from "vitest";

vi.mock("@/features/common/services/logger", () => ({ logInfo: vi.fn(), logWarn: vi.fn(), logError: vi.fn() }));
vi.mock("@/features/common/services/openai", () => ({ OpenAIV1Instance: vi.fn() }));
vi.mock("@/features/common/services/azure-default-credential", () => ({ getAzureCognitiveServicesTokenProvider: vi.fn() }));
vi.mock("../chat-image-persistence-service", () => ({ persistBase64Image: vi.fn() }));
vi.mock("../code-interpreter-container", () => ({ ensureCodeInterpreterContainer: vi.fn() }));

import { ensureRunCodeContainer } from "./provider-clients";
import { unindexedUploadPaths } from "./search-documents-hint";

describe("ensureRunCodeContainer", () => {
  it("creates the container with the thread's files, reuses it while they stay, and replaces it when they change", async () => {
    let n = 0;
    const ensure = vi.fn(async (a: { existingContainerId?: string; fileIds: string[] }) => a.existingContainerId ?? `cntr_${++n}`);
    const first = await ensureRunCodeContainer("k1", "t1", ["f-code", "f-skill"], ensure);
    expect(ensure.mock.calls[0][0]).toMatchObject({ existingContainerId: undefined, fileIds: ["f-code", "f-skill"] });
    expect(await ensureRunCodeContainer("k1", "t1", ["f-skill", "f-code"], ensure)).toBe(first);
    const third = await ensureRunCodeContainer("k1", "t1", ["f-code"], ensure);
    expect(third).not.toBe(first);
    expect(ensure.mock.calls[2][0]).toMatchObject({ existingContainerId: undefined, fileIds: ["f-code"] });
  });

  it("runs without the files when the container cannot take them", async () => {
    const ensure = vi.fn(async (a: { fileIds: string[] }) => (a.fileIds.length ? undefined : "cntr_plain"));
    expect(await ensureRunCodeContainer("k2", "t2", ["gone"], ensure)).toBe("cntr_plain");
  });
});

describe("unindexedUploadPaths", () => {
  it("leaves out indexed uploads and their text extracts, newest first", () => {
    const at = (path: string, t: number) => ({ path, lastModified: new Date(t) });
    expect(
      unindexedUploadPaths(
        [at("/workspace/uploads/a.pdf", 1), at("/workspace/uploads/a.pdf.md", 2), at("/workspace/uploads/b.xlsx", 3), at("/workspace/outputs/c.png", 4)],
        new Set(["/workspace/uploads/a.pdf"]),
      ),
    ).toEqual(["/workspace/uploads/b.xlsx"]);
  });
});
