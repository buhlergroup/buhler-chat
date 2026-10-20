"use client";

import { ServerActionResponse } from "@/features/common/server-action-response";
import {
  showError,
  showSuccess,
} from "@/features/globals/global-message-store";
import { proxy, useSnapshot } from "valtio";
import { IndexDocuments } from "../../chat-services/azure-ai-search/azure-ai-search";
import {
  CrackDocument,
  CreateChatDocument,
} from "../../chat-services/chat-document-service";
import { SupportedFileExtensionsInputImages, AttachedFileModel } from "../../chat-services/models";
import {
  getCodeInterpreterFileLimit,
  isCodeInterpreterSupportedFile,
} from "../../chat-services/code-interpreter-constants";
import { getActiveChatStore } from "../../active-chat-store";
import { InputImageStore } from "@/features/ui/chat/chat-input-area/input-image-store";
import { AddAttachedFile } from "../../chat-services/chat-thread-service";

// File extensions that should be handled by Code Interpreter instead of Azure Search
// These are data files that are better processed by Python code
const CODE_INTERPRETER_ONLY_EXTENSIONS = [
  "XLSX", "XLS",  // Excel files
  "CSV",          // CSV files  
  "JSON",         // JSON data files
  "XML",          // XML data files
  "PKL",          // Python pickle files
  "ZIP", "TAR",   // Archives
];

// File extensions that should be indexed in Azure Search for RAG
const AZURE_SEARCH_INDEXABLE_EXTENSIONS = [
  "PDF",          // PDF documents
  "TXT",          // Text files
  "DOCX", "DOC",  // Word documents
  "PPTX", "PPT",  // PowerPoint
  "HTML", "HTM",  // HTML files
  "MD",           // Markdown
];

async function shouldUseCodeInterpreter(extension: string): Promise<boolean> {
  return CODE_INTERPRETER_ONLY_EXTENSIONS.includes(extension.toUpperCase());
}

async function shouldIndexInAzureSearch(extension: string): Promise<boolean> {
  return AZURE_SEARCH_INDEXABLE_EXTENSIONS.includes(extension.toUpperCase());
}

class FileStore {
  public uploadButtonLabel: string = "";
  public loading: "idle" | "file upload" = "idle";

  public async onFileChange(props: {
    formData: FormData;
    chatThreadId: string;
  }) {
    const { formData, chatThreadId } = props;

    try {
      this.loading = "file upload";

      formData.append("id", chatThreadId);
      const file: File | null = formData.get("file") as unknown as File;
      
      if(file.size > Number(process.env.NEXT_PUBLIC_MAX_UPLOAD_DOCUMENT_SIZE)){
        const maxSizeMB = Math.round(Number(process.env.NEXT_PUBLIC_MAX_UPLOAD_DOCUMENT_SIZE) / (1024 * 1024));
        showError(`File size is too large. Please upload a file less than ${maxSizeMB}MB.`);
        return;
      }

      const fileExtension = file.name.split(".").pop()?.toUpperCase();
      const isInputImage =
        !!fileExtension &&
        Object.values(SupportedFileExtensionsInputImages).includes(
          fileExtension as SupportedFileExtensionsInputImages
        );
      const isCodeInterpreterOnly =
        !!fileExtension && (await shouldUseCodeInterpreter(fileExtension));
      const isCodeInterpreterSupported = isCodeInterpreterSupportedFile(file.name);
      const z = getActiveChatStore()?.getState();
      const shouldUploadToCodeInterpreter =
        isCodeInterpreterOnly ||
        // Manual override: when CI is enabled, route CI-supported non-image files to CI.
        (!!z?.codeInterpreterEnabled &&
          isCodeInterpreterSupported &&
          !isInputImage);

      if (isInputImage) {
        const reader = new FileReader();
        reader.readAsDataURL(file);
        reader.onload = () => {
          if (typeof reader.result === "string") {
            InputImageStore.AddImage(reader.result);
          }
        };
        this.loading = "idle";
        return;
      }

      // Check if this file should go to Code Interpreter instead of Azure Search
      if (shouldUploadToCodeInterpreter) {
        const active = getActiveChatStore();
        const attachedFileCount =
          active
            ?.getState()
            .attachedFiles.filter((attached) => attached.type === "code-interpreter")
            .length ?? 0;
        const fileLimit = getCodeInterpreterFileLimit(
          process.env.NEXT_PUBLIC_MAX_PERSONA_CI_DOCUMENT_LIMIT
        );

        if (attachedFileCount >= fileLimit) {
          showError(
            `Code Interpreter supports a maximum of ${fileLimit} files.`
          );
          return;
        }

        this.uploadButtonLabel = "Uploading for Code Interpreter";

        try {
          const uploadFormData = new FormData();
          uploadFormData.append("file", file);

          const response = await fetch("/api/code-interpreter/upload", {
            method: "POST",
            body: uploadFormData,
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
          };

          // Write synchronously to the per-thread Zustand store so a
          // same-tick Send sees this file id in the request payload —
          // the architect2 SEV-1 B3 race that the old Valtio path had.
          if (active) {
            active.getState().addAttachedFile(attachedFile);
            active.getState().toggleCodeInterpreter(true);
          }

          // Persist to database
          await AddAttachedFile(chatThreadId, attachedFile);

          this.uploadButtonLabel = file.name + " ready for analysis";
          showSuccess({
            title: "File uploaded",
            description: `${file.name} is ready for Code Interpreter analysis`,
          });
        } catch (error) {
          showError(`Failed to upload file: ${error instanceof Error ? error.message : String(error)}`);
        } finally {
          this.uploadButtonLabel = "";
          this.loading = "idle";
        }
        return;
      }

      // For text documents, proceed with Azure Search indexing
      this.uploadButtonLabel = "Processing document";
      const crackingResponse = await CrackDocument(formData);
      if (crackingResponse.status === "OK") {
        let index = 0;

        const documentIndexResponses: Array<ServerActionResponse<boolean>> = [];

        for (const doc of crackingResponse.response) {
          this.uploadButtonLabel = `Indexing document ${index + 1}/${
            crackingResponse.response.length
          }`;

          // index one document at a time
          const indexResponses = await IndexDocuments(
            [doc],
            file.name,
            chatThreadId
          );

          documentIndexResponses.push(...indexResponses);
          index++;
        }

        if (documentIndexResponses.length === 0) {
          showError(`${file.name}: Document contains no text that can be indexed.`);
          return;
        }

        const allDocumentsIndexed = documentIndexResponses.every(
          (r) => r.status === "OK"
        );

        if (allDocumentsIndexed) {
          // Update state
          this.uploadButtonLabel = file.name + " loaded";
          // Update history DB with doc on chat thread
          const response = await CreateChatDocument(file.name, chatThreadId);

          if (response.status === "OK") {
            showSuccess({
              title: "File upload",
              description: `${file.name} uploaded successfully.`,
            });
          } else {
            showError(response.errors.map((e) => e).join("\n"));
          }
        } else {
          const errors: Array<string> = [];

          documentIndexResponses.forEach((r) => {
            if (r.status === "ERROR") {
              errors.push(...r.errors.map((e) => e.message));
            }
          });

          showError(
            "Looks like not all documents were indexed" +
              errors.map((e) => e).join("\n")
          );
        }
      } else {
        showError(crackingResponse.errors.map((e) => e.message).join("\n"));
      }
    } catch (error) {
      showError("" + error);
    } finally {
      this.uploadButtonLabel = "";
      this.loading = "idle";
    }
  }
}

export const fileStore = proxy(new FileStore());

export function useFileStore() {
  return useSnapshot(fileStore);
}
