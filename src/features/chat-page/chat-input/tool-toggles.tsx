"use client";

import { Button } from "@/features/ui/button";
import { Globe, ImageIcon, Building2, Code2 } from "lucide-react";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/features/ui/tooltip";
import { useChatStore, useChatSession } from "../chat-store-context";
import { cn } from "@/ui/lib";

export const ToolToggles = () => {
  const webSearchEnabled = useChatStore((s) => s.webSearchEnabled);
  const imageGenerationEnabled = useChatStore((s) => s.imageGenerationEnabled);
  const companyContentEnabled = useChatStore((s) => s.companyContentEnabled);
  const codeInterpreterEnabled = useChatStore((s) => s.codeInterpreterEnabled);
  const toggleWebSearch = useChatStore((s) => s.toggleWebSearch);
  const toggleImageGeneration = useChatStore((s) => s.toggleImageGeneration);
  const toggleCompanyContent = useChatStore((s) => s.toggleCompanyContent);
  const toggleCodeInterpreter = useChatStore((s) => s.toggleCodeInterpreter);
  const { status } = useChatSession();
  const loading = status === "streaming" || status === "submitted" ? "loading" : "ready";

  return (
    <div className="flex gap-1 items-center">
      <TooltipProvider>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              type="button"
              aria-label="Web search"
              aria-pressed={webSearchEnabled}
              variant={webSearchEnabled ? "default" : "ghost"}
              size={webSearchEnabled ? "sm" : "icon"}
              className={cn("h-8", webSearchEnabled ? "bg-primary text-primary-foreground gap-1 px-2" : "w-8")}
              onClick={() => toggleWebSearch(!webSearchEnabled)}
              disabled={loading === "loading"}
            >
              <Globe className="h-4 w-4 shrink-0" />
              {webSearchEnabled && <span className="text-xs">Web</span>}
            </Button>
          </TooltipTrigger>
          <TooltipContent 
            side="top" 
            align="start" 
            sideOffset={5} 
            collisionPadding={{ left: 16, right: 16, top: 8, bottom: 8 }}
            avoidCollisions={true}
          >
            <p>Web Search</p>
            <p className="text-xs text-muted-foreground">
              Search the web for real-time information
            </p>
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>

      <TooltipProvider>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              type="button"
              aria-label="Image generation"
              aria-pressed={imageGenerationEnabled}
              variant={imageGenerationEnabled ? "default" : "ghost"}
              size={imageGenerationEnabled ? "sm" : "icon"}
              className={cn("h-8", imageGenerationEnabled ? "bg-primary text-primary-foreground gap-1 px-2" : "w-8")}
              onClick={() => toggleImageGeneration(!imageGenerationEnabled)}
              disabled={loading === "loading"}
            >
              <ImageIcon className="h-4 w-4 shrink-0" />
              {imageGenerationEnabled && <span className="text-xs">Image</span>}
            </Button>
          </TooltipTrigger>
          <TooltipContent 
            side="top" 
            align="start" 
            sideOffset={5} 
            collisionPadding={{ left: 16, right: 16, top: 8, bottom: 8 }}
            avoidCollisions={true}
          >
            <p>Image Generation</p>
            <p className="text-xs text-muted-foreground">
              Generate images
            </p>
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>

      <TooltipProvider>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              type="button"
              aria-label="Company content"
              aria-pressed={companyContentEnabled}
              variant={companyContentEnabled ? "default" : "ghost"}
              size={companyContentEnabled ? "sm" : "icon"}
              className={cn("h-8", companyContentEnabled ? "bg-primary text-primary-foreground gap-1 px-2" : "w-8")}
              onClick={() => toggleCompanyContent(!companyContentEnabled)}
              disabled={loading === "loading"}
            >
              <Building2 className="h-4 w-4 shrink-0" />
              {companyContentEnabled && <span className="text-xs">Company</span>}
            </Button>
          </TooltipTrigger>
          <TooltipContent 
            side="top" 
            align="start" 
            sideOffset={5} 
            collisionPadding={{ left: 16, right: 16, top: 8, bottom: 8 }}
            avoidCollisions={true}
          >
            <p>Company Content</p>
            <p className="text-xs text-muted-foreground">
              Search SharePoint, OneDrive & connected sources
            </p>
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>

      <TooltipProvider>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              type="button"
              aria-label="Code interpreter"
              aria-pressed={codeInterpreterEnabled}
              variant={codeInterpreterEnabled ? "default" : "ghost"}
              size={codeInterpreterEnabled ? "sm" : "icon"}
              className={cn("h-8", codeInterpreterEnabled ? "bg-primary text-primary-foreground gap-1 px-2" : "w-8")}
              onClick={() => toggleCodeInterpreter(!codeInterpreterEnabled)}
              disabled={loading === "loading"}
            >
              <Code2 className="h-4 w-4 shrink-0" />
              {codeInterpreterEnabled && <span className="text-xs">Code</span>}
            </Button>
          </TooltipTrigger>
          <TooltipContent 
            side="top" 
            align="start" 
            sideOffset={5} 
            collisionPadding={{ left: 16, right: 16, top: 8, bottom: 8 }}
            avoidCollisions={true}
          >
            <p>Code Interpreter</p>
            <p className="text-xs text-muted-foreground">
              Execute Python code for data analysis & file processing
            </p>
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>
    </div>
  );
};
