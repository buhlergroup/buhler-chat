import { describe, it, expect, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

vi.mock("@/features/common/services/logger", () => ({ logInfo: vi.fn(), logWarn: vi.fn(), logError: vi.fn() }));

import { copyRuntime, ensurePrivateDir, fileSha256 } from "./runtime-path";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "rt-path-test-"));

describe("runtime binary copy", () => {
  it("copies once, reuses a verified copy, and replaces a tampered one", () => {
    const root = tmp();
    const bin = tmp();
    const rel = path.join("prebuilds", "x", "copilot-runtime");
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), "binary-v1");
    const copied = copyRuntime(root, rel, bin, "1.0.0-x");
    expect(fileSha256(copied)).toBe(fileSha256(path.join(root, rel)));
    const firstMtime = fs.statSync(copied).mtimeMs;
    // Same content: reused (on Windows X_OK is not meaningful, the hash check still runs).
    expect(copyRuntime(root, rel, bin, "1.0.0-x")).toBe(copied);
    // Tampered copy: copied again from the package.
    fs.writeFileSync(copied, "tampered");
    if (process.platform !== "win32") fs.chmodSync(copied, 0o700);
    copyRuntime(root, rel, bin, "1.0.0-x");
    expect(fs.readFileSync(copied, "utf8")).toBe("binary-v1");
    expect(fs.statSync(copied).mtimeMs).toBeGreaterThanOrEqual(firstMtime);
  });

  it.skipIf(process.platform === "win32")("the runtime directory is private (0700)", () => {
    const dir = path.join(tmp(), "home");
    fs.mkdirSync(dir, { mode: 0o777 });
    fs.chmodSync(dir, 0o777);
    ensurePrivateDir(dir);
    expect(fs.statSync(dir).mode & 0o777).toBe(0o700);
  });
});
