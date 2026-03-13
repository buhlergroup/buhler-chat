"use client";

import { FC } from "react";
import { ScrollArea } from "../ui/scroll-area";
import { AddNewPersona } from "./add-new-persona";
import { AgentList } from "./agent-list";
import { PersonaHero } from "./persona-hero/persona-hero";
import { PersonaModel } from "./persona-services/models";
import { ExtensionModel } from "../extensions-page/extension-services/models";

interface ChatPersonaProps {
  personas: PersonaModel[];
  extensions: ExtensionModel[];
  initialFavoriteIds: string[];
  currentUserId: string;
}

export const ChatPersonaPage: FC<ChatPersonaProps> = (props) => {
  return (
    <ScrollArea className="flex-1">
      <main className="flex flex-1 flex-col">
        <PersonaHero />
        <div className="container max-w-4xl py-8">
          <AgentList
            personas={props.personas}
            initialFavoriteIds={props.initialFavoriteIds}
            currentUserId={props.currentUserId}
            showContextMenu
          />
        </div>
        <AddNewPersona extensions={props.extensions} personas={props.personas} />
      </main>
    </ScrollArea>
  );
};
