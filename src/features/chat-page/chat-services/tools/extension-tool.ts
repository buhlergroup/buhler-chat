import "server-only";

import { tool, jsonSchema } from "ai";
import { userHashedId } from "@/features/auth-page/helpers";
import { logDebug, logError } from "@/features/common/services/logger";
import type { ExtensionModel, ExtensionFunctionModel } from "@/features/extensions-page/extension-services/models";
import type { Tool } from "@ai-sdk/provider-utils";
import { assertExtensionUrlAllowed } from "./extension-url-guard";
import { buildExtensionUrl } from "./extension-url-builder";

/** Redirect hops an extension call may follow (same origin only). */
export const MAX_EXTENSION_REDIRECTS = 3;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

/** The SSRF guard or the redirect rules refused a request. */
export class ExtensionRequestRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ExtensionRequestRefusedError";
  }
}

/**
 * fetch for an extension call. Redirects are never followed by fetch itself
 * (`redirect: "manual"`). A redirect is followed here only to an https URL
 * of the same origin (the same rule the MCP client uses), the SSRF guard runs
 * again on every hop, and at most MAX_EXTENSION_REDIRECTS hops are taken. So
 * the header secrets never go to another host.
 */
export async function fetchExtensionUrl(
  url: string,
  init: RequestInit,
  assertUrl: (url: string) => Promise<unknown> = assertExtensionUrlAllowed
): Promise<Response> {
  let current = url;
  let currentInit: RequestInit = { ...init, redirect: "manual" };
  for (let hop = 0; ; hop++) {
    try {
      await assertUrl(current);
    } catch (err) {
      throw new ExtensionRequestRefusedError(err instanceof Error ? err.message : String(err));
    }
    const response = await fetch(current, currentInit);
    if (!REDIRECT_STATUSES.has(response.status)) return response;

    await response.body?.cancel().catch(() => {});
    if (hop >= MAX_EXTENSION_REDIRECTS) {
      throw new ExtensionRequestRefusedError("Extension endpoint redirected too many times");
    }
    const location = response.headers.get("location");
    if (!location) {
      throw new ExtensionRequestRefusedError("Extension endpoint sent a redirect without a location");
    }
    let next: URL;
    try {
      next = new URL(location, current);
    } catch {
      throw new ExtensionRequestRefusedError("Extension endpoint sent an invalid redirect location");
    }
    if (next.protocol !== "https:") {
      throw new ExtensionRequestRefusedError("Extension endpoint redirected to a non-https URL");
    }
    if (next.origin !== new URL(current).origin) {
      throw new ExtensionRequestRefusedError("Extension endpoint redirected to another origin");
    }
    const method = (currentInit.method ?? "GET").toUpperCase();
    if (
      response.status === 303 ? method !== "HEAD" : (response.status === 301 || response.status === 302) && method === "POST"
    ) {
      currentInit = { ...currentInit, method: "GET", body: undefined };
    }
    current = next.href;
  }
}

export interface ExtensionToolOptions {
  extension: ExtensionModel;
  /** Header key→value secrets already resolved from Key Vault. */
  headerSecrets: Record<string, string>;
}

/**
 * Wraps one ExtensionFunctionModel entry as an AI SDK v5 Tool.
 *
 * The JSON Schema embedded in functionDef.code is lifted via `jsonSchema()`
 * so the AI SDK can present it to the provider without requiring a Zod schema.
 *
 * Note: jsonSchema() performs NO runtime validation by default — it passes the
 * raw schema straight to the model. This is intentional: extension schemas are
 * authored externally and may use constructs (e.g. $ref, allOf) that Zod cannot
 * represent. The absence of a validate callback means execute() receives `unknown`
 * input; we cast it to `any` and forward to the HTTP endpoint as-is.
 *
 * execute() throws on any HTTP error; the AI SDK emits a typed `tool-error` part.
 */
/**
 * Shape of arguments the model emits for an extension call. The JSON
 * Schema is externally-authored (extension-config) and not Zod-checked,
 * so this is the loosest sensible runtime contract:
 *   - `query`: a map of name → primitive that fills URL path/query holes
 *   - `body`: an arbitrary JSON-shaped object for non-GET methods
 */
interface ExtensionArgs {
  query?: Record<string, unknown>;
  body?: unknown;
}

function isExtensionArgs(value: unknown): value is ExtensionArgs {
  return typeof value === "object" && value !== null;
}

// True when the extension endpoint is this application's own /api/document
// route. The built-in "Azure AI Search" extension points there. Such calls run
// in-process (see execute below) instead of over the network: a server-to-server
// HTTP request would not carry the user session cookie, and /api/document is now
// behind the authentication middleware. In-process also removes a needless hop.
function isSelfDocumentEndpoint(rawUrl: string): boolean {
  try {
    const target = new URL(rawUrl);
    if (target.pathname !== "/api/document") return false;
    const base = process.env.NEXTAUTH_URL;
    if (!base) return false;
    return target.host === new URL(base).host;
  } catch {
    return false;
  }
}

export function extensionTool(
  functionDef: ExtensionFunctionModel,
  parsedFunction: { name: string; description: string; parameters: unknown },
  { extension, headerSecrets }: ExtensionToolOptions
): Tool {
  const schema = jsonSchema(parsedFunction.parameters as Record<string, unknown>);

  return tool({
    description: parsedFunction.description,
    inputSchema: schema,
    // The extension author writes the schema. Strict decoding would make the
    // model fill every optional field (see mcp-tool.ts), so it stays off.
    strict: false,
    execute: async (rawArgs: unknown, { abortSignal }: { abortSignal?: AbortSignal }) => {
      const args: ExtensionArgs = isExtensionArgs(rawArgs) ? rawArgs : {};
      logDebug("extensionTool: executing", {
        functionName: parsedFunction.name,
        argsKeys: Object.keys(args),
        extensionId: extension.id,
      });

      const userId = await userHashedId();

      const mergedHeaders: Record<string, string> = {
        "Content-Type": "application/json",
        ...headerSecrets,
        authorization: userId,
      };

      // Fill the endpoint template from the declared query keys only, and
      // keep the configured origin (see extension-url-builder.ts).
      let url: string;
      try {
        url = buildExtensionUrl(
          functionDef.endpoint,
          args.query,
          parsedFunction.parameters
        );
      } catch (err) {
        logError("extensionTool: URL rejected", {
          functionName: parsedFunction.name,
          extensionId: extension.id,
          reason: err instanceof Error ? err.message : String(err),
        });
        throw new Error(
          `Extension "${parsedFunction.name}" arguments are not allowed for its endpoint`
        );
      }
      const requestInit: RequestInit = {
        method: functionDef.endpointType,
        headers: mergedHeaders,
        cache: "no-store",
        signal: abortSignal,
      };

      // Handle body parameters
      const method = functionDef.endpointType;
      if (
        args.body !== undefined &&
        (method === "POST" || method === "PUT" || method === "PATCH")
      ) {
        requestInit.body = JSON.stringify(args.body);
      }

      // The built-in Azure AI Search extension targets this app's own
      // /api/document route. Run the handler in-process. See
      // isSelfDocumentEndpoint above for why this avoids the network hop and the
      // session-cookie problem.
      if (isSelfDocumentEndpoint(url)) {
        const { SearchAzureAISimilarDocuments } = await import(
          "@/features/chat-page/chat-services/chat-api/chat-api-rag-extension"
        );
        const internalRequest = new Request(url, {
          method: "POST",
          headers: mergedHeaders,
          body: requestInit.body ?? JSON.stringify(args.body ?? {}),
        });
        const internalResponse = await SearchAzureAISimilarDocuments(
          internalRequest
        );
        if (!internalResponse.ok) {
          logError("extensionTool: in-process document search failed", {
            functionName: parsedFunction.name,
            status: internalResponse.status,
          });
          throw new Error(
            `Extension "${parsedFunction.name}" failed with status ${internalResponse.status}`
          );
        }
        return await internalResponse.json();
      }

      // SSRF guard: refuse private/link-local/loopback addresses and
      // non-https schemes, on the first URL and on every redirect hop.
      // Without this check any user-authored extension could pivot to
      // internal services (Cosmos, Key Vault, Azure IMDS).
      let response: Response;
      try {
        response = await fetchExtensionUrl(url, requestInit);
      } catch (err) {
        if (!(err instanceof ExtensionRequestRefusedError)) throw err;
        logError("extensionTool: URL or redirect rejected", {
          functionName: parsedFunction.name,
          extensionId: extension.id,
          reason: err instanceof Error ? err.message : String(err),
        });
        throw new Error(
          `Extension "${parsedFunction.name}" endpoint is not allowed`
        );
      }

      if (!response.ok) {
        logError("extensionTool: HTTP error", {
          functionName: parsedFunction.name,
          status: response.status,
        });
        throw new Error(
          `Extension "${parsedFunction.name}" failed with status ${response.status}`
        );
      }

      const result = await response.json();
      return result;
    },
  });
}
