import { describe, it, expect, vi } from "vitest";

// The native regex engine cannot load (as with a build for another Node.js
// version): only the search calls may fail, not the module or other tools.
const re2Loads = vi.hoisted(() => ({ count: 0 }));
vi.mock("re2", () => {
  re2Loads.count++;
  throw new Error("re2.node was compiled against a different Node.js version (abi)");
});
const logError = vi.hoisted(() => vi.fn());
vi.mock("@/features/common/services/logger", () => ({ logDebug: vi.fn(), logInfo: vi.fn(), logWarn: vi.fn(), logError }));

import { sanitizeUiErrorText } from "../tools/tool-user-error";
import { BlobSessionFs } from "./blob-session-fs";
import { FakeBlobStore } from "./fake-blob-store.test-helper";
import { workspaceViewTool } from "./workspace-view";

const text = (r: { textResultForLlm: string }) => r.textResultForLlm;

async function workspace() {
  const fs = new BlobSessionFs(new FakeBlobStore(), "userA/thread1");
  await fs.writeFile("/workspace/a.txt", "alpha\n");
  return fs;
}

describe("workspace search without the re2 native addon", () => {
  it("the module loads; re2 is not loaded before a search runs", async () => {
    const mod = await import("./workspace-tools");
    expect(re2Loads.count).toBe(0);
    expect(mod.workspaceTools(await workspace(), "gpt").map((t) => t.name)).toEqual(["rg", "glob"]);
    expect(mod.literalGlobPrefix("notes/**/*.md")).toBe("notes/");
  });

  it("rg / grep / glob return the fixed text, do not throw, and the failure is logged once", async () => {
    const { runGlob, runRipgrep, workspaceTools, SEARCH_UNAVAILABLE_TEXT } = await import("./workspace-tools");
    const fs = await workspace();
    for (const res of [await runRipgrep(fs, { pattern: "alpha" }), await runGlob(fs, { pattern: "*.txt" })]) {
      expect(res.resultType).toBe("failure");
      expect(text(res)).toBe(SEARCH_UNAVAILABLE_TEXT);
    }
    const onError = vi.fn();
    for (const family of ["gpt", "claude"] as const) {
      for (const tool of workspaceTools(fs, family, { onError })) {
        const res = (await tool.handler({ pattern: "alpha" }, { toolCallId: "c1" } as never)) as {
          textResultForLlm: string;
          resultType: string;
          error?: string;
          skipLargeOutputProcessing?: boolean;
        };
        expect(res.resultType, tool.name).toBe("failure");
        expect(res.textResultForLlm, tool.name).toBe(SEARCH_UNAVAILABLE_TEXT);
        expect(res.skipLargeOutputProcessing).toBe(true);
        // The chat shows the same short text (nothing to clean in it).
        expect(sanitizeUiErrorText(res.error ?? "")).toBe(SEARCH_UNAVAILABLE_TEXT);
      }
    }
    expect(onError).not.toHaveBeenCalled();
    // One load attempt within the retry interval, one log line.
    expect(re2Loads.count).toBe(1);
    expect(logError).toHaveBeenCalledTimes(1);
    // The message only (vitest wraps the factory's error in its own).
    expect(logError.mock.calls[0][1]).toEqual({ error: expect.any(String) });
  });

  it("the other workspace tools still work", async () => {
    const fs = await workspace();
    const view = workspaceViewTool(fs, "gpt");
    const res = (await view.handler({ path: "/workspace/a.txt" }, { toolCallId: "c2" } as never)) as {
      textResultForLlm: string;
      resultType: string;
    };
    expect(res.resultType).toBe("success");
    expect(text(res)).toBe("alpha\n");
  });
});
