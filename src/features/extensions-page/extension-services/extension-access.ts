import "server-only";

/**
 * Who may add an extension to a chat thread: the minimal server-side rule.
 *
 * A thread's extension ids are trusted by /api/chat, which resolves them with
 * their header secrets. So an extension id may enter a thread only when the
 * user may use that extension: it is published, or the user owns it. This is
 * the same set FindAllExtensionForCurrentUser lists. Agents (personas) bring
 * their own extension ids through CreatePersonaChat; that path does not use
 * this check.
 *
 * TODO(#203): replace this with `decideExtensionAccess` from
 * feat/remote-mcp-extensions once that PR is merged.
 *
 * No `"use server"` here on purpose: this module is called only from other
 * server modules.
 */

import { userHashedId } from "@/features/auth-page/helpers";
import { HistoryContainer } from "@/features/common/services/cosmos";
import { SqlQuerySpec } from "@azure/cosmos";
import { EXTENSION_ATTRIBUTE, ExtensionModel } from "./models";

export const canUseExtension = (
  viewerUserId: string,
  extension: Pick<ExtensionModel, "userId" | "isPublished">
): boolean =>
  extension.isPublished === true || extension.userId === viewerUserId;

/**
 * The extension with this id when the current user may use it, otherwise
 * undefined (also for an unknown id, so the answer does not tell that a
 * private extension exists).
 */
export const findUsableExtension = async (
  id: string
): Promise<ExtensionModel | undefined> => {
  const querySpec: SqlQuerySpec = {
    query: "SELECT * FROM root r WHERE r.type=@type AND r.id=@id",
    parameters: [
      { name: "@type", value: EXTENSION_ATTRIBUTE },
      { name: "@id", value: id },
    ],
  };
  const { resources } = await HistoryContainer()
    .items.query<ExtensionModel>(querySpec)
    .fetchAll();
  const extension = resources.find((e) => e.id === id);
  if (!extension) return undefined;
  return canUseExtension(await userHashedId(), extension)
    ? extension
    : undefined;
};
