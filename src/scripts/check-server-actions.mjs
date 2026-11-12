#!/usr/bin/env node
// Checks that every Server Action in a production build resolves to a function.
//
// Run after `next build`:  npm run check:server-actions
//
// Why: a "use server" file that re-exports a binding it imported
// (`import { X } from "./a"; export { X };`) gets its own action id in the
// Turbopack production build, but the id resolves to `undefined` at runtime.
// The client then fails with `Cannot read properties of undefined (reading
// 'apply')` and the POST returns HTTP 500. The build itself does not report it.
//
// The check does what the Next runtime does when it dispatches an action:
// for each action id in build/server/server-reference-manifest.json and each
// page that uses it, it loads the worker module through the page's
// `__next_app__.require(moduleId)` and checks that `module[actionId]` is a
// function. Exit code 1 if one or more ids do not resolve.
//
// Usage: node scripts/check-server-actions.mjs [buildDir]   (default: build)

import { createRequire } from "node:module";
import { AsyncLocalStorage } from "node:async_hooks";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);

// The server bundles expect these globals, as `next start` sets them.
globalThis.AsyncLocalStorage ??= AsyncLocalStorage;
process.env.NODE_ENV = "production";

const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const buildDir = path.resolve(appDir, process.argv[2] ?? "build");
const serverDir = path.join(buildDir, "server");
const manifestPath = path.join(serverDir, "server-reference-manifest.json");

if (!existsSync(manifestPath)) {
  console.error(`check-server-actions: ${manifestPath} not found. Run "next build" first.`);
  process.exit(1);
}

// Page bundles resolve some paths relative to the app directory.
process.chdir(appDir);

const manifest = require(manifestPath);
const actions = Object.entries(manifest.node ?? {});

const appCache = new Map();
const loadApp = (workerKey) => {
  if (!appCache.has(workerKey)) {
    let app = null;
    let error = null;
    try {
      const mod = require(path.join(serverDir, `${workerKey}.js`));
      app = mod.__next_app__ ?? null;
      if (!app || typeof app.require !== "function") {
        error = "no __next_app__.require export";
        app = null;
      }
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }
    appCache.set(workerKey, { app, error });
  }
  return appCache.get(workerKey);
};

const failures = [];
let checked = 0;
let skipped = 0;

for (const [actionId, entry] of actions) {
  const name = entry.exportedName ?? "?";
  const file = entry.filename ?? "?";
  for (const [workerKey, worker] of Object.entries(entry.workers ?? {})) {
    // Next dispatches Server Actions only through pages. Route handlers
    // (route.js) list the actions they import but never dispatch them.
    if (!workerKey.endsWith("/page")) {
      skipped++;
      continue;
    }
    checked++;
    const { app, error } = loadApp(workerKey);
    if (!app) {
      failures.push({ actionId, name, file, workerKey, reason: `cannot load worker: ${error}` });
      continue;
    }
    try {
      const mod = await app.require(worker.moduleId);
      if (typeof mod?.[actionId] !== "function") {
        failures.push({ actionId, name, file, workerKey, reason: `resolves to ${typeof mod?.[actionId]}` });
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      failures.push({ actionId, name, file, workerKey, reason: `require failed: ${msg.slice(0, 200)}` });
    }
  }
}

console.log(
  `check-server-actions: ${actions.length} action ids, ${checked} (action, page) pairs checked, ` +
    `${skipped} route-handler pairs skipped, ${failures.length} not resolved`
);

if (failures.length > 0) {
  for (const f of failures) {
    console.error(`  NOT RESOLVED ${f.name} (${f.file}) in ${f.workerKey}: ${f.reason} [id ${f.actionId}]`);
  }
  console.error(
    'A "use server" file must export only the async functions it defines. ' +
      "Import shared actions from their own module instead of re-exporting them."
  );
  process.exit(1);
}

process.exit(0);
