import { describe, it, expect } from "vitest";
import {
  SkillZipError,
  normaliseZipPath,
  parseSkillFrontMatter,
  readSkillZipFile,
  validateSkillZip,
} from "../skill-zip";
import { SKILL_LIMITS } from "../skill-models";
import { buildZip, SKILL_MD } from "./zip-fixture";

const goodEntries = () => [
  { name: "demo-skill/", data: "" },
  { name: "demo-skill/SKILL.md", data: SKILL_MD },
  { name: "demo-skill/scripts/run.py", data: "print('hi')\n" },
  { name: "demo-skill/references/guide.md", data: "# Guide\n" },
  { name: "demo-skill/assets/a/b/logo.bin", data: Buffer.from([0, 1, 2, 3]) },
];

const expectReject = async (buf: Buffer, pattern: RegExp, limits = SKILL_LIMITS) => {
  let error: unknown;
  try {
    await validateSkillZip(buf, limits);
  } catch (e) {
    error = e;
  }
  expect(error).toBeInstanceOf(SkillZipError);
  expect((error as Error).message).toMatch(pattern);
};

describe("validateSkillZip — good packages", () => {
  it("accepts a skill in one top folder and reads name, description and files", async () => {
    const pkg = await validateSkillZip(buildZip(goodEntries()));
    expect(pkg.name).toBe("demo-skill");
    expect(pkg.description).toBe("Builds demo things. Use it when the user asks for a demo.");
    expect(pkg.rootPrefix).toBe("demo-skill/");
    expect(pkg.files.map((f) => f.path)).toEqual([
      "SKILL.md",
      "assets/a/b/logo.bin",
      "references/guide.md",
      "scripts/run.py",
    ]);
    expect(pkg.skillMd).toContain("# Demo skill");
  });

  it("accepts SKILL.md at the zip root and ignores __MACOSX junk", async () => {
    const pkg = await validateSkillZip(
      buildZip([
        { name: "SKILL.md", data: SKILL_MD },
        { name: "scripts/run.py", data: "x" },
        { name: "__MACOSX/._SKILL.md", data: "junk" },
      ]),
    );
    expect(pkg.rootPrefix).toBe("");
    expect(pkg.files.map((f) => f.path)).toEqual(["SKILL.md", "scripts/run.py"]);
  });

  it("accepts backslash separators from old Windows archivers", async () => {
    const pkg = await validateSkillZip(
      buildZip([
        { name: "demo-skill\\SKILL.md", data: SKILL_MD },
        { name: "demo-skill\\scripts\\run.py", data: "x" },
      ]),
    );
    expect(pkg.files.map((f) => f.path)).toEqual(["SKILL.md", "scripts/run.py"]);
  });

  it("reads one file back from the package", async () => {
    const buf = buildZip(goodEntries());
    const pkg = await validateSkillZip(buf);
    expect(readSkillZipFile(buf, pkg.rootPrefix, "references/guide.md")?.toString()).toBe("# Guide\n");
    expect(readSkillZipFile(buf, pkg.rootPrefix, "./scripts/run.py")?.toString()).toContain("print");
    expect(readSkillZipFile(buf, pkg.rootPrefix, "missing.md")).toBeUndefined();
    expect(readSkillZipFile(buf, pkg.rootPrefix, "../demo-skill/SKILL.md")).toBeUndefined();
  });
});

describe("validateSkillZip — path attacks", () => {
  it("rejects zip-slip (..) paths", async () => {
    await expectReject(
      buildZip([...goodEntries(), { name: "demo-skill/../../evil.sh", data: "rm -rf /" }]),
      /Unsafe path/,
    );
  });

  it("rejects absolute paths and drive letters", async () => {
    await expectReject(buildZip([...goodEntries(), { name: "/etc/passwd", data: "x" }]), /Absolute/);
    await expectReject(buildZip([...goodEntries(), { name: "C:/Windows/x.dll", data: "x" }]), /Absolute/);
  });

  it("rejects symbolic links", async () => {
    await expectReject(
      buildZip([
        ...goodEntries(),
        { name: "demo-skill/link", data: "/etc/passwd", method: 0, unixMode: 0o120777 },
      ]),
      /Symbolic links/,
    );
  });

  it("accepts regular Unix files and folders", async () => {
    const pkg = await validateSkillZip(
      buildZip([
        { name: "demo-skill/", unixMode: 0o040755 },
        { name: "demo-skill/SKILL.md", data: SKILL_MD, unixMode: 0o100644 },
      ]),
    );
    expect(pkg.files).toHaveLength(1);
  });

  it("rejects encrypted entries", async () => {
    await expectReject(
      buildZip([{ name: "demo-skill/SKILL.md", data: SKILL_MD, flags: 0x1 }]),
      /Encrypted/,
    );
  });

  it("rejects duplicate paths (case-insensitive)", async () => {
    await expectReject(
      buildZip([...goodEntries(), { name: "demo-skill/scripts/RUN.py", data: "x" }]),
      /Duplicate/,
    );
  });

  it("normaliseZipPath rejects . and empty segments", async () => {
    expect(() => normaliseZipPath("a/./b")).toThrow(SkillZipError);
    expect(() => normaliseZipPath("a//b")).toThrow(SkillZipError);
    expect(normaliseZipPath("a\\b.txt")).toBe("a/b.txt");
  });
});

describe("validateSkillZip — size and bomb limits", () => {
  it("rejects a file that inflates far beyond its compressed size (ratio)", async () => {
    const zeros = Buffer.alloc(5_000_000); // deflates to a few KB: ratio ~1000
    await expectReject(
      buildZip([...goodEntries(), { name: "demo-skill/assets/zeros.bin", data: zeros }]),
      /zip bomb/,
    );
  });

  it("rejects a total unpacked size over the limit", async () => {
    const limits = { ...SKILL_LIMITS, maxUncompressedBytes: 1000 };
    await expectReject(
      buildZip([...goodEntries(), { name: "demo-skill/assets/big.txt", data: "x".repeat(2000), method: 0 }]),
      /larger than/,
      limits,
    );
  });

  it("rejects a header that under-declares the real size (inflate cap)", async () => {
    await expectReject(
      buildZip([
        { name: "demo-skill/SKILL.md", data: SKILL_MD },
        { name: "demo-skill/assets/liar.txt", data: "y".repeat(50_000), declaredSize: 10 },
      ]),
      /larger than declared|does not match/,
    );
  });

  // Pinned: junk entries (__MACOSX/, .DS_Store, Thumbs.db) used to be skipped
  // before these checks, but the stored zip keeps them and the sandbox
  // extracts the whole zip.
  it("counts junk entries for the ratio (zip bomb) check", async () => {
    const zeros = Buffer.alloc(5_000_000); // deflates to a few KB: ratio ~1000
    await expectReject(
      buildZip([...goodEntries(), { name: "__MACOSX/demo-skill/._zeros", data: zeros }]),
      /zip bomb/,
    );
  });

  it("counts junk entries for the total unpacked size", async () => {
    const limits = { ...SKILL_LIMITS, maxUncompressedBytes: 1000 };
    await expectReject(
      buildZip([
        ...goodEntries(),
        { name: "demo-skill/.DS_Store", data: "x".repeat(2000), method: 0 },
      ]),
      /larger than/,
      limits,
    );
  });

  it("counts junk entries for the file limit", async () => {
    const limits = { ...SKILL_LIMITS, maxFiles: 5 };
    await expectReject(
      buildZip([
        ...goodEntries(),
        { name: "__MACOSX/demo-skill/._SKILL.md", data: "junk" },
        { name: "demo-skill/Thumbs.db", data: "junk" },
      ]),
      /more than 5 files/,
      limits,
    );
  });

  it("still accepts small junk entries and leaves them out of the file list", async () => {
    const pkg = await validateSkillZip(
      buildZip([
        ...goodEntries(),
        { name: "__MACOSX/demo-skill/._SKILL.md", data: "junk" },
        { name: "demo-skill/.DS_Store", data: "junk" },
      ]),
    );
    expect(pkg.files.map((f) => f.path)).not.toContain(".DS_Store");
    expect(pkg.files).toHaveLength(4);
  });

  it("rejects a zip over the size limit", async () => {
    const limits = { ...SKILL_LIMITS, maxZipBytes: 100 };
    await expectReject(buildZip(goodEntries()), /larger than/, limits);
  });

  it("rejects too many files", async () => {
    const limits = { ...SKILL_LIMITS, maxFiles: 3 };
    await expectReject(buildZip(goodEntries()), /more than 3 files/, limits);
  });

  it("rejects folders nested deeper than the limit", async () => {
    await expectReject(
      buildZip([...goodEntries(), { name: "demo-skill/a/b/c/d/deep.txt", data: "x" }]),
      /nested too deep/,
    );
  });

  it("rejects data that is not a zip", async () => {
    await expectReject(Buffer.from("this is not a zip file at all, really not"), /not a valid zip/);
  });
});

describe("validateSkillZip — SKILL.md and front matter", () => {
  it("rejects a zip without SKILL.md", async () => {
    await expectReject(
      buildZip([{ name: "demo-skill/README.md", data: "# hi" }]),
      /SKILL.md is missing/,
    );
  });

  it("rejects SKILL.md that is not at the root or in the only top folder", async () => {
    await expectReject(
      buildZip([
        { name: "one/SKILL.md", data: SKILL_MD },
        { name: "two/other.md", data: "x" },
      ]),
      /SKILL.md is missing/,
    );
    await expectReject(
      buildZip([{ name: "demo-skill/nested/SKILL.md", data: SKILL_MD }]),
      /SKILL.md is missing/,
    );
  });

  it("rejects SKILL.md without front matter", async () => {
    await expectReject(buildZip([{ name: "SKILL.md", data: "# No front matter" }]), /front matter/);
  });

  it("rejects front matter without a description", async () => {
    await expectReject(buildZip([{ name: "SKILL.md", data: "---\nname: demo\n---\nbody" }]), /description/);
  });

  it("rejects an invalid name", async () => {
    await expectReject(
      buildZip([{ name: "SKILL.md", data: "---\nname: Demo_Skill\ndescription: x\n---\n" }]),
      /not valid/,
    );
    await expectReject(
      buildZip([{ name: "SKILL.md", data: "---\nname: demo--skill\ndescription: x\n---\n" }]),
      /not valid/,
    );
  });

  it("rejects a name that does not match its folder", async () => {
    await expectReject(
      buildZip([{ name: "other-folder/SKILL.md", data: SKILL_MD }]),
      /must match its folder/,
    );
  });

  it("parses quoted values, folded and literal block scalars, and CRLF", async () => {
    const { frontMatter, body } = parseSkillFrontMatter(
      '---\r\nname: "x-skill"\r\ndescription: >\r\n  first line\r\n  second line\r\ncompatibility: |\r\n  a\r\n  b\r\n---\r\n# Body\r\n',
    );
    expect(frontMatter.name).toBe("x-skill");
    expect(frontMatter.description).toBe("first line second line");
    expect(frontMatter.extra.compatibility).toBe("a\nb");
    expect(body).toBe("# Body\n");
  });

  it("parses a single-quoted description with a colon", async () => {
    const { frontMatter } = parseSkillFrontMatter(
      "---\nname: x\ndescription: 'Use it: for ''demo'' work'\n---\n",
    );
    expect(frontMatter.description).toBe("Use it: for 'demo' work");
  });
});

// Optional check against a real package: SKILL_ZIP_SAMPLE=<path to .zip>.
describe.skipIf(!process.env.SKILL_ZIP_SAMPLE)("validateSkillZip — real package", () => {
  it("accepts the sample package", async () => {
    const { readFileSync } = await import("node:fs");
    const buf = readFileSync(process.env.SKILL_ZIP_SAMPLE as string);
    const pkg = await validateSkillZip(buf);
    console.log(
      `sample: name=${pkg.name} files=${pkg.files.length} zip=${pkg.zipBytes} unpacked=${pkg.uncompressedBytes} root=${pkg.rootPrefix}`,
    );
    expect(pkg.files.length).toBeGreaterThan(0);
  });
});
