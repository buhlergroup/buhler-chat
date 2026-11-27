import "server-only";

import type { Tool as AiTool } from "@ai-sdk/provider-utils";
import { logInfo, logWarn } from "@/features/common/services/logger";
import {
  canOpenPersona,
  currentPersonaViewer,
  findPersonaDocument,
} from "@/features/persona-page/persona-services/persona-access";
import { loadUsableSkills } from "@/features/persona-page/persona-services/skills/persona-skill-store";
import { buildSkillCatalogPrompt } from "@/features/persona-page/persona-services/skills/skill-models";
import { resolveExtensionsForChat } from "@/features/extensions-page/extension-services/extension-runtime";
import type { PersonaModel } from "@/features/persona-page/persona-services/models";
import { FALLBACK_MODEL_CHAIN, MODEL_CONFIGS, normalizeChatModelId, type ChatModel } from "../models";
import { resolveReasoningEffort } from "../models/reasoning-effort";
import type { ToolContext } from "../tools/tool-context";
import { copilotModelSelectionId } from "./providers";
import { copilotProviderFor } from "./runtime-flag";
import {
  MAX_SUBAGENT_DEPTH,
  PERSONA_SCOPED_TOOLS,
  personaToolKey,
  type PersonaSubAgentSpec,
  type SubAgentPlanInput,
} from "./subagents";

/** Tools a persona sub-agent never gets: delegation is the runtime's `task` here. */
const DROPPED_TOOLS = new Set(["call_sub_agent", "search_sub_agent"]);

/** Selection id of a model when the Copilot path can run it, else undefined. */
export function selectionIdIfDeployed(modelId: string | undefined): string | undefined {
  if (!modelId) return undefined;
  const id = normalizeChatModelId(modelId) as ChatModel | undefined;
  const config = id ? MODEL_CONFIGS[id] : undefined;
  if (!config?.deploymentName || !copilotProviderFor(config)) return undefined;
  try {
    return copilotModelSelectionId(id as ChatModel);
  } catch {
    return undefined;
  }
}

/**
 * `general` runs on COPILOT_SUBAGENT_MODEL when it is deployed, else on the
 * first deployed model of the fallback chain (GPT-6 Luna, then gpt-5.6-luna),
 * else on the parent model (undefined).
 */
export function generalSubAgentModel(
  env: Record<string, string | undefined> = process.env,
  selectionIdOf: (modelId: string) => string | undefined = selectionIdIfDeployed,
  defaults: ReadonlyArray<string> = FALLBACK_MODEL_CHAIN,
): string | undefined {
  for (const id of [env.COPILOT_SUBAGENT_MODEL?.trim(), ...defaults]) {
    const selectionId = id ? selectionIdOf(id) : undefined;
    if (selectionId) return selectionId;
  }
  return undefined;
}

/** May the current user open this persona (fresh lookup, same rule as call_sub_agent)? */
export async function canUsePersona(personaId: string): Promise<boolean> {
  const persona = await findPersonaDocument(personaId);
  return !!persona && (await canOpenPersona(await currentPersonaViewer(), persona));
}

/**
 * A persona's tools under session-unique keys: search_documents / load_skill
 * get the persona prefix (their behaviour depends on the persona), and the
 * skill catalog in its instructions names the renamed load_skill.
 */
export function scopePersonaTools(
  personaId: string,
  toolset: Record<string, AiTool>,
  instructions: string,
): { toolset: Record<string, AiTool>; instructions: string } {
  const out: Record<string, AiTool> = {};
  let text = instructions;
  for (const [key, t] of Object.entries(toolset)) {
    if (DROPPED_TOOLS.has(key)) continue;
    if ((PERSONA_SCOPED_TOOLS as readonly string[]).includes(key)) {
      const scoped = personaToolKey(personaId, key);
      out[scoped] = t;
      text = text.split(`\`${key}\``).join(`\`${scoped}\``);
    } else {
      out[key] = t;
    }
  }
  return { toolset: out, instructions: text };
}

async function personaSpec(
  persona: PersonaModel,
  ctx: Pick<ToolContext, "user" | "threadId" | "threadDocumentIds" | "clientDateTime">,
  depth: number,
  buildToolset: (ctx: ToolContext) => Promise<Record<string, AiTool>>,
  visited: Set<string>,
): Promise<PersonaSubAgentSpec> {
  const skills = await loadUsableSkills(persona.id);
  const toolset = await buildToolset({
    user: ctx.user,
    threadId: ctx.threadId,
    threadDocumentIds: [],
    personaDocumentIds: persona.personaDocumentIds ?? [],
    defaultTools: persona.defaultTools ?? {},
    clientDateTime: ctx.clientDateTime,
    // Its OWN extensions, under the same access rule as a chat with it.
    extensions: await resolveExtensionsForChat({ extensionIds: persona.extensionIds ?? [], personaId: persona.id }),
    subAgentIds: [],
    // Above the AI SDK path's sub-agent depth: no call_sub_agent / search_sub_agent.
    depth: MAX_SUBAGENT_DEPTH,
    skills,
    skillsInCodeInterpreter: [],
    mcpOutputLimit: Number.POSITIVE_INFINITY,
  });
  const modelId = normalizeChatModelId(persona.selectedModel) as ChatModel | undefined;
  const modelSelectionId = selectionIdIfDeployed(modelId);
  if (persona.selectedModel && !modelSelectionId) {
    logWarn("copilot-runtime: sub-agent model not available on this path, using the parent model", {
      personaId: persona.id,
      model: persona.selectedModel,
    });
  }
  const scoped = scopePersonaTools(
    persona.id,
    toolset,
    (persona.personaMessage ?? "") + buildSkillCatalogPrompt(skills),
  );
  const children =
    depth < MAX_SUBAGENT_DEPTH ? await resolvePersonas(persona.subAgentIds ?? [], ctx, depth + 1, buildToolset, visited) : [];
  return {
    personaId: persona.id,
    displayName: persona.name,
    description: persona.description,
    instructions: scoped.instructions,
    modelSelectionId,
    reasoningEffort: modelSelectionId && modelId ? resolveReasoningEffort({ modelId }) : undefined,
    toolset: scoped.toolset,
    children,
  };
}

async function resolvePersonas(
  ids: readonly string[],
  ctx: Pick<ToolContext, "user" | "threadId" | "threadDocumentIds" | "clientDateTime">,
  depth: number,
  buildToolset: (ctx: ToolContext) => Promise<Record<string, AiTool>>,
  visited: Set<string>,
): Promise<PersonaSubAgentSpec[]> {
  const viewer = await currentPersonaViewer();
  const specs: PersonaSubAgentSpec[] = [];
  for (const id of ids) {
    if (typeof id !== "string" || !id || visited.has(id)) continue;
    visited.add(id);
    const persona = await findPersonaDocument(id);
    if (!persona || !(await canOpenPersona(viewer, persona))) {
      logInfo("copilot-runtime: sub-agent not available to this user", { personaId: id });
      continue;
    }
    specs.push(await personaSpec(persona, ctx, depth, buildToolset, visited));
  }
  return specs;
}

/**
 * The sub-agents of a Copilot session: `general` plus the chat agent's
 * configured sub-agents the user may open (two levels, like call_sub_agent).
 * Runs in the chatting user's request context.
 */
export async function resolveSubAgents(args: {
  subAgentIds: readonly string[] | undefined;
  ctx: Pick<ToolContext, "user" | "threadId" | "threadDocumentIds" | "clientDateTime">;
  parentPersonaId?: string;
}): Promise<SubAgentPlanInput> {
  const { buildToolset } = await import("../tools/registry");
  const visited = new Set<string>(args.parentPersonaId ? [args.parentPersonaId] : []);
  const personas = await resolvePersonas(args.subAgentIds ?? [], args.ctx, 1, buildToolset, visited);
  return { generalModelSelectionId: generalSubAgentModel(), personas };
}
