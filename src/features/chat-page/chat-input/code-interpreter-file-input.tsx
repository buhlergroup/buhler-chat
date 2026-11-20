"use client";

import { FileSpreadsheet, X, Upload, Loader2 } from "lucide-react";
import { useRef, useState } from "react";
import { Button } from "@/features/ui/button";
import { useChatStore, useChatSession } from "@/features/chat-page/chat-store-context";
import { showError, showSuccess } from "@/features/globals/global-message-store";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/features/ui/tooltip";
import { cn } from "@/ui/lib";
import { AttachedFileModel } from "../chat-services/models";
import { RemoveAttachedFile } from "../chat-services/chat-thread-service";

const CODE_INTERPRETER_SUPPORTED_EXTENSIONS = [
  ".csv", ".json", ".xml", ".xlsx", ".xls",
  ".pdf", ".txt", ".md", ".html", ".htm",
  ".py", ".js", ".ts", ".c", ".cpp", ".h", ".hpp", ".java", ".cs", ".php", ".rb", ".tex",
  ".css", ".sh", ".bat",
  ".jpeg", ".jpg", ".png", ".gif", ".webp",
  ".zip", ".tar",
  ".pkl", ".pptx", ".docx"
];

export const CodeInterpreterFileInput = () => {
  const codeInterpreterEnabled = useChatStore((s) => s.codeInterpreterEnabled);
  const attachedFiles = useChatStore((s) => s.attachedFiles);
  const chatThreadId = useChatStore((s) => s.threadId);
  const toggleCodeInterpreter = useChatStore((s) => s.toggleCodeInterpreter);
  const addAttachedFile = useChatStore((s) => s.addAttachedFile);
  const removeAttachedFile = useChatStore((s) => s.removeAttachedFile);
  const { status } = useChatSession();
  const loading = status === "streaming" || status === "submitted";
  const codeInterpreterFiles = attachedFiles.filter((f) => f.type === "code-interpreter");
  const [uploading, setUploading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const handleClick = () => {
    if (!codeInterpreterEnabled) {
      toggleCodeInterpreter(true);
    }
    fileInputRef.current?.click();
  };

  const handleFileChange = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;

    // Reset input
    event.target.value = "";

    // Auto-enable code interpreter when file is uploaded
    if (!codeInterpreterEnabled) {
      toggleCodeInterpreter(true);
    }

    setUploading(true);

    try {
      const formData = new FormData();
      formData.append("file", file);
      // The server records the upload on this thread; only recorded files
      // reach the code interpreter.
      formData.append("threadId", chatThreadId);

      const response = await fetch("/api/code-interpreter/upload", {
        method: "POST",
        body: formData
      });

      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.error || "Upload failed");
      }

      const data = await response.json();
      
      const attachedFile: AttachedFileModel = {
        id: data.id,
        name: data.name,
        type: "code-interpreter",
        uploadedAt: new Date(),
        source: "upload",
      };
      
      addAttachedFile(attachedFile);

      showSuccess({
        title: "File uploaded",
        description: `${file.name} is ready for Code Interpreter`
      });
    } catch (error) {
      showError(`Failed to upload file: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setUploading(false);
    }
  };

  const removeFile = async (fileId: string) => {
    try {
      const deleteResponse = await fetch(`/api/code-interpreter/file/${encodeURIComponent(fileId)}`, {
        method: "DELETE",
      });

      // 404: not a file this user uploaded (an agent document or skill
      // archive): it stays in OpenAI and is only detached from this chat.
      if (!deleteResponse.ok && deleteResponse.status !== 404) {
        const errorText = await deleteResponse.text();
        throw new Error(errorText || "Failed to delete file from Code Interpreter");
      }

      await RemoveAttachedFile(chatThreadId, fileId);
      removeAttachedFile(fileId);
    } catch (error) {
      showError(`Failed to remove file: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  return (
    <div className="flex items-center gap-1">
      {/* File chips */}
      {codeInterpreterFiles.length > 0 && (
        <div className="flex gap-1 flex-wrap max-w-[200px]">
          {codeInterpreterFiles.map((file) => (
            <div 
              key={file.id}
              className="flex items-center gap-1 bg-muted px-2 py-1 rounded-md text-xs"
            >
              <FileSpreadsheet className="h-3 w-3" />
              <span className="truncate max-w-[80px]" title={file.name}>
                {file.name}
              </span>
              <button
                type="button"
                onClick={() => removeFile(file.id)}
                className="hover:bg-muted-foreground/20 rounded-full p-0.5"
              >
                <X className="h-3 w-3" />
              </button>
            </div>
          ))}
        </div>
      )}

      {/* Upload button */}
      <TooltipProvider>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className={cn(
                "h-8 w-8",
                codeInterpreterFiles.length > 0 && "text-primary"
              )}
              onClick={handleClick}
              disabled={loading || uploading}
            >
              {uploading ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <FileSpreadsheet className="h-4 w-4" />
              )}
            </Button>
          </TooltipTrigger>
          <TooltipContent 
            side="top" 
            align="start" 
            sideOffset={5}
            collisionPadding={{ left: 16, right: 16, top: 8, bottom: 8 }}
            avoidCollisions={true}
          >
            <p>Upload file for Code Interpreter</p>
            <p className="text-xs text-muted-foreground">
              Excel, CSV, PDF, images & more
            </p>
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>

      <input
        type="file"
        ref={fileInputRef}
        style={{ display: "none" }}
        accept={CODE_INTERPRETER_SUPPORTED_EXTENSIONS.join(",")}
        onChange={handleFileChange}
      />
    </div>
  );
};
