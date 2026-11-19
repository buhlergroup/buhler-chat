"use client";

import { FC, useCallback, useEffect, useRef, useState } from "react";
import { useSession } from "next-auth/react";
import { Label } from "@/features/ui/label";
import { Button } from "@/features/ui/button";
import { LoadingIndicator } from "@/features/ui/loading";
import { toast } from "@/features/ui/use-toast";
import { Cloud, Puzzle, RefreshCw, RotateCw, Trash, Upload } from "lucide-react";
import {
  CheckPersonaSkillNow,
  DeletePersonaSkill,
  FindPersonaSkills,
  LinkPersonaSkillFromSharePoint,
  UploadPersonaSkill,
} from "../persona-services/skills/persona-skill-service";
import {
  SKILL_LIMITS,
  isHttpsUrl,
  type PersonaSkillSummary,
} from "../persona-services/skills/skill-models";
import type { SharePointFile } from "../persona-services/models";
import { CodeInterpreterFilePicker } from "../persona-documents/code-interpreter-file-picker";

interface Props {
  /** Empty for an agent that is not saved yet. */
  personaId: string;
}

const formatSize = (bytes: number): string =>
  bytes >= 1_000_000
    ? `${(bytes / 1_000_000).toFixed(1)} MB`
    : `${Math.max(1, Math.round(bytes / 1000))} KB`;

const formatDate = (iso: string): string => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleString();
};

const SHAREPOINT_URL = process.env.NEXT_PUBLIC_SHAREPOINT_URL ?? "";

/**
 * Skills of an agent: upload a skill .zip (Agent Skills format) or link a
 * .zip in SharePoint, list, replace, check and delete. Changes run
 * immediately through their own server actions, independent of the agent's
 * Save button. The server decides who may change skills (owner or admin);
 * the editor only hides the buttons.
 */
export const PersonaSkills: FC<Props> = ({ personaId }) => {
  const { data: session } = useSession();
  const [skills, setSkills] = useState<PersonaSkillSummary[]>([]);
  const [canEdit, setCanEdit] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const replaceTarget = useRef<string | undefined>(undefined);

  const refresh = useCallback(async () => {
    if (!personaId) return;
    const res = await FindPersonaSkills(personaId);
    if (res.status === "OK") {
      setSkills(res.response.skills);
      setCanEdit(res.response.canEdit);
    }
  }, [personaId]);

  useEffect(() => {
    setSkills([]);
    setCanEdit(false);
    refresh();
  }, [refresh]);

  const pickFile = (replaceSkillId?: string) => {
    replaceTarget.current = replaceSkillId;
    fileInput.current?.click();
  };

  const onFile = async (file: File | undefined) => {
    if (!file) return;
    if (file.size > SKILL_LIMITS.maxZipBytes) {
      toast({
        title: "Skill",
        description: `Choose a zip of up to ${SKILL_LIMITS.maxZipBytes / 1_000_000} MB.`,
        variant: "destructive",
      });
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
        toast({ title: "Skill", description: `Skill "${res.response.name}" saved.` });
        await refresh();
      } else {
        toast({
          title: "Skill",
          description: res.errors.map((e) => e.message).join(" "),
          variant: "destructive",
        });
      }
    } finally {
      setBusy(null);
      replaceTarget.current = undefined;
      if (fileInput.current) fileInput.current.value = "";
    }
  };

  const showErrors = (errors: { message: string }[]) =>
    toast({
      title: "Skill",
      description: errors.map((e) => e.message).join(" "),
      variant: "destructive",
    });

  const onSharePointPicked = async (files: SharePointFile[]) => {
    const file = files[0];
    if (!file) return;
    setBusy("sharepoint");
    try {
      const res = await LinkPersonaSkillFromSharePoint({
        personaId,
        driveId: file.parentReference.driveId,
        itemId: file.documentId,
      });
      if (res.status === "OK") {
        toast({
          title: "Skill",
          description: `Skill "${res.response.name}" added. It uses the latest file from SharePoint.`,
        });
        await refresh();
      } else {
        showErrors(res.errors);
      }
    } finally {
      setBusy(null);
    }
  };

  const onCheckNow = async (skill: PersonaSkillSummary) => {
    setBusy(skill.id);
    try {
      const res = await CheckPersonaSkillNow(personaId, skill.id);
      if (res.status !== "OK") {
        showErrors(res.errors);
        return;
      }
      const { result, skill: checked } = res.response;
      if (result === "invalid") {
        toast({
          title: "Skill",
          description: `The latest file is not a valid skill: ${checked.source?.syncError ?? ""} Chats use the last good version.`,
          variant: "destructive",
        });
      } else {
        toast({
          title: "Skill",
          description:
            result === "updated"
              ? `Skill "${checked.name}" now uses the latest file.`
              : `Skill "${checked.name}" uses the latest file.`,
        });
      }
      await refresh();
    } finally {
      setBusy(null);
    }
  };

  const onDelete = async (skill: PersonaSkillSummary) => {
    setBusy(skill.id);
    try {
      const res = await DeletePersonaSkill(personaId, skill.id);
      if (res.status === "OK") {
        setSkills((prev) => prev.filter((s) => s.id !== skill.id));
      } else {
        toast({
          title: "Skill",
          description: res.errors.map((e) => e.message).join(" "),
          variant: "destructive",
        });
      }
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="grid gap-2" data-testid="persona-skills">
      <Label>Skills</Label>
      <p className="text-xs text-muted-foreground">
        Upload a skill as .zip with SKILL.md (Agent Skills format), or add a
        .zip from SharePoint to always use its latest version. The agent loads
        a skill when a task needs it. Up to{" "}
        {SKILL_LIMITS.maxZipBytes / 1_000_000} MB and {SKILL_LIMITS.maxFiles}{" "}
        files per skill.
      </p>
      {!personaId ? (
        <p className="text-xs text-muted-foreground">
          Save the agent to add skills.
        </p>
      ) : (
        <>
          {skills.length > 0 && (
            <ul className="flex flex-col gap-2 border rounded-md p-2">
              {skills.map((skill) => (
                <li
                  key={skill.id}
                  className="flex items-start gap-2"
                  data-testid="persona-skill-item"
                >
                  <Puzzle size={16} className="mt-1 shrink-0" />
                  <div className="flex flex-col flex-1 min-w-0">
                    <span className="text-sm font-medium break-all">{skill.name}</span>
                    <span className="text-xs text-muted-foreground line-clamp-2">
                      {skill.description}
                    </span>
                    <span className="text-xs text-muted-foreground">
                      {formatSize(skill.zipBytes)} · {skill.fileCount} files
                    </span>
                    {skill.source && (
                      <>
                        <span
                          className="text-xs text-muted-foreground break-all"
                          data-testid="persona-skill-source"
                        >
                          SharePoint ·{" "}
                          {isHttpsUrl(skill.source.webUrl) ? (
                            <a
                              href={skill.source.webUrl}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="underline"
                            >
                              {skill.source.fileName}
                            </a>
                          ) : (
                            skill.source.fileName
                          )}
                          {formatDate(skill.source.lastModifiedDateTime) &&
                            ` · Last updated ${formatDate(skill.source.lastModifiedDateTime)}`}
                        </span>
                        <span className="text-xs text-muted-foreground">
                          Uses the latest file from SharePoint.
                        </span>
                        {skill.source.syncError && (
                          <span
                            className="text-xs text-destructive"
                            data-testid="persona-skill-sync-error"
                          >
                            The latest file is not in use: {skill.source.syncError} Chats
                            use the last good version.
                          </span>
                        )}
                      </>
                    )}
                  </div>
                  {canEdit && (
                    <div className="flex gap-1 shrink-0">
                      {skill.source ? (
                        <Button
                          type="button"
                          size="icon"
                          variant="ghost"
                          title="Check now"
                          aria-label={`Check ${skill.name} now`}
                          disabled={busy !== null}
                          onClick={() => onCheckNow(skill)}
                        >
                          {busy === skill.id ? <LoadingIndicator isLoading /> : <RotateCw size={16} />}
                        </Button>
                      ) : (
                        <Button
                          type="button"
                          size="icon"
                          variant="ghost"
                          title="Replace"
                          aria-label={`Replace ${skill.name}`}
                          disabled={busy !== null}
                          onClick={() => pickFile(skill.id)}
                        >
                          {busy === skill.id ? <LoadingIndicator isLoading /> : <RefreshCw size={16} />}
                        </Button>
                      )}
                      <Button
                        type="button"
                        size="icon"
                        variant="ghost"
                        title="Delete"
                        aria-label={`Delete ${skill.name}`}
                        disabled={busy !== null}
                        onClick={() => onDelete(skill)}
                      >
                        <Trash size={16} />
                      </Button>
                    </div>
                  )}
                </li>
              ))}
            </ul>
          )}
          {canEdit && (
            <>
              <input
                ref={fileInput}
                type="file"
                accept=".zip,application/zip"
                className="hidden"
                data-testid="persona-skill-file"
                onChange={(e) => onFile(e.target.files?.[0])}
              />
              <div className="flex flex-wrap gap-2">
                <Button
                  type="button"
                  variant="outline"
                  className="gap-2 w-fit"
                  disabled={busy !== null || skills.length >= SKILL_LIMITS.maxSkillsPerAgent}
                  onClick={() => pickFile()}
                >
                  {busy === "upload" ? <LoadingIndicator isLoading /> : <Upload size={16} />}
                  Upload skill (.zip)
                </Button>
                {SHAREPOINT_URL && (
                  <CodeInterpreterFilePicker
                    tenantUrl={SHAREPOINT_URL}
                    token={session?.user?.accessToken ?? ""}
                    onFilesSelected={onSharePointPicked}
                    filters={[".zip"]}
                    single
                    title="Add a skill from SharePoint"
                    description="Choose a skill .zip with SKILL.md. Chats always use the latest version of the file."
                    trigger={(open) => (
                      <Button
                        type="button"
                        variant="outline"
                        className="gap-2 w-fit"
                        disabled={
                          busy !== null || skills.length >= SKILL_LIMITS.maxSkillsPerAgent
                        }
                        onClick={open}
                      >
                        {busy === "sharepoint" ? (
                          <LoadingIndicator isLoading />
                        ) : (
                          <Cloud size={16} />
                        )}
                        Add from SharePoint
                      </Button>
                    )}
                  />
                )}
              </div>
            </>
          )}
        </>
      )}
    </div>
  );
};
