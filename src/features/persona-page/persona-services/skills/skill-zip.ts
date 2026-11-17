import "server-only";

/**
 * skill-zip.ts — reads and validates an Agent Skills package (.zip).
 *
 * A small, dependency-free zip reader. We parse the central directory
 * ourselves instead of adding a zip library because the security checks need
 * fields most libraries hide (host OS + external attributes for symlinks,
 * the declared sizes for the bomb check) and because a new dependency is a
 * supply-chain decision of its own.
 *
 * Supported: stored (0) and deflate (8) entries, no encryption, no zip64,
 * single disk. That covers every zip produced by Windows Explorer, macOS
 * Finder, `zip`, Python `zipfile` and PowerShell `Compress-Archive` for
 * packages below the size limit.
 *
 * Every entry is fully inflated during validation with a hard output cap of
 * its declared size, so a lying header cannot expand past the limits, and
 * the CRC-32 is checked.
 */

import { inflateRawSync } from "node:zlib";
import {
  SKILL_LIMITS,
  SKILL_NAME_PATTERN,
  type SkillFileEntry,
  type SkillLimits,
} from "./skill-models";

export class SkillZipError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SkillZipError";
  }
}

interface RawEntry {
  /** Normalised path ("/" separators). Directories end with "/". */
  path: string;
  isDirectory: boolean;
  method: number;
  crc32: number;
  compressedSize: number;
  uncompressedSize: number;
  localHeaderOffset: number;
}

const SIG_EOCD = 0x06054b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_LOCAL = 0x04034b50;
const SIG_ZIP64_LOCATOR = 0x07064b50;

const S_IFMT = 0o170000;
const S_IFREG = 0o100000;
const S_IFDIR = 0o040000;
const S_IFLNK = 0o120000;

/** Entries that archivers add on their own; ignored, never stored. */
const isJunkPath = (path: string): boolean =>
  path.startsWith("__MACOSX/") ||
  path === ".DS_Store" ||
  path.endsWith("/.DS_Store") ||
  path === "Thumbs.db" ||
  path.endsWith("/Thumbs.db");

let crcTable: Uint32Array | undefined;
export function crc32(data: Uint8Array): number {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (let i = 0; i < data.length; i++) {
    crc = crcTable[(crc ^ data[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/**
 * Rejects every path that could escape the extraction folder or that a
 * Windows/Linux file system would interpret differently from what we store.
 * Backslashes are accepted as separators (old PowerShell writes them).
 */
export function normaliseZipPath(rawName: string): string {
  if (rawName.length === 0) throw new SkillZipError("The zip has an entry without a name.");
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f]/.test(rawName)) {
    throw new SkillZipError(`Invalid file name in the zip: ${JSON.stringify(rawName)}`);
  }
  const name = rawName.replace(/\\/g, "/");
  if (name.startsWith("/") || /^[a-zA-Z]:/.test(name)) {
    throw new SkillZipError(`Absolute paths are not allowed: ${rawName}`);
  }
  const isDirectory = name.endsWith("/");
  const segments = (isDirectory ? name.slice(0, -1) : name).split("/");
  for (const segment of segments) {
    if (segment === "" || segment === "." || segment === "..") {
      throw new SkillZipError(`Unsafe path in the zip: ${rawName}`);
    }
  }
  return name;
}

function findEndOfCentralDirectory(buf: Buffer): number {
  // EOCD is 22 bytes plus a comment of at most 65535 bytes.
  const min = Math.max(0, buf.length - 22 - 0xffff);
  for (let i = buf.length - 22; i >= min; i--) {
    if (buf.readUInt32LE(i) === SIG_EOCD) return i;
  }
  throw new SkillZipError("The file is not a valid zip.");
}

/** Reads the central directory. Throws SkillZipError on anything unsafe. */
export function readZipEntries(buf: Buffer, limits: SkillLimits = SKILL_LIMITS): RawEntry[] {
  if (buf.length < 22) throw new SkillZipError("The file is not a valid zip.");
  const eocd = findEndOfCentralDirectory(buf);
  if (eocd >= 20 && buf.readUInt32LE(eocd - 20) === SIG_ZIP64_LOCATOR) {
    throw new SkillZipError("Zip64 archives are not supported.");
  }
  const diskNumber = buf.readUInt16LE(eocd + 4);
  const cdDisk = buf.readUInt16LE(eocd + 6);
  const totalEntries = buf.readUInt16LE(eocd + 10);
  const cdSize = buf.readUInt32LE(eocd + 12);
  const cdOffset = buf.readUInt32LE(eocd + 16);
  if (diskNumber !== 0 || cdDisk !== 0) {
    throw new SkillZipError("Multi-part zips are not supported.");
  }
  if (totalEntries === 0xffff || cdOffset === 0xffffffff || cdSize === 0xffffffff) {
    throw new SkillZipError("Zip64 archives are not supported.");
  }
  // Directory entries count too; allow some headroom for them.
  if (totalEntries > limits.maxFiles * 2) {
    throw new SkillZipError(`The zip has more than ${limits.maxFiles} files.`);
  }
  if (cdOffset + cdSize > eocd) throw new SkillZipError("The zip is damaged.");

  const entries: RawEntry[] = [];
  let p = cdOffset;
  for (let i = 0; i < totalEntries; i++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== SIG_CENTRAL) {
      throw new SkillZipError("The zip is damaged.");
    }
    const versionMadeBy = buf.readUInt16LE(p + 4);
    const flags = buf.readUInt16LE(p + 8);
    const method = buf.readUInt16LE(p + 10);
    const crc = buf.readUInt32LE(p + 16);
    const compressedSize = buf.readUInt32LE(p + 20);
    const uncompressedSize = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const externalAttr = buf.readUInt32LE(p + 38);
    const localHeaderOffset = buf.readUInt32LE(p + 42);
    if (p + 46 + nameLen > buf.length) throw new SkillZipError("The zip is damaged.");
    const rawName = buf.toString("utf8", p + 46, p + 46 + nameLen);
    p += 46 + nameLen + extraLen + commentLen;

    const path = normaliseZipPath(rawName);
    const isDirectory = path.endsWith("/");

    if (flags & 0x1) throw new SkillZipError("Encrypted zips are not supported.");
    if (
      compressedSize === 0xffffffff ||
      uncompressedSize === 0xffffffff ||
      localHeaderOffset === 0xffffffff
    ) {
      throw new SkillZipError("Zip64 archives are not supported.");
    }

    // Unix host: the high 16 bits of the external attributes are st_mode.
    const hostOs = versionMadeBy >> 8;
    if (hostOs === 3) {
      const mode = (externalAttr >>> 16) & S_IFMT;
      if (mode === S_IFLNK) {
        throw new SkillZipError(`Symbolic links are not allowed: ${rawName}`);
      }
      if (mode !== 0 && mode !== S_IFREG && mode !== S_IFDIR) {
        throw new SkillZipError(`Only files and folders are allowed: ${rawName}`);
      }
    }

    if (!isDirectory && method !== 0 && method !== 8) {
      throw new SkillZipError(`Unsupported compression in ${rawName}. Use deflate.`);
    }

    entries.push({
      path,
      isDirectory,
      method,
      crc32: crc,
      compressedSize,
      uncompressedSize,
      localHeaderOffset,
    });
  }
  return entries;
}

/** Inflates one entry, capped at its declared size, and checks the CRC. */
function inflateEntry(buf: Buffer, entry: RawEntry): Buffer {
  const lh = entry.localHeaderOffset;
  if (lh + 30 > buf.length || buf.readUInt32LE(lh) !== SIG_LOCAL) {
    throw new SkillZipError(`The zip is damaged at ${entry.path}.`);
  }
  const nameLen = buf.readUInt16LE(lh + 26);
  const extraLen = buf.readUInt16LE(lh + 28);
  const start = lh + 30 + nameLen + extraLen;
  const end = start + entry.compressedSize;
  if (end > buf.length) throw new SkillZipError(`The zip is damaged at ${entry.path}.`);
  const compressed = buf.subarray(start, end);

  let out: Buffer;
  if (entry.method === 0) {
    out = Buffer.from(compressed);
  } else {
    try {
      // maxOutputLength makes a lying header fail instead of filling memory.
      out = inflateRawSync(compressed, {
        maxOutputLength: Math.max(1, entry.uncompressedSize),
      });
    } catch {
      throw new SkillZipError(`The zip is damaged or larger than declared at ${entry.path}.`);
    }
  }
  if (out.length !== entry.uncompressedSize) {
    throw new SkillZipError(`The size of ${entry.path} does not match the zip header.`);
  }
  if (crc32(out) !== entry.crc32) {
    throw new SkillZipError(`Checksum error in ${entry.path}.`);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Front matter
// ---------------------------------------------------------------------------

export interface SkillFrontMatter {
  name: string;
  description: string;
  /** Other top-level scalar keys (license, compatibility, ...). */
  extra: Record<string, string>;
}

function unquote(value: string): string {
  const v = value.trim();
  if (v.length >= 2 && v.startsWith('"') && v.endsWith('"')) {
    try {
      return JSON.parse(v) as string;
    } catch {
      return v.slice(1, -1);
    }
  }
  if (v.length >= 2 && v.startsWith("'") && v.endsWith("'")) {
    return v.slice(1, -1).replace(/''/g, "'");
  }
  // Plain scalar: strip a trailing " # comment".
  return v.replace(/\s+#.*$/, "");
}

/**
 * Parses the YAML front matter of a SKILL.md. Supports the subset the spec
 * needs: top-level `key: value` scalars (plain, single- or double-quoted),
 * block scalars (`|`, `>`, with -/+ chomping), and nested maps (e.g.
 * `metadata:`) which are skipped. Anything else is an error.
 */
export function parseSkillFrontMatter(text: string): { frontMatter: SkillFrontMatter; body: string } {
  const src = text.replace(/^﻿/, "").replace(/\r\n?/g, "\n");
  if (!src.startsWith("---\n")) {
    throw new SkillZipError("SKILL.md must start with YAML front matter (---).");
  }
  const close = src.indexOf("\n---", 4);
  if (close < 0) throw new SkillZipError("SKILL.md front matter has no closing ---.");
  const afterClose = src.indexOf("\n", close + 4);
  const yamlText = src.slice(4, close + 1);
  const body = afterClose < 0 ? "" : src.slice(afterClose + 1);

  const lines = yamlText.split("\n");
  const values: Record<string, string> = {};
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line.trim() === "" || line.trimStart().startsWith("#")) {
      i++;
      continue;
    }
    if (/^\s/.test(line)) {
      // Indented line outside a block: belongs to a nested map we skip.
      i++;
      continue;
    }
    const m = /^([A-Za-z0-9_-]+):(?:\s+(.*))?$/.exec(line);
    if (!m) throw new SkillZipError(`SKILL.md front matter: cannot read line "${line}".`);
    const key = m[1];
    const rest = (m[2] ?? "").trim();
    i++;
    const block = /^([|>])([+-]?)$/.exec(rest);
    if (block) {
      const collected: string[] = [];
      while (i < lines.length && (lines[i].trim() === "" || /^\s/.test(lines[i]))) {
        collected.push(lines[i]);
        i++;
      }
      const indent = Math.min(
        ...collected.filter((l) => l.trim() !== "").map((l) => l.length - l.trimStart().length),
      );
      const stripped = collected.map((l) => (l.trim() === "" ? "" : l.slice(indent)));
      let value: string;
      if (block[1] === "|") {
        value = stripped.join("\n");
      } else {
        // Folded: lines of a paragraph join with a space, blank lines break.
        const paragraphs: string[] = [];
        let current: string[] = [];
        for (const l of stripped) {
          if (l === "") {
            paragraphs.push(current.join(" "));
            current = [];
          } else {
            current.push(l);
          }
        }
        paragraphs.push(current.join(" "));
        value = paragraphs.join("\n");
      }
      if (block[2] !== "+") value = value.replace(/\n+$/, "");
      values[key] = value;
      continue;
    }
    if (rest === "") {
      // Nested map or list (metadata:, allowed-tools as list). Skip children.
      while (i < lines.length && (lines[i].trim() === "" || /^\s/.test(lines[i]))) i++;
      values[key] = "";
      continue;
    }
    values[key] = unquote(rest);
  }

  const name = (values.name ?? "").trim();
  const description = (values.description ?? "").trim();
  if (!name) throw new SkillZipError("SKILL.md front matter needs a name.");
  if (!description) throw new SkillZipError("SKILL.md front matter needs a description.");
  if (name.length > 64 || !SKILL_NAME_PATTERN.test(name)) {
    throw new SkillZipError(
      `Skill name "${name}" is not valid. Use 1-64 lowercase letters, digits and single hyphens.`,
    );
  }
  if (description.length > 1024) {
    throw new SkillZipError("Skill description is longer than 1024 characters.");
  }
  const { name: _n, description: _d, ...extra } = values;
  return { frontMatter: { name, description, extra }, body };
}

// ---------------------------------------------------------------------------
// Package validation
// ---------------------------------------------------------------------------

export interface ValidatedSkillPackage {
  name: string;
  description: string;
  /** Full SKILL.md text (front matter + body). */
  skillMd: string;
  /** "" when SKILL.md is at the zip root, else "<top-folder>/". */
  rootPrefix: string;
  /** Files relative to the skill root, sorted, excluding junk entries. */
  files: SkillFileEntry[];
  uncompressedBytes: number;
  zipBytes: number;
}

/**
 * Validates a skill zip against the limits and the Agent Skills format.
 * Throws SkillZipError with a user-facing message on the first problem.
 */
export function validateSkillZip(
  buf: Buffer,
  limits: SkillLimits = SKILL_LIMITS,
): ValidatedSkillPackage {
  if (buf.length > limits.maxZipBytes) {
    throw new SkillZipError(
      `The zip is larger than ${Math.round(limits.maxZipBytes / 1_000_000)} MB.`,
    );
  }
  const all = readZipEntries(buf, limits);
  const entries = all.filter((e) => !isJunkPath(e.path));
  const files = entries.filter((e) => !e.isDirectory);
  if (files.length === 0) throw new SkillZipError("The zip is empty.");
  if (files.length > limits.maxFiles) {
    throw new SkillZipError(`The zip has more than ${limits.maxFiles} files.`);
  }

  // Duplicate paths would make "which file wins" depend on the extractor.
  const seen = new Set<string>();
  for (const f of files) {
    const key = f.path.toLowerCase();
    if (seen.has(key)) throw new SkillZipError(`Duplicate file in the zip: ${f.path}`);
    seen.add(key);
  }

  // Bomb checks on the declared sizes first (cheap), then the real ones below.
  let declaredTotal = 0;
  for (const f of files) {
    declaredTotal += f.uncompressedSize;
    if (
      f.uncompressedSize > limits.ratioCheckMinBytes &&
      f.uncompressedSize > f.compressedSize * limits.maxCompressionRatio
    ) {
      throw new SkillZipError(`${f.path} is compressed too strongly (zip bomb check).`);
    }
  }
  if (declaredTotal > limits.maxUncompressedBytes) {
    throw new SkillZipError(
      `The unpacked skill is larger than ${Math.round(limits.maxUncompressedBytes / 1_000_000)} MB.`,
    );
  }
  if (
    declaredTotal > limits.ratioCheckMinBytes &&
    declaredTotal > buf.length * limits.maxCompressionRatio
  ) {
    throw new SkillZipError("The zip is compressed too strongly (zip bomb check).");
  }

  // Locate SKILL.md: at the root, or inside one single top folder.
  let rootPrefix: string;
  if (files.some((f) => f.path === "SKILL.md")) {
    rootPrefix = "";
  } else {
    const tops = new Set(entries.map((e) => e.path.split("/")[0]));
    const onlyTop = tops.size === 1 ? [...tops][0] : undefined;
    if (!onlyTop || !files.some((f) => f.path === `${onlyTop}/SKILL.md`)) {
      throw new SkillZipError(
        "SKILL.md is missing. Put it at the root of the zip or in one top folder.",
      );
    }
    rootPrefix = `${onlyTop}/`;
  }

  for (const f of files) {
    const rel = f.path.slice(rootPrefix.length);
    const folderDepth = rel.split("/").length - 1;
    if (folderDepth > limits.maxDepth) {
      throw new SkillZipError(
        `${f.path} is nested too deep (max ${limits.maxDepth} folders below the skill root).`,
      );
    }
  }

  // Inflate everything once: proves the real sizes and the checksums.
  let skillMdBuf: Buffer | undefined;
  let realTotal = 0;
  for (const f of files) {
    const out = inflateEntry(buf, f);
    realTotal += out.length;
    if (f.path === `${rootPrefix}SKILL.md`) skillMdBuf = out;
  }
  if (realTotal > limits.maxUncompressedBytes) {
    throw new SkillZipError("The unpacked skill is too large.");
  }
  if (!skillMdBuf) throw new SkillZipError("SKILL.md is missing.");
  if (skillMdBuf.length > limits.maxSkillMdBytes) {
    throw new SkillZipError(
      `SKILL.md is larger than ${Math.round(limits.maxSkillMdBytes / 1024)} KB. Move details to references/.`,
    );
  }

  const skillMd = skillMdBuf.toString("utf8");
  const { frontMatter } = parseSkillFrontMatter(skillMd);
  if (rootPrefix && rootPrefix.slice(0, -1) !== frontMatter.name) {
    throw new SkillZipError(
      `The skill name "${frontMatter.name}" must match its folder "${rootPrefix.slice(0, -1)}".`,
    );
  }

  return {
    name: frontMatter.name,
    description: frontMatter.description,
    skillMd,
    rootPrefix,
    files: files
      .map((f) => ({ path: f.path.slice(rootPrefix.length), size: f.uncompressedSize }))
      .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)),
    uncompressedBytes: realTotal,
    zipBytes: buf.length,
  };
}

/**
 * Reads one file of an already validated package. `relPath` is relative to
 * the skill root. Returns undefined when the file is not in the zip.
 */
export function readSkillZipFile(
  buf: Buffer,
  rootPrefix: string,
  relPath: string,
): Buffer | undefined {
  let wanted: string;
  try {
    wanted = rootPrefix + normaliseZipPath(relPath.replace(/^\.\//, ""));
  } catch {
    return undefined;
  }
  const entry = readZipEntries(buf).find((e) => !e.isDirectory && e.path === wanted);
  return entry ? inflateEntry(buf, entry) : undefined;
}
