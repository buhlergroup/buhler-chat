"use client";

import { useCallback, useState } from "react";
import { FolderOpen, Trash2 } from "lucide-react";
import { PromptInputButton } from "@/components/ai-elements/prompt-input";
import { Button } from "@/features/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/features/ui/dialog";
import { ScrollArea } from "@/features/ui/scroll-area";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/features/ui/sheet";
import { useChatStore } from "@/features/chat-page/chat-store-context";
import { ListWorkspaceFiles } from "../chat-services/copilot-runtime/workspace-upload-actions";
import type { WorkspaceFileInfo, WorkspaceListing } from "../chat-services/workspace-file-model";
import { formatFileSize, WorkspaceFileIcon, workspaceFileUrl } from "./workspace-file-icon";
import { useRemoveWorkspaceFile } from "./workspace-upload-chips";

const formatTime = (iso: string): string => {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? "" : date.toLocaleString();
};

function FileRow(props: {
  threadId: string;
  file: WorkspaceFileInfo;
  onDelete: (file: WorkspaceFileInfo) => void;
}) {
  const { threadId, file, onDelete } = props;
  const details = [formatFileSize(file.size), formatTime(file.modified)].filter(Boolean).join(" · ");
  return (
    <li className="flex items-center gap-3 rounded-md border px-3 py-2" data-testid="workspace-file-row">
      <WorkspaceFileIcon name={file.name} />
      <div className="flex min-w-0 flex-1 flex-col">
        <a
          href={workspaceFileUrl(threadId, file.path)}
          download={file.name}
          className="truncate text-sm font-medium hover:underline"
          title={`Download ${file.name}`}
        >
          {file.name}
        </a>
        <span className="truncate text-xs text-muted-foreground" title={file.path}>
          {file.path}
        </span>
        {details && <span className="text-xs text-muted-foreground">{details}</span>}
      </div>
      <Button
        variant="ghost"
        size="icon"
        className="h-7 w-7 shrink-0"
        aria-label={`Delete ${file.path}`}
        onClick={() => onDelete(file)}
        type="button"
      >
        <Trash2 className="h-3.5 w-3.5" />
      </Button>
    </li>
  );
}

function FileGroup(props: {
  title: string;
  files: WorkspaceFileInfo[];
  threadId: string;
  onDelete: (file: WorkspaceFileInfo) => void;
}) {
  if (props.files.length === 0) return null;
  return (
    <section className="flex flex-col gap-2" aria-label={props.title}>
      <h3 className="text-sm font-semibold">
        {props.title} ({props.files.length})
      </h3>
      <ul className="flex flex-col gap-2">
        {props.files.map((file) => (
          <FileRow key={file.path} threadId={props.threadId} file={file} onDelete={props.onDelete} />
        ))}
      </ul>
    </section>
  );
}

/**
 * "Files (N)" next to the upload button (Copilot path): every file of the
 * chat workspace, the user's uploads and the files the agent created, newest
 * first. Each file can be downloaded and deleted. The list loads when the
 * panel opens, so it also shows files of the last reply.
 */
export function WorkspaceFilesPanel(props: { threadId: string }) {
  const { threadId } = props;
  const count = useChatStore((s) => s.workspaceFileCount);
  const setCount = useChatStore((s) => s.setWorkspaceFileCount);
  const remove = useRemoveWorkspaceFile(threadId);
  const [open, setOpen] = useState(false);
  const [listing, setListing] = useState<WorkspaceListing | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | undefined>();
  // A delete in the panel asks first (it may be a file the agent made).
  const [pendingDelete, setPendingDelete] = useState<WorkspaceFileInfo | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(undefined);
    try {
      const res = await ListWorkspaceFiles(threadId);
      if (res.status === "OK") {
        setListing(res.response);
        setCount(res.response.total);
      } else {
        setError(res.errors.map((e) => e.message).join(", "));
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [threadId, setCount]);

  // The list loads each time the panel opens.
  const openPanel = () => {
    setOpen(true);
    void load();
  };

  const onDelete = async (file: WorkspaceFileInfo) => {
    const removed = await remove(file);
    if (!removed) return;
    const gone = new Set(removed);
    setListing((prev) =>
      prev ? { ...prev, files: prev.files.filter((f) => !gone.has(f.path)), total: Math.max(0, prev.total - gone.size) } : prev,
    );
  };

  const files = listing?.files ?? [];
  const uploaded = files.filter((f) => f.group === "uploaded");
  const created = files.filter((f) => f.group === "created");

  return (
    <>
      <PromptInputButton aria-label="Files of this chat" onClick={openPanel}>
        <FolderOpen className="size-4" />
        <span>Files ({count})</span>
      </PromptInputButton>
      <Sheet open={open} onOpenChange={setOpen}>
        <SheetContent className="min-w-[320px] sm:w-[540px] flex flex-col">
          <SheetHeader className="space-y-2">
            <SheetTitle>Files ({listing?.total ?? count})</SheetTitle>
            <SheetDescription>Files you uploaded to this chat and files the agent created.</SheetDescription>
          </SheetHeader>
          <ScrollArea className="flex-1 mt-4 -mx-6" type="always">
            <div className="flex flex-col gap-6 px-6 pb-6">
              {loading && !listing && <p className="text-sm text-muted-foreground">Loading files…</p>}
              {error && (
                <p className="text-sm text-destructive" role="alert">
                  {error}
                </p>
              )}
              {listing && files.length === 0 && (
                <p className="text-sm text-muted-foreground">This chat has no files yet.</p>
              )}
              <FileGroup title="Uploaded" files={uploaded} threadId={threadId} onDelete={setPendingDelete} />
              <FileGroup title="Created" files={created} threadId={threadId} onDelete={setPendingDelete} />
              {listing?.truncated && (
                <p className="text-xs text-muted-foreground">
                  Shows the newest {files.length} of {listing.total} files.
                </p>
              )}
            </div>
          </ScrollArea>
        </SheetContent>
      </Sheet>
      <Dialog open={pendingDelete !== null} onOpenChange={(o) => !o && setPendingDelete(null)}>
        <DialogContent data-testid="workspace-file-delete-confirm">
          <DialogHeader>
            <DialogTitle>Delete file</DialogTitle>
            <DialogDescription>
              {pendingDelete
                ? `Delete ${pendingDelete.path} from this chat? Its extracted text and search index entries are deleted too. You cannot undo this.`
                : ""}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              type="button"
              variant="destructive"
              onClick={() => {
                const file = pendingDelete;
                setPendingDelete(null);
                if (file) void onDelete(file);
              }}
            >
              Delete
            </Button>
            <DialogClose asChild>
              <Button type="button" variant="outline">
                Cancel
              </Button>
            </DialogClose>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
