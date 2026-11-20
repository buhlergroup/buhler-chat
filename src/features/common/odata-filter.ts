// Helpers to build OData filter expressions (Azure AI Search, Microsoft Graph)
// from values that are not constants in the code.

// Ids this app writes (uniqueId(), user hashes, Cosmos generated ids) use only
// these characters. A value outside this set is not an id of ours.
const ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

export const isValidId = (value: unknown): value is string =>
  typeof value === "string" && ID_PATTERN.test(value);

// An OData string literal: wrapped in single quotes, a quote is doubled.
export const odataString = (value: string): string =>
  `'${String(value).replace(/'/g, "''")}'`;

export const odataEq = (field: string, value: string): string =>
  `${field} eq ${odataString(value)}`;

// search.in(field, 'a,b,c', ','). Only valid ids are kept, so no value can
// contain the delimiter or a quote. Returns undefined when no id is left.
export const odataSearchIn = (
  field: string,
  values: readonly unknown[]
): string | undefined => {
  const ids = Array.from(new Set((values ?? []).filter(isValidId)));
  if (ids.length === 0) {
    return undefined;
  }
  return `search.in(${field}, '${ids.join(",")}', ',')`;
};
