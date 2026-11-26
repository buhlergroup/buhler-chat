import "server-only";

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { logInfo } from "@/features/common/services/logger";

/**
 * Path of the Copilot runtime binary to spawn, or undefined to let the SDK
 * find it (its platform package `@microsoft/copilot-sdk-<platform>`).
 *
 * Why this exists: the SDK runs the binary from the platform package in place
 * and chmods it when it is not executable. On App Service with
 * WEBSITE_RUN_FROM_PACKAGE the app files are a read-only mount, so a missing
 * exec bit cannot be fixed there. Then the package is copied once to a
 * writable temp directory and the copy is used.
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

  const version = readVersion(root);
  const target = path.join(os.tmpdir(), `copilot-runtime-${version}-${platform}`);
  const copied = path.join(target, wrapperRel);
  if (!isExecutable(copied)) {
    const staging = fs.mkdtempSync(path.join(os.tmpdir(), "copilot-runtime-staging-"));
    fs.cpSync(root, staging, { recursive: true });
    fs.chmodSync(path.join(staging, wrapperRel), 0o755);
    fs.rmSync(target, { recursive: true, force: true });
    fs.renameSync(staging, target);
    logInfo("copilot-runtime: copied the runtime to a writable directory", { target });
  }
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
