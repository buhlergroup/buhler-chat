import { describe, it, expect } from "vitest";
import { tool } from "ai";
import { z } from "zod";

import {
  buildSubAgentPlan,
  GENERAL_AGENT_NAME,
  personaAgentName,
  personaToolKey,
  SubAgentTurnGate,
  type PersonaSubAgentSpec,
} from "./subagents";

const t = () => tool({ description: "d", inputSchema: z.object({}), execute: async () => "ok" });
const parent = {
  appToolNames: ["get_current_time", "search_documents", "abcd1234_lookup"],
  workspaceToolNames: ["view", "apply_patch", "rg", "glob"],
  readOnlyWorkspaceToolNames: ["view", "rg", "glob"],
};
const persona = (id: string, name: string, toolKeys: string[], children: PersonaSubAgentSpec[] = []): PersonaSubAgentSpec => ({
  personaId: id,
  displayName: name,
  description: `${name} agent`,
  instructions: `You are ${name}.`,
  modelSelectionId: "azure/model-x",
  reasoningEffort: "low",
  toolset: Object.fromEntries(toolKeys.map((k) => [k, t()])),
  children,
});
const hook = (toolName: string, toolArgs: unknown, extra: Record<string, unknown> = {}) =>
  ({ toolName, toolArgs, timestamp: 0, cwd: "/workspace", ...extra }) as never;

describe("sub-agent plan", () => {
  it("general: the parent's tools without task, its model, no built-in agents needed", () => {
    const plan = buildSubAgentPlan({ generalModelSelectionId: "azure/fast", personas: [] }, parent);
    const general = plan.definitions.find((d) => d.name === GENERAL_AGENT_NAME)!;
    expect(general.tools).toEqual(["view", "apply_patch", "rg", "glob", "get_current_time", "search_documents", "abcd1234_lookup"]);
    expect(general.tools).not.toContain("task");
    expect(general.model).toBe("azure/fast");
    expect(general.description).toMatch(/parallel/);
    expect(plan.rootCanStart.has(GENERAL_AGENT_NAME)).toBe(true);
    expect(plan.extraTools).toEqual({});
    // No model configured: the runtime uses the parent model.
    expect(buildSubAgentPlan({ personas: [] }, parent).definitions[0].model).toBeUndefined();
  });

  it("persona: own allow-list, its tools hidden from the parent, children only to depth 2", () => {
    const ownKey = personaToolKey("p1aaaaaaaa", "search_documents");
    const grandchild = persona("p3", "Deep", ["get_current_time"]);
    const child = persona("p2", "Child", ["ext22222_fetch"], [grandchild]);
    const plan = buildSubAgentPlan({ personas: [persona("p1aaaaaaaa", "Research", [ownKey, "abcd1234_lookup"], [child])] }, parent);
    const research = plan.definitions.find((d) => d.displayName === "Research")!;
    expect(research.tools).toEqual(["view", "rg", "glob", ownKey, "abcd1234_lookup", "task"]);
    expect(research.model).toBe("azure/model-x");
    expect(research.prompt).toContain("You are Research.");
    const childDef = plan.definitions.find((d) => d.displayName === "Child")!;
    // Depth 2: no task, and its own child is not registered.
    expect(childDef.tools).not.toContain("task");
    expect(plan.definitions.some((d) => d.displayName === "Deep")).toBe(false);
    // The parent sees neither the persona's own search nor the child's extension tool.
    expect(plan.parentExcludedTools.sort()).toEqual([ownKey, "ext22222_fetch"].sort());
    expect(Object.keys(plan.extraTools).sort()).toEqual([ownKey, "ext22222_fetch"].sort());
    // A tool the parent has too is shared, not duplicated.
    expect(plan.parentExcludedTools).not.toContain("abcd1234_lookup");
    expect(plan.rootCanStart.has(research.name)).toBe(true);
    expect(plan.rootCanStart.has(childDef.name)).toBe(false);
  });

  it("names are stable, readable and never 'general'", () => {
    expect(personaAgentName("AbC-123456", "Market Research!")).toBe("market-research-abc123");
    expect(personaAgentName("x", "General")).not.toBe(GENERAL_AGENT_NAME);
    expect(personaToolKey("p1", "load_skill")).toMatch(/^[A-Za-z0-9]{8}_load_skill$/);
  });

  it("the signature changes with the definitions", () => {
    const a = buildSubAgentPlan({ personas: [persona("p1", "A", [])] }, parent).signature;
    const b = buildSubAgentPlan({ personas: [persona("p1", "B", [])] }, parent).signature;
    expect(a).not.toBe(b);
  });
});

describe("sub-agent turn gate", () => {
  const plan = () =>
    buildSubAgentPlan(
      { personas: [persona("p1", "Research", ["get_current_time"], [persona("p2", "Child", [])]), persona("p9", "Other", [])] },
      parent,
    );

  it("allows general and configured personas, forces synchronous mode", async () => {
    const gate = new SubAgentTurnGate(plan());
    const ok = await gate.checkTask(hook("task", { agent_type: "general", prompt: "x", mode: "sync" }, { toolCallId: "c1" }));
    expect(ok.permissionDecision).toBe("allow");
    const bg = await gate.checkTask(hook("task", { agent_type: "general", prompt: "x", mode: "background" }, { toolCallId: "c2" }));
    expect(bg).toMatchObject({ permissionDecision: "allow", modifiedArgs: { mode: "sync" } });
    const unknown = await gate.checkTask(hook("task", { agent_type: "explore" }, { toolCallId: "c3" }));
    expect(unknown.permissionDecision).toBe("deny");
  });

  it("at most 4 sub-agents at once; a finished one frees its slot", async () => {
    const gate = new SubAgentTurnGate(plan());
    for (let i = 0; i < 4; i++) {
      expect((await gate.checkTask(hook("task", { agent_type: "general" }, { toolCallId: `c${i}` }))).permissionDecision).toBe("allow");
    }
    const fifth = await gate.checkTask(hook("task", { agent_type: "general" }, { toolCallId: "c4" }));
    expect(fifth.permissionDecision).toBe("deny");
    expect(fifth.permissionDecisionReason).toMatch(/At most 4/);
    gate.onEvent({ type: "subagent.completed", agentId: "x", data: { toolCallId: "c0" } });
    expect((await gate.checkTask(hook("task", { agent_type: "general" }, { toolCallId: "c5" }))).permissionDecision).toBe("allow");
  });

  it("re-checks access to a persona sub-agent (cached per turn)", async () => {
    const canUsePersona = async (id: string) => id !== "p9";
    const gate = new SubAgentTurnGate(plan(), { canUsePersona });
    const p = plan();
    const other = [...p.agents.values()].find((a) => a.personaId === "p9")!.name;
    const research = [...p.agents.values()].find((a) => a.personaId === "p1")!.name;
    expect((await gate.checkTask(hook("task", { agent_type: other }, { toolCallId: "c1" }))).permissionDecision).toBe("deny");
    expect((await gate.checkTask(hook("task", { agent_type: research }, { toolCallId: "c2" }))).permissionDecision).toBe("allow");
    await expect(gate.onStart(other)).rejects.toThrow(/not available/);
    await expect(gate.onStart(research)).resolves.toBeUndefined();
    await expect(gate.onStart("explore")).rejects.toThrow(/not configured/);
  });

  it("a sub-agent may start only its own children, and nothing below depth 2", async () => {
    const p = plan();
    const gate = new SubAgentTurnGate(p);
    const research = [...p.agents.values()].find((a) => a.personaId === "p1")!.name;
    const child = [...p.agents.values()].find((a) => a.personaId === "p2")!.name;
    expect((await gate.checkTask(hook("task", { agent_type: research }, { toolCallId: "r1" }))).permissionDecision).toBe("allow");
    gate.onEvent({ type: "subagent.started", agentId: "agent-r", data: { agentName: research, toolCallId: "r1" } });
    // Research (depth 1) may start Child, not general.
    expect((await gate.checkTask(hook("task", { agent_type: child }, { toolCallId: "r2", agentId: "agent-r" }))).permissionDecision).toBe("allow");
    expect((await gate.checkTask(hook("task", { agent_type: "general" }, { toolCallId: "r3", agentId: "agent-r" }))).permissionDecision).toBe("deny");
    gate.onEvent({ type: "subagent.started", agentId: "agent-c", data: { agentName: child, toolCallId: "r2" } });
    // Child runs at depth 2: no further sub-agents.
    expect((await gate.checkTask(hook("task", { agent_type: child }, { toolCallId: "r4", agentId: "agent-c" }))).permissionDecision).toBe("deny");
    // Tool allow-list per agent.
    expect(gate.toolAllowed(hook("get_current_time", {}, { agentId: "agent-r" }))).toBe(true);
    expect(gate.toolAllowed(hook("abcd1234_lookup", {}, { agentId: "agent-r" }))).toBe(false);
    expect(gate.toolAllowed(hook("abcd1234_lookup", {}))).toBe(true);
    // Unknown sub-agent instance: fail closed.
    expect(gate.toolAllowed(hook("view", {}, { agentId: "agent-unknown" }))).toBe(false);
    expect(gate.agentNameOf("agent-r")).toBe(research);
    expect(gate.personaIdOf(research)).toBe("p1");
    expect(gate.displayName(research)).toBe("Research");
  });
});
