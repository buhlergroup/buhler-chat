import { describe, it, expect } from "vitest";
import {
  PersonaSkillModelSchema,
  buildSkillCatalogPrompt,
  isGraphDriveId,
  isGraphItemId,
  resolveSkillCodeInterpreterFiles,
  skillArchiveFileName,
  toSkillSummary,
  type PersonaSkillModel,
} from "../skill-models";


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

  it("passes unknown ids and non-skill files through", () => {
    const out = resolveSkillCodeInterpreterFiles({
      skills: [],
      attachedFiles: attached,
      requestedFileIds: ["file-user", "file-new-upload"],
    });
    expect(out.fileIds).toEqual(["file-user", "file-new-upload"]);
    expect(out.skillsInCodeInterpreter).toEqual([]);
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

  it("names skills the user cannot read in SharePoint, without their description", () => {
    const text = buildSkillCatalogPrompt([{ name: "alpha", description: "First" }], ["secret-skill"]);
    expect(text).toContain("- alpha: First");
    expect(text).toMatch(/not available in this chat.*secret-skill/);
    const only = buildSkillCatalogPrompt([], ["secret-skill"]);
    expect(only).toContain("## Skills");
    expect(only).not.toContain("load_skill");
  });
});

describe("linked skills (SharePoint)", () => {
  const linked: PersonaSkillModel = {
    id: "s1",
    type: "PERSONA_SKILL",
    userId: "owner-hash",
    personaId: "p1",
    name: "demo",
    description: "Demo.",
    skillMd: "x",
    rootPrefix: "",
    files: [],
    zipFileName: "demo.zip",
    zipBytes: 1,
    uncompressedBytes: 1,
    blobName: "b",
    source: {
      kind: "sharepoint",
      driveId: "b!AbC_d-1",
      itemId: "01ABCDEF",
      webUrl: "https://example.sharepoint.com/sites/x/demo.zip",
      name: "demo.zip",
      version: "c1",
      lastModifiedDateTime: "2026-11-18T09:00:00Z",
      size: 1,
      syncError: { version: "c2", message: "SKILL.md is missing.", at: "2026-11-18T10:00:00Z" },
    },
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  it("accepts Graph-shaped ids and refuses anything that could change the URL", () => {
    expect(isGraphDriveId("b!AbC_d-1")).toBe(true);
    expect(isGraphItemId("01ABCDEF")).toBe(true);
    expect(isGraphItemId("D4648F06C91D9D3D!54927")).toBe(true);
    for (const bad of ["", "a/b", "../x", "a?b", "a%2Fb", "a.b", "a b", "x".repeat(300)]) {
      expect(isGraphDriveId(bad)).toBe(false);
      expect(isGraphItemId(bad)).toBe(false);
    }
  });

  it("the row schema refuses a non-https link", () => {
    expect(PersonaSkillModelSchema.safeParse(linked).success).toBe(true);
    const bad = { ...linked, source: { ...linked.source!, webUrl: "javascript:alert(1)" } };
    expect(PersonaSkillModelSchema.safeParse(bad).success).toBe(false);
  });

  it("the editor summary shows source, link, date and the sync error, but no ids", () => {
    const summary = toSkillSummary(linked);
    expect(summary.source).toEqual({
      kind: "sharepoint",
      fileName: "demo.zip",
      webUrl: "https://example.sharepoint.com/sites/x/demo.zip",
      lastModifiedDateTime: "2026-11-18T09:00:00Z",
      syncError: "SKILL.md is missing.",
    });
    expect(JSON.stringify(summary)).not.toContain("b!AbC_d-1");
    const { source: _s, ...uploaded } = linked;
    expect(toSkillSummary(uploaded).source).toBeUndefined();
  });
});
