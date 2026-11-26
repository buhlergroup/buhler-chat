import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// Every export of a "use server" module is a Server Action that any signed-in
// browser can call with its own arguments. These modules take thread ids, file
// names, bytes and file ids from their callers and do no ownership check of
// their own, so they must stay server-only helpers.
const SERVER_ONLY_MODULES = [
  "features/chat-page/chat-services/chat-image-service.ts",
  "features/chat-page/chat-services/chat-image-persistence-service.ts",
  "features/chat-page/chat-services/chat-file-store-ingest.ts",
  "features/chat-page/chat-services/code-interpreter-service.ts",
  "features/chat-page/chat-services/images-api.ts",
];

describe("chat-page.unit.server-only — storage and code interpreter helpers are not Server Actions", () => {
  it.each(SERVER_ONLY_MODULES)("%s has no \"use server\" directive and imports server-only", (file) => {
    // vitest runs from src/ (vitest.config.ts).
    const source = readFileSync(resolve(process.cwd(), file), "utf8");
    expect(source).not.toMatch(/^\s*(\/\/[^\n]*\n\s*)*["']use server["']/);
    expect(source).toMatch(/import "server-only";/);
  });
});
