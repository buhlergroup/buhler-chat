/**
 * Checks for values that go into Microsoft Graph URLs or onto the page.
 * No server-only import: the agent editor uses isHttpsUrl too.
 *
 * Graph drive ids ("b!..." for SharePoint and OneDrive for Business, hex for
 * personal OneDrive) and item ids ("01ABC...", "ABC!123") only use these
 * characters. Anything else (slash, dot, "?", "%") is refused before a Graph
 * URL is built, so a value from the client or from a model cannot change the
 * request path.
 */
export const GRAPH_DRIVE_ID_PATTERN = /^[A-Za-z0-9!_-]{1,256}$/;
export const GRAPH_ITEM_ID_PATTERN = /^[A-Za-z0-9!_-]{1,128}$/;

export const isGraphDriveId = (v: unknown): v is string =>
  typeof v === "string" && GRAPH_DRIVE_ID_PATTERN.test(v);
export const isGraphItemId = (v: unknown): v is string =>
  typeof v === "string" && GRAPH_ITEM_ID_PATTERN.test(v);

/** True for an absolute https URL (the editor renders it as a link). */
export const isHttpsUrl = (v: unknown): v is string => {
  if (typeof v !== "string" || v.length > 2048) return false;
  try {
    return new URL(v).protocol === "https:";
  } catch {
    return false;
  }
};
