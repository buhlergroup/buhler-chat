import { Label } from "@/features/ui/label";
import { FC, ReactNode, useEffect, useState } from "react";
import { PersonaAccessGroupSelector } from "./persona-access-group-selector";
import { AccessGroup, TrustLevel } from "../persona-services/models";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/features/ui/tooltip";
import { Check, Info, Link as LinkIcon, Trash } from "lucide-react";
import { Button } from "@/features/ui/button";
import { Switch } from "@/features/ui/switch";
import { AccessGroupById } from "../persona-services/access-group-service";
import { logoutOnSessionExpired } from "@/features/auth-page/logout-on-session-expired";
import { TrustBadge } from "../persona-card/trust-badge";

interface Props {
  initialSelectedGroup: string | null;
  initialIsPublished: boolean;
  /** Effective trust tier when the agent is already published, else null. */
  trustLevel: TrustLevel | null;
  /** Stored "Anyone with the link can use this agent" value; on unless false. */
  initialLinkAccess?: boolean;
  /** Id of the saved agent; empty for a new agent (no link to copy yet). */
  personaId?: string;
  /** Shown while the agent is shared with a group, by link, or published. */
  sharedNotice?: ReactNode;
}

export const PersonaAccessGroup: FC<Props> = (props) => {
  const [selectedGroup, setSelectedGroup] = useState<AccessGroup | null>();
  const [isPublished, setIsPublished] = useState(props.initialIsPublished);
  const [linkAccess, setLinkAccess] = useState(props.initialLinkAccess !== false);
  const [linkCopied, setLinkCopied] = useState(false);
  const [isLoading, setIsLoading] = useState(false);

  useEffect(() => {
    const fetchGroupDetails = async () => {
      if (!props.initialSelectedGroup) return;
      setIsLoading(true);
      const response = await AccessGroupById(props.initialSelectedGroup);
      if (logoutOnSessionExpired(response)) {
        setIsLoading(false);
        return;
      }
      if (response.status === "OK") {
        setSelectedGroup(response.response);
      } else {
        setSelectedGroup(null);
      }
      setIsLoading(false);
    };

    fetchGroupDetails();
  }, [props.initialSelectedGroup]);

  // Publishing supersedes group sharing: everyone has access anyway, so the
  // group selection is deactivated while the agent is published.
  const accessSummary = () => {
    if (isPublished) return "Published — everyone can use this agent";
    if (selectedGroup) return selectedGroup.name;
    if (linkAccess) return "Everyone with the link can use this agent";
    return "Only you can access this agent";
  };

  // Link access has no effect while the agent is published (everyone can use
  // it) or shared with a group (only its members can use it). The stored
  // value is kept, so the switch is disabled, not reset.
  const linkAccessDisabled = isPublished || !!selectedGroup;

  const copyAgentLink = async () => {
    if (!props.personaId) return;
    await navigator.clipboard.writeText(
      `${window.location.origin}/agent/${props.personaId}/chat`
    );
    setLinkCopied(true);
    setTimeout(() => setLinkCopied(false), 2000);
  };

  return (
    <div className="grid gap-2">
      <div className="flex items-center space-x-2 justify-between">
        <div className="flex items-center space-x-4">
          <Label>Access to Agent</Label>
          <Tooltip>
            <TooltipTrigger asChild>
              <Info size={15} />
            </TooltipTrigger>
            <TooltipContent>
              <p>Defines who can view your agent</p>
            </TooltipContent>
          </Tooltip>
        </div>
        <div className="flex items-center space-x-2">
          <Button
            variant={"ghost"}
            type="button"
            size={"icon"}
            className="disabled:cursor-not-allowed"
            disabled={!selectedGroup || isPublished}
            onClick={() => setSelectedGroup(null)}
          >
            <Trash size={15} className="text-red-600" />
          </Button>
          <PersonaAccessGroupSelector
            onSelectGroup={(e: any) => setSelectedGroup(e)}
            selectedAccessGroupId={selectedGroup?.id ?? ""}
            disabled={isPublished}
          />
        </div>
      </div>
      <div className="flex items-center space-x-2">
        <div className="border border-input bg-background rounded-md p-2 flex items-center w-full">
          {isLoading ? (
            <div className="animate-pulse w-full h-4 bg-muted rounded-md" />
          ) : (
            <input
              value={accessSummary()}
              readOnly
              className={`w-full bg-transparent ${
                selectedGroup ? "" : "text-muted-foreground"
              }`}
              disabled
            />
          )}
          {/* Bc disabled input fields won't be recognised in a form. */}
          <input
            name="accessGroupId"
            value={selectedGroup?.id ?? ""}
            type="hidden"
          />
        </div>
      </div>
      {/* Publishing is part of access: fresh publishes start as "community"
          — see persona-service. */}
      <div className="flex items-center gap-2 pt-1">
        <Switch
          id="isPublished"
          name="isPublished"
          checked={isPublished}
          onCheckedChange={setIsPublished}
        />
        <Label
          htmlFor="isPublished"
          className="text-muted-foreground font-normal"
        >
          Publish to the whole organization
        </Label>
        {props.trustLevel && <TrustBadge level={props.trustLevel} />}
      </div>
      <div className="flex items-center gap-2">
        <Switch
          id="linkAccess"
          name="linkAccess"
          checked={linkAccess}
          onCheckedChange={setLinkAccess}
          disabled={linkAccessDisabled}
        />
        {/* A disabled switch is not sent with the form: keep the stored value. */}
        {linkAccessDisabled && linkAccess && (
          <input type="hidden" name="linkAccess" value="on" />
        )}
        <Label
          htmlFor="linkAccess"
          className="text-muted-foreground font-normal"
        >
          Anyone with the link can use this agent
        </Label>
        {props.personaId && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-7 gap-1 px-2 text-xs"
            onClick={copyAgentLink}
          >
            {linkCopied ? <Check size={14} /> : <LinkIcon size={14} />}
            {linkCopied ? "Copied" : "Copy link"}
          </Button>
        )}
      </div>
      {!isPublished && !!selectedGroup && (
        <p className="text-xs text-muted-foreground">
          A share group is set: only its members can use the agent.
        </p>
      )}
      {(isPublished || !!selectedGroup || linkAccess) && props.sharedNotice}
    </div>
  );
};
