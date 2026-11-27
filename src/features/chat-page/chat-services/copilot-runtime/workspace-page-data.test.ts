// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("server-only", () => ({}));

const mockRuntime = vi.fn();
const mockSummary = vi.fn();
const mockConfigured = vi.fn();
const mockToolDefaults = vi.fn();

vi.mock("@/features/auth-page/helpers", () => ({ userHashedId: async () => "user-hash" }));
vi.mock("@/features/common/services/logger", () => ({ logWarn: vi.fn() }));
vi.mock("./runtime-selection", () => ({ resolveAgentRuntimeForCurrentUser: () => mockRuntime() }));
vi.mock("./workspace-files", () => ({
  copilotRuntimeConfigured: () => mockConfigured(),
  threadWorkspaceSummary: (...a: unknown[]) => mockSummary(...a),
}));

vi.mock("./tool-defaults", () => ({ copilotToolDefaults: () => mockToolDefaults() }));

import { FindWorkspaceSummaryForCurrentUser } from "./workspace-page-data";

const summary = {
  uploads: [{ path: "uploads/a.pdf", name: "a.pdf", size: 4, modified: "2026-01-01T00:00:00.000Z", group: "uploaded" }],
  fileCount: 3,
};

describe("FindWorkspaceSummaryForCurrentUser (chat page data)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockConfigured.mockReturnValue(true);
    mockRuntime.mockResolvedValue("copilot");
    mockSummary.mockResolvedValue(summary);
    mockToolDefaults.mockReturnValue({ webSearch: true, runCode: true });
  });

  it("gives the uploads, the file count and the paste limit of the thread on the Copilot path", async () => {
    expect(await FindWorkspaceSummaryForCurrentUser("thread1")).toEqual({
      ...summary,
      pastedTextLimitBytes: 16 * 1024,
      webSearchDefault: true,
      runCodeDefault: true,
    });
    expect(mockSummary).toHaveBeenCalledWith("user-hash", "thread1");
  });

  it("passes the server's Web / Code toggle defaults (tool-defaults.ts) to the page", async () => {
    mockToolDefaults.mockReturnValue({ webSearch: false, runCode: true });
    const page = await FindWorkspaceSummaryForCurrentUser("thread1");
    expect(page?.webSearchDefault).toBe(false);
    expect(page?.runCodeDefault).toBe(true);
  });

  it("the paste limit is the tool result inline limit (COPILOT_TOOL_RESULT_INLINE_BYTES)", async () => {
    vi.stubEnv("COPILOT_TOOL_RESULT_INLINE_BYTES", "5000");
    try {
      expect((await FindWorkspaceSummaryForCurrentUser("thread1"))?.pastedTextLimitBytes).toBe(5000);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("gives null on the AI SDK path, without a workspace read", async () => {
    mockRuntime.mockResolvedValue("ai-sdk");
    expect(await FindWorkspaceSummaryForCurrentUser("thread1")).toBeNull();
    expect(mockSummary).not.toHaveBeenCalled();
  });

  it("costs nothing in a deployment without the Copilot path", async () => {
    mockConfigured.mockReturnValue(false);
    expect(await FindWorkspaceSummaryForCurrentUser("thread1")).toBeNull();
    expect(mockRuntime).not.toHaveBeenCalled();
    expect(mockSummary).not.toHaveBeenCalled();
  });

  it("refuses an invalid thread id", async () => {
    expect(await FindWorkspaceSummaryForCurrentUser("../x")).toBeNull();
    expect(mockSummary).not.toHaveBeenCalled();
  });

  it("gives an empty workspace when the read fails", async () => {
    mockSummary.mockRejectedValue(new Error("blob down"));
    expect(await FindWorkspaceSummaryForCurrentUser("thread1")).toEqual({
      uploads: [],
      fileCount: 0,
      pastedTextLimitBytes: 16 * 1024,
      webSearchDefault: true,
      runCodeDefault: true,
    });
  });
});
