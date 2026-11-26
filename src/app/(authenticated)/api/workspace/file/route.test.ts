import { describe, it, expect, vi } from "vitest";

vi.mock("@/features/chat-page/chat-services/copilot-runtime/workspace-file-api", () => ({
  WorkspaceFileAPIEntry: vi.fn(),
}));

import { WorkspaceFileAPIEntry } from "@/features/chat-page/chat-services/copilot-runtime/workspace-file-api";
import { GET } from "./route";

describe("/api/workspace/file route", () => {
  it("GET delegates to WorkspaceFileAPIEntry and forwards its response", async () => {
    const response = new Response("bytes", { status: 200 });
    vi.mocked(WorkspaceFileAPIEntry).mockResolvedValue(response);
    const req = new Request("http://localhost/api/workspace/file?t=thread1&p=out%2Fa.csv");
    expect(await GET(req)).toBe(response);
    expect(WorkspaceFileAPIEntry).toHaveBeenCalledWith(req);
  });
});
