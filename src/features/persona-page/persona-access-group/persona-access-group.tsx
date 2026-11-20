import { Label } from "@/features/ui/label";
import { FC, ReactNode, useEffect, useState } from "react";
import { PersonaAccessGroupSelector } from "./persona-access-group-selector";
import { AccessGroup, TrustLevel } from "../persona-services/models";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/features/ui/tooltip";
import { Info, Trash } from "lucide-react";
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
  /** Shown while the agent is shared with a group or published. */
  sharedNotice?: ReactNode;
}

export const PersonaAccessGroup: FC<Props> = (props) => {
  const [selectedGroup, setSelectedGroup] = useState<AccessGroup | null>();
  const [isPublished, setIsPublished] = useState(props.initialIsPublished);
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
    return "Only you can access this agent";
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
      {(isPublished || !!selectedGroup) && props.sharedNotice}
    </div>
  );
};
