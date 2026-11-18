import { describe, it, expect } from "vitest";
import {
  buildSkillCatalogPrompt,
  resolveSkillCodeInterpreterFiles,
  skillArchiveFileName,
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
});
