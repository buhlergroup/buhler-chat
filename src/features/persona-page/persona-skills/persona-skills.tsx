"use client";

import { FC, useCallback, useEffect, useRef, useState } from "react";
import { Label } from "@/features/ui/label";
import { Button } from "@/features/ui/button";
import { LoadingIndicator } from "@/features/ui/loading";
import { toast } from "@/features/ui/use-toast";
import { Puzzle, RefreshCw, Trash, Upload } from "lucide-react";
import {
  DeletePersonaSkill,
  FindPersonaSkills,
  UploadPersonaSkill,
} from "../persona-services/skills/persona-skill-service";
import {
  SKILL_LIMITS,
  type PersonaSkillSummary,
} from "../persona-services/skills/skill-models";

interface Props {
  /** Empty for an agent that is not saved yet. */
  personaId: string;
}

const formatSize = (bytes: number): string =>
  bytes >= 1_000_000
    ? `${(bytes / 1_000_000).toFixed(1)} MB`
    : `${Math.max(1, Math.round(bytes / 1000))} KB`;

/**
 * Skills of an agent: upload a skill .zip (Agent Skills format), list,
 * replace and delete. Uploads run immediately through their own server
 * actions, independent of the agent's Save button. The server decides who
 * may change skills (owner only); the editor only hides the buttons.
 */
export const PersonaSkills: FC<Props> = ({ personaId }) => {
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
        Upload a skill as .zip with SKILL.md (Agent Skills format). The agent
        loads a skill when a task needs it. Up to{" "}
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
                  </div>
                  {canEdit && (
                    <div className="flex gap-1 shrink-0">
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
            </>
          )}
        </>
      )}
    </div>
  );
};
