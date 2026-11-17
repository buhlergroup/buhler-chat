"use client";

import { Alert, AlertDescription, AlertTitle } from "@/features/ui/alert";
import { Button } from "@/features/ui/button";
import { Input } from "@/features/ui/input";
import { Label } from "@/features/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/features/ui/select";
import { SheetTitle } from "@/features/ui/sheet";
import { Textarea } from "@/features/ui/textarea";
import { KeyRound, Plug, Plus, RefreshCw, Trash, Unplug } from "lucide-react";
import { FC, useEffect, useState } from "react";
import {
  DiscoverMcpTools,
  DisconnectMcpOAuth,
  GetMcpConnections,
  StartMcpOAuth,
} from "../extension-services/mcp/mcp-service";
import type {
  McpSecretModel,
  McpSecretPlacement,
  McpTransport,
} from "../extension-services/models";
import { SECRET_MASK, extensionStore, useExtensionState } from "../extension-store";

const PLACEMENT_LABELS: Record<McpSecretPlacement, string> = {
  bearer: "Bearer token",
  header: "Header",
  query: "Query parameter",
};

const TRANSPORT_LABELS: Record<McpTransport, string> = {
  auto: "Automatic",
  "streamable-http": "Streamable HTTP",
  sse: "SSE",
};

const McpImport: FC = () => {
  const [text, setText] = useState("");
  return (
    <div className="grid gap-2">
      <Label htmlFor="mcp-import">Paste connection details</Label>
      <Textarea
        id="mcp-import"
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder={"type: streamable-http\nurl: https://example.com/mcp\nMY_TOKEN=..."}
        className="font-mono text-xs"
        autoComplete="off"
        spellCheck={false}
      />
      <div>
        <Button
          type="button"
          variant="outline"
          disabled={!text.trim()}
          onClick={() => {
            const errors = extensionStore.importMcpText(text);
            extensionStore.setErrors(errors);
            setText("");
          }}
        >
          Fill in
        </Button>
      </div>
    </div>
  );
};

const McpSecretRow: FC<{ secret: McpSecretModel; saved: boolean }> = ({ secret, saved }) => {
  const showsMask = saved && secret.value === SECRET_MASK;
  return (
    <div className="flex flex-col gap-2 border rounded-md p-3">
      <div className="flex gap-2">
        <Input
          aria-label="Secret name"
          placeholder="NAME"
          className="flex-1 font-mono"
          value={secret.name}
          onChange={(e) => extensionStore.updateMcpSecret(secret.id, { name: e.target.value })}
        />
        <Input
          aria-label="Secret value"
          type="password"
          autoComplete="new-password"
          className="flex-1"
          placeholder={saved ? "Saved. Type to replace." : "Value"}
          value={showsMask ? "" : secret.value}
          onChange={(e) =>
            extensionStore.updateMcpSecret(secret.id, {
              value: e.target.value || (saved ? SECRET_MASK : ""),
            })
          }
        />
        <Button
          variant="outline"
          size="icon"
          type="button"
          onClick={() => extensionStore.removeMcpSecret(secret.id)}
          aria-label="Remove this secret"
        >
          <Trash size={18} />
        </Button>
      </div>
      <div className="flex gap-2 items-center">
        <Label className="text-muted-foreground text-xs w-16">Send as</Label>
        <Select
          value={secret.placement}
          onValueChange={(v) =>
            extensionStore.updateMcpSecret(secret.id, { placement: v as McpSecretPlacement })
          }
        >
          <SelectTrigger className="flex-1" aria-label="Send secret as">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {Object.entries(PLACEMENT_LABELS).map(([value, label]) => (
              <SelectItem key={value} value={value}>
                {label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {secret.placement !== "bearer" && (
          <Input
            aria-label={secret.placement === "header" ? "Header name" : "Parameter name"}
            className="flex-1 font-mono"
            placeholder={secret.name || (secret.placement === "header" ? "Header name" : "Parameter name")}
            value={secret.target ?? ""}
            onChange={(e) => extensionStore.updateMcpSecret(secret.id, { target: e.target.value })}
          />
        )}
      </div>
    </div>
  );
};

const McpSecrets: FC = () => {
  const { extension, savedSecretIds } = useExtensionState();
  const secrets = extension.mcp?.secrets ?? [];
  return (
    <div className="flex flex-col gap-4 bg-foreground/[0.02] border p-4 rounded-md">
      <div className="flex justify-between items-center gap-2">
        <SheetTitle>Secrets</SheetTitle>
        <Button
          type="button"
          variant="outline"
          className="flex gap-2"
          onClick={() => extensionStore.addMcpSecret()}
        >
          <Plus size={18} /> Add secret
        </Button>
      </div>
      <Alert className="text-xs">
        <KeyRound size={18} />
        <AlertTitle>Write-only values</AlertTitle>
        <AlertDescription className="text-xs">
          Values go to Azure Key Vault and are sent only to this server. Agents that use
          this extension use the tools, never the values.
        </AlertDescription>
      </Alert>
      {secrets.map((secret) => (
        <McpSecretRow key={secret.id} secret={secret} saved={savedSecretIds.includes(secret.id)} />
      ))}
    </div>
  );
};

const McpOAuth: FC = () => {
  const { extension, hasSavedClientSecret: clientSecretSaved } = useExtensionState();
  const oauth = extension.mcp?.oauth;
  const [busy, setBusy] = useState(false);
  // Sign-ins are per user: this is the editing user's own connection.
  const [connected, setConnected] = useState(false);
  useEffect(() => {
    if (!extension.id) return;
    let cancelled = false;
    GetMcpConnections([extension.id])
      .then((r) => {
        if (!cancelled && r.status === "OK") setConnected(r.response[0]?.connected ?? false);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [extension.id]);

  const connect = async () => {
    setBusy(true);
    const response = await StartMcpOAuth(extension.id, { returnTo: "/extensions" });
    setBusy(false);
    if (response.status !== "OK") {
      extensionStore.setErrors(response.errors.map((e) => e.message));
      return;
    }
    if (response.response.authorizationUrl) {
      window.location.href = response.response.authorizationUrl;
    } else {
      setConnected(true);
    }
  };

  const disconnect = async () => {
    setBusy(true);
    const response = await DisconnectMcpOAuth(extension.id);
    setBusy(false);
    if (response.status !== "OK") {
      extensionStore.setErrors(response.errors.map((e) => e.message));
      return;
    }
    setConnected(false);
  };

  return (
    <div className="flex flex-col gap-4 bg-foreground/[0.02] border p-4 rounded-md">
      <SheetTitle>OAuth sign-in</SheetTitle>
      <div className="grid gap-2">
        <Label htmlFor="mcp-oauth-client-id">Client ID (optional)</Label>
        <Input
          id="mcp-oauth-client-id"
          placeholder="Leave empty to register automatically"
          value={oauth?.clientId ?? ""}
          onChange={(e) => extensionStore.updateMcpOAuth({ clientId: e.target.value })}
        />
      </div>
      <div className="grid gap-2">
        <Label htmlFor="mcp-oauth-client-secret">Client secret (optional)</Label>
        <Input
          id="mcp-oauth-client-secret"
          type="password"
          autoComplete="new-password"
          placeholder={clientSecretSaved ? "Saved. Type to replace." : "Client secret"}
          value={oauth?.clientSecret && oauth.clientSecret !== SECRET_MASK ? oauth.clientSecret : ""}
          onChange={(e) =>
            extensionStore.updateMcpOAuth({
              clientSecret: e.target.value || (clientSecretSaved ? SECRET_MASK : ""),
            })
          }
        />
      </div>
      <div className="grid gap-2">
        <Label htmlFor="mcp-oauth-scopes">Scopes (optional)</Label>
        <Input
          id="mcp-oauth-scopes"
          placeholder="Space-separated"
          value={oauth?.scopes ?? ""}
          onChange={(e) => extensionStore.updateMcpOAuth({ scopes: e.target.value })}
        />
      </div>
      <p className="text-xs text-muted-foreground">
        Each user signs in with their own account. The tool list uses your sign-in.
      </p>
      {extension.id ? (
        <div className="flex items-center gap-2">
          <span className="text-sm flex-1">{connected ? "You are connected." : "Connect to load the tools."}</span>
          {connected ? (
            <Button type="button" variant="outline" className="gap-2" disabled={busy} onClick={disconnect}>
              <Unplug size={16} /> Disconnect
            </Button>
          ) : (
            <Button type="button" variant="outline" className="gap-2" disabled={busy} onClick={connect}>
              <Plug size={16} /> Connect
            </Button>
          )}
        </div>
      ) : (
        <p className="text-sm">Save the extension to connect.</p>
      )}
    </div>
  );
};

const McpTools: FC = () => {
  const { extension } = useExtensionState();
  const [busy, setBusy] = useState(false);
  const tools = extension.mcp?.tools ?? [];
  const allowList = extension.mcp?.toolAllowList ?? [];

  const refresh = async () => {
    setBusy(true);
    const response = await DiscoverMcpTools(extension.id);
    setBusy(false);
    if (response.status !== "OK") {
      extensionStore.setErrors(response.errors.map((e) => e.message));
      return;
    }
    extensionStore.setErrors([]);
    extensionStore.setMcpTools(response.response.mcp?.tools);
  };

  return (
    <div className="flex flex-col gap-4 bg-foreground/[0.02] border p-4 rounded-md">
      <div className="flex justify-between items-center gap-2">
        <SheetTitle>Tools</SheetTitle>
        {extension.id && (
          <Button type="button" variant="outline" className="gap-2" disabled={busy} onClick={refresh}>
            <RefreshCw size={16} /> Refresh tools
          </Button>
        )}
      </div>
      <p className="text-xs text-muted-foreground">
        {extension.id
          ? "Select tools to limit the extension to them. With no selection, all tools are available."
          : "Tools load when you save."}
      </p>
      {tools.length > 0 && (
        <div className="flex flex-col gap-2 max-h-[240px] overflow-y-auto border rounded-md p-2">
          {tools.map((tool) => (
            <label key={tool.name} className="flex items-start gap-2 cursor-pointer hover:bg-accent rounded p-1">
              <input
                type="checkbox"
                className="h-4 w-4 mt-0.5 rounded border-input"
                checked={allowList.includes(tool.name)}
                onChange={(e) => extensionStore.toggleMcpTool(tool.name, e.target.checked)}
              />
              <span className="flex flex-col">
                <span className="text-sm font-mono">{tool.name}</span>
                {tool.description && (
                  <span className="text-xs text-muted-foreground line-clamp-2">{tool.description}</span>
                )}
              </span>
            </label>
          ))}
        </div>
      )}
    </div>
  );
};

/** Form section for a Remote MCP server extension. Controlled by the extension store. */
export const McpServerSection: FC = () => {
  const { extension } = useExtensionState();
  const mcp = extension.mcp;
  return (
    <div className="flex flex-col gap-8">
      <McpImport />
      <div className="grid gap-2">
        <Label htmlFor="mcp-url">Server URL</Label>
        <Input
          id="mcp-url"
          type="url"
          required
          placeholder="https://example.com/mcp"
          value={mcp?.url ?? ""}
          onChange={(e) => extensionStore.updateMcp({ url: e.target.value })}
        />
      </div>
      <div className="flex gap-4">
        <div className="grid gap-2 flex-1">
          <Label>Transport</Label>
          <Select
            value={mcp?.transport ?? "auto"}
            onValueChange={(v) => extensionStore.updateMcp({ transport: v as McpTransport })}
          >
            <SelectTrigger aria-label="Transport">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {Object.entries(TRANSPORT_LABELS).map(([value, label]) => (
                <SelectItem key={value} value={value}>
                  {label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="grid gap-2 flex-1">
          <Label>Sign-in</Label>
          <Select
            value={mcp?.auth ?? "none"}
            onValueChange={(v) => extensionStore.updateMcp({ auth: v as "none" | "oauth" })}
          >
            <SelectTrigger aria-label="Sign-in">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="none">Secrets only</SelectItem>
              <SelectItem value="oauth">OAuth</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>
      <McpSecrets />
      {mcp?.auth === "oauth" && <McpOAuth />}
      <McpTools />
    </div>
  );
};
