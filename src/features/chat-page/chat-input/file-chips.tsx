"use client";

import { X, FileSpreadsheet, FileText, Image as ImageIcon, File } from "lucide-react";
import { Button } from "@/features/ui/button";
import { useChatStore } from "@/features/chat-page/chat-store-context";
import { useInputImage, InputImageStore } from "@/features/ui/chat/chat-input-area/input-image-store";
import { cn } from "@/ui/lib";
import type { ChatDocumentModel } from "../chat-services/models";
import { SoftDeleteChatDocumentsForCurrentUser, RemoveAttachedFile } from "../chat-services/chat-thread-service";
import { RevalidateCache } from "@/features/common/navigation-helpers";
import { showError } from "@/features/globals/global-message-store";

interface FileChipsProps {
  chatDocuments: ChatDocumentModel[];
}

// Get icon based on file name/extension
const getFileIcon = (fileName: string) => {
  const ext = fileName.split(".").pop()?.toLowerCase() || "";
  
  if (["xlsx", "xls", "csv"].includes(ext)) {
    return <FileSpreadsheet className="h-4 w-4 text-green-600" />;
  }
  if (["jpg", "jpeg", "png", "gif", "webp", "svg"].includes(ext)) {
    return <ImageIcon className="h-4 w-4 text-blue-500" />;
  }
  if (["pdf", "doc", "docx", "txt", "md"].includes(ext)) {
    return <FileText className="h-4 w-4 text-red-500" />;
  }
  return <File className="h-4 w-4 text-muted-foreground" />;
};

// Get file type label
const getFileTypeLabel = (fileName: string) => {
  const ext = fileName.split(".").pop()?.toLowerCase() || "";
  
  if (["xlsx", "xls"].includes(ext)) return "Spreadsheet";
  if (["csv"].includes(ext)) return "CSV File";
  if (["json"].includes(ext)) return "JSON File";
  if (["pdf"].includes(ext)) return "PDF Document";
  if (["doc", "docx"].includes(ext)) return "Word Document";
  if (["jpg", "jpeg", "png", "gif", "webp"].includes(ext)) return "Image";
  
  return ext.toUpperCase() || "File";
};

export const FileChips = ({ chatDocuments }: FileChipsProps) => {
  const attachedFiles = useChatStore((s) => s.attachedFiles);
  const chatThreadId = useChatStore((s) => s.threadId);
  const removeAttachedFile = useChatStore((s) => s.removeAttachedFile);
  const codeInterpreterFiles = attachedFiles.filter((f) => f.type === "code-interpreter");
  const { previewImages } = useInputImage();

  const hasCodeInterpreterFiles = codeInterpreterFiles.length > 0;
  const hasImages = previewImages.length > 0;
  const hasDocuments = chatDocuments.length > 0;
  const hasAnyFiles = hasCodeInterpreterFiles || hasImages || hasDocuments;

  const handleRemoveCodeInterpreterFile = async (fileId: string) => {
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
      showError(
        `Failed to remove Code Interpreter file: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  };

  const handleRemoveAllDocuments = async () => {
    if (chatDocuments.length > 0) {
      const threadId = chatDocuments[0].chatThreadId;
      await SoftDeleteChatDocumentsForCurrentUser(threadId);
      RevalidateCache({ page: "chat", type: "layout" });
    }
  };

  if (!hasAnyFiles) return null;

  return (
    <div className="flex flex-wrap gap-2 px-3 pt-3 pb-1">
      {codeInterpreterFiles.map((file) => (
        <div key={`ci-${file.id}`} className="relative group">
          <div className="flex items-center gap-2 bg-muted border rounded-lg px-3 py-2 pr-8">
            {getFileIcon(file.name)}
            <div className="flex flex-col min-w-0">
              <span className="text-sm font-medium truncate max-w-[150px]" title={file.name}>
                {file.name}
              </span>
              <span className="text-xs text-muted-foreground">{getFileTypeLabel(file.name)}</span>
            </div>
          </div>
          <Button
            variant="ghost"
            size="icon"
            className="absolute -top-1 -right-1 h-5 w-5 rounded-full bg-background border shadow-sm opacity-0 group-hover:opacity-100 transition-opacity"
            onClick={() => handleRemoveCodeInterpreterFile(file.id)}
          >
            <X className="h-3 w-3" />
          </Button>
        </div>
      ))}

      {previewImages.map((img, idx) => (
        <div key={`img-${idx}`} className="relative group">
          <div className="flex items-center gap-2 bg-muted border rounded-lg px-3 py-2 pr-8">
            <div className="w-10 h-10 rounded overflow-hidden flex-shrink-0">
              <img src={img} alt={`Attached ${idx + 1}`} className="w-full h-full object-cover" />
            </div>
            <div className="flex flex-col min-w-0">
              <span className="text-sm font-medium truncate max-w-[150px]">{`Bild ${idx + 1}`}</span>
              <span className="text-xs text-muted-foreground">Bild</span>
            </div>
          </div>
          <Button
            variant="ghost"
            size="icon"
            className="absolute -top-1 -right-1 h-5 w-5 rounded-full bg-background border shadow-sm opacity-0 group-hover:opacity-100 transition-opacity"
            onClick={() => InputImageStore.RemoveImage(idx)}
          >
            <X className="h-3 w-3" />
          </Button>
        </div>
      ))}

      {chatDocuments.map((doc, index) => (
        <div key={`doc-${index}`} className="relative group">
          <div className={cn(
            "flex items-center gap-2 bg-muted border rounded-lg px-3 py-2",
            index === 0 && "pr-8"
          )}>
            {getFileIcon(doc.name)}
            <div className="flex flex-col min-w-0">
              <span className="text-sm font-medium truncate max-w-[150px]" title={doc.name}>
                {doc.name}
              </span>
              <span className="text-xs text-muted-foreground">{getFileTypeLabel(doc.name)} • Indiziert</span>
            </div>
          </div>
          {index === 0 && (
            <Button
              variant="ghost"
              size="icon"
              className="absolute -top-1 -right-1 h-5 w-5 rounded-full bg-background border shadow-sm opacity-0 group-hover:opacity-100 transition-opacity"
              onClick={handleRemoveAllDocuments}
            >
              <X className="h-3 w-3" />
            </Button>
          )}
        </div>
      ))}
    </div>
  );
};
