"use client";

import { useState, useEffect, useRef } from "react";
import { v4 as uuid } from "uuid";
import { Button } from "@/features/ui/button";
import { Edit, ExternalLink } from "lucide-react";
import { toast } from "@/features/ui/use-toast";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/features/ui/dialog";
import { SharePointFile } from "../persona-services/models";
import { CODE_INTERPRETER_SUPPORTED_EXTENSIONS } from "@/features/chat-page/chat-services/code-interpreter-constants";
import { logInfo } from "@/features/common/services/logger";

interface CodeInterpreterFilePickerProps {
  tenantUrl: string;
  token: string;
  onFilesSelected: (files: SharePointFile[]) => void;
}

export function CodeInterpreterFilePicker({
  tenantUrl,
  token,
  onFilesSelected,
}: CodeInterpreterFilePickerProps) {
  const [showPicker, setShowPicker] = useState(false);
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const portRef = useRef<MessagePort | null>(null);
  const channelIdRef = useRef<string>(uuid());

  useEffect(() => {
    const messageListener = (event: MessageEvent) => {
      if (event.origin.includes(new URL(tenantUrl).hostname)) {
        const message = event.data;

        if (
          message.type === "initialize" &&
          message.channelId === channelIdRef.current
        ) {
          portRef.current = event.ports[0];

          portRef.current.addEventListener("message", channelMessageListener);
          portRef.current.start();

          portRef.current.postMessage({
            type: "activate",
          });
        }
      }
    };

    window.addEventListener("message", messageListener);

    return () => {
      window.removeEventListener("message", messageListener);
    };
  }, []);

  const channelMessageListener = async (message: MessageEvent) => {
    const payload = message.data;

    switch (payload.type) {
      case "notification":
        const notification = payload.data;

        if (notification.notification === "page-loaded") {
          logInfo("Code Interpreter file picker page loaded and ready");
        }

        break;

      case "command":
        portRef.current?.postMessage({
          type: "acknowledge",
          id: message.data.id,
        });

        const command = payload.data;

        switch (command.command) {
          case "authenticate":
            try {
              if (!token) {
                throw new Error("No token provided");
              }

              portRef.current?.postMessage({
                type: "result",
                id: message.data.id,
                data: {
                  result: "token",
                  token: token,
                },
              });
            } catch (error) {
              console.error("Authentication failed:", error);
              portRef.current?.postMessage({
                type: "result",
                id: message.data.id,
                data: {
                  result: "error",
                  error: {
                    code: "tokenExpired",
                    message: "Authentication failed",
                  },
                },
              });
            }
            break;

          case "pick":
            logInfo("Code Interpreter files picked", { items: command.items });
            const pickedFiles: SharePointFile[] = command.items.map(
              (item: any) => ({
                documentId: item.id,
                parentReference: {
                  driveId: item.parentReference.driveId,
                },
              })
            );

            onFilesSelected(pickedFiles);
            setShowPicker(false);
            break;

          case "close":
            setShowPicker(false);
            break;
        }
        break;
    }
  };

  const openFilePicker = async () => {
    try {
      setShowPicker(true);

      const documentLimit = Number(process.env.NEXT_PUBLIC_MAX_PERSONA_CI_DOCUMENT_LIMIT) || 25;

      // Filter for Code Interpreter supported extensions
      const filters = CODE_INTERPRETER_SUPPORTED_EXTENSIONS.map(
        (ext) => `.${ext.toLowerCase()}`
      );

      const options = {
        sdk: "8.0",
        entry: {},
        messaging: {
          origin: window.location.origin,
          channelId: channelIdRef.current,
        },
        search: { enabled: true },
        typesAndSources: {
          mode: "files",
          filters: filters,
        },
        selection: {
          mode: "multiple",
          enablePersistence: true,
          maximumCount: documentLimit,
        },
      };

      const queryString = new URLSearchParams({
        filePicker: JSON.stringify(options),
        locale: "en-us",
      });

      const url = `${tenantUrl}_layouts/15/FilePicker.aspx?${queryString}`;

      setTimeout(() => {
        if (iframeRef.current) {
          const iframeDoc =
            iframeRef.current.contentDocument ||
            iframeRef.current.contentWindow?.document;

          if (iframeDoc) {
            const form = iframeDoc.createElement("form");
            form.setAttribute("action", url);
            form.setAttribute("method", "POST");

            const tokenInput = iframeDoc.createElement("input");
            tokenInput.setAttribute("type", "hidden");
            tokenInput.setAttribute("name", "access_token");
            tokenInput.setAttribute("value", token);
            form.appendChild(tokenInput);

            iframeDoc.body.appendChild(form);
            form.submit();
          }
        }
      }, 100);
    } catch (error) {
      toast({
        title: "Error",
        description: "Unable to open file picker. Please try again.",
        variant: "destructive",
      });
      setShowPicker(false);
    }
  };

  return (
    <div className="relative">
      <Button
        size={"icon"}
        onClick={openFilePicker}
        className="p-1 cursor-pointer"
        variant={"ghost"}
        type="button"
      >
        <Edit size={15} />
      </Button>

      <Dialog open={showPicker} onOpenChange={setShowPicker}>
        <DialogContent className="w-[90vw] max-w-[1500px]">
          <DialogHeader>
            <DialogTitle className="text-xl font-semibold">
              Select Code Interpreter Files
            </DialogTitle>
            <DialogDescription className="">
              <span className="gap-2 flex flex-col">
                <span>
                  Select files for Code Interpreter (Excel, CSV, JSON, images, etc.).
                  These files will be automatically loaded when starting a chat with this persona.
                </span>
                <span>
                  Files can not be larger than <b>512MB</b> each.
                </span>
              </span>
            </DialogDescription>
          </DialogHeader>
          <div className="h-[50vh] max-h-[1000px]">
            <iframe
              ref={iframeRef}
              className="inset-0 w-full h-full border-0 rounded-lg"
              title="OneDrive File Picker - Code Interpreter"
            />
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
