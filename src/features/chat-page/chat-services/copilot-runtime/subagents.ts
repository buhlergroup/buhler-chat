/**
 * Sub-agents on the Copilot path.
 *
 * The runtime's own built-in sub-agents are OFF (`includedBuiltinAgents: []`):
 * they are coding agents with shell and repository tools. Instead every
 * session gets:
 *
 *   - `general`: a generic helper for delegated subtasks. Same tools as the
 *     parent except sub-agent spawning (depth 1). Model from
 *     COPILOT_SUBAGENT_MODEL (default: the fast model) or the parent model.
 *   - one agent per configured sub-agent of the chat's agent (persona) that
 *     the user may open: its instructions, model, skills and its OWN tools
 *     (extensions, MCP tools, search over its documents) plus read-only
 *     workspace tools. A persona sub-agent with configured sub-agents of its
 *     own may start those (max depth 2, as call_sub_agent on the AI SDK path).
 *
 * All tools are registered once per session; each agent sees only its
 * allow-list (CustomAgentConfig.tools), and the parent does not see tools
 * that belong only to a sub-agent (agents.default.excludedTools).
 *
 * The turn gate (SubAgentTurnGate) is the hook-side check of every `task`
 * call: target allowed for the caller, access re-checked, depth <= 2, at most
 * MAX_PARALLEL_SUBAGENTS running at once, and synchronous mode only (a
 * background sub-agent would outlive the turn).
 */
import type { CustomAgentConfig } from "@microsoft/copilot-sdk";
import type { Tool as AiTool } from "@ai-sdk/provider-utils";
import type { CopilotEventLike } from "./event-mapper";
import { SUBAGENT_TOOL, type PreToolUseInput, type PreToolUseOutput, type SubAgentHookGate } from "./session-gates";

export const GENERAL_AGENT_NAME = "general";
export const MAX_SUBAGENT_DEPTH = 2;
export const MAX_PARALLEL_SUBAGENTS = 4;

const GENERAL_DESCRIPTION =
  "General helper for a delegated subtask. Use it to run independent subtasks in parallel " +
  "(several task calls in one message), to read large files or long tool results and report " +
  "only what matters, for research steps, and to keep your own context small. It has your tools " +
  "and the files in /workspace, but cannot start sub-agents. Give it a complete, self-contained task.";

const GENERAL_PROMPT = [
  "You are a helper agent. Another agent delegated one task to you.",
  "Do exactly that task with the tools you have. You can read and write files in /workspace.",
  "Return a short result: the answer or the key facts, and the paths of files you wrote.",
  "Put long content into a file in /workspace and return its path instead of the full text.",
  "Do not ask questions back; if something is missing, make a sensible assumption and say so.",
].join(" ");

const PERSONA_SUFFIX = [
  "",
  "",
  "## Working as a sub-agent",
  "Another agent delegated one task to you. Do it with your own tools.",
  "You can read files in /workspace (view, search). Return a short result with the key facts",
  "and any file paths; do not ask questions back.",
].join("\n");

export interface PersonaSubAgentSpec {
  personaId: string;
  displayName: string;
  description: string;
  /** The agent's instructions (persona message + skill catalog). */
  instructions: string;
  /** Selection id (`<provider>/<model>`), undefined to run on the parent model. */
  modelSelectionId?: string;
  reasoningEffort?: string;
  /** Its own tools; keys are unique across the session (see personaToolKey). */
  toolset: Record<string, AiTool>;
  /** Its own configured sub-agents (depth 2). */
  children?: PersonaSubAgentSpec[];
}

export interface SubAgentPlanInput {
  /** Model of `general`, undefined to use the parent model. */
  generalModelSelectionId?: string;
  personas: PersonaSubAgentSpec[];
}

export interface PlannedAgent {
  name: string;
  displayName: string;
  personaId?: string;
  /** Tools the agent may call (its allow-list). */
  tools: ReadonlySet<string>;
  /** Agents it may start with `task`. */
  canStart: ReadonlySet<string>;
}

export interface SubAgentPlan {
  definitions: CustomAgentConfig[];
  /** Sub-agent tools that are not in the parent's toolset (registered too). */
  extraTools: Record<string, AiTool>;
  /** Tools the parent must not see. */
  parentExcludedTools: string[];
  agents: ReadonlyMap<string, PlannedAgent>;
  /** Agents the parent (root) may start. */
  rootCanStart: ReadonlySet<string>;
  /** Changes when any definition changes (the session must then be reopened). */
  signature: string;
}

/** Runtime agent name of a persona: readable slug + id prefix, unique and stable. */
export function personaAgentName(personaId: string, displayName: string): string {
  const slug = displayName
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32);
  const id = personaId.replace(/[^A-Za-z0-9]/g, "").slice(0, 6).toLowerCase();
  const name = `${slug || "agent"}-${id || "x"}`;
  return name === GENERAL_AGENT_NAME ? `${name}-agent` : name;
}

/**
 * Session-unique key for a persona's own copy of a tool whose plain name the
 * parent may use for ITS copy (search_documents over other documents,
 * load_skill with other skills). Same shape as an extension tool key, so the
 * chat shows the plain name.
 */
export function personaToolKey(personaId: string, toolName: string): string {
  const prefix = `${personaId.replace(/[^A-Za-z0-9]/g, "")}xxxxxxxx`.slice(0, 8);
  return `${prefix}_${toolName}`;
}

/** Tools of a persona that are renamed (their behaviour depends on the persona). */
export const PERSONA_SCOPED_TOOLS = ["search_documents", "load_skill"] as const;

export function buildSubAgentPlan(
  input: SubAgentPlanInput,
  parent: { appToolNames: readonly string[]; workspaceToolNames: readonly string[]; readOnlyWorkspaceToolNames: readonly string[] },
): SubAgentPlan {
  const definitions: CustomAgentConfig[] = [];
  const agents = new Map<string, PlannedAgent>();
  const extraTools: Record<string, AiTool> = {};
  const parentTools = new Set(parent.appToolNames);

  const generalTools = [...parent.workspaceToolNames, ...parent.appToolNames].filter((t) => t !== SUBAGENT_TOOL);
  definitions.push({
    name: GENERAL_AGENT_NAME,
    displayName: "General",
    description: GENERAL_DESCRIPTION,
    prompt: GENERAL_PROMPT,
    tools: generalTools,
    infer: true,
    ...(input.generalModelSelectionId ? { model: input.generalModelSelectionId } : {}),
  });
  agents.set(GENERAL_AGENT_NAME, {
    name: GENERAL_AGENT_NAME,
    displayName: "General",
    tools: new Set(generalTools),
    canStart: new Set(),
  });

  const seen = new Set<string>();
  const add = (spec: PersonaSubAgentSpec, depth: number): string | undefined => {
    const name = personaAgentName(spec.personaId, spec.displayName);
    if (seen.has(spec.personaId)) return name;
    seen.add(spec.personaId);
    const children =
      depth < MAX_SUBAGENT_DEPTH
        ? (spec.children ?? []).map((c) => add(c, depth + 1)).filter((n): n is string => !!n)
        : [];
    for (const [key, t] of Object.entries(spec.toolset)) {
      if (!parentTools.has(key)) extraTools[key] = t;
    }
    const tools = [
      ...parent.readOnlyWorkspaceToolNames,
      ...Object.keys(spec.toolset),
      ...(children.length > 0 ? [SUBAGENT_TOOL] : []),
    ];
    definitions.push({
      name,
      displayName: spec.displayName,
      description: spec.description || spec.displayName,
      prompt: `${spec.instructions}${PERSONA_SUFFIX}`,
      tools,
      infer: true,
      ...(spec.modelSelectionId ? { model: spec.modelSelectionId } : {}),
      ...(spec.reasoningEffort ? { reasoningEffort: spec.reasoningEffort as CustomAgentConfig["reasoningEffort"] } : {}),
    });
    agents.set(name, {
      name,
      displayName: spec.displayName,
      personaId: spec.personaId,
      tools: new Set(tools),
      canStart: new Set(children),
    });
    return name;
  };
  const rootPersonas = input.personas.map((p) => add(p, 1)).filter((n): n is string => !!n);

  const signature = JSON.stringify(
    definitions.map((d) => [d.name, d.description, d.prompt, d.tools, d.model ?? "", d.reasoningEffort ?? ""]),
  );
  return {
    definitions,
    extraTools,
    parentExcludedTools: Object.keys(extraTools),
    agents,
    rootCanStart: new Set([GENERAL_AGENT_NAME, ...rootPersonas]),
    signature,
  };
}

export interface SubAgentTurnGateOptions {
  maxParallel?: number;
  /** Access re-check for a persona sub-agent, in the chatting user's request context. */
  canUsePersona?: (personaId: string) => Promise<boolean>;
  onDenied?: (reason: string, detail: Record<string, unknown>) => void;
}

const deny = (reason: string): PreToolUseOutput => ({ permissionDecision: "deny", permissionDecisionReason: reason });

/** Per-turn state of the sub-agent gate (see file header). */
export class SubAgentTurnGate implements SubAgentHookGate {
  private readonly agentNames = new Map<string, string>();
  private readonly agentDepths = new Map<string, number>();
  private readonly pendingDepth = new Map<string, number>();
  private readonly active = new Set<string>();
  private readonly accessCache = new Map<string, Promise<boolean>>();
  private readonly maxParallel: number;

  constructor(
    private readonly plan: SubAgentPlan,
    private readonly options: SubAgentTurnGateOptions = {},
  ) {
    this.maxParallel = options.maxParallel ?? MAX_PARALLEL_SUBAGENTS;
  }

  /** Display name of an agent (for the chat's tool part). */
  displayName(name: string): string {
    return this.plan.agents.get(name)?.displayName ?? name;
  }

  /** Persona id of an agent name (usage attribution). */
  personaIdOf(name: string): string | undefined {
    return this.plan.agents.get(name)?.personaId;
  }

  /** Agent name of a sub-agent instance id (from subagent.started). */
  agentNameOf(agentId: string): string | undefined {
    return this.agentNames.get(agentId);
  }

  get running(): number {
    return this.active.size;
  }

  /** Feed every session event of the turn. */
  onEvent(event: CopilotEventLike): void {
    const d = event.data ?? {};
    switch (event.type) {
      case "subagent.started":
        if (event.agentId && typeof d.agentName === "string") {
          this.agentNames.set(event.agentId, d.agentName);
          this.agentDepths.set(event.agentId, this.pendingDepth.get(String(d.toolCallId)) ?? 1);
        }
        break;
      case "subagent.completed":
      case "subagent.failed":
      case "tool.execution_complete":
        if (typeof d.toolCallId === "string") this.active.delete(d.toolCallId);
        break;
      default:
        break;
    }
  }

  private caller(input: PreToolUseInput): { name: string; depth: number } | undefined {
    if (!input.agentId) return { name: "", depth: 0 };
    const name = this.agentNames.get(input.agentId) ?? input.agentType;
    if (!name) return undefined;
    return { name, depth: this.agentDepths.get(input.agentId) ?? 1 };
  }

  toolAllowed(input: PreToolUseInput): boolean {
    const caller = this.caller(input);
    if (!caller) return false;
    if (caller.depth === 0) return true;
    const agent = this.plan.agents.get(caller.name);
    return !!agent && agent.tools.has(input.toolName);
  }

  async checkTask(input: PreToolUseInput): Promise<PreToolUseOutput> {
    const args = (input.toolArgs && typeof input.toolArgs === "object" ? input.toolArgs : {}) as Record<string, unknown>;
    const target = typeof args.agent_type === "string" ? args.agent_type : "";
    const caller = this.caller(input);
    const refuse = (reason: string) => {
      this.options.onDenied?.(reason, { target, caller: caller?.name, depth: caller?.depth });
      return deny(reason);
    };
    if (!caller) return refuse("Unknown caller");
    if (caller.depth >= MAX_SUBAGENT_DEPTH) return refuse("Sub-agents cannot be nested deeper.");
    const allowed = caller.depth === 0 ? this.plan.rootCanStart : this.plan.agents.get(caller.name)?.canStart;
    if (!allowed?.has(target)) {
      return refuse(`Agent "${target}" is not available. Available: ${[...(allowed ?? [])].join(", ") || "none"}.`);
    }
    const personaId = this.plan.agents.get(target)?.personaId;
    if (personaId && !(await this.canUse(personaId))) return refuse(`Agent "${target}" is not available to this user.`);
    if (this.active.size >= this.maxParallel) {
      return refuse(`At most ${this.maxParallel} sub-agents can run at the same time. Wait for one to finish.`);
    }
    const id = input.toolCallId ?? `call-${this.active.size}-${Date.now()}`;
    this.active.add(id);
    this.pendingDepth.set(id, caller.depth + 1);
    // Synchronous only: a background sub-agent would outlive the turn.
    return args.mode === "sync" || args.mode === undefined
      ? { permissionDecision: "allow" }
      : { permissionDecision: "allow", modifiedArgs: { ...args, mode: "sync" } };
  }

  /** onSubagentStart: the access check again, right before the sub-agent runs. */
  async onStart(agentName: string): Promise<void> {
    const personaId = this.plan.agents.get(agentName)?.personaId;
    if (!this.plan.agents.has(agentName)) throw new Error(`Agent "${agentName}" is not configured`);
    if (personaId && !(await this.canUse(personaId))) {
      this.options.onDenied?.("access", { target: agentName });
      throw new Error(`Agent "${agentName}" is not available to this user`);
    }
  }

  private canUse(personaId: string): Promise<boolean> {
    const check = this.options.canUsePersona;
    if (!check) return Promise.resolve(true);
    let cached = this.accessCache.get(personaId);
    if (!cached) {
      cached = check(personaId).catch(() => false);
      this.accessCache.set(personaId, cached);
    }
    return cached;
  }
}
