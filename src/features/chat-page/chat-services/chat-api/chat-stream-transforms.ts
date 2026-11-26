import "server-only";

import type { ToolSet } from "ai";
import { createImageGenerationStreamRewriter } from "./image-generation-stream-rewriter";
import { createCodeInterpreterStreamRewriter } from "./code-interpreter-stream-rewriter";
import { createSandboxUrlTransform } from "./sandbox-url-transform";

/**
 * The `experimental_transform` chain of /api/chat, in the order the route
 * runs it. Kept in one place so the route and its stream tests use the same
 * chain.
 *
 * The code-interpreter rewriter fills a shared map when it persists a data:
 * URL → blob ref; the sandbox text-delta transform reads that map to swap
 * matching data: URLs the model echoes in its prose.
 */
export function createChatStreamTransforms<TOOLS extends ToolSet>(
  threadId: string,
) {
  const dataUrlToBlobRef = new Map<string, string>();
  return [
    createImageGenerationStreamRewriter<TOOLS>(threadId),
    createCodeInterpreterStreamRewriter<TOOLS>(threadId, dataUrlToBlobRef),
    createSandboxUrlTransform<TOOLS>(threadId, dataUrlToBlobRef),
  ];
}
