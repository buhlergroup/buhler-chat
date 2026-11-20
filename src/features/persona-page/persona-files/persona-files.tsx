"use client";

import { FC, useCallback, useEffect, useRef, useState } from "react";
import { useSession } from "next-auth/react";
import { ChevronDown, Cloud, FileText, Folder, Puzzle, Upload } from "lucide-react";
import { Label } from "@/features/ui/label";
import { Button } from "@/features/ui/button";
import { LoadingIndicator } from "@/features/ui/loading";
import { toast } from "@/features/ui/use-toast";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/features/ui/dropdown-menu";
import { isHttpsUrl } from "@/features/common/services/sharepoint/graph-ids";
import type { SharePointFile } from "../persona-services/models";
import { CodeInterpreterFilePicker } from "./code-interpreter-file-picker";
import {
  AddAgentFiles,
  ChangeAgentFileUse,
  ListAgentFiles,
  RemoveAgentFile,
} from "../persona-services/agent-files/agent-file-service";
import {
  AGENT_FILE_STATUS_TEXT,
  AGENT_FILE_USE_TEXT,
  MAX_ITEMS_PER_ADD,
  isAgentFileUse,
  type AgentFileItem,
  type AgentFilesList,
} from "../persona-services/agent-files/agent-file-models";
import {
  CheckPersonaSkillNow,
  UploadPersonaSkill,
} from "../persona-services/skills/persona-skill-service";
import { SKILL_LIMITS } from "../persona-services/skills/skill-models";

interface Props {
  /** Empty for an agent that is not saved yet. */
  personaId: string;
  /**
   * Told whether the agent has a file that needs the code interpreter
   * (Code, Skill, On demand); the editor then keeps that tool on.
   */
  onNeedsCodeInterpreterChange?: (needs: boolean) => void;
}

const SHAREPOINT_URL = process.env.NEXT_PUBLIC_SHAREPOINT_URL ?? "";

export const FILES_SUBTITLE =
  "Add files and folders from SharePoint. The app chooses how the agent uses each item. You can change it.";

const STATUS_TEXT: Partial<Record<AgentFileItem["status"], string>> = AGENT_FILE_STATUS_TEXT;

const formatSize = (bytes: number): string =>
  bytes >= 1_000_000
    ? `${(bytes / 1_000_000).toFixed(1)} MB`
    : `${Math.max(1, Math.round(bytes / 1000))} KB`;

const filesText = (n: number) => (n === 1 ? "This agent uses 1 file." : `This agent uses ${n} files.`);

/**
 * The Files section of the agent editor: one list for every SharePoint file
 * and folder of the agent, whatever its use (Search, Code, Skill, On demand).
 * Changes are saved immediately through their own server actions,
 * independent of the agent's Save button. The server decides who may see
 * and change the list; users who can only use the agent see the count.
 */
export const PersonaFiles: FC<Props> = ({ personaId, onNeedsCodeInterpreterChange }) => {
  const { data: session } = useSession();
  const [list, setList] = useState<AgentFilesList | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [notAdded, setNotAdded] = useState<{ name: string; reason: string }[]>([]);
  const fileInput = useRef<HTMLInputElement>(null);
  const replaceTarget = useRef<string | undefined>(undefined);
  const needsCallback = useRef(onNeedsCodeInterpreterChange);
  needsCallback.current = onNeedsCodeInterpreterChange;

  const refresh = useCallback(async () => {
    if (!personaId) {
      setList(null);
      needsCallback.current?.(false);
      return;
    }
    let res: Awaited<ReturnType<typeof ListAgentFiles>>;
    try {
      res = await ListAgentFiles(personaId);
    } catch {
      res = { status: "ERROR", errors: [{ message: "The files could not be loaded." }] };
    }
    if (res.status === "OK") {
      setLoadError(null);
      setList(res.response);
      needsCallback.current?.(res.response.needsCodeInterpreter);
    } else {
      setLoadError(res.errors.map((e) => e.message).join(" ") || "The files could not be loaded.");
    }
  }, [personaId]);

  const retryLoad = async () => {
    setLoadError(null);
    setList(null);
    await refresh();
  };

  useEffect(() => {
    setList(null);
    setLoadError(null);
    setNotAdded([]);
    refresh();
  }, [refresh]);

  const showErrors = (errors: { message: string }[]) =>
    toast({
      title: "Files",
      description: errors.map((e) => e.message).join(" "),
      variant: "destructive",
    });

  const showWarning = (warning: string | undefined) => {
    if (warning) toast({ title: "Files", description: warning, variant: "destructive" });
  };

  const onPicked = async (files: SharePointFile[]) => {
    if (files.length === 0) return;
    setBusy("add");
    setNotAdded([]);
    try {
      const res = await AddAgentFiles(
        personaId,
        files.map((f) => ({ driveId: f.parentReference.driveId, itemId: f.documentId })),
      );
      if (res.status !== "OK") {
        showErrors(res.errors);
        return;
      }
      const added = res.response.filter((r) => r.status === "added");
      const rejected = res.response.flatMap((r) =>
        r.status === "rejected" ? [{ name: r.name || "Item", reason: r.reason }] : [],
      );
      setNotAdded(rejected);
      if (added.length > 0) {
        toast({
          title: "Files",
          description: added.length === 1 ? `"${added[0].name}" added.` : `${added.length} items added.`,
        });
      }
      await refresh();
    } finally {
      setBusy(null);
    }
  };

  const onChangeUse = async (item: AgentFileItem, value: string) => {
    if (!isAgentFileUse(value) || value === item.use) return;
    setBusy(item.ref.id);
    try {
      const res = await ChangeAgentFileUse(personaId, item.ref, value);
      if (res.status === "OK") {
        toast({
          title: "Files",
          description: `"${item.name}" now uses ${AGENT_FILE_USE_TEXT[value].label}.`,
        });
        showWarning(res.response.warning);
        await refresh();
      } else {
        showErrors(res.errors);
      }
    } finally {
      setBusy(null);
    }
  };

  const onRemove = async (item: AgentFileItem) => {
    setBusy(item.ref.id);
    try {
      const res = await RemoveAgentFile(personaId, item.ref);
      if (res.status === "OK") {
        showWarning(res.response.warning);
        await refresh();
      } else showErrors(res.errors);
    } finally {
      setBusy(null);
    }
  };

  const onCheckNow = async (item: AgentFileItem) => {
    setBusy(item.ref.id);
    try {
      const res = await CheckPersonaSkillNow(personaId, item.ref.id);
      if (res.status !== "OK") {
        showErrors(res.errors);
        return;
      }
      toast({
        title: "Files",
        description:
          res.response.result === "invalid"
            ? "The latest file is not a valid skill. Chats use the last good version."
            : `"${item.name}" uses the latest file.`,
        variant: res.response.result === "invalid" ? "destructive" : "default",
      });
      await refresh();
    } finally {
      setBusy(null);
    }
  };

  const pickZip = (replaceSkillId?: string) => {
    replaceTarget.current = replaceSkillId;
    fileInput.current?.click();
  };

  const onZip = async (file: File | undefined) => {
    if (!file) return;
    if (file.size > SKILL_LIMITS.maxZipBytes) {
      showErrors([{ message: `Choose a zip of up to ${SKILL_LIMITS.maxZipBytes / 1_000_000} MB.` }]);
      return;
    }
    const form = new FormData();
    form.append("personaId", personaId);
    form.append("file", file);
    if (replaceTarget.current) form.append("replaceSkillId", replaceTarget.current);
    setBusy(replaceTarget.current ?? "upload");
    try {
      const res = await UploadPersonaSkill(form);
      if (res.status === "OK") {
        toast({ title: "Files", description: `Skill "${res.response.name}" saved.` });
        await refresh();
      } else {
        showErrors(res.errors);
      }
    } finally {
      setBusy(null);
      replaceTarget.current = undefined;
      if (fileInput.current) fileInput.current.value = "";
    }
  };

  const token = session?.user?.accessToken ?? "";

  return (
    <div className="grid gap-2" data-testid="persona-files">
      <Label>Files</Label>
      <p className="text-xs text-muted-foreground">{FILES_SUBTITLE}</p>
      {!personaId ? (
        <p className="text-xs text-muted-foreground">Save the agent to add files.</p>
      ) : loadError ? (
        <div role="alert" className="flex items-center gap-2 text-xs" data-testid="persona-files-load-error">
          <span className="text-destructive">{loadError}</span>
          <Button type="button" size="sm" variant="outline" onClick={retryLoad}>
            Try again
          </Button>
        </div>
      ) : !list ? (
        <p className="text-xs text-muted-foreground">Loading files...</p>
      ) : !list.canEdit ? (
        <p className="text-sm" data-testid="persona-files-count">
          {filesText(list.count)}
        </p>
      ) : (
        <>
          {list.items.length > 0 && (
            <ul className="flex flex-col gap-2 border rounded-md p-2">
              {list.items.map((item) => (
                <FileRow
                  key={`${item.ref.kind}:${item.ref.id}`}
                  item={item}
                  busy={busy}
                  onChangeUse={onChangeUse}
                  onRemove={onRemove}
                  onCheckNow={onCheckNow}
                  onReplace={(i) => pickZip(i.ref.id)}
                />
              ))}
            </ul>
          )}
          {notAdded.length > 0 && (
            <div
              role="status"
              data-testid="persona-files-not-added"
              className="rounded-md border border-amber-500/40 bg-amber-500/10 p-2 text-xs flex flex-col gap-1"
            >
              {notAdded.map((r, i) => (
                <span key={i}>
                  <b>{r.name}</b>: {r.reason}
                </span>
              ))}
            </div>
          )}
          <input
            ref={fileInput}
            type="file"
            accept=".zip,application/zip"
            className="hidden"
            data-testid="persona-files-zip"
            onChange={(e) => onZip(e.target.files?.[0])}
          />
          <div className="flex flex-wrap items-center gap-3">
            {SHAREPOINT_URL ? (
              <CodeInterpreterFilePicker
                tenantUrl={SHAREPOINT_URL}
                token={token}
                onFilesSelected={onPicked}
                mode="all"
                maxCount={MAX_ITEMS_PER_ADD}
                title="Add from SharePoint"
                description="Choose files and folders. The app chooses how the agent uses each item."
                trigger={(open) => (
                  <Button
                    type="button"
                    className="gap-2 w-fit"
                    disabled={busy !== null}
                    onClick={open}
                  >
                    {busy === "add" ? <LoadingIndicator isLoading /> : <Cloud size={16} />}
                    Add from SharePoint
                  </Button>
                )}
              />
            ) : (
              <span className="text-xs text-muted-foreground">
                Add skills as zip files here. SharePoint files need the SharePoint setup of this app.
              </span>
            )}
            <button
              type="button"
              className="text-xs underline text-muted-foreground disabled:opacity-50 inline-flex items-center gap-1"
              disabled={busy !== null}
              onClick={() => pickZip()}
            >
              {busy === "upload" ? <LoadingIndicator isLoading /> : <Upload size={12} />}
              Upload a skill zip
            </button>
          </div>
        </>
      )}
    </div>
  );
};

const FileIcon: FC<{ item: AgentFileItem }> = ({ item }) =>
  item.isFolder ? (
    <Folder size={16} className="mt-1 shrink-0" />
  ) : item.use === "skill" ? (
    <Puzzle size={16} className="mt-1 shrink-0" />
  ) : (
    <FileText size={16} className="mt-1 shrink-0" />
  );

const FileRow: FC<{
  item: AgentFileItem;
  busy: string | null;
  onChangeUse: (item: AgentFileItem, use: string) => void;
  onRemove: (item: AgentFileItem) => void;
  onCheckNow: (item: AgentFileItem) => void;
  onReplace: (item: AgentFileItem) => void;
}> = ({ item, busy, onChangeUse, onRemove, onCheckNow, onReplace }) => {
  const text = AGENT_FILE_USE_TEXT[item.use];
  const statusText = STATUS_TEXT[item.status] ?? item.statusMessage;
  return (
    <li className="flex items-start gap-2" data-testid="persona-file-item">
      <FileIcon item={item} />
      <div className="flex flex-col flex-1 min-w-0">
        <span className="text-sm break-all">
          {item.webUrl && isHttpsUrl(item.webUrl) ? (
            <a href={item.webUrl} target="_blank" rel="noopener noreferrer" className="underline">
              {item.name}
            </a>
          ) : (
            item.name
          )}
        </span>
        {statusText && (
          <span
            className={
              item.status === "ok" ? "text-xs text-muted-foreground" : "text-xs text-destructive"
            }
            data-testid="persona-file-status"
          >
            {statusText}
          </span>
        )}
        {item.status === "ok" && item.sizeBytes !== undefined && !item.isFolder && (
          <span className="text-xs text-muted-foreground">{formatSize(item.sizeBytes)}</span>
        )}
      </div>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="gap-1 shrink-0"
            title={text.help}
            aria-label={`${item.name}: ${text.label}. Change the use or remove.`}
            disabled={busy !== null}
            data-testid="persona-file-use"
          >
            {busy === item.ref.id ? <LoadingIndicator isLoading /> : null}
            {text.label}
            <ChevronDown size={14} />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="max-w-xs">
          <DropdownMenuLabel>Use</DropdownMenuLabel>
          <DropdownMenuRadioGroup value={item.use} onValueChange={(v) => onChangeUse(item, v)}>
            {item.allowedUses.map((use) => (
              <DropdownMenuRadioItem key={use} value={use}>
                <span className="flex flex-col">
                  <span>{AGENT_FILE_USE_TEXT[use].label}</span>
                  <span className="text-xs text-muted-foreground">{AGENT_FILE_USE_TEXT[use].help}</span>
                </span>
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
          <DropdownMenuSeparator />
          {item.linkedSkill && (
            <DropdownMenuItem onSelect={() => onCheckNow(item)}>Check now</DropdownMenuItem>
          )}
          {item.uploadedSkill && (
            <DropdownMenuItem onSelect={() => onReplace(item)}>Replace zip</DropdownMenuItem>
          )}
          <DropdownMenuItem onSelect={() => onRemove(item)}>Remove</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </li>
  );
};
