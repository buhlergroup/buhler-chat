// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/features/common/services/logger", () => ({
  logError: vi.fn(),
  logInfo: vi.fn(),
  logWarn: vi.fn(),
  logDebug: vi.fn(),
}));

const mockContainerContent = vi.fn();
const mockFileRetrieve = vi.fn();
const mockFileContent = vi.fn();
vi.mock("@/features/common/services/openai", () => ({
  OpenAIV1Instance: () => ({
    containers: { files: { content: { retrieve: (...a: unknown[]) => mockContainerContent(...a) } } },
    files: {
      retrieve: (...a: unknown[]) => mockFileRetrieve(...a),
      content: (...a: unknown[]) => mockFileContent(...a),
    },
  }),
}));

import {
  DownloadContainerFile,
  DownloadFileFromCodeInterpreter,
} from "../code-interpreter-service";

describe("code-interpreter-service — content types of downloaded files", () => {
  beforeEach(() => {
    mockContainerContent.mockReset();
    mockFileRetrieve.mockReset();
    mockFileContent.mockReset();
  });

  it("never takes the upstream content type for an unknown extension (svg)", async () => {
    mockContainerContent.mockResolvedValue(
      new Response("<svg/>", { headers: { "content-type": "image/svg+xml" } })
    );
    const res = await DownloadContainerFile("cntr_1", "cfile_1", "x.svg");
    expect(res.status).toBe("OK");
    if (res.status === "OK") expect(res.response.contentType).toBe("application/octet-stream");
  });

  it("maps html to application/octet-stream and keeps png", async () => {
    mockContainerContent.mockResolvedValue(new Response("<html/>", { headers: { "content-type": "text/html" } }));
    const html = await DownloadContainerFile("cntr_1", "cfile_1", "page.html");
    if (html.status === "OK") expect(html.response.contentType).toBe("application/octet-stream");

    mockContainerContent.mockResolvedValue(new Response("png"));
    const png = await DownloadContainerFile("cntr_1", "cfile_2", "chart.PNG");
    if (png.status === "OK") expect(png.response.contentType).toBe("image/png");
  });

  it("DownloadFileFromCodeInterpreter maps svg to application/octet-stream", async () => {
    mockFileRetrieve.mockResolvedValue({ filename: "x.svg" });
    mockFileContent.mockResolvedValue(new Response("<svg/>"));
    const res = await DownloadFileFromCodeInterpreter("file-1");
    expect(res.status).toBe("OK");
    if (res.status === "OK") expect(res.response.contentType).toBe("application/octet-stream");
  });
});
