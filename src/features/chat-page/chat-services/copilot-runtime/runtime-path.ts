import "server-only";

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { logInfo, logWarn } from "@/features/common/services/logger";

/**
 * Directory owned by this app for the runtime's files (its config home and,
 * when needed, a copy of the binary): COPILOT_RUNTIME_HOME, else a per-user
 * folder in the temp directory. Created with mode 0700; on POSIX it must be
 * owned by this process's user and not be accessible to others (a folder
 * another user created first in a shared /tmp is refused).
 */
export function appRuntimeDir(...parts: string[]): string {
  const base =
    process.env.COPILOT_RUNTIME_HOME?.trim() ||
    path.join(os.tmpdir(), `chat-copilot-runtime-${typeof process.getuid === "function" ? process.getuid() : "user"}`);
  ensurePrivateDir(base);
  let dir = base;
  for (const part of parts) {
    dir = path.join(dir, part);
    ensurePrivateDir(dir);
  }
  return dir;
}

/** mkdir -m 0700, then check owner and mode (POSIX). Exported for tests. */
export function ensurePrivateDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (process.platform === "win32") return;
  const st = fs.lstatSync(dir);
  if (!st.isDirectory()) throw new Error(`Runtime directory is not a directory: ${dir}`);
  const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
  if (uid !== undefined && st.uid !== uid) throw new Error(`Runtime directory is owned by another user: ${dir}`);
  if ((st.mode & 0o077) !== 0) fs.chmodSync(dir, 0o700);
}

/** sha256 of a file (hex), read in 1 MB chunks (the binary is large). */
export function fileSha256(file: string): string {
  const hash = crypto.createHash("sha256");
  const buf = Buffer.alloc(1024 * 1024);
  const fd = fs.openSync(file, "r");
  try {
    for (let n = fs.readSync(fd, buf, 0, buf.length, null); n > 0; n = fs.readSync(fd, buf, 0, buf.length, null)) {
      hash.update(buf.subarray(0, n));
    }
  } finally {
    fs.closeSync(fd);
  }
  return hash.digest("hex");
}

/**
 * Path of the Copilot runtime binary to spawn, or undefined to let the SDK
 * find it (its platform package `@microsoft/copilot-sdk-<platform>`).
 *
 * Why this exists: the SDK runs the binary from the platform package in place
 * and chmods it when it is not executable. On App Service with
 * WEBSITE_RUN_FROM_PACKAGE the app files are a read-only mount, so a missing
 * exec bit cannot be fixed there. Then the package is copied once into the
 * app's private runtime directory (appRuntimeDir, 0700) and the copy is used.
 * A copy is reused only when its binary has the same sha256 as the package's.
 *
 * COPILOT_CLI_PATH still wins (an existing installation).
 */
export function resolveCopilotRuntimePath(): string | undefined {
  const explicit = process.env.COPILOT_CLI_PATH?.trim();
  if (explicit) return explicit;

  const platform = runtimePlatform();
  if (!platform) return undefined;
  const root = packageRoot(`@microsoft/copilot-sdk-${platform}`);
  if (!root) return undefined; // the SDK reports the missing package itself
  const wrapperRel = path.join("prebuilds", platform, platform.startsWith("win32") ? "copilot-runtime.exe" : "copilot-runtime");
  const wrapper = path.join(root, wrapperRel);
  if (process.platform === "win32" || isExecutable(wrapper)) return undefined;
  return copyRuntime(root, wrapperRel, appRuntimeDir("bin"), `${readVersion(root)}-${platform}`);
}

/**
 * Copies the runtime package into `binDir/<tag>` unless a verified copy is
 * there. Exported for tests.
 */
export function copyRuntime(root: string, wrapperRel: string, binDir: string, tag: string): string {
  const target = path.join(binDir, `copilot-runtime-${tag}`);
  const copied = path.join(target, wrapperRel);
  const expected = fileSha256(path.join(root, wrapperRel));
  if (isExecutable(copied)) {
    if (fileSha256(copied) === expected) return copied;
    logWarn("copilot-runtime: runtime copy does not match the package, copying again", { target });
  }
  const staging = fs.mkdtempSync(path.join(binDir, "staging-"));
  fs.cpSync(root, staging, { recursive: true });
  fs.chmodSync(path.join(staging, wrapperRel), 0o700);
  if (fileSha256(path.join(staging, wrapperRel)) !== expected) {
    fs.rmSync(staging, { recursive: true, force: true });
    throw new Error("Copilot runtime copy failed verification");
  }
  fs.rmSync(target, { recursive: true, force: true });
  fs.renameSync(staging, target);
  logInfo("copilot-runtime: copied the runtime to the app's runtime directory", { target });
  return copied;
}

function runtimePlatform(): string | undefined {
  const arch = process.arch;
  if (arch !== "x64" && arch !== "arm64") return undefined;
  if (process.platform === "linux") {
    const report = process.report?.getReport() as { header?: { glibcVersionRuntime?: string } } | undefined;
    const musl = report?.header?.glibcVersionRuntime === undefined;
    return `${musl ? "linuxmusl" : "linux"}-${arch}`;
  }
  if (process.platform === "darwin" || process.platform === "win32") return `${process.platform}-${arch}`;
  return undefined;
}

function packageRoot(name: string): string | undefined {
  // Resolve from the app directory (the standalone server runs with cwd = its own folder).
  const req = createRequire(path.join(process.cwd(), "noop.js"));
  try {
    return path.dirname(req.resolve(`${name}/package.json`));
  } catch {
    return undefined;
  }
}

function isExecutable(file: string): boolean {
  try {
    fs.accessSync(file, fs.constants.X_OK);
    return fs.statSync(file).size > 0;
  } catch {
    return false;
  }
}

function readVersion(root: string): string {
  try {
    return (JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")) as { version?: string }).version ?? "0";
  } catch {
    return "0";
  }
}
