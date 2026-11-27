/**
 * The Web and Code toggles on the Copilot path: "this tool is available in
 * this chat". Toggle on: the tool (web_search / run_code) is offered and the
 * model calls it when it decides it helps. Toggle off: the tool is not
 * offered (run_code still is when the chat's files need it,
 * agent-code-interpreter.ts).
 *
 * Both toggles are on by default. The settings are read here only:
 *   COPILOT_WEB_SEARCH_DEFAULT  the Web toggle  (web_search)
 *   COPILOT_RUN_CODE_DEFAULT    the Code toggle (run_code)
 * Unset = on; "false", "0" or "off" = the toggle starts off. The default
 * applies when the turn carries no choice: no toggle in the request and none
 * on the thread (an agent's default tools). An explicit false, from the user
 * or the agent, wins.
 *
 * The default is on only when a Responses model for the tool is deployed
 * (resolveResponsesModel). Offering a tool costs nothing until the model
 * calls it (the run_code container is created on the first call), and a
 * tool list that does not change from turn to turn keeps the prompt cache.
 *
 * The chat page gets the same defaults (WorkspaceSummary.webSearchDefault /
 * runCodeDefault), so the toggles show what the server does. Nothing about
 * the toggles goes into the system message or the user message.
 */
import { FALLBACK_MODEL_CHAIN, MODEL_CONFIGS } from "../models";
import { resolveResponsesModel, RUN_CODE_MODEL_ENV, WEB_SEARCH_MODEL_ENV, type ModelChoice } from "./provider-tools";

type Env = Record<string, string | undefined>;

const OFF_VALUES: ReadonlySet<string> = new Set(["false", "0", "off"]);

function settingOn(value: string | undefined): boolean {
  const v = value?.trim().toLowerCase();
  return !v || !OFF_VALUES.has(v);
}

/** COPILOT_WEB_SEARCH_DEFAULT: on when unset; "false", "0" or "off" turns it off. */
export function webSearchDefaultOn(env: Env = process.env): boolean {
  return settingOn(env.COPILOT_WEB_SEARCH_DEFAULT);
}

/** COPILOT_RUN_CODE_DEFAULT: on when unset; "false", "0" or "off" turns it off. */
export function runCodeDefaultOn(env: Env = process.env): boolean {
  return settingOn(env.COPILOT_RUN_CODE_DEFAULT);
}

interface ModelLookup {
  env?: Env;
  configs?: Readonly<Record<string, ModelChoice>>;
  defaultIds?: ReadonlyArray<string>;
}

function toolModelDeployed(modelEnv: string, args: ModelLookup): boolean {
  const env = args.env ?? process.env;
  return !!resolveResponsesModel(args.configs ?? MODEL_CONFIGS, env[modelEnv], args.defaultIds ?? FALLBACK_MODEL_CHAIN);
}

/**
 * Is web_search offered on this Copilot turn? `toggle` is the turn's choice
 * (request, else thread); undefined means no choice, and the default
 * (COPILOT_WEB_SEARCH_DEFAULT) applies. Never without a deployed Responses
 * model for the tool.
 */
export function copilotOffersWebSearch(args: ModelLookup & { toggle: boolean | undefined }): boolean {
  if (!(args.toggle ?? webSearchDefaultOn(args.env ?? process.env))) return false;
  return toolModelDeployed(WEB_SEARCH_MODEL_ENV, args);
}

/**
 * The Code toggle of this Copilot turn: the turn's choice (request, else
 * thread), or with no choice (undefined) the default (COPILOT_RUN_CODE_DEFAULT,
 * only with a deployed Responses model for run_code). The code interpreter
 * plan (agent-code-interpreter.ts) also turns run_code on for the chat's files.
 */
export function copilotRunCodeToggle(args: ModelLookup & { toggle: boolean | undefined }): boolean {
  if (args.toggle !== undefined) return args.toggle;
  return runCodeDefaultOn(args.env ?? process.env) && toolModelDeployed(RUN_CODE_MODEL_ENV, args);
}

/** The toggles' state for a chat with no choice of its own (the chat page's defaults). */
export function copilotToolDefaults(args: ModelLookup = {}): { webSearch: boolean; runCode: boolean } {
  return {
    webSearch: copilotOffersWebSearch({ ...args, toggle: undefined }),
    runCode: copilotRunCodeToggle({ ...args, toggle: undefined }),
  };
}
