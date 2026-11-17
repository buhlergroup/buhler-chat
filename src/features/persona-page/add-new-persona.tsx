"use client";

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
import { FindMissingExtensionIds } from "../extensions-page/extension-services/extension-service";
import {
  PersonaModel,
  DefaultTools,
  effectiveTrustLevel,
} from "./persona-services/models";
import { PersonaDocuments } from "./persona-documents/persona-documents";
import { CodeInterpreterDocuments } from "./persona-documents/code-interpreter-documents";
import { PersonaAccessGroup } from "./persona-access-group/persona-access-group";
import { TooltipProvider } from "@radix-ui/react-tooltip";
import { useResetableActionState } from "../common/hooks/useResetableActionState";
import { AdvancedLoadingIndicator } from "../ui/advanced-loading-indicator";
import { MODEL_CONFIGS, getAvailableModels, ModelConfig } from "../chat-page/chat-services/models";

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

  const [selectedModel, setSelectedModel] = useState<string>(
    persona.selectedModel || "__default__"
  );
  const [selectedSubAgentIds, setSelectedSubAgentIds] = useState<string[]>(
    [...(persona.subAgentIds || [])]
  );
  const [defaultTools, setDefaultTools] = useState<NonNullable<DefaultTools>>(
    persona.defaultTools || {}
  );
  const [availableModels, setAvailableModels] = useState<Record<string, ModelConfig>>(MODEL_CONFIGS);

  // Reset local state when persona changes
  useEffect(() => {
    setSelectedModel(persona.selectedModel || "__default__");
    setSelectedSubAgentIds([...(persona.subAgentIds || [])]);
    setDefaultTools(persona.defaultTools || {});
  }, [persona.id, persona.selectedModel, persona.subAgentIds, persona.defaultTools]);

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

  // Extensions this agent lists that their owner has deleted. The agent keeps
  // working without their tools; the notice lets the editor clean the list.
  const [missingExtensionIds, setMissingExtensionIds] = useState<string[]>([]);
  const extensionIdsKey = (persona.extensionIds ?? []).join(",");
  useEffect(() => {
    const ids = extensionIdsKey ? extensionIdsKey.split(",") : [];
    if (!isOpened || ids.length === 0) {
      setMissingExtensionIds([]);
      return;
    }
    let cancelled = false;
    FindMissingExtensionIds(ids)
      .then((response) => {
        if (!cancelled && response.status === "OK") setMissingExtensionIds(response.response);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [isOpened, extensionIdsKey]);

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
                <input
                  type="hidden"
                  name="defaultTools"
                  value={JSON.stringify(defaultTools)}
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
                  <Label>Default Tools</Label>
                  <p className="text-xs text-muted-foreground">
                    Tools enabled by default when a chat is started with this agent. Users can still toggle them in the chat.
                  </p>
                  <div className="flex flex-col gap-2 border rounded-md p-3">
                    <label className="flex items-center gap-2 cursor-pointer">
                      <input
                        type="checkbox"
                        className="h-4 w-4 rounded border-input"
                        checked={defaultTools.webSearch ?? false}
                        onChange={(e) =>
                          setDefaultTools((prev) => ({ ...prev, webSearch: e.target.checked }))
                        }
                      />
                      <span className="text-sm">Web Search</span>
                    </label>
                    <label className="flex items-center gap-2 cursor-pointer">
                      <input
                        type="checkbox"
                        className="h-4 w-4 rounded border-input"
                        checked={defaultTools.imageGeneration ?? false}
                        onChange={(e) =>
                          setDefaultTools((prev) => ({ ...prev, imageGeneration: e.target.checked }))
                        }
                      />
                      <span className="text-sm">Image Generation</span>
                    </label>
                    <label className="flex items-center gap-2 cursor-pointer">
                      <input
                        type="checkbox"
                        className="h-4 w-4 rounded border-input"
                        checked={defaultTools.companyContent ?? false}
                        onChange={(e) =>
                          setDefaultTools((prev) => ({ ...prev, companyContent: e.target.checked }))
                        }
                      />
                      <span className="text-sm">Company Content</span>
                    </label>
                    <label className="flex items-center gap-2 cursor-pointer">
                      <input
                        type="checkbox"
                        className="h-4 w-4 rounded border-input"
                        checked={defaultTools.codeInterpreter ?? false}
                        onChange={(e) =>
                          setDefaultTools((prev) => ({ ...prev, codeInterpreter: e.target.checked }))
                        }
                      />
                      <span className="text-sm">Code Interpreter</span>
                    </label>
                  </div>
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
                  {missingExtensionIds.length > 0 && (
                    <div
                      role="status"
                      className="flex items-center justify-between gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 p-2 text-xs"
                    >
                      <span>
                        {missingExtensionIds.length === 1
                          ? "1 extension was deleted by its owner. The agent works without its tools."
                          : `${missingExtensionIds.length} extensions were deleted by their owners. The agent works without their tools.`}
                      </span>
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={() => {
                          missingExtensionIds.forEach((id) => personaStore.removeExtension(id));
                          setMissingExtensionIds([]);
                        }}
                      >
                        Remove from list
                      </Button>
                    </div>
                  )}
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
                  initialIsPublished={persona.isPublished}
                  trustLevel={effectiveTrustLevel(persona)}
                />
                <PersonaDocuments
                  initialPersonaDocumentIds={persona.personaDocumentIds || []}
                />
                <CodeInterpreterDocuments
                  initialCIDocumentIds={persona.codeInterpreterDocumentIds || []}
                />
              </div>
            </ScrollArea>
            <SheetFooter className="py-2 flex justify-end flex-row">
              <Submit isLoading={isLoading} />
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
