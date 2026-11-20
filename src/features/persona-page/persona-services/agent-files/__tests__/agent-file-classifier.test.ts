import { describe, it, expect } from "vitest";
import {
  allowedUses,
  automaticUse,
  type AgentFileCandidate,
  type AgentFileSizeLimits,
} from "../agent-file-classifier";

const MB = 1_000_000;
const limits: AgentFileSizeLimits = {
  searchMaxBytes: 10 * MB,
  codeMaxBytes: 512 * MB,
  onDemandMaxBytes: 50 * MB,
};

const file = (name: string, sizeBytes = 1000, extra: Partial<AgentFileCandidate> = {}): AgentFileCandidate => ({
  name,
  isFolder: false,
  sizeBytes,
  ...extra,
});

describe("automaticUse (decision 4)", () => {
  it("a folder is On demand", () => {
    expect(automaticUse({ name: "Reports", isFolder: true }, limits)).toEqual({ use: "on-demand" });
  });

  it("a zip that passes the skill validation is a Skill", () => {
    expect(automaticUse(file("brand.zip", 1000, { validSkillZip: true }), limits)).toEqual({ use: "skill" });
  });

  it("any other zip is Code", () => {
    expect(automaticUse(file("data.zip", 1000, { validSkillZip: false }), limits)).toEqual({ use: "code" });
  });

  it("a zip too large for the code interpreter is rejected with the limit", () => {
    const res = automaticUse(file("huge.zip", 600 * MB, { validSkillZip: false }), limits);
    expect(res).toEqual({ rejected: expect.stringMatching(/larger than 512 MB/) });
  });

  it.each(["pdf", "docx", "pptx", "txt", "md", "html", "htm"])(
    "a typical document (.%s) the index reads is Search",
    (ext) => {
      expect(automaticUse(file(`Handbook.${ext}`), limits)).toEqual({ use: "search" });
    },
  );

  it("upper-case extensions count the same", () => {
    expect(automaticUse(file("REPORT.PDF"), limits)).toEqual({ use: "search" });
  });

  it("a .doc file is not Search: the index cannot read it (Document Intelligence has no .doc)", () => {
    const res = automaticUse(file("old.doc"), limits);
    expect(res).toEqual({ rejected: expect.stringMatching(/\.doc cannot be added/) });
  });

  it("a document above the Search size limit goes to Code", () => {
    expect(automaticUse(file("big.pdf", 20 * MB), limits)).toEqual({ use: "code" });
  });

  it.each(["csv", "xlsx", "json", "png", "jpg", "py", "ts", "xls"])(
    "a code interpreter type (.%s) is Code",
    (ext) => {
      expect(automaticUse(file(`data.${ext}`), limits)).toEqual({ use: "code" });
    },
  );

  it.each(["tif", "tiff", "bmp", "heic", "psd"])(
    "a type only the On-demand tools take (.%s) is On demand",
    (ext) => {
      expect(automaticUse(file(`scan.${ext}`), limits)).toEqual({ use: "on-demand" });
    },
  );

  it("an unsupported type is rejected with a clear reason", () => {
    expect(automaticUse(file("setup.exe"), limits)).toEqual({
      rejected: expect.stringMatching(/\.exe cannot be added/),
    });
  });

  it("a file without an extension is rejected", () => {
    expect(automaticUse(file("README"), limits)).toEqual({
      rejected: "Files without an extension cannot be added.",
    });
  });

  it("a supported type that is too large for every use is rejected for its size", () => {
    expect(automaticUse(file("video.pdf", 900 * MB), limits)).toEqual({
      rejected: expect.stringMatching(/too large/),
    });
  });
});

describe("allowedUses (decision 5)", () => {
  it("a folder: On demand only", () => {
    expect(allowedUses({ name: "Reports", isFolder: true }, limits)).toEqual(["on-demand"]);
  });

  it("a valid skill zip: Skill and Code", () => {
    expect(allowedUses(file("brand.zip", 1000, { validSkillZip: true }), limits)).toEqual(["skill", "code"]);
  });

  it("a zip not checked yet offers Skill (validated on change) and Code", () => {
    expect(allowedUses(file("brand.zip"), limits)).toEqual(["skill", "code"]);
  });

  it("a zip known to be no skill: Code only", () => {
    expect(allowedUses(file("data.zip", 1000, { validSkillZip: false }), limits)).toEqual(["code"]);
  });

  it("a zip never offers On demand or Search", () => {
    const uses = allowedUses(file("x.zip"), limits);
    expect(uses).not.toContain("on-demand");
    expect(uses).not.toContain("search");
  });

  it("a PDF: Search (indexable), Code (CI type), On demand (fetchable)", () => {
    expect(allowedUses(file("a.pdf"), limits)).toEqual(["search", "code", "on-demand"]);
  });

  it("an xlsx: Search too (Document Intelligence reads it)", () => {
    expect(allowedUses(file("a.xlsx"), limits)).toEqual(["search", "code", "on-demand"]);
  });

  it("a gif: Code and On demand, not Search (the index cannot read it)", () => {
    expect(allowedUses(file("a.gif"), limits)).toEqual(["code", "on-demand"]);
  });

  it("a tiff: Search and On demand, not Code", () => {
    expect(allowedUses(file("scan.tiff"), limits)).toEqual(["search", "on-demand"]);
  });

  it("a big PDF loses Search above its size limit", () => {
    expect(allowedUses(file("big.pdf", 20 * MB), limits)).toEqual(["code", "on-demand"]);
  });

  it("an image above the fetch limit stays On demand (it comes as a preview)", () => {
    expect(allowedUses(file("huge.png", 60 * MB), limits)).toEqual(["code", "on-demand"]);
  });

  it("an unsupported file allows nothing", () => {
    expect(allowedUses(file("setup.exe"), limits)).toEqual([]);
  });

  it("an unknown size does not limit", () => {
    expect(allowedUses({ name: "a.pdf", isFolder: false }, limits)).toEqual(["search", "code", "on-demand"]);
  });
});
