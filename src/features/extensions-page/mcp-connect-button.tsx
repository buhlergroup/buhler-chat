"use client";

import { Button } from "@/features/ui/button";
import { Plug, Unplug } from "lucide-react";
import { FC, useState } from "react";
import { showError } from "@/features/globals/global-message-store";
import {
  DisconnectMcpOAuth,
  StartMcpOAuth,
} from "./extension-services/mcp/mcp-service";

interface Props {
  extensionId: string;
  extensionName: string;
  /** Agent through which the user may use the extension. */
  personaId?: string;
  connected?: boolean;
  onChange?: (connected: boolean) => void;
}

/**
 * The current user's own sign-in to an OAuth MCP server. "Connect" starts the
 * PKCE flow and comes back to this page; "Disconnect" forgets only this
 * user's tokens.
 */
export const McpConnectButton: FC<Props> = (props) => {
  const [busy, setBusy] = useState(false);
  const [connected, setConnected] = useState(props.connected ?? false);

  const update = (value: boolean) => {
    setConnected(value);
    props.onChange?.(value);
  };

  const connect = async () => {
    setBusy(true);
    const response = await StartMcpOAuth(props.extensionId, {
      personaId: props.personaId,
      returnTo: window.location.pathname,
    });
    setBusy(false);
    if (response.status !== "OK") {
      showError(response.errors[0]?.message ?? "Could not start the sign-in.");
      return;
    }
    if (response.response.authorizationUrl) {
      window.location.href = response.response.authorizationUrl;
    } else {
      update(true);
    }
  };

  const disconnect = async () => {
    setBusy(true);
    const response = await DisconnectMcpOAuth(props.extensionId);
    setBusy(false);
    if (response.status !== "OK") {
      showError(response.errors[0]?.message ?? "Could not disconnect.");
      return;
    }
    update(false);
  };

  return connected ? (
    <Button type="button" variant="outline" size="sm" className="gap-2" disabled={busy} onClick={disconnect}>
      <Unplug size={16} /> Disconnect {props.extensionName}
    </Button>
  ) : (
    <Button type="button" variant="outline" size="sm" className="gap-2" disabled={busy} onClick={connect}>
      <Plug size={16} /> Connect {props.extensionName}
    </Button>
  );
};
