import { describe, it, expect } from "vitest";
import {
  buildSkillCatalogPrompt,
  canEditPersonaSkills,
  canUsePersonaSkills,
  resolveSkillCodeInterpreterFiles,
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

describe("canEditPersonaSkills — owner or admin", () => {
  it("the owner may change skills", () => {
    expect(canEditPersonaSkills({ userId: OWNER }, OWNER, false)).toBe(true);
  });

  it("an admin may change skills of any agent", () => {
    expect(canEditPersonaSkills({ userId: OWNER }, OTHER, true)).toBe(true);
  });

  it("other users may not", () => {
    expect(canEditPersonaSkills({ userId: OWNER }, OTHER, false)).toBe(false);
  });
});

describe("resolveSkillCodeInterpreterFiles", () => {
  const attached = [
    { id: "file-old", name: "skill-demo.zip" },
    { id: "file-gone", name: "skill-removed.zip" },
    { id: "file-user", name: "data.csv" },
  ];

  it("maps a skill archive onto the current file of the skill version", () => {
    const out = resolveSkillCodeInterpreterFiles({
      skills: [{ name: "demo", openAiFileId: "file-new" }],
      attachedFiles: attached,
      requestedFileIds: ["file-user", "file-old"],
    });
    expect(out.fileIds).toEqual(["file-user", "file-new"]);
    expect(out.skillsInCodeInterpreter).toEqual(["demo"]);
  });

  it("drops the archive of a deleted or no longer usable skill", () => {
    const out = resolveSkillCodeInterpreterFiles({
      skills: [{ name: "demo", openAiFileId: "file-old" }],
      attachedFiles: attached,
      requestedFileIds: ["file-old", "file-gone", "file-user"],
    });
    expect(out.fileIds).toEqual(["file-old", "file-user"]);
    expect(out.skillsInCodeInterpreter).toEqual(["demo"]);
  });

  it("keeps the requested id when the skill has no cached file yet", () => {
    const out = resolveSkillCodeInterpreterFiles({
      skills: [{ name: "demo" }],
      attachedFiles: attached,
      requestedFileIds: ["file-old"],
    });
    expect(out.fileIds).toEqual(["file-old"]);
  });

  it("passes attached non-skill files through", () => {
    const out = resolveSkillCodeInterpreterFiles({
      skills: [],
      attachedFiles: attached,
      requestedFileIds: ["file-user"],
    });
    expect(out.fileIds).toEqual(["file-user"]);
    expect(out.skillsInCodeInterpreter).toEqual([]);
    expect(out.droppedCount).toBe(0);
  });

  // Pinned: ids that are not attached to the thread used to pass through, so
  // a copied file id (e.g. the shared archive of a skill the user can no
  // longer use, or another user's upload) reached the container.
  it("drops requested ids that are not attached to the thread", () => {
    const out = resolveSkillCodeInterpreterFiles({
      skills: [{ name: "demo", openAiFileId: "file-new" }],
      attachedFiles: attached,
      requestedFileIds: ["file-user", "file-foreign", "file-other-skill"],
    });
    expect(out.fileIds).toEqual(["file-user"]);
    expect(out.skillsInCodeInterpreter).toEqual([]);
    expect(out.droppedCount).toBe(2);
  });

  it("accepts the current file of a usable skill even when it is not attached", () => {
    const out = resolveSkillCodeInterpreterFiles({
      skills: [{ name: "demo", openAiFileId: "file-new" }],
      attachedFiles: attached,
      requestedFileIds: ["file-new", "file-old"],
    });
    expect(out.fileIds).toEqual(["file-new"]);
    expect(out.skillsInCodeInterpreter).toEqual(["demo"]);
    expect(out.droppedCount).toBe(0);
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
    expect(skillArchiveFileName("example-skill")).toBe("skill-example-skill.zip");
  });
});
