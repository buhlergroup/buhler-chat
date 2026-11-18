import { FC } from "react";
import { ScrollArea } from "../ui/scroll-area";
import { AddExtension } from "./add-extension/add-new-extension";
import { ExtensionCard } from "./extension-card/extension-card";
import { ExtensionHero } from "./extension-hero/extension-hero";
import { ExtensionModel } from "./extension-services/models";
import { userHashedId } from "../auth-page/helpers";
import { ExtensionEditFromQuery } from "./extension-edit-from-query";

interface Props {
  extensions: ExtensionModel[];
  /** `?edit=<id>`: open this extension's sheet (owner only, like the edit button). */
  editId?: string;
  /** `?mcp=` from the MCP OAuth callback. */
  mcpResult?: string;
}

export const ExtensionPage = async (props: Props) => {
  const hashedId = await userHashedId();
  const editExtension = props.editId
    ? props.extensions.find((e) => e.id === props.editId && e.userId === hashedId)
    : undefined;
  return (
    <ScrollArea className="flex-1">
      <main className="flex flex-1 flex-col">
        <ExtensionHero />
        <div className="container max-w-4xl py-8 px-4">
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
            {props.extensions.map((extension) => (
              <ExtensionCard
                extension={extension}
                key={extension.id}
                showActionMenu={extension.userId === hashedId}
              />
            ))}
          </div>
        </div>
        <AddExtension />
        <ExtensionEditFromQuery extension={editExtension} mcpResult={props.mcpResult} />
      </main>
    </ScrollArea>
  );
};
