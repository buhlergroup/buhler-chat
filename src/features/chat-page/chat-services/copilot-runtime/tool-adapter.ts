/**
 * Turns the app's AI SDK toolset (buildToolset) into Copilot runtime custom
 * tools: same names, same JSON schemas, and the handler calls the existing
 * tool's `execute`. No tool is re-implemented here, so every tool family
 * (documents, company content, time, skills, SharePoint, HTTP and MCP
 * extensions, sub-agents) behaves as it does on the AI SDK path.
 *
 * Handlers do not close over one request: a Copilot session outlives a
 * request, so each call looks up the CURRENT turn's binding (its toolset with
 * that request's context, its abort signal, its result sink).
 */
import { asSchema } from "ai";
import type { Tool as AiTool } from "@ai-sdk/provider-utils";
import type { Tool as CopilotTool, ToolInvocation, ToolResultObject } from "@microsoft/copilot-sdk";
import { uiErrorText } from "../tools/tool-user-error";

/** One finished call of an app tool, with the RAW output (not the model text). */
export interface ToolCallRecord {
  toolCallId: string;
  toolName: string;
  input: unknown;
  output?: unknown;
  /** Error text for the model. */
  error?: string;
  /** Error text for the chat UI: a ToolUserError's message, else the generic text. */
  uiError?: string;
}

/** What a handler needs from the turn that is running now. */
export interface TurnToolBinding {
  toolset: Record<string, AiTool>;
  /** Trips when the user presses stop. */
  abortSignal?: AbortSignal;
  /** Receives every finished call (success or error). */
  onResult?: (record: ToolCallRecord) => void;
}

const isAsyncIterable = (value: unknown): value is AsyncIterable<unknown> =>
  value != null && typeof (value as { [Symbol.asyncIterator]?: unknown })[Symbol.asyncIterator] === "function";

/** Same text the AI SDK sends the model by default: strings as-is, the rest as JSON. */
export function toModelText(output: unknown): string {
  if (typeof output === "string") return output;
  const json = JSON.stringify(output ?? null);
  return json === undefined ? "null" : json;
}

const anySignal = (signals: Array<AbortSignal | undefined>): AbortSignal | undefined => {
  const present = signals.filter((s): s is AbortSignal => s !== undefined);
  if (present.length === 0) return undefined;
  if (present.length === 1) return present[0];
  return AbortSignal.any(present);
};

/** Tool description; AI SDK 7 allows a function of the call context (none here). */
export function toolDescription(tool: AiTool): string {
  const d = tool.description as unknown;
  if (typeof d === "function") return String((d as (o: { context: unknown }) => unknown)({ context: undefined }) ?? "");
  return typeof d === "string" ? d : "";
}

/** JSON schema of an AI SDK tool's input, as the AI SDK would send it. */
export async function toolJsonSchema(tool: AiTool): Promise<Record<string, unknown>> {
  const schema = asSchema(tool.inputSchema as Parameters<typeof asSchema>[0]);
  const json = (await schema.jsonSchema) as Record<string, unknown>;
  return json ?? { type: "object", properties: {} };
}

/**
 * Builds the Copilot tool definitions for `toolset`. `getBinding` is read on
 * every call; it returns the turn that is running now.
 */
export async function toCopilotTools(
  toolset: Record<string, AiTool>,
  getBinding: () => TurnToolBinding | undefined,
): Promise<CopilotTool[]> {
  const tools: CopilotTool[] = [];
  for (const [name, definition] of Object.entries(toolset)) {
    if (typeof definition.execute !== "function") continue; // provider-executed: not ours to run
    tools.push({
      name,
      description: toolDescription(definition),
      parameters: await toolJsonSchema(definition),
      // Keep every tool loaded (no tool search), like the AI SDK path.
      defer: "never",
      handler: (args: unknown, invocation: ToolInvocation) =>
        runAppTool(name, args, invocation, getBinding()),
    });
  }
  return tools;
}

/** Runs one call against the current turn's toolset. Exported for tests. */
export async function runAppTool(
  name: string,
  rawArgs: unknown,
  invocation: Pick<ToolInvocation, "toolCallId" | "signal">,
  binding: TurnToolBinding | undefined,
): Promise<ToolResultObject> {
  const toolCallId = invocation.toolCallId;
  const fail = (message: string, input: unknown, cause?: unknown): ToolResultObject => {
    binding?.onResult?.({ toolCallId, toolName: name, input, error: message, uiError: uiErrorText(cause) });
    // Return the failure instead of throwing: a thrown message is hidden from
    // the model ("Tool execution failed"), while the AI SDK path shows the
    // model the error text so it can correct itself.
    return { textResultForLlm: message, resultType: "failure", error: message };
  };

  const definition = binding?.toolset[name];
  if (!definition || typeof definition.execute !== "function") {
    return fail(`Tool "${name}" is not available in this turn.`, rawArgs);
  }

  let input: unknown = rawArgs ?? {};
  const schema = asSchema(definition.inputSchema as Parameters<typeof asSchema>[0]);
  if (schema.validate) {
    const checked = await schema.validate(input);
    if (!checked.success) {
      return fail(`Invalid arguments for ${name}: ${checked.error.message}`, input);
    }
    input = checked.value;
  }

  try {
    const execute = definition.execute as (
      input: unknown,
      options: { toolCallId: string; messages: unknown[]; abortSignal?: AbortSignal; context: unknown },
    ) => unknown;
    let output = await execute(input, {
      toolCallId,
      messages: [],
      abortSignal: anySignal([binding?.abortSignal, invocation.signal]),
      context: undefined,
    });
    if (isAsyncIterable(output)) {
      // Streaming tool: the last value is the final output.
      let last: unknown;
      for await (const chunk of output) last = chunk;
      output = last;
    }
    binding?.onResult?.({ toolCallId, toolName: name, input, output });
    return { textResultForLlm: toModelText(output), resultType: "success" };
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err), input, err);
  }
}
