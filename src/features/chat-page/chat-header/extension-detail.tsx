import { ExtensionModel } from "@/features/extensions-page/extension-services/models";
import { Button } from "@/features/ui/button";
import { ScrollArea } from "@/features/ui/scroll-area";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/features/ui/sheet";
import { Switch } from "@/features/ui/switch";
import { Globe, KeyRound, PocketKnife } from "lucide-react";
import { FC, useEffect, useState } from "react";
import { GetMcpConnections } from "@/features/extensions-page/extension-services/mcp/mcp-service";
import { GetExtensionCredentialInfo } from "@/features/extensions-page/extension-services/extension-service";
import { McpConnectButton } from "@/features/extensions-page/mcp-connect-button";
import {
  AddExtensionToChatThread,
  RemoveExtensionFromChatThread,
} from "../chat-services/chat-thread-service";
import { showError } from "@/features/globals/global-message-store";
import { RevalidateCache } from "@/features/common/navigation-helpers";
import { personaStore } from "@/features/persona-page/persona-store";

interface Props {
  extensions: Array<ExtensionModel>;
  chatThreadId: string;
  installedExtensionIds: Array<string>;
  disabled: boolean;
  parent: string;
  /** Agent of the chat: OAuth MCP sign-ins may be granted through it. */
  personaId?: string;
}

export const ExtensionDetail: FC<Props> = (props) => {
  const toggleInstall = async (isChecked: boolean, extensionId: string) => {
    if (props.parent !== "chat") {
      if (isChecked) personaStore.addExtension(extensionId);
      else personaStore.removeExtension(extensionId);
      return;
    }
    const response = isChecked
      ? await AddExtensionToChatThread({ extensionId, chatThreadId: props.chatThreadId })
      : await RemoveExtensionFromChatThread({ extensionId, chatThreadId: props.chatThreadId });
    RevalidateCache({ page: "chat", type: isChecked ? "layout" : undefined });
    if (response.status !== "OK") {
      showError(response.errors[0].message);
    }
  };

  // Per-user sign-ins of OAuth MCP extensions on this chat (chat only).
  const [open, setOpen] = useState(false);
  const [connections, setConnections] = useState<Record<string, boolean>>({});
  const mcpIdsKey = props.extensions
    .filter((e) => e.kind === "mcp" && props.installedExtensionIds?.includes(e.id))
    .map((e) => e.id)
    .join(",");
  useEffect(() => {
    if (!open || props.parent !== "chat" || !mcpIdsKey) return;
    let cancelled = false;
    GetMcpConnections(mcpIdsKey.split(","), props.personaId)
      .then((r) => {
        if (cancelled || r.status !== "OK") return;
        setConnections(
          Object.fromEntries(r.response.filter((c) => c.oauth).map((c) => [c.id, c.connected]))
        );
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [open, mcpIdsKey, props.parent, props.personaId]);

  // Extensions that run with the stored credentials of their owner (another
  // user). The server answers with booleans only (chat only).
  const [ownerCredentialIds, setOwnerCredentialIds] = useState<Set<string>>(new Set());
  const extensionIdsKey = props.extensions.map((e) => e.id).join(",");
  useEffect(() => {
    if (!open || props.parent !== "chat" || !extensionIdsKey) return;
    let cancelled = false;
    GetExtensionCredentialInfo(extensionIdsKey.split(","), props.personaId)
      .then((r) => {
        if (cancelled || r.status !== "OK") return;
        setOwnerCredentialIds(
          new Set(r.response.filter((i) => i.usesStoredSecrets && !i.ownedByYou).map((i) => i.id))
        );
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [open, extensionIdsKey, props.parent, props.personaId]);

  const installedCount = props.installedExtensionIds?.length ?? 0;
  const totalCount = props.extensions.length;

  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger asChild>
        <Button
          variant={"outline"}
          className="gap-2"
          disabled={props.disabled}
          aria-label="Current Chat Extensions Menu"
        >
          <PocketKnife size={16} />
          {installedCount > 0 && (
            <span className="text-xs bg-primary/10 text-primary rounded-full px-1.5 py-0.5 font-medium">{installedCount}</span>
          )}
        </Button>
      </SheetTrigger>
      <SheetContent className="min-w-[480px] sm:w-[540px] flex flex-col">
        <SheetHeader>
          <SheetTitle>Extensions</SheetTitle>
          <SheetDescription>
            Enhance your AI Chat with added tools and features for extended
            functionality and smarter interactions.
          </SheetDescription>
        </SheetHeader>
        <ScrollArea className="flex-1 -mx-6 flex" type="always">
          <div className="pb-6 px-6 flex gap-4 flex-col  flex-1">
            {props.extensions.map((extension) => {
              const isInstalled =
                props.installedExtensionIds?.includes(extension.id) ?? false;
              return (
                <div
                  className="flex gap-2 p-4 items-center justify-between border rounded-md"
                  key={extension.id}
                >
                  <div className="flex flex-col gap-2 flex-1">
                    <div>{extension.name}</div>
                    <div className="text-muted-foreground">
                      {extension.description}
                    </div>
                    {ownerCredentialIds.has(extension.id) && (
                      <div className="flex items-center gap-1 text-xs text-muted-foreground">
                        <KeyRound size={12} aria-hidden="true" />
                        <span>Uses the credentials of the extension owner</span>
                      </div>
                    )}
                    {extension.id in connections && (
                      <div>
                        <McpConnectButton
                          key={String(connections[extension.id])}
                          extensionId={extension.id}
                          extensionName={extension.name}
                          personaId={props.personaId}
                          connected={connections[extension.id]}
                          onChange={(value) =>
                            setConnections((prev) => ({ ...prev, [extension.id]: value }))
                          }
                        />
                      </div>
                    )}
                  </div>
                  <div>
                    {extension.name !== "Bing Search" ||
                    props.parent !== "chat" ? (
                      <Switch
                        defaultChecked={isInstalled}
                        onCheckedChange={(e) => toggleInstall(e, extension.id)}
                      />
                    ) : (
                      <Globe />
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </ScrollArea>
      </SheetContent>
    </Sheet>
  );
};
