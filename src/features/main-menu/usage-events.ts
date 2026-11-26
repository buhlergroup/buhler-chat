/** Fired in the browser when a chat turn finished, so usage displays can refresh. */
export const USAGE_CHANGED_EVENT = "app:usage-changed";

export function notifyUsageChanged(): void {
  if (typeof window !== "undefined") window.dispatchEvent(new Event(USAGE_CHANGED_EVENT));
}
