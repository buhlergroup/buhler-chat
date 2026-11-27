/**
 * web_search on the Copilot path: offered on every turn by default.
 *
 * The agent decides itself when to search. A tool list that changes with the
 * Web toggle also changes the cached prompt prefix (the tool definitions are
 * part of it); a tool that is always there keeps the prompt cache valid.
 *
 * COPILOT_WEB_SEARCH_ALWAYS (default on; "false", "0" or "off" turns it off)
 * is read here only. Off: web_search is offered while the toggle is on, as
 * before. Without a deployed Responses model for the tool
 * (resolveResponsesModel) the toggle decides too, as before.
 *
 * The toggle keeps a meaning: on a turn with the toggle on, the USER message
 * gets a short static note that the user asked for a web search. Nothing goes
 * into the system message, and the tool description is static, so both stay
 * the same on every turn.
 */
import { FALLBACK_MODEL_CHAIN, MODEL_CONFIGS } from "../models";
import { resolveResponsesModel, WEB_SEARCH_MODEL_ENV, type ModelChoice } from "./provider-tools";

type Env = Record<string, string | undefined>;

const OFF_VALUES: ReadonlySet<string> = new Set(["false", "0", "off"]);

/** COPILOT_WEB_SEARCH_ALWAYS: on when unset; "false", "0" or "off" turns it off. */
export function webSearchAlways(env: Env = process.env): boolean {
  const value = env.COPILOT_WEB_SEARCH_ALWAYS?.trim().toLowerCase();
  return !value || !OFF_VALUES.has(value);
}

/**
 * Is web_search offered on this Copilot turn? Always when the toggle is on;
 * with the toggle off when COPILOT_WEB_SEARCH_ALWAYS is on and a Responses
 * model for the tool is deployed.
 */
export function copilotOffersWebSearch(args: {
  toggle: boolean;
  env?: Env;
  configs?: Readonly<Record<string, ModelChoice>>;
  defaultIds?: ReadonlyArray<string>;
}): boolean {
  if (args.toggle) return true;
  const env = args.env ?? process.env;
  if (!webSearchAlways(env)) return false;
  return !!resolveResponsesModel(args.configs ?? MODEL_CONFIGS, env[WEB_SEARCH_MODEL_ENV], args.defaultIds ?? FALLBACK_MODEL_CHAIN);
}

/** The note on the user message of a turn with the Web toggle on (static text). */
export const WEB_SEARCH_REQUESTED_NOTE =
  "(The user turned on web search for this message: search the web with web_search before you answer.)";

/** The user message for the model: with the web search note at the end when the toggle is on. */
export function withWebSearchRequestNote(prompt: string, requested: boolean): string {
  return requested ? `${prompt}${String.fromCharCode(10, 10)}${WEB_SEARCH_REQUESTED_NOTE}` : prompt;
}
