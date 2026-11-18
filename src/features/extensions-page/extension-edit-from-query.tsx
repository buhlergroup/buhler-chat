"use client";

import { FC, useEffect, useRef } from "react";
import type { ExtensionModel } from "./extension-services/models";
import { extensionStore } from "./extension-store";

interface Props {
  /** The extension named by `?edit=<id>`, only when the user may edit it. */
  extension?: ExtensionModel;
  /** `?mcp=` set by the OAuth callback: "connected" or "failed". */
  mcpResult?: string;
}

/**
 * Reopens an extension sheet from the URL. The MCP OAuth callback returns to
 * `/extensions?edit=<id>&mcp=connected`; the owner lands in the same sheet and
 * the tools load with the new sign-in.
 */
export const ExtensionEditFromQuery: FC<Props> = ({ extension, mcpResult }) => {
  const done = useRef(false);
  useEffect(() => {
    if (done.current || !extension) return;
    done.current = true;
    extensionStore.openAndUpdate(extension);
    if (mcpResult === "connected") {
      void extensionStore.loadMcpTools();
    } else if (mcpResult === "failed") {
      extensionStore.setErrors(["The sign-in did not finish. Connect again."]);
    }
    // Drop the parameters, so a reload does not reopen the sheet.
    window.history.replaceState(null, "", window.location.pathname);
  }, [extension, mcpResult]);
  return null;
};
