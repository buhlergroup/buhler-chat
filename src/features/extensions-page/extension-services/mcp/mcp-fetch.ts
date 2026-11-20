import "server-only";

import { assertExtensionUrlAllowed } from "@/features/chat-page/chat-services/tools/extension-url-guard";

/** The fetch shape the MCP SDK transports and OAuth helpers accept. */
export type McpFetch = (url: string | URL, init?: RequestInit) => Promise<Response>;

export interface GuardedFetchOptions {
  /** Abort every request (headers AND body) after this many ms. */
  timeoutMs: number;
  /** Fail a response whose body grows past this many bytes. */
  maxResponseBytes: number;
  /** URL check run before each request. Default: the extension SSRF guard. */
  assertUrl?: (url: string) => Promise<unknown>;
  /** Underlying fetch. Default: global fetch. */
  baseFetch?: typeof fetch;
}

export class McpResponseTooLargeError extends Error {
  constructor(limit: number) {
    super(`MCP server response is larger than ${limit} bytes`);
    this.name = "McpResponseTooLargeError";
  }
}

const NULL_BODY_STATUSES = new Set([101, 204, 205, 304]);

/**
 * fetch for every request the MCP client makes: the MCP endpoint, the SSE
 * stream, and the OAuth discovery / registration / token endpoints.
 *
 *  - SSRF: each URL (including every redirect hop, which the SDK follows
 *    itself and only within the same origin) passes the extension URL guard:
 *    https only, no private, loopback, link-local or metadata addresses.
 *  - Redirects are never followed by fetch itself (`redirect: "manual"`).
 *  - A hard timeout covers the whole exchange, including a streamed body.
 *  - The body is cut off with an error once it passes `maxResponseBytes`.
 *
 * Known limit, shared with the HTTP extensions: the guard resolves DNS
 * before fetch resolves it again, so a DNS-rebinding host can in theory
 * answer differently the second time.
 */
export function createGuardedFetch(options: GuardedFetchOptions): McpFetch {
  const assertUrl = options.assertUrl ?? assertExtensionUrlAllowed;
  const baseFetch = options.baseFetch ?? fetch;

  return async (input, init) => {
    const url = typeof input === "string" ? input : input.href;
    await assertUrl(url);

    const timeout = AbortSignal.timeout(options.timeoutMs);
    const signal = init?.signal ? AbortSignal.any([init.signal, timeout]) : timeout;

    const response = await baseFetch(url, {
      ...init,
      signal,
      redirect: "manual",
      cache: "no-store",
    });

    if (!response.body || NULL_BODY_STATUSES.has(response.status)) {
      return response;
    }

    const declared = Number(response.headers.get("content-length"));
    if (Number.isFinite(declared) && declared > options.maxResponseBytes) {
      await response.body.cancel().catch(() => {});
      throw new McpResponseTooLargeError(options.maxResponseBytes);
    }

    let received = 0;
    const limit = options.maxResponseBytes;
    const limited = response.body.pipeThrough(
      new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, controller) {
          received += chunk.byteLength;
          if (received > limit) {
            controller.error(new McpResponseTooLargeError(limit));
            return;
          }
          controller.enqueue(chunk);
        },
      })
    );

    const wrapped = new Response(limited, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
    // Keep the final URL for the SDK's redirect messages.
    Object.defineProperty(wrapped, "url", { value: response.url });
    return wrapped;
  };
}
