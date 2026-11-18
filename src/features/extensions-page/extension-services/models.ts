import { refineFromEmpty } from "@/features/common/schema-validation";
import { z } from "zod";

export const EXTENSION_ATTRIBUTE = "EXTENSION";

export type ExtensionModel = z.infer<typeof ExtensionModelSchema>;
export type ExtensionFunctionModel = z.infer<typeof ExtensionFunctionSchema>;
export type HeaderModel = z.infer<typeof HeaderSchema>;

export const HeaderSchema = z.object({
  id: z.string(),
  key: z
    .string()
    .min(1, {
      message: "Header key cannot be empty",
    })
    .refine(refineFromEmpty, "Header key cannot be empty"),
  value: z
    .string()
    .min(1, {
      message: "Header value cannot be empty",
    })
    .refine(refineFromEmpty, "Header value cannot be empty"),
});

export type EndpointType = z.infer<typeof EndpointTypeSchema>;

export const EndpointTypeSchema = z.enum([
  "GET",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
]);

export const ExtensionFunctionSchema = z.object({
  id: z.string({ error: "Function ID is required" }),
  functionName: z
    .string()
    .min(1, {
      message: "Function name cannot be empty",
    })
    .refine(refineFromEmpty, "Function name cannot be empty"),
  code: z
    .string()
    .min(1, {
      message: "Function code cannot be empty",
    })
    .refine(refineFromEmpty, "Function code cannot be empty"),
  endpoint: z
    .string()
    .min(1, {
      message: "Function endpoint cannot be empty",
    })
    .refine(refineFromEmpty, "Function endpoint cannot be empty"),
  endpointType: EndpointTypeSchema,
  isOpen: z.boolean(),
});

export type ExtensionKind = z.infer<typeof ExtensionKindSchema>;
/** "http": the classic extension (functions + endpoints). "mcp": a remote MCP server. */
export const ExtensionKindSchema = z.enum(["http", "mcp"]);

export type McpTransport = z.infer<typeof McpTransportSchema>;
/** "auto" tries Streamable HTTP first and falls back to the legacy SSE transport. */
export const McpTransportSchema = z.enum(["auto", "streamable-http", "sse"]);

export type McpSecretPlacement = z.infer<typeof McpSecretPlacementSchema>;
/**
 * How a secret travels to the MCP server:
 *   bearer: `Authorization: Bearer <value>`
 *   header: a header named `target` (default: the secret name)
 *   query:  a query parameter named `target` (default: the secret name)
 */
export const McpSecretPlacementSchema = z.enum(["bearer", "header", "query"]);

// HTTP header token characters (RFC 9110 tchar). Also used for query names.
const HTTP_TOKEN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

// Headers the app sets itself, or that would break the transport.
const RESERVED_SECRET_HEADERS = new Set([
  "host",
  "content-length",
  "content-type",
  "accept",
  "connection",
  "transfer-encoding",
  "mcp-session-id",
  "mcp-protocol-version",
  "last-event-id",
  "cookie",
]);

/** The header or query parameter name a secret is sent under. */
export const mcpSecretTargetName = (secret: {
  name: string;
  placement: McpSecretPlacement;
  target?: string;
}): string =>
  secret.placement === "bearer" ? "Authorization" : secret.target || secret.name;

export type McpSecretModel = z.infer<typeof McpSecretSchema>;
export const McpSecretSchema = z
  .object({
    id: z.string(),
    name: z
      .string()
      .min(1, { message: "Secret name cannot be empty" })
      .max(128, { message: "Secret name is too long" })
      .regex(/^[A-Za-z0-9_.-]+$/, {
        message: "Secret name can use letters, digits, '_', '-' and '.'",
      }),
    // In Cosmos this is always the Key Vault mask; the value lives in Key Vault.
    value: z.string().min(1, { message: "Secret value cannot be empty" }),
    placement: McpSecretPlacementSchema,
    target: z
      .union([
        z.literal(""),
        z
          .string()
          .max(128)
          .regex(HTTP_TOKEN, { message: "Header or parameter name is not valid" }),
      ])
      .optional(),
  })
  .refine(
    (s) =>
      s.placement !== "header" ||
      (HTTP_TOKEN.test(mcpSecretTargetName(s)) &&
        !RESERVED_SECRET_HEADERS.has(mcpSecretTargetName(s).toLowerCase())),
    { message: "This header name cannot be used for a secret" }
  );

export type McpToolInfo = z.infer<typeof McpToolInfoSchema>;
export const McpToolInfoSchema = z.object({
  name: z.string().min(1).max(256),
  description: z.string().optional(),
  inputSchema: z.record(z.string(), z.unknown()).optional(),
});

export type McpOAuthConfig = z.infer<typeof McpOAuthConfigSchema>;
/** OAuth settings of the server. Sign-ins are per user and live in Key Vault, not here. */
export const McpOAuthConfigSchema = z.object({
  /** Pre-registered client id. Empty: the app registers itself (dynamic client registration). */
  clientId: z.string().max(512).optional(),
  /** Key Vault mask when a client secret is stored; empty when there is none. */
  clientSecret: z.string().max(4096).optional(),
  /** Space-separated scopes to request. Empty: the server's default. */
  scopes: z.string().max(1024).optional(),
});

export type McpConfigModel = z.infer<typeof McpConfigSchema>;
export const McpConfigSchema = z.object({
  url: z
    .string()
    .min(1, { message: "Server URL cannot be empty" })
    .max(2048, { message: "Server URL is too long" })
    .refine((u) => {
      try {
        return new URL(u).protocol === "https:";
      } catch {
        return false;
      }
    }, "Server URL must be a valid https URL"),
  transport: McpTransportSchema,
  secrets: z.array(McpSecretSchema).max(20, { message: "Use 20 secrets or fewer" }),
  /** Tool names the model may use. Empty: all tools of the server. */
  toolAllowList: z.array(z.string().min(1).max(256)).max(200),
  /** Tools found on the server at the last discovery. Server-managed. */
  tools: z.array(McpToolInfoSchema).max(200).optional(),
  toolsDiscoveredAt: z.coerce.date().optional(),
  auth: z.enum(["none", "oauth"]),
  oauth: McpOAuthConfigSchema.optional(),
});

export const ExtensionModelSchema = z.object({
  id: z.string(),
  name: z
    .string()
    .min(1, {
      message: "Title cannot be empty",
    })
    .refine(refineFromEmpty, "Title cannot be empty"),
  description: z
    .string()
    .min(1, {
      message: "Description cannot be empty",
    })
    .refine(refineFromEmpty, "Description cannot be empty"),
  executionSteps: z
    .string()
    .min(1, {
      message: "persona cannot be empty",
    })
    .refine(refineFromEmpty, "Description cannot be empty"),
  headers: z.array(HeaderSchema),
  userId: z.string(),
  isPublished: z.boolean(),
  createdAt: z.date(),
  functions: z.array(ExtensionFunctionSchema), // validation is done in the function schema
  type: z.literal(EXTENSION_ATTRIBUTE),
  /** Missing on extensions saved before Remote MCP support: read as "http". */
  kind: ExtensionKindSchema.optional(),
  /** Set only when kind === "mcp". */
  mcp: McpConfigSchema.optional(),
});

/** The kind of an extension; documents saved before the field existed are HTTP extensions. */
export const extensionKind = (extension: { kind?: ExtensionKind }): ExtensionKind =>
  extension.kind ?? "http";
