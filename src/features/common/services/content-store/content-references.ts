import "server-only";

/**
 * References to content store entries: the rows that store a content hash.
 * The cleanup deletes content only when none of them points to it.
 *
 *   row                       | field                     | partition (scope)
 *   --------------------------|---------------------------|------------------
 *   CHAT_DOCUMENT             | sha256 (not deleted)      | the user
 *   CHAT_THREAD               | attachedFiles[].sha256    | the user
 *   PERSONA_DOCUMENT          | sha256                    | the agent owner
 *   PERSONA_CI_DOCUMENT       | sha256                    | the agent owner
 *
 * Rows written before the content store have no hash: they point to no
 * content entry, and they keep working as before.
 *
 * Not a "use server" module: nothing here is callable from the browser.
 */

import { HistoryContainer } from "../cosmos";
import { contentStore } from ".";
import type { CleanupOptions, CleanupResult } from "./content-store";

/** True when a row in the scope's partition points to the content. */
export async function isContentReferenced(scope: string, sha256: string): Promise<boolean> {
  const { resources } = await HistoryContainer()
    .items.query<number>(
      {
        query:
          "SELECT VALUE COUNT(1) FROM r WHERE r.userId = @scope AND (NOT IS_DEFINED(r.isDeleted) OR r.isDeleted = false) AND (r.sha256 = @sha256 OR ARRAY_CONTAINS(r.attachedFiles, { \"sha256\": @sha256 }, true))",
        parameters: [
          { name: "@scope", value: scope },
          { name: "@sha256", value: sha256 },
        ],
      },
      { partitionKey: scope }
    )
    .fetchAll();
  return (resources?.[0] ?? 0) > 0;
}

/**
 * Deletes content that no row points to and that is older than the grace
 * period (default 7 days). The scheduled job (cleanup-job.ts) calls it with
 * bounds per run; nothing calls it on a request path.
 */
export async function cleanupUnreferencedContent(
  options: Omit<CleanupOptions, "isReferenced"> = {}
): Promise<CleanupResult> {
  return contentStore().cleanup({ ...options, isReferenced: isContentReferenced });
}
