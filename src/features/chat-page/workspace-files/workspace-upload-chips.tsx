"use client";

import { useEffect } from "react";
import { X } from "lucide-react";
import { Button } from "@/features/ui/button";
import { showError } from "@/features/globals/global-message-store";
import { useChatStore } from "@/features/chat-page/chat-store-context";
import { RemoveWorkspaceFile } from "../chat-services/copilot-runtime/workspace-upload-actions";
import type { WorkspaceFileInfo, WorkspaceSummary } from "../chat-services/workspace-file-model";
import { WorkspaceFileIcon } from "./workspace-file-icon";

/**
 * Deletes a workspace file with an optimistic update of the chat store: the
 * chip and the count go at once and come back when the server refuses.
 * Text extracts the server deleted with it lower the count too.
 */
export function useRemoveWorkspaceFile(threadId: string) {
  const uploads = useChatStore((s) => s.workspaceUploads);
  const removeWorkspaceFiles = useChatStore((s) => s.removeWorkspaceFiles);
  const addWorkspaceUpload = useChatStore((s) => s.addWorkspaceUpload);
  const setWorkspaceFileCount = useChatStore((s) => s.setWorkspaceFileCount);
  const fileCount = useChatStore((s) => s.workspaceFileCount);
  return async (file: WorkspaceFileInfo): Promise<string[] | undefined> => {
    const wasChip = uploads.some((f) => f.path === file.path);
    removeWorkspaceFiles([file.path]);
    let failure: string | undefined;
    try {
      const res = await RemoveWorkspaceFile(threadId, file.path);
      if (res.status === "OK") {
        removeWorkspaceFiles(res.response.removed.filter((p) => p !== file.path));
        return res.response.removed;
      }
      // Already gone (another tab, the agent): nothing to restore.
      if (res.status === "NOT_FOUND" && res.errors[0]?.message === "File not found") return [file.path];
      failure = res.errors.map((e) => e.message).join(", ");
    } catch (e) {
      failure = e instanceof Error ? e.message : String(e);
    }
    // Put back what the optimistic update took away.
    if (wasChip) addWorkspaceUpload(file);
    else setWorkspaceFileCount(fileCount);
    showError(`${file.name} could not be deleted: ${failure}`);
    return undefined;
  };
}

/**
 * The user's uploads in the chat workspace (Copilot path) as chips in the
 * input field, like the "Uploaded" chips of the code interpreter files. The
 * server list (page props) seeds the chat store; an upload adds its chip at
 * once (file-store.ts); the cross deletes the file from the workspace.
 */
export function WorkspaceUploadChips(props: { threadId: string; summary: WorkspaceSummary }) {
  const { threadId, summary } = props;
  const uploads = useChatStore((s) => s.workspaceUploads);
  const setWorkspace = useChatStore((s) => s.setWorkspace);
  const remove = useRemoveWorkspaceFile(threadId);

  // A new server list (page load, router.refresh) replaces the store's.
  useEffect(() => {
    setWorkspace(summary);
  }, [setWorkspace, summary]);

  if (uploads.length === 0) return null;
  return (
    <div className="flex flex-wrap gap-2 p-2" data-testid="workspace-upload-chips">
      {uploads.map((file) => (
        <div
          key={file.path}
          className="relative group flex items-center gap-2 bg-muted border rounded-lg px-3 py-2 pr-8"
        >
          <WorkspaceFileIcon name={file.name} />
          <div className="flex flex-col min-w-0">
            <span className="text-sm font-medium truncate max-w-[150px]" title={file.name}>
              {file.name}
            </span>
            <span className="text-xs text-muted-foreground">Uploaded</span>
          </div>
          <Button
            variant="ghost"
            size="icon"
            aria-label={`Remove ${file.name}`}
            className="absolute -top-1 -right-1 h-5 w-5 rounded-full bg-background border shadow-sm opacity-0 group-hover:opacity-100 focus-visible:opacity-100 transition-opacity"
            onClick={() => void remove(file)}
            type="button"
          >
            <X className="h-3 w-3" />
          </Button>
        </div>
      ))}
    </div>
  );
}
