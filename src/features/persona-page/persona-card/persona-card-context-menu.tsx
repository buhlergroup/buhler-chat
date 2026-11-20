"use client";

import { DropdownMenuItemWithIcon } from "@/features/chat-page/chat-menu/chat-menu-item";
import { RevalidateCache } from "@/features/common/navigation-helpers";
import { LoadingIndicator } from "@/features/ui/loading";
import {
  BadgeCheck,
  BadgeX,
  MoreVertical,
  Pencil,
  Store,
  Trash,
} from "lucide-react";
import { FC, useState } from "react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "../../ui/dropdown-menu";
import { effectiveTrustLevel, PersonaModel } from "../persona-services/models";
import {
  SetAgentTrustLevel,
  UnpublishAgent,
} from "../persona-services/agent-trust-service";
import { DeletePersona } from "../persona-services/persona-service";
import { personaStore } from "../persona-store";
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

interface Props {
  persona: PersonaModel;
  /** Owner/admin actions (edit, delete). */
  showOwnerActions?: boolean;
  /** Governance actions on published agents (verify/downgrade/unpublish). */
  isVerifier?: boolean;
}

type DropdownAction = "delete" | "verify" | "downgrade" | "unpublish";

/** Actions that ask first, in the app's own dialog (not window.confirm). */
type ConfirmedAction = "delete" | "unpublish";

export const deleteAgentText = (name: string) =>
  `Delete the agent "${name}"? Its files, skills and folder links are removed from the agent. Chats that already used it stay.`;

export const unpublishAgentText = (name: string) =>
  `Unpublish the agent "${name}" for the whole organization? Only the owner will still see it.`;

const CONFIRM: Record<ConfirmedAction, { title: string; button: string; text: (name: string) => string }> = {
  delete: { title: "Delete agent", button: "Delete", text: deleteAgentText },
  unpublish: { title: "Unpublish agent", button: "Unpublish", text: unpublishAgentText },
};

export const PersonaCardContextMenu: FC<Props> = (props) => {
  const { persona, showOwnerActions = true, isVerifier = false } = props;
  const { isLoading, handleAction } = useDropdownAction({ persona });
  const [confirm, setConfirm] = useState<ConfirmedAction | null>(null);

  const trustLevel = effectiveTrustLevel(persona);
  const showVerifierActions = isVerifier && persona.isPublished;

  if (!showOwnerActions && !showVerifierActions) return null;

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger>
          {isLoading ? (
            <LoadingIndicator isLoading={isLoading} />
          ) : (
            <MoreVertical size={18} />
          )}
        </DropdownMenuTrigger>
        <DropdownMenuContent>
          {showOwnerActions && (
            <>
              <DropdownMenuItemWithIcon
                onClick={() => personaStore.updatePersona(persona)}
              >
                <Pencil size={18} />
                <span>Edit</span>
              </DropdownMenuItemWithIcon>
              <DropdownMenuItemWithIcon
                onClick={() => setConfirm("delete")}
              >
                <Trash size={18} />
                <span>Delete</span>
              </DropdownMenuItemWithIcon>
            </>
          )}
          {showOwnerActions && showVerifierActions && <DropdownMenuSeparator />}
          {showVerifierActions && (
            <>
              {trustLevel === "community" ? (
                <DropdownMenuItemWithIcon
                  onClick={async () => await handleAction("verify")}
                >
                  <BadgeCheck size={18} />
                  <span>Mark as Verified</span>
                </DropdownMenuItemWithIcon>
              ) : (
                <DropdownMenuItemWithIcon
                  onClick={async () => await handleAction("downgrade")}
                >
                  <BadgeX size={18} />
                  <span>Downgrade to Community</span>
                </DropdownMenuItemWithIcon>
              )}
              <DropdownMenuItemWithIcon
                onClick={() => setConfirm("unpublish")}
              >
                <Store size={18} />
                <span>Unpublish agent</span>
              </DropdownMenuItemWithIcon>
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
      <Dialog open={confirm !== null} onOpenChange={(open) => !open && setConfirm(null)}>
        <DialogContent data-testid="persona-card-confirm">
          <DialogHeader>
            <DialogTitle>{confirm ? CONFIRM[confirm].title : ""}</DialogTitle>
            <DialogDescription>{confirm ? CONFIRM[confirm].text(persona.name) : ""}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              type="button"
              variant="destructive"
              onClick={async () => {
                const action = confirm;
                setConfirm(null);
                if (action) await handleAction(action);
              }}
            >
              {confirm ? CONFIRM[confirm].button : ""}
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
};

const useDropdownAction = (props: { persona: PersonaModel }) => {
  const { persona } = props;
  const [isLoading, setIsLoading] = useState(false);

  const revalidate = () => {
    RevalidateCache({
      page: "persona",
    });
    RevalidateCache({
      page: "agent",
    });
  };

  const handleAction = async (action: DropdownAction) => {
    setIsLoading(true);
    switch (action) {
      // Delete and unpublish run after the dialog of the menu (confirmed).
      case "delete":
        await DeletePersona(persona.id);
        revalidate();
        break;
      case "verify":
        await SetAgentTrustLevel(persona.id, "verified");
        revalidate();
        break;
      case "downgrade":
        await SetAgentTrustLevel(persona.id, "community");
        revalidate();
        break;
      case "unpublish":
        await UnpublishAgent(persona.id);
        revalidate();
        break;
    }
    setIsLoading(false);
  };

  return {
    isLoading,
    handleAction,
  };
};
