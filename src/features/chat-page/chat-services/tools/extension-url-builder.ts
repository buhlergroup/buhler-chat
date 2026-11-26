// Builds the request URL of an HTTP extension call from the configured
// endpoint template and the query arguments the model sent.
//
// The model's arguments are not validated against the extension's JSON
// Schema at run time, so every key and value here is untrusted:
//   - only keys declared under parameters.properties.query.properties count;
//   - a key fills a placeholder only in the PATH or in a query VALUE of the
//     template, never in the scheme, host, port or a query parameter name;
//   - a placeholder is `{KEY}` or the bare token KEY as a whole word (the
//     documented form, e.g. `?q=BING_SEARCH_QUERY`);
//   - every value is percent-encoded, so "/", "?", "#", "&" cannot change
//     the URL structure, and a path segment may not become "." or "..";
//   - declared keys that are no placeholder go into the query string through
//     URLSearchParams;
//   - the finished URL must have the same origin as the template.

export class ExtensionUrlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ExtensionUrlError";
  }
}

/** Keys declared in `parameters.properties.query.properties`. */
export function declaredQueryKeys(parameters: unknown): Set<string> {
  const query = (parameters as { properties?: { query?: { properties?: unknown } } } | null)
    ?.properties?.query?.properties;
  if (!query || typeof query !== "object" || Array.isArray(query)) return new Set();
  return new Set(Object.keys(query as Record<string, unknown>));
}

const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// `{KEY}` (braces also percent-encoded) or KEY not next to a word character.
const placeholderPattern = (key: string): RegExp => {
  const k = escapeRegExp(key);
  return new RegExp(
    String.raw`(?:\{|%7[Bb])${k}(?:\}|%7[Dd])|(?<![A-Za-z0-9_])${k}(?![A-Za-z0-9_])`,
    "g"
  );
};

const valueToString = (value: unknown): string | null => {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    return String(value);
  }
  return JSON.stringify(value);
};

// "." and ".." (also percent-encoded) are dot segments in the URL standard.
const isDotSegment = (segment: string): boolean => {
  const lowered = segment.toLowerCase().replace(/%2e/g, ".");
  return lowered === "." || lowered === "..";
};

// scheme://authority | path | ?query | #fragment
const TEMPLATE_PARTS = /^([a-z][a-z0-9+.-]*:\/\/[^/?#]*)([^?#]*)(\?[^#]*)?(#.*)?$/i;

interface QueryPair {
  name: string;
  value: string | null;
}

const parseQueryPairs = (query: string): QueryPair[] =>
  query
    .replace(/^\?/, "")
    .split("&")
    .filter((pair) => pair !== "")
    .map((pair) => {
      const eq = pair.indexOf("=");
      return eq === -1
        ? { name: pair, value: null }
        : { name: pair.slice(0, eq), value: pair.slice(eq + 1) };
    });

const fill = (text: string, pattern: RegExp, encoded: string): string | null => {
  pattern.lastIndex = 0;
  if (!pattern.test(text)) return null;
  pattern.lastIndex = 0;
  return text.replace(pattern, () => encoded);
};

/**
 * The URL for one extension call. Throws ExtensionUrlError when the
 * template is not an absolute URL, an argument would add a dot segment, or
 * the result would leave the template's origin.
 */
export function buildExtensionUrl(
  endpointTemplate: string,
  query: unknown,
  parameters: unknown
): string {
  let configuredOrigin: string;
  let normalised: string;
  try {
    const parsed = new URL(endpointTemplate);
    configuredOrigin = parsed.origin;
    normalised = parsed.href;
  } catch {
    throw new ExtensionUrlError("Extension endpoint is not a valid URL");
  }
  // A template without "//" ("https:host/x") is split in its parsed form.
  const parts = TEMPLATE_PARTS.exec(endpointTemplate) ?? TEMPLATE_PARTS.exec(normalised);
  if (!parts || configuredOrigin === "null") {
    throw new ExtensionUrlError("Extension endpoint is not a valid URL");
  }

  const [, authority, templatePath, templateQuery = "", fragment = ""] = parts;
  let path = templatePath;
  const pairs = parseQueryPairs(templateQuery);
  const extra = new URLSearchParams();

  const allowed = declaredQueryKeys(parameters);
  const entries =
    query && typeof query === "object" && !Array.isArray(query)
      ? Object.entries(query as Record<string, unknown>)
      : [];

  for (const [key, rawValue] of entries) {
    if (!allowed.has(key)) continue;
    const value = valueToString(rawValue);
    if (value === null) continue;
    const encoded = encodeURIComponent(value);
    const pattern = placeholderPattern(key);

    let used = false;
    const filledPath = fill(path, pattern, encoded);
    if (filledPath !== null) {
      path = filledPath;
      used = true;
    }
    for (const pair of pairs) {
      if (pair.value === null) continue;
      const filledValue = fill(pair.value, pattern, encoded);
      if (filledValue !== null) {
        pair.value = filledValue;
        used = true;
      }
    }
    if (!used) extra.append(key, value);
  }

  if (path.split("/").some((segment) => segment !== "" && isDotSegment(segment))) {
    throw new ExtensionUrlError("Extension argument would change the endpoint path");
  }

  const queryParts = pairs.map((pair) =>
    pair.value === null ? pair.name : `${pair.name}=${pair.value}`
  );
  const extraQuery = extra.toString();
  if (extraQuery) queryParts.push(extraQuery);
  const search = queryParts.length > 0 ? `?${queryParts.join("&")}` : "";

  const built = `${authority}${path}${search}${fragment}`;
  let builtOrigin: string;
  try {
    builtOrigin = new URL(built).origin;
  } catch {
    throw new ExtensionUrlError("Extension URL is not valid after filling its arguments");
  }
  if (builtOrigin !== configuredOrigin) {
    throw new ExtensionUrlError("Extension URL would leave the configured origin");
  }
  return built;
}
