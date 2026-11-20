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
import { LoadingIndicator } from "@/features/ui/loading";
import { KeyRound, Plug, Plus, RefreshCw, Trash, Unplug } from "lucide-react";
import { FC, useEffect, useState } from "react";
import {
  DisconnectMcpOAuth,
  GetMcpConnections,
  StartMcpOAuth,
} from "../extension-services/mcp/mcp-service";
import {
  mcpSecretTargetName,
  type McpConfigModel,
  type McpSecretModel,
  type McpTransport,
} from "../extension-services/models";
import { SECRET_MASK, extensionStore, useExtensionState } from "../extension-store";
import { checkedToolNames, completeDraftKey, selectionSummary } from "./mcp-tool-selection";

/** Wait after the last keystroke before the tools load by themselves. */
export const MCP_AUTO_LOAD_DELAY_MS = 800;

const TRANSPORT_LABELS: Record<McpTransport, string> = {
  auto: "Automatic",
  "streamable-http": "Streamable HTTP",
  sse: "SSE",
};

const McpHeaderRow: FC<{ secret: McpSecretModel; saved: boolean; first: boolean }> = ({
  secret,
  saved,
  first,
}) => {
  const showsMask = saved && secret.value === SECRET_MASK;
  const legacyQuery = secret.placement === "query";
  const legacyBearer = secret.placement === "bearer";
  const name = mcpSecretTargetName(secret);
  return (
    <div className="flex flex-col gap-2">
      <div className="flex gap-2">
        <Input
          aria-label="Header name"
          placeholder="Header name"
          className="flex-1 font-mono"
          value={name}
          readOnly={legacyQuery || legacyBearer}
          onChange={(e) => extensionStore.setMcpHeaderName(secret.id, e.target.value)}
        />
        <Input
          aria-label="Value"
          type="password"
          autoComplete="new-password"
          className="flex-1"
          placeholder={saved ? "Saved. Type to replace." : first ? "Bearer <token>" : "Value"}
          value={showsMask ? "" : secret.value}
          readOnly={legacyQuery}
          onChange={(e) => extensionStore.setMcpHeaderValue(secret.id, e.target.value)}
        />
        <Button
          variant="outline"
          size="icon"
          type="button"
          onClick={() => extensionStore.removeMcpHeader(secret.id)}
          aria-label={`Remove header ${name}`.trim()}
        >
          <Trash size={18} />
        </Button>
      </div>
      {legacyBearer && (
        <p className="text-xs text-muted-foreground">
          The saved value is sent as Bearer &lt;value&gt;. A new value is sent exactly as typed.
        </p>
      )}
      {legacyQuery && (
        <p className="text-xs text-muted-foreground">
          Sent as the query parameter {name}. To change it, remove it and add a header.
        </p>
      )}
    </div>
  );
};

const McpHeaders: FC = () => {
  const { extension, savedSecretIds } = useExtensionState();
  const secrets = extension.mcp?.secrets ?? [];
  return (
    <div className="flex flex-col gap-4 bg-foreground/[0.02] border p-4 rounded-md">
      <div className="flex justify-between items-center gap-2">
        <SheetTitle>Headers</SheetTitle>
        <Button
          type="button"
          variant="outline"
          className="flex gap-2"
          onClick={() => extensionStore.addMcpHeader()}
        >
          <Plus size={18} /> Add header
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
      {secrets.map((secret, index) => (
        <McpHeaderRow
          key={secret.id}
          secret={secret}
          saved={savedSecretIds.includes(secret.id)}
          first={index === 0}
        />
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
    // Back to this extension's sheet; it loads the tools (see ExtensionEditFromQuery).
    const response = await StartMcpOAuth(extension.id, {
      returnTo: `/extensions?edit=${encodeURIComponent(extension.id)}`,
    });
    setBusy(false);
    if (response.status !== "OK") {
      extensionStore.setErrors(response.errors.map((e) => e.message));
      return;
    }
    if (response.response.authorizationUrl) {
      window.location.href = response.response.authorizationUrl;
    } else {
      setConnected(true);
      void extensionStore.loadMcpTools();
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
        <p className="text-sm">Save to connect.</p>
      )}
    </div>
  );
};

const McpTools: FC = () => {
  const { extension, toolsLoading, toolsError, toolsDraftKey, mcpNoToolSelected } = useExtensionState();
  const mcp = extension.mcp;
  const tools = mcp?.tools;
  const oauth = mcp?.auth === "oauth";
  const names = (tools ?? []).map((t) => t.name);
  const selection = { toolAllowList: [...(mcp?.toolAllowList ?? [])], noneSelected: mcpNoToolSelected };
  const checked = checkedToolNames(names, selection);

  // Sign-in None: load the tools by themselves once the draft is complete
  // and no list is shown yet. Retried only when the draft changes.
  const draftKey = completeDraftKey(mcp as McpConfigModel | undefined);
  const hasTools = !!tools;
  useEffect(() => {
    if (!draftKey || hasTools || draftKey === toolsDraftKey) return;
    const timer = setTimeout(() => void extensionStore.loadMcpTools(), MCP_AUTO_LOAD_DELAY_MS);
    return () => clearTimeout(timer);
  }, [draftKey, hasTools, toolsDraftKey]);

  const canLoad = oauth ? !!extension.id : true;
  const hint = oauth
    ? extension.id
      ? "Connect to load the tools."
      : "Save to connect. The tools load after you connect."
    : "Enter the server URL and the header values. The tools load by themselves.";

  return (
    <div className="flex flex-col gap-4 bg-foreground/[0.02] border p-4 rounded-md">
      <div className="flex justify-between items-center gap-2">
        <SheetTitle>Tools</SheetTitle>
        {canLoad && (
          <Button
            type="button"
            variant="outline"
            className="gap-2"
            disabled={toolsLoading}
            onClick={() => void extensionStore.loadMcpTools()}
          >
            {toolsLoading ? <LoadingIndicator isLoading /> : <RefreshCw size={16} />}
            {tools ? "Refresh tools" : "Load tools"}
          </Button>
        )}
      </div>
      {toolsLoading && (
        <p className="text-xs text-muted-foreground" role="status">
          Loading tools...
        </p>
      )}
      {toolsError && (
        <p className="text-sm text-red-500" role="alert">
          {toolsError}
        </p>
      )}
      {!tools && !toolsLoading && !toolsError && <p className="text-xs text-muted-foreground">{hint}</p>}
      {tools && tools.length === 0 && (
        <p className="text-xs text-muted-foreground">The server has no tools.</p>
      )}
      {tools && tools.length > 0 && (
        <>
          <div className="flex items-center gap-2">
            <p
              className={`text-xs flex-1 ${mcpNoToolSelected ? "text-red-500" : "text-muted-foreground"}`}
              data-testid="mcp-tool-summary"
            >
              {selectionSummary(names, selection)}
            </p>
            <Button
              type="button"
              variant="link"
              size="sm"
              className="h-auto px-1 text-xs"
              disabled={checked.size === names.length}
              onClick={() => extensionStore.selectAllMcpTools()}
            >
              Select all
            </Button>
            <Button
              type="button"
              variant="link"
              size="sm"
              className="h-auto px-1 text-xs"
              disabled={checked.size === 0}
              onClick={() => extensionStore.clearMcpTools()}
            >
              Clear
            </Button>
          </div>
          <div className="flex flex-col gap-2 max-h-[240px] overflow-y-auto border rounded-md p-2">
            {tools.map((tool) => (
              <label key={tool.name} className="flex items-start gap-2 cursor-pointer hover:bg-accent rounded p-1">
                <input
                  type="checkbox"
                  className="h-4 w-4 mt-0.5 rounded border-input"
                  checked={checked.has(tool.name)}
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
        </>
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
              <SelectItem value="none">None</SelectItem>
              <SelectItem value="oauth">OAuth</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>
      <McpHeaders />
      {mcp?.auth === "oauth" && <McpOAuth />}
      <McpTools />
    </div>
  );
};
