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
 * user's tokens. For an extension somebody else set up, the server sends the
 * hosts of the sign-in page and of the MCP server; they are shown before the
 * browser leaves the page.
 */
export const McpConnectButton: FC<Props> = (props) => {
  const [busy, setBusy] = useState(false);
  const [connected, setConnected] = useState(props.connected ?? false);
  const [confirm, setConfirm] = useState<
    { authorizationUrl: string; signInHost: string; serverHost: string } | undefined
  >();

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
    const { authorizationUrl, notice } = response.response;
    if (authorizationUrl && notice) {
      setConfirm({ authorizationUrl, ...notice });
    } else if (authorizationUrl) {
      window.location.href = authorizationUrl;
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

  if (confirm) {
    return (
      <div role="note" data-testid="mcp-sign-in-notice" className="grid gap-2 rounded-md border p-2 text-xs">
        <p>
          {props.personaId ? "The agent owner set up " : "The extension owner set up "}
          {props.extensionName}. You sign in at <strong>{confirm.signInHost}</strong>, and the MCP server at{" "}
          <strong>{confirm.serverHost}</strong> receives your access.
        </p>
        <div className="flex gap-2">
          <Button
            type="button"
            size="sm"
            className="gap-2"
            onClick={() => {
              window.location.href = confirm.authorizationUrl;
            }}
          >
            <Plug size={16} /> Continue to sign-in
          </Button>
          <Button type="button" variant="outline" size="sm" onClick={() => setConfirm(undefined)}>
            Cancel
          </Button>
        </div>
      </div>
    );
  }

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
