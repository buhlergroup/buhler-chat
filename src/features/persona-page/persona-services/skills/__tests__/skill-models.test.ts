import { describe, it, expect } from "vitest";
import {
  buildSkillCatalogPrompt,
  canEditPersonaSkills,
  canUsePersonaSkills,
  skillArchiveFileName,
} from "../skill-models";

const OWNER = "owner-hash";
const OTHER = "other-hash";

describe("canUsePersonaSkills — same rule as opening the agent", () => {
  it("owner can always use the skills", () => {
    expect(canUsePersonaSkills({ userId: OWNER, isPublished: false }, OWNER, false)).toBe(true);
    expect(
      canUsePersonaSkills({ userId: OWNER, isPublished: false, accessGroup: { id: "g1" } }, OWNER, false),
    ).toBe(true);
  });

  it("other users can use the skills of a published agent", () => {
    expect(canUsePersonaSkills({ userId: OWNER, isPublished: true }, OTHER, false)).toBe(true);
  });

  it("other users cannot use the skills of a private agent", () => {
    expect(canUsePersonaSkills({ userId: OWNER, isPublished: false }, OTHER, false)).toBe(false);
  });

  it("group-shared agent: members yes, non-members no (even when published)", () => {
    const shared = { userId: OWNER, isPublished: true, accessGroup: { id: "g1" } };
    expect(canUsePersonaSkills(shared, OTHER, true)).toBe(true);
    expect(canUsePersonaSkills(shared, OTHER, false)).toBe(false);
    expect(canUsePersonaSkills({ ...shared, isPublished: false }, OTHER, true)).toBe(true);
  });

  it("an empty access group id counts as no group", () => {
    expect(
      canUsePersonaSkills({ userId: OWNER, isPublished: true, accessGroup: { id: "" } }, OTHER, false),
    ).toBe(true);
  });
});

describe("canEditPersonaSkills — owner only", () => {
  it("only the owner may change skills", () => {
    expect(canEditPersonaSkills({ userId: OWNER }, OWNER)).toBe(true);
    expect(canEditPersonaSkills({ userId: OWNER }, OTHER)).toBe(false);
  });
});

describe("buildSkillCatalogPrompt", () => {
  it("is empty without skills", () => {
    expect(buildSkillCatalogPrompt([])).toBe("");
  });

  it("lists names and descriptions sorted by name, on one line each", () => {
    const text = buildSkillCatalogPrompt([
      { name: "zeta", description: "Last\nskill" },
      { name: "alpha", description: "First skill" },
    ]);
    expect(text).toContain("## Skills");
    expect(text).toContain("load_skill");
    expect(text.indexOf("- alpha: First skill")).toBeLessThan(text.indexOf("- zeta: Last skill"));
  });

  it("names the code interpreter archive after the skill", () => {
    expect(skillArchiveFileName("buhler-brand-slides")).toBe("skill-buhler-brand-slides.zip");
  });
});
