"use client";

import { ServerActionResponse } from "@/features/common/server-action-response";
import { LoadingIndicator } from "@/features/ui/loading";
import { Textarea } from "@/features/ui/textarea";
import { useSession } from "next-auth/react";
import { FC, useActionState } from "react";
import { Button } from "../../ui/button";
import { Input } from "../../ui/input";
import { Label } from "../../ui/label";
import { ScrollArea } from "../../ui/scroll-area";
import {
  Sheet,
  SheetContent,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "../../ui/sheet";
import { Switch } from "../../ui/switch";
import {
  AddOrUpdateExtension,
  extensionStore,
  useExtensionState,
} from "../extension-store";
import { AddFunction } from "./add-function";
import { EndpointHeader } from "./endpoint-header";
import { ErrorMessages } from "./error-messages";
import { McpServerSection } from "./mcp-server";

interface Props {}

export const AddExtension: FC<Props> = (props) => {
  const { isOpened, extension } = useExtensionState();

  const { data } = useSession();
  const initialState: ServerActionResponse | undefined = undefined;

  const [formState, formAction] = useActionState(
    AddOrUpdateExtension,
    initialState
  );

  const PublicSwitch = () => {
    if (data === undefined || data === null) return null;

    if (data?.user?.isAdmin) {
      return (
        <div className="flex items-center space-x-2">
          <Switch name="isPublished" defaultChecked={extension.isPublished} />
          <Label htmlFor="description">Publish</Label>
        </div>
      );
    }
  };

  return (
    <Sheet
      open={isOpened}
      onOpenChange={(value) => {
        extensionStore.updateOpened(value);
      }}
    >
      <SheetContent className="min-w-[680px] flex flex-col">
        <SheetHeader>
          <SheetTitle>
            {extension.kind === "mcp" ? "Remote MCP server" : "Extension"}
          </SheetTitle>
        </SheetHeader>
        <form
          action={formAction}
          className="flex-1 flex flex-col "
          onChange={() => extensionStore.clearSaveNotice()}
        >
          <ScrollArea
            className="h-full -mx-6 max-h-[calc(100vh-140px)]"
            type="always"
          >
            <div className="pb-6 px-6 flex gap-8 flex-col">
              <ErrorMessages />
              {/* Controlled: after the first save of an MCP extension the sheet
                  stays open and the next save must update, not create. */}
              <input type="hidden" name="id" value={extension.id} />
              <input type="hidden" name="kind" value={extension.kind ?? "http"} />
              <div className="grid gap-2">
                <Label>Name</Label>
                <Input
                  type="text"
                  required
                  name="name"
                  defaultValue={extension.name}
                  placeholder="Name of your Extension"
                />
              </div>
              <div className="grid gap-2">
                <Label htmlFor="description">Short description</Label>
                <Input
                  type="text"
                  required
                  defaultValue={extension.description}
                  name="description"
                  placeholder="Short description"
                />
              </div>
              <div className="grid gap-2">
                <Label htmlFor="description">Detail description</Label>
                <Textarea
                  required
                  defaultValue={extension.executionSteps}
                  name="executionSteps"
                  placeholder="Describe specialties and the steps to execute the extension"
                />
              </div>
              {extension.kind === "mcp" ? (
                <McpServerSection />
              ) : (
                <>
                  <EndpointHeader />
                  <AddFunction />
                </>
              )}
            </div>
          </ScrollArea>
          <SheetFooter className="py-2 flex sm:justify-between flex-row">
            <PublicSwitch />
            <Submit />
          </SheetFooter>
        </form>
      </SheetContent>
    </Sheet>
  );
};

function Submit() {
  const { isLoading, saveNotice } = useExtensionState();
  return (
    <div className="flex items-center gap-3">
      {saveNotice && (
        <span className="text-sm text-muted-foreground" role="status">
          {saveNotice}
        </span>
      )}
      <Button disabled={isLoading} className="gap-2">
        <LoadingIndicator isLoading={isLoading} />
        Save
      </Button>
    </div>
  );
}
