import { describe, it, expect, vi } from "vitest";

vi.mock("@/features/common/services/azure-storage", () => ({
  GetBlob: vi.fn(),
  UploadBlob: vi.fn(),
}));

import { GetThreadAndImageFromUrl } from "../chat-image-service";

const url = (t: string, img: string) =>
  `http://localhost/api/images?t=${encodeURIComponent(t)}&img=${encodeURIComponent(img)}`;

describe("GetThreadAndImageFromUrl — blob path guard", () => {
  it("accepts a normal thread image", async () => {
    const res = await GetThreadAndImageFromUrl(url("thread1", "image.png"));
    expect(res).toEqual({ status: "OK", response: { threadId: "thread1", imgName: "image.png" } });
  });

  it("refuses the agent skill packages that share the images container", async () => {
    expect((await GetThreadAndImageFromUrl(url("agent-skills", "p1/s1-1.zip"))).status).toBe("ERROR");
    expect((await GetThreadAndImageFromUrl(url("agent-skills/p1", "s1-1.zip"))).status).toBe("ERROR");
  });

  it("refuses dot segments that could steer the blob path", async () => {
    expect((await GetThreadAndImageFromUrl(url("thread1", "../agent-skills/p1/s.zip"))).status).toBe("ERROR");
    expect((await GetThreadAndImageFromUrl(url("thread1", "..\\agent-skills\\p1\\s.zip"))).status).toBe("ERROR");
    expect((await GetThreadAndImageFromUrl(url(".", "x.png"))).status).toBe("ERROR");
  });
});
