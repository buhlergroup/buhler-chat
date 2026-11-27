import { describe, it, expect, vi } from "vitest";

vi.mock("@/features/common/services/logger", () => ({ logInfo: vi.fn(), logWarn: vi.fn(), logError: vi.fn() }));
vi.mock("@/features/persona-page/persona-services/persona-access", () => ({
  canOpenPersona: vi.fn(),
  currentPersonaViewer: vi.fn(),
  findPersonaDocument: vi.fn(),
}));
vi.mock("@/features/persona-page/persona-services/skills/persona-skill-store", () => ({ loadUsableSkills: vi.fn() }));
vi.mock("@/features/persona-page/persona-services/skills/skill-models", () => ({ buildSkillCatalogPrompt: vi.fn(() => "") }));
vi.mock("@/features/extensions-page/extension-services/extension-runtime", () => ({ resolveExtensionsForChat: vi.fn() }));

import { generalSubAgentModel } from "./subagent-resolver";

/** Selection ids of the models deployed in a test environment. */
const deployed = (...ids: string[]) => (id: string) => (ids.includes(id) ? `openai/${id}` : undefined);

describe("generalSubAgentModel", () => {
  it("defaults to GPT-6 Luna when both Luna models are deployed", () => {
    expect(generalSubAgentModel({}, deployed("gpt-6-luna", "gpt-5.6-luna"))).toBe("openai/gpt-6-luna");
  });

  it("falls back to gpt-5.6-luna when GPT-6 Luna is not deployed", () => {
    expect(generalSubAgentModel({}, deployed("gpt-5.6-luna"))).toBe("openai/gpt-5.6-luna");
  });

  it("COPILOT_SUBAGENT_MODEL wins when it is deployed", () => {
    expect(generalSubAgentModel({ COPILOT_SUBAGENT_MODEL: " gpt-6-sol " }, deployed("gpt-6-sol", "gpt-6-luna"))).toBe("openai/gpt-6-sol");
  });

  it("an undeployed COPILOT_SUBAGENT_MODEL falls back to the chain, then to the parent model (negative)", () => {
    expect(generalSubAgentModel({ COPILOT_SUBAGENT_MODEL: "gpt-6-sol" }, deployed("gpt-6-luna"))).toBe("openai/gpt-6-luna");
    expect(generalSubAgentModel({}, deployed())).toBeUndefined();
  });
});
