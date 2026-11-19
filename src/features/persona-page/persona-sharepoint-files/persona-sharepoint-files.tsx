"use client";

import { FC, useCallback, useEffect, useState } from "react";
import { useSession } from "next-auth/react";
import { Label } from "@/features/ui/label";
import { Button } from "@/features/ui/button";
import { LoadingIndicator } from "@/features/ui/loading";
import { toast } from "@/features/ui/use-toast";
import { FileText, Folder, FolderPlus, FilePlus, Trash } from "lucide-react";
import {
  AddPersonaFileSource,
  DeletePersonaFileSource,
  FindPersonaFileSources,
} from "../persona-services/sharepoint-files/sharepoint-file-service";
import {
  pickerFileFilters,
  type PersonaFileSourceSummary,
} from "../persona-services/sharepoint-files/sharepoint-file-models";
import { isHttpsUrl } from "@/features/common/services/sharepoint/graph-ids";
import type { SharePointFile } from "../persona-services/models";
import { CodeInterpreterFilePicker } from "../persona-documents/code-interpreter-file-picker";

interface Props {
  /** Empty for an agent that is not saved yet. */
  personaId: string;
}

const SHAREPOINT_URL = process.env.NEXT_PUBLIC_SHAREPOINT_URL ?? "";

/**
 * "SharePoint files for the model": SharePoint folders and files the model
 * may list and fetch into the code interpreter during a chat (tools
 * find_sharepoint_files / fetch_sharepoint_file). Shown to the owner and
 * admins only; the server decides (FindPersonaFileSources returns
 * canEdit=false for everyone else, and every change is checked again).
 * Changes run immediately, independent of the agent's Save button.
 */
export const PersonaSharePointFiles: FC<Props> = ({ personaId }) => {
  const { data: session } = useSession();
  const [sources, setSources] = useState<PersonaFileSourceSummary[]>([]);
  const [canEdit, setCanEdit] = useState(false);
  const [maxSources, setMaxSources] = useState(0);
  const [busy, setBusy] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!personaId) return;
    const res = await FindPersonaFileSources(personaId);
    if (res.status === "OK") {
      setSources(res.response.sources);
      setCanEdit(res.response.canEdit);
      setMaxSources(res.response.maxSources);
    }
  }, [personaId]);

  useEffect(() => {
    setSources([]);
    setCanEdit(false);
    refresh();
  }, [refresh]);

  const showErrors = (errors: { message: string }[]) =>
    toast({
      title: "SharePoint files",
      description: errors.map((e) => e.message).join(" "),
      variant: "destructive",
    });

  const onPicked = async (files: SharePointFile[], kind: "folder" | "file") => {
    const item = files[0];
    if (!item) return;
    setBusy(kind);
    try {
      const res = await AddPersonaFileSource({
        personaId,
        driveId: item.parentReference.driveId,
        itemId: item.documentId,
      });
      if (res.status === "OK") {
        toast({
          title: "SharePoint files",
          description: `${res.response.kind === "folder" ? "Folder" : "File"} "${res.response.name}" added.`,
        });
        await refresh();
      } else {
        showErrors(res.errors);
      }
    } finally {
      setBusy(null);
    }
  };

  const onDelete = async (source: PersonaFileSourceSummary) => {
    setBusy(source.id);
    try {
      const res = await DeletePersonaFileSource(personaId, source.id);
      if (res.status === "OK") setSources((prev) => prev.filter((s) => s.id !== source.id));
      else showErrors(res.errors);
    } finally {
      setBusy(null);
    }
  };

  // Owner/admin only. A new agent (no id yet) shows the hint below.
  if (personaId && !canEdit) return null;

  const full = sources.length >= maxSources;
  const token = session?.user?.accessToken ?? "";

  return (
    <div className="grid gap-2" data-testid="persona-sharepoint-files">
      <Label>SharePoint files for the model</Label>
      <p className="text-xs text-muted-foreground">
        Add SharePoint folders or files. With the code interpreter on, the
        agent can list the files in them and fetch the ones a task needs, with
        the access rights of the person who chats. Name the files in the
        agent&apos;s instructions or a skill so it fetches only what it needs.
      </p>
      {!personaId ? (
        <p className="text-xs text-muted-foreground">Save the agent to add SharePoint files.</p>
      ) : (
        <>
          {sources.length > 0 && (
            <ul className="flex flex-col gap-2 border rounded-md p-2">
              {sources.map((source) => (
                <li
                  key={source.id}
                  className="flex items-center gap-2"
                  data-testid="persona-sharepoint-source"
                >
                  {source.kind === "folder" ? (
                    <Folder size={16} className="shrink-0" />
                  ) : (
                    <FileText size={16} className="shrink-0" />
                  )}
                  <span className="text-sm flex-1 min-w-0 break-all">
                    {isHttpsUrl(source.webUrl) ? (
                      <a
                        href={source.webUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="underline"
                      >
                        {source.name}
                      </a>
                    ) : (
                      source.name
                    )}
                  </span>
                  <Button
                    type="button"
                    size="icon"
                    variant="ghost"
                    title="Remove"
                    aria-label={`Remove ${source.name}`}
                    disabled={busy !== null}
                    onClick={() => onDelete(source)}
                  >
                    {busy === source.id ? <LoadingIndicator isLoading /> : <Trash size={16} />}
                  </Button>
                </li>
              ))}
            </ul>
          )}
          {SHAREPOINT_URL ? (
            <div className="flex flex-wrap gap-2">
              <CodeInterpreterFilePicker
                tenantUrl={SHAREPOINT_URL}
                token={token}
                onFilesSelected={(files) => onPicked(files, "folder")}
                mode="folders"
                single
                title="Add a folder from SharePoint"
                description="Choose a folder. The agent can fetch files from it and from its subfolders (up to 3 levels)."
                trigger={(open) => (
                  <Button
                    type="button"
                    variant="outline"
                    className="gap-2 w-fit"
                    disabled={busy !== null || full}
                    onClick={open}
                  >
                    {busy === "folder" ? <LoadingIndicator isLoading /> : <FolderPlus size={16} />}
                    Add folder from SharePoint
                  </Button>
                )}
              />
              <CodeInterpreterFilePicker
                tenantUrl={SHAREPOINT_URL}
                token={token}
                onFilesSelected={(files) => onPicked(files, "file")}
                filters={pickerFileFilters()}
                single
                title="Add a file from SharePoint"
                description="Choose a file the agent can fetch into the code interpreter."
                trigger={(open) => (
                  <Button
                    type="button"
                    variant="outline"
                    className="gap-2 w-fit"
                    disabled={busy !== null || full}
                    onClick={open}
                  >
                    {busy === "file" ? <LoadingIndicator isLoading /> : <FilePlus size={16} />}
                    Add file from SharePoint
                  </Button>
                )}
              />
            </div>
          ) : (
            <p className="text-xs text-muted-foreground">SharePoint is not set up for this app.</p>
          )}
          {full && maxSources > 0 && (
            <p className="text-xs text-muted-foreground">
              The limit of {maxSources} folders and files is reached.
            </p>
          )}
        </>
      )}
    </div>
  );
};
