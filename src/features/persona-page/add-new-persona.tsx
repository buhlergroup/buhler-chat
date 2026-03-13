"use client";

import { useSession } from "next-auth/react";
import { FC, startTransition, useState, useEffect } from "react";
import { ServerActionResponse } from "../common/server-action-response";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { LoadingIndicator } from "../ui/loading";
import { ScrollArea } from "../ui/scroll-area";
import {
  Sheet,
  SheetContent,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "../ui/sheet";
import { Switch } from "../ui/switch";
import { Textarea } from "../ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../ui/select";
import {
  AddOrUpdatePersona,
  personaStore,
  usePersonaState,
} from "./persona-store";
import { ExtensionDetail } from "../chat-page/chat-header/extension-detail";
import { ExtensionModel } from "../extensions-page/extension-services/models";
import { PersonaModel } from "./persona-services/models";
import { PersonaDocuments } from "./persona-documents/persona-documents";
import { CodeInterpreterDocuments } from "./persona-documents/code-interpreter-documents";
import { PersonaAccessGroup } from "./persona-access-group/persona-access-group";
import { TooltipProvider } from "@radix-ui/react-tooltip";
import { useResetableActionState } from "../common/hooks/useResetableActionState";
import { AdvancedLoadingIndicator } from "../ui/advanced-loading-indicator";
import { MODEL_CONFIGS, getAvailableModels, ChatModel, ModelConfig } from "../chat-page/chat-services/models";

interface Props {
  extensions: Array<ExtensionModel>;
  personas: Array<PersonaModel>;
}

export const AddNewPersona: FC<Props> = (props) => {
  const initialState: ServerActionResponse | undefined = undefined;

  const { isOpened, persona } = usePersonaState();

  const [state, submit, reset, isLoading] = useResetableActionState(
    AddOrUpdatePersona,
    initialState
  );

  const { data } = useSession();

  const [selectedModel, setSelectedModel] = useState<string>(
    persona.selectedModel || "__default__"
  );
  const [selectedSubAgentIds, setSelectedSubAgentIds] = useState<string[]>(
    [...(persona.subAgentIds || [])]
  );
  const [availableModels, setAvailableModels] = useState<Record<string, ModelConfig>>(MODEL_CONFIGS);

  // Reset local state when persona changes
  useEffect(() => {
    setSelectedModel(persona.selectedModel || "__default__");
    setSelectedSubAgentIds([...(persona.subAgentIds || [])]);
  }, [persona.id, persona.selectedModel, persona.subAgentIds]);

  useEffect(() => {
    const fetchModels = async () => {
      try {
        const models = await getAvailableModels();
        setAvailableModels(models);
      } catch {
        setAvailableModels(MODEL_CONFIGS);
      }
    };
    fetchModels();
  }, []);

  const toggleSubAgent = (agentId: string) => {
    setSelectedSubAgentIds((prev) =>
      prev.includes(agentId)
        ? prev.filter((id) => id !== agentId)
        : [...prev, agentId]
    );
  };

  // Filter out the current persona from the sub-agent list to prevent self-reference
  const availableSubAgents = props.personas.filter(
    (p) => p.id !== persona.id
  );

  const PublicSwitch = () => {
    if (data === undefined || data === null) return null;

    if (data?.user?.isAdmin) {
      return (
        <div className="flex items-center space-x-2">
          <Switch name="isPublished" defaultChecked={persona.isPublished} />
          <Label htmlFor="description">Publish</Label>
        </div>
      );
    }
  };

  return (
    <Sheet
      open={isOpened}
      onOpenChange={(value) => {
        if (!isLoading) {
          personaStore.updateOpened(value);
          startTransition(() => {
            reset();
          });
        }
      }}
    >
      <SheetContent className="min-w-[480px] sm:w-[540px] flex flex-col">
        <SheetHeader>
          <SheetTitle>Agent</SheetTitle>
          {state && state.status === "OK" ? null : (
            <>
              {state &&
                state.errors.map((error, index) => (
                  <div key={index} className="text-red-500">
                    {error.message}
                  </div>
                ))}
            </>
          )}
        </SheetHeader>
        <TooltipProvider>
          <form action={submit} className="flex-1 flex flex-col">
            <ScrollArea
              className="flex-1 -mx-6 flex max-h-[calc(100vh-140px)]"
              type="always"
            >
              <div className="pb-6 px-6 flex gap-8 flex-col  flex-1">
                <input type="hidden" name="id" defaultValue={persona.id} />
                <input
                  type="hidden"
                  name="subAgentIds"
                  value={JSON.stringify(selectedSubAgentIds)}
                />
                <div className="grid gap-2">
                  <Label>Name</Label>
                  <Input
                    type="text"
                    required
                    name="name"
                    defaultValue={persona.name}
                    placeholder="Name of your agent"
                  />
                </div>
                <div className="grid gap-2">
                  <Label htmlFor="description">Short description</Label>
                  <Textarea
                    className="min-h-[200px]"
                    required
                    defaultValue={persona.description}
                    name="description"
                    placeholder="Short description"
                  />
                </div>
                <div className="grid gap-2 flex-1 ">
                  <Label htmlFor="personaMessage">Instructions</Label>
                  <Textarea
                    className="min-h-[300px]"
                    required
                    defaultValue={persona.personaMessage}
                    name="personaMessage"
                    placeholder="Instructions for your agent"
                  />
                </div>
                <div className="grid gap-2">
                  <Label>Model</Label>
                  <input
                    type="hidden"
                    name="selectedModel"
                    value={selectedModel === "__default__" ? "" : selectedModel}
                  />
                  <Select
                    value={selectedModel}
                    onValueChange={setSelectedModel}
                  >
                    <SelectTrigger>
                      <SelectValue placeholder="Use default model" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="__default__">Use default model</SelectItem>
                      {Object.values(availableModels).map((model) => (
                        <SelectItem key={model.id} value={model.id}>
                          {model.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <p className="text-xs text-muted-foreground">
                    Optionally set a specific model for this agent. If not set, the model selected by the user at chat time will be used.
                  </p>
                </div>
                <div className="grid gap-2">
                  <Label htmlFor="extensionIds[]">Extensions</Label>
                  <input
                    type="hidden"
                    name="extensionIds[]"
                    value={persona.extensionIds}
                  />
                  <ExtensionDetail
                    disabled={false}
                    extensions={props.extensions}
                    installedExtensionIds={
                      persona.extensionIds?.map((e) => e) || []
                    }
                    chatThreadId={persona.id}
                    parent="persona"
                  />
                </div>
                {availableSubAgents.length > 0 && (
                  <div className="grid gap-2">
                    <Label>Sub-Agents</Label>
                    <p className="text-xs text-muted-foreground">
                      Select agents that this agent can delegate tasks to. Only agents you have access to are shown.
                    </p>
                    <div className="flex flex-col gap-2 max-h-[200px] overflow-y-auto border rounded-md p-2">
                      {availableSubAgents.map((agent) => (
                        <label
                          key={agent.id}
                          className="flex items-center gap-2 cursor-pointer hover:bg-accent rounded p-1"
                        >
                          <input
                            type="checkbox"
                            className="h-4 w-4 rounded border-input"
                            checked={selectedSubAgentIds.includes(agent.id)}
                            onChange={() => toggleSubAgent(agent.id)}
                          />
                          <div className="flex flex-col">
                            <span className="text-sm font-medium">
                              {agent.name}
                            </span>
                            <span className="text-xs text-muted-foreground line-clamp-1">
                              {agent.description}
                            </span>
                          </div>
                        </label>
                      ))}
                    </div>
                  </div>
                )}
                <PersonaAccessGroup
                  initialSelectedGroup={persona.accessGroup?.id || null}
                />
                <PersonaDocuments
                  initialPersonaDocumentIds={persona.personaDocumentIds || []}
                />
                <CodeInterpreterDocuments
                  initialCIDocumentIds={persona.codeInterpreterDocumentIds || []}
                />
              </div>
            </ScrollArea>
            <SheetFooter className="py-2 flex sm:justify-between flex-row">
              <PublicSwitch /> <Submit isLoading={isLoading} />
            </SheetFooter>
          </form>
        </TooltipProvider>
      </SheetContent>
    </Sheet>
  );
};

function Submit({ isLoading }: { isLoading: boolean }) {
  return (
    <div className="flex items-center space-x-4">
      <Button disabled={isLoading} className="gap-2">
        <LoadingIndicator isLoading={isLoading} />
        Save
      </Button>
      <AdvancedLoadingIndicator
        isLoading={isLoading}
        interval={2500}
        loadingMessages={[
          "Checking Documents...",
          "Searching for Documents...",
          "Translating Documents...",
          "Indexing Documents...",
          "Almost there...",
          "Big documents take time...",
          "Just a moment...",
          "Hang tight...",
          "Processing your request...",
          "Analyzing content...",
          "Finalizing setup...",
          "Loading resources...",
          "Wrapping things up...",
          "Preparing your results...",
          "Tidying up the details...",
          "Double-checking info...",
          "Synchronizing...",
          "Fetching additional data...",
          "Reviewing documents...",
          "Securing data...",
          "Hold on, almost finished...",
          "Making progress...",
          "One last check...",
          "Taking longer than expected...",
        ]
        }
        />
    </div>
  );
}
