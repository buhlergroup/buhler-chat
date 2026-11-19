import { describe, it, expect, vi, beforeEach } from "vitest";
import sharp from "sharp";
import { FakeGraph, type FakeItem } from "./fake-graph";

vi.mock("@/features/common/services/logger", () => ({
  logInfo: vi.fn(),
  logWarn: vi.fn(),
  logError: vi.fn(),
  logDebug: vi.fn(),
}));

import {
  NOT_AVAILABLE_MESSAGE,
  OUTSIDE_SOURCES_MESSAGE,
  SharePointFileSession,
  containerFileName,
} from "../sharepoint-file-access";
import type { PersonaFileSourceModel } from "../sharepoint-file-models";
import { readSharePointFileLimits, type SharePointFileLimits } from "../sharepoint-file-limits";

const DRIVE = "b!driveA_123";
const OTHER_DRIVE = "b!driveB_456";

const folderSource = (over: Partial<PersonaFileSourceModel> = {}): PersonaFileSourceModel => ({
  id: "src-folder",
  type: "PERSONA_SHAREPOINT_FILE_SOURCE",
  userId: "owner-hash",
  personaId: "p1",
  driveId: DRIVE,
  itemId: "FOLDER1",
  name: "Images",
  webUrl: "https://contoso.sharepoint.com/sites/demo/Images",
  kind: "folder",
  createdAt: new Date("2026-11-01T00:00:00Z"),
  ...over,
});

const LIMITS: SharePointFileLimits = {
  maxSources: 10,
  maxFetchesPerRequest: 10,
  maxFileBytes: 50_000_000,
  imageMaxPx: 2560,
};

let graph: FakeGraph;
let upload: ReturnType<typeof vi.fn>;
let containerId: string | undefined;

const session = (
  sources: PersonaFileSourceModel[] = [folderSource()],
  limits: Partial<SharePointFileLimits> = {},
) =>
  new SharePointFileSession({
    sources,
    accessToken: "user-token",
    limits: { ...LIMITS, ...limits },
    getContainerId: () => containerId,
    uploadToContainer: upload as never,
    threadId: "t1",
  });

/*
 * Drive A:
 *   root
 *   ├── Images (FOLDER1)            ← linked folder
 *   │   ├── photo-01.jpg            level 1
 *   │   ├── logo.png                level 1
 *   │   ├── design.psd              level 1
 *   │   ├── notes.txt               level 1
 *   │   └── events (SUB1)
 *   │       ├── photo-02.jpg        level 2
 *   │       ├── logo.png            level 2 (same name as above)
 *   │       └── 2024 (SUB2)
 *   │           ├── scan.tif        level 3
 *   │           └── old (SUB3)
 *   │               └── deep.jpg    level 4 (beyond the limit)
 *   └── Private (OUTSIDE)
 *       └── secret.jpg
 * Drive B: other.jpg
 */
const smallJpeg = () =>
  sharp({ create: { width: 40, height: 20, channels: 3, background: "#336699" } }).jpeg().toBuffer();

async function buildTree(): Promise<FakeGraph> {
  const g = new FakeGraph();
  const jpg = await smallJpeg();
  const png = await sharp({ create: { width: 8, height: 8, channels: 4, background: "#00000000" } })
    .png()
    .toBuffer();
  const tif = await sharp({ create: { width: 64, height: 32, channels: 3, background: "#aa3300" } })
    .tiff()
    .toBuffer();
  g.add(DRIVE, { id: "ROOT", name: "root", folder: true })
    .add(DRIVE, { id: "FOLDER1", name: "Images", parent: "ROOT", folder: true })
    .add(DRIVE, { id: "P01", name: "photo-01.jpg", parent: "FOLDER1", content: jpg })
    .add(DRIVE, { id: "LOGO1", name: "logo.png", parent: "FOLDER1", content: png })
    .add(DRIVE, { id: "PSD1", name: "design.psd", parent: "FOLDER1", content: Buffer.from("8BPS") })
    .add(DRIVE, { id: "TXT1", name: "notes.txt", parent: "FOLDER1", content: Buffer.from("hello") })
    .add(DRIVE, { id: "SUB1", name: "events", parent: "FOLDER1", folder: true })
    .add(DRIVE, { id: "P02", name: "photo-02.jpg", parent: "SUB1", content: jpg })
    .add(DRIVE, { id: "LOGO2", name: "logo.png", parent: "SUB1", content: png })
    .add(DRIVE, { id: "SUB2", name: "2024", parent: "SUB1", folder: true })
    .add(DRIVE, { id: "TIF1", name: "scan.tif", parent: "SUB2", content: tif })
    .add(DRIVE, { id: "SUB3", name: "old", parent: "SUB2", folder: true })
    .add(DRIVE, { id: "DEEP1", name: "deep.jpg", parent: "SUB3", content: jpg })
    .add(DRIVE, { id: "OUTSIDE", name: "Private", parent: "ROOT", folder: true })
    .add(DRIVE, { id: "SECRET1", name: "secret.jpg", parent: "OUTSIDE", content: jpg })
    .add(OTHER_DRIVE, { id: "ROOTB", name: "root", folder: true })
    .add(OTHER_DRIVE, { id: "OTHER1", name: "other.jpg", parent: "ROOTB", content: jpg });
  return g;
}

beforeEach(async () => {
  graph = await buildTree();
  vi.stubGlobal("fetch", graph.fetch);
  upload = vi.fn(async (_c: string, name: string) => ({ path: `/mnt/data/${name}` }));
  containerId = "cntr_1";
});

describe("find_sharepoint_files", () => {
  it("lists files up to 3 levels below the linked folder, with relative paths", async () => {
    const res = await session().find({});
    const paths = res.files.map((f) => f.path);
    expect(paths).toContain("photo-01.jpg");
    expect(paths).toContain("events/photo-02.jpg");
    expect(paths).toContain("events/2024/scan.tif");
    // Level 4 and files outside the folder are not listed.
    expect(paths).not.toContain("events/2024/old/deep.jpg");
    expect(paths.some((p) => p.includes("secret"))).toBe(false);
    expect(res.files.find((f) => f.path === "photo-01.jpg")).toMatchObject({
      id: "P01",
      name: "photo-01.jpg",
      source: "Images",
      lastModified: "2026-11-01T10:00:00Z",
    });
    // Only Graph was called, and the deepest folder was never read.
    expect(graph.calls.every((c) => c.startsWith("https://graph.microsoft.com/v1.0/"))).toBe(true);
    expect(graph.count("/items/SUB3/children")).toBe(0);
  });

  it("filters by words (case-insensitive, all must match) and by path", async () => {
    const s = session();
    expect((await s.find({ query: "PHOTO 02" })).files.map((f) => f.path)).toEqual([
      "events/photo-02.jpg",
    ]);
    expect((await s.find({ path: "events/2024" })).files.map((f) => f.path)).toEqual([
      "events/2024/scan.tif",
    ]);
    expect((await s.find({ query: "logo", path: "events" })).files.map((f) => f.id)).toEqual([
      "LOGO2",
    ]);
    // One listing per request, however often find runs.
    expect(graph.count("/items/FOLDER1/children")).toBe(1);
  });

  it("returns at most 50 results and says how many there are", async () => {
    for (let i = 0; i < 70; i++) {
      graph.add(DRIVE, { id: `MANY${i}`, name: `img-${String(i).padStart(2, "0")}.jpg`, parent: "FOLDER1" });
    }
    graph.pageSize = 25; // also follows @odata.nextLink pages
    const res = await session().find({ query: "img" });
    expect(res.files).toHaveLength(50);
    expect(res.total).toBe(70);
    expect(res.note).toMatch(/first 50 of 70/);
  });

  it("reports a source the user cannot read as not available", async () => {
    graph.drives.get(DRIVE)!.get("FOLDER1")!.status = 403;
    const res = await session().find({});
    expect(res.files).toEqual([]);
    expect(res.problems?.[0]).toContain(NOT_AVAILABLE_MESSAGE);
  });
});

describe("fetch_sharepoint_file — inside the sources only", () => {
  it("fetches a file by exact name into the container", async () => {
    const res = await session().fetch({ name: "photo-01.jpg" });
    expect(res).toMatchObject({ path: "/mnt/data/photo-01.jpg", name: "photo-01.jpg" });
    expect(upload).toHaveBeenCalledOnce();
    expect(upload.mock.calls[0][0]).toBe("cntr_1");
    expect(upload.mock.calls[0][1]).toBe("photo-01.jpg");
    expect(Buffer.isBuffer(upload.mock.calls[0][2])).toBe(true);
  });

  it("fetches a descendant by id, proven through its parent chain in Graph", async () => {
    const res = await session().fetch({ id: "P02" });
    expect(res).toMatchObject({ path: "/mnt/data/photo-02.jpg", sourcePath: "events/photo-02.jpg" });
    // No listing needed: item + parent metadata only.
    expect(graph.count("/children")).toBe(0);
  });

  it("refuses a file outside the linked folder (same drive) without downloading it", async () => {
    const res = await session().fetch({ id: "SECRET1" });
    expect(res).toEqual({ error: OUTSIDE_SOURCES_MESSAGE });
    expect(graph.count("/content")).toBe(0);
    expect(upload).not.toHaveBeenCalled();
  });

  it("refuses a file deeper than 3 levels", async () => {
    const res = await session().fetch({ id: "DEEP1" });
    expect(res).toEqual({ error: OUTSIDE_SOURCES_MESSAGE });
    expect(graph.count("/content")).toBe(0);
  });

  it("refuses a file of another drive", async () => {
    const res = await session().fetch({ id: "OTHER1" });
    expect(res).toEqual({ error: OUTSIDE_SOURCES_MESSAGE });
    // The model cannot name a drive: only the source's drive was asked.
    expect(graph.calls.some((c) => c.includes(OTHER_DRIVE))).toBe(false);
    expect(upload).not.toHaveBeenCalled();
  });

  it("refuses an item whose Graph answer puts it in another drive", async () => {
    graph.drives.get(DRIVE)!.get("P01")!.reportedDriveId = OTHER_DRIVE;
    const res = await session().fetch({ id: "P01" });
    expect(res).toEqual({ error: OUTSIDE_SOURCES_MESSAGE });
    expect(upload).not.toHaveBeenCalled();
  });

  it("refuses invalid ids before any Graph call", async () => {
    for (const id of ["../../me", "P01/content", "a?b", "x".repeat(300)]) {
      expect(await session().fetch({ id })).toEqual({ error: "Invalid file id." });
    }
    expect(graph.calls).toEqual([]);
  });

  it("allows only the linked file for a file source", async () => {
    const fileSource = folderSource({ id: "src-file", kind: "file", itemId: "TXT1", name: "notes.txt" });
    const s = session([fileSource]);
    expect(await s.fetch({ id: "TXT1" })).toMatchObject({ path: "/mnt/data/notes.txt" });
    expect(await s.fetch({ id: "P01" })).toEqual({ error: OUTSIDE_SOURCES_MESSAGE });
    expect((await s.find({})).files.map((f) => f.id)).toEqual(["TXT1"]);
  });

  it("returns the candidates when a name is not unique", async () => {
    const res = await session().fetch({ name: "logo.png" });
    expect(res.error).toMatch(/2 files are named "logo.png"/);
    expect((res as { candidates: { id: string; path: string }[] }).candidates.map((c) => c.path)).toEqual([
      "logo.png",
      "events/logo.png",
    ]);
    expect(upload).not.toHaveBeenCalled();
    // A relative path picks one.
    expect(await session().fetch({ name: "events/logo.png" })).toMatchObject({
      path: "/mnt/data/logo.png",
      sourcePath: "events/logo.png",
    });
  });

  it("says when a name is not in the sources", async () => {
    const res = await session().fetch({ name: "secret.jpg" });
    expect(res.error).toMatch(/No file named "secret.jpg"/);
  });
});

describe("fetch_sharepoint_file — access rule (no fallback)", () => {
  it.each([401, 403, 404])("download %i → not available for you", async (status) => {
    graph.drives.get(DRIVE)!.get("P01")!.contentStatus = status;
    const res = await session().fetch({ name: "photo-01.jpg" });
    expect(res).toEqual({ error: NOT_AVAILABLE_MESSAGE, name: "photo-01.jpg" });
    expect(upload).not.toHaveBeenCalled();
  });

  it("403 on the item metadata → not available for you", async () => {
    graph.drives.get(DRIVE)!.get("P02")!.status = 403;
    expect(await session().fetch({ id: "P02" })).toEqual({ error: NOT_AVAILABLE_MESSAGE });
    expect(upload).not.toHaveBeenCalled();
  });

  it("calls Graph with the user's token only", async () => {
    const seen: string[] = [];
    vi.stubGlobal("fetch", async (input: string, init?: RequestInit) => {
      seen.push(new Headers(init?.headers).get("authorization") ?? "");
      return graph.fetch(input);
    });
    await session().fetch({ name: "photo-01.jpg" });
    expect(seen.length).toBeGreaterThan(0);
    expect(new Set(seen)).toEqual(new Set(["Bearer user-token"]));
  });
});

describe("fetch_sharepoint_file — limits", () => {
  it("refuses the 11th fetch of a request without calling Graph", async () => {
    const s = session();
    for (let i = 0; i < 10; i++) {
      expect(await s.fetch({ id: "P01" })).toHaveProperty("path");
    }
    const before = graph.calls.length;
    const res = await s.fetch({ id: "P02" });
    expect(res.error).toMatch(/limit of 10/);
    expect(graph.calls.length).toBe(before);
    expect(upload).toHaveBeenCalledTimes(10);
  });

  it("refuses a non-image file whose size is above the limit before any download", async () => {
    graph.drives.get(DRIVE)!.get("TXT1")!.size = 60_000_000;
    const res = await session().fetch({ name: "notes.txt" });
    expect(res.error).toMatch(/larger than 50 MB/);
    expect(graph.count("/content")).toBe(0);
    expect(upload).not.toHaveBeenCalled();
  });

  it("stops reading a download beyond the limit (size in the metadata was wrong)", async () => {
    const item = graph.drives.get(DRIVE)!.get("TXT1")!;
    item.content = Buffer.alloc(1_000_000, 1);
    item.size = 10;
    item.chunkSize = 10_000; // 100 chunks, no content-length
    const res = await session([folderSource()], { maxFileBytes: 50_000 }).fetch({ name: "notes.txt" });
    expect(res.error).toMatch(/larger than 0.05 MB/);
    expect(upload).not.toHaveBeenCalled();
    // Reading stopped right after the limit, not at the end of the file.
    expect(graph.pulledChunks).toBeLessThan(10);
  });

  it("refuses PSD without a SharePoint preview, and unknown types, without downloading them", async () => {
    const res = await session().fetch({ name: "design.psd" });
    expect(res.error).toMatch(/no preview image of this Photoshop file \(\.psd\)/);
    expect(graph.thumbnails("PSD1")).toBe(1);
    expect(graph.originals("PSD1")).toBe(0);
    graph.add(DRIVE, { id: "EXE1", name: "tool.exe", parent: "FOLDER1" });
    const exe = await session().fetch({ name: "tool.exe" });
    expect(exe.error).toMatch(/\.exe are not supported/);
    expect(graph.count("/items/EXE1/")).toBe(0);
    expect(upload).not.toHaveBeenCalled();
  });

  it("fails cleanly when the code interpreter has no container this turn", async () => {
    containerId = undefined;
    const res = await session().fetch({ name: "photo-01.jpg" });
    expect(res.error).toMatch(/not ready/);
    expect(graph.count("/content")).toBe(0);
  });
});

describe("fetch_sharepoint_file — images", () => {
  it("converts TIFF to JPEG when SharePoint has no preview", async () => {
    const res = await session().fetch({ name: "scan.tif" });
    expect(res).toMatchObject({
      path: "/mnt/data/scan.jpg",
      name: "scan.jpg",
      width: 64,
      height: 32,
      source: "sharepoint-original",
    });
    expect(graph.thumbnails("TIF1")).toBe(1);
    expect(graph.originals("TIF1")).toBe(1);
    const out = upload.mock.calls[0][2] as Buffer;
    expect((await sharp(out).metadata()).format).toBe("jpeg");
  });

  it("scales an image above 2560 px down, keeping the aspect ratio", async () => {
    const big = await sharp({ create: { width: 4000, height: 2000, channels: 3, background: "#808080" } })
      .jpeg()
      .toBuffer();
    graph.add(DRIVE, { id: "BIG1", name: "big.jpg", parent: "FOLDER1", content: big });
    const res = await session().fetch({ id: "BIG1" });
    expect(res).toMatchObject({ name: "big.jpg", width: 2560, height: 1280 });
    const meta = await sharp(upload.mock.calls[0][2] as Buffer).metadata();
    expect([meta.format, meta.width, meta.height]).toEqual(["jpeg", 2560, 1280]);
  });

  it("applies the EXIF orientation before scaling", async () => {
    // Stored 3000x1000, EXIF 6 (rotate 90°): shown as 1000x3000.
    const rotated = await sharp({ create: { width: 3000, height: 1000, channels: 3, background: "#808080" } })
      .jpeg()
      .withMetadata({ orientation: 6 })
      .toBuffer();
    graph.add(DRIVE, { id: "ROT1", name: "portrait.jpg", parent: "FOLDER1", content: rotated });
    const res = await session().fetch({ id: "ROT1" });
    expect(res).toMatchObject({ width: 853, height: 2560 });
    const meta = await sharp(upload.mock.calls[0][2] as Buffer).metadata();
    expect([meta.width, meta.height]).toEqual([853, 2560]);
  });

  it("passes a small image through unchanged (no preview asked for)", async () => {
    graph.drives.get(DRIVE)!.get("P01")!.thumbnail = "auto";
    const res = await session().fetch({ name: "photo-01.jpg" });
    expect(res).not.toHaveProperty("note");
    expect(res).toMatchObject({ source: "sharepoint-original", width: 40, height: 20 });
    expect(graph.thumbnails("P01")).toBe(0);
    const original = graph.drives.get(DRIVE)!.get("P01")!.content!;
    expect((upload.mock.calls[0][2] as Buffer).equals(original)).toBe(true);
  });

  it("converts an uncompressed 24-bit BMP to JPEG", async () => {
    graph.add(DRIVE, { id: "BMP1", name: "chart.bmp", parent: "FOLDER1", content: bmp24(3, 2) });
    const res = await session().fetch({ id: "BMP1" });
    expect(res).toMatchObject({ name: "chart.jpg", width: 3, height: 2 });
    expect((await sharp(upload.mock.calls[0][2] as Buffer).metadata()).format).toBe("jpeg");
  });
});

describe("fetch_sharepoint_file — SharePoint preview images", () => {
  const MB = 1_000_000;
  let bigJpeg: Buffer;

  beforeEach(async () => {
    bigJpeg = await sharp({ create: { width: 4000, height: 2000, channels: 3, background: "#808080" } })
      .jpeg()
      .toBuffer();
  });

  /** A JPEG whose metadata says it is 8 MB (above the 2 MB "small original" rule). */
  const addPhoto = (over: Partial<FakeItem> = {}) =>
    graph.add(DRIVE, {
      id: "PHOTO8",
      name: "harbour.JPG",
      parent: "FOLDER1",
      content: bigJpeg,
      size: 8 * MB,
      thumbnail: "auto",
      ...over,
    });

  it("fetches an image as a c2560x2560 thumbnail with the user's token; name .jpg, sizes and pixels reported", async () => {
    addPhoto();
    const seen: { url: string; auth: string }[] = [];
    vi.stubGlobal("fetch", async (input: string, init?: RequestInit) => {
      seen.push({ url: String(input), auth: new Headers(init?.headers).get("authorization") ?? "" });
      return graph.fetch(input);
    });
    const res = await session().fetch({ id: "PHOTO8" });
    expect(res).toMatchObject({
      path: "/mnt/data/harbour.jpg",
      name: "harbour.jpg",
      source: "sharepoint-thumbnail",
      originalBytes: 8 * MB,
      width: 2560,
      height: 1280,
    });
    const delivered = upload.mock.calls[0][2] as Buffer;
    expect((res as { bytes: number }).bytes).toBe(delivered.length);
    expect((res as { note: string }).note).toMatch(/preview image of "harbour.JPG" \(8\.0 MB\)/);
    const meta = await sharp(delivered).metadata();
    expect([meta.format, meta.width, meta.height]).toEqual(["jpeg", 2560, 1280]);
    const thumbCalls = seen.filter((c) => c.url.includes("/thumbnails/"));
    expect(thumbCalls.map((c) => c.url)).toEqual([
      `https://graph.microsoft.com/v1.0/drives/${DRIVE}/items/PHOTO8/thumbnails/0/c2560x2560/content`,
    ]);
    expect(new Set(seen.map((c) => c.auth))).toEqual(new Set(["Bearer user-token"]));
    expect(graph.originals("PHOTO8")).toBe(0);
  });

  it("asks for the thumbnail size set with SHAREPOINT_FILES_IMAGE_MAX_PX", async () => {
    addPhoto();
    const limits = readSharePointFileLimits({ SHAREPOINT_FILES_IMAGE_MAX_PX: "1024" });
    const res = await session([folderSource()], limits).fetch({ id: "PHOTO8" });
    expect(graph.calls).toContain(
      `https://graph.microsoft.com/v1.0/drives/${DRIVE}/items/PHOTO8/thumbnails/0/c1024x1024/content`,
    );
    expect(res).toMatchObject({ name: "harbour.jpg", width: 1024, height: 512, source: "sharepoint-thumbnail" });
  });

  it("fetches a TIFF far above the file limit through its thumbnail", async () => {
    const tif = graph.drives.get(DRIVE)!.get("TIF1")!;
    tif.size = 383 * MB;
    tif.thumbnail = "auto";
    const res = await session().fetch({ id: "TIF1" });
    expect(res).toMatchObject({
      name: "scan.jpg",
      source: "sharepoint-thumbnail",
      originalBytes: 383 * MB,
      width: 64,
      height: 32,
    });
    expect(graph.originals("TIF1")).toBe(0);
    expect((await sharp(upload.mock.calls[0][2] as Buffer).metadata()).format).toBe("jpeg");
  });

  it("fetches HEIC and PSD through their thumbnail", async () => {
    const jpg = await smallJpeg();
    graph.drives.get(DRIVE)!.get("PSD1")!.thumbnail = jpg;
    graph.add(DRIVE, { id: "HEIC1", name: "phone.heic", parent: "FOLDER1", size: 3 * MB, thumbnail: jpg });
    expect(await session().fetch({ id: "PSD1" })).toMatchObject({
      name: "design.jpg",
      source: "sharepoint-thumbnail",
      width: 40,
      height: 20,
    });
    expect(await session().fetch({ id: "HEIC1" })).toMatchObject({ name: "phone.jpg", source: "sharepoint-thumbnail" });
    expect(graph.originals("PSD1") + graph.originals("HEIC1")).toBe(0);
  });

  it.each([404, 400, 500])("thumbnail %i → falls back to the original", async (status) => {
    addPhoto({ thumbnailStatus: status });
    const res = await session().fetch({ id: "PHOTO8" });
    expect(res).toMatchObject({ name: "harbour.JPG", source: "sharepoint-original", width: 2560, height: 1280 });
    expect(graph.thumbnails("PHOTO8")).toBe(1);
    expect(graph.originals("PHOTO8")).toBe(1);
  });

  it("thumbnail that is not an image → falls back to the original", async () => {
    addPhoto({ thumbnail: Buffer.from("<html></html>"), thumbnailType: "text/html" });
    const res = await session().fetch({ id: "PHOTO8" });
    expect(res).toMatchObject({ source: "sharepoint-original" });
    expect(graph.thumbnails("PHOTO8")).toBe(1);
    expect(graph.originals("PHOTO8")).toBe(1);
  });

  it("thumbnail with image content-type but unreadable bytes → falls back to the original", async () => {
    addPhoto({ thumbnail: Buffer.from("not really a jpeg") });
    const res = await session().fetch({ id: "PHOTO8" });
    expect(res).toMatchObject({ source: "sharepoint-original" });
    expect(graph.thumbnails("PHOTO8")).toBe(1);
    expect(graph.originals("PHOTO8")).toBe(1);
  });

  it("no thumbnail and the original above the file limit → refused without downloading it", async () => {
    const tif = graph.drives.get(DRIVE)!.get("TIF1")!;
    tif.size = 60 * MB;
    const res = await session().fetch({ id: "TIF1" });
    expect(res).toEqual({ error: "The file is larger than 50 MB and cannot be fetched.", name: "scan.tif" });
    expect(graph.thumbnails("TIF1")).toBe(1);
    expect(graph.originals("TIF1")).toBe(0);
    expect(upload).not.toHaveBeenCalled();
  });

  it.each([401, 403])("thumbnail %i → not available for you, no fallback", async (status) => {
    addPhoto({ thumbnailStatus: status });
    const res = await session().fetch({ id: "PHOTO8" });
    expect(res).toEqual({ error: NOT_AVAILABLE_MESSAGE, name: "harbour.JPG" });
    expect(graph.originals("PHOTO8")).toBe(0);
    expect(upload).not.toHaveBeenCalled();
  });

  it("stops reading a thumbnail beyond 20 MB, then falls back to the original", async () => {
    addPhoto({ thumbnail: Buffer.alloc(30 * MB, 0xff), thumbnailChunkSize: MB });
    const res = await session().fetch({ id: "PHOTO8" });
    // Reading stopped right after 20 MB, not at the end of the 30 MB answer.
    expect(graph.pulledChunks).toBeGreaterThanOrEqual(20);
    expect(graph.pulledChunks).toBeLessThanOrEqual(22);
    expect(res).toMatchObject({ source: "sharepoint-original" });
    expect(graph.originals("PHOTO8")).toBe(1);
  });

  it("refuses a thumbnail that declares more than 20 MB before reading it", async () => {
    addPhoto({ thumbnail: Buffer.alloc(21 * MB, 0xff) });
    const res = await session().fetch({ id: "PHOTO8" });
    expect(res).toMatchObject({ source: "sharepoint-original" });
    expect(graph.thumbnails("PHOTO8")).toBe(1);
    expect(graph.originals("PHOTO8")).toBe(1);
  });

  it("leaves non-image files on the original path (no thumbnail call)", async () => {
    graph.add(DRIVE, { id: "XLSX1", name: "plan.xlsx", parent: "FOLDER1", content: Buffer.from("PK"), thumbnail: "auto" });
    const res = await session().fetch({ id: "XLSX1" });
    expect(res).toMatchObject({ name: "plan.xlsx", source: "sharepoint-original", bytes: 2 });
    expect(graph.thumbnails("XLSX1")).toBe(0);
    expect(graph.originals("XLSX1")).toBe(1);
  });
});

describe("containerFileName", () => {
  it("keeps one safe path segment", () => {
    expect(containerFileName("a/b\\c.jpg")).toBe("a_b_c.jpg");
    expect(containerFileName("..hidden")).toBe("_hidden");
    expect(containerFileName("ok name.png")).toBe("ok name.png");
  });
});

/** A bottom-up 24-bit BI_RGB bitmap filled with one colour. */
function bmp24(width: number, height: number): Buffer {
  const rowSize = Math.ceil((width * 3) / 4) * 4;
  const pixels = rowSize * height;
  const buf = Buffer.alloc(54 + pixels);
  buf.write("BM", 0, "latin1");
  buf.writeUInt32LE(54 + pixels, 2);
  buf.writeUInt32LE(54, 10);
  buf.writeUInt32LE(40, 14);
  buf.writeInt32LE(width, 18);
  buf.writeInt32LE(height, 22);
  buf.writeUInt16LE(1, 26);
  buf.writeUInt16LE(24, 28);
  buf.writeUInt32LE(0, 30);
  buf.writeUInt32LE(pixels, 34);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const o = 54 + y * rowSize + x * 3;
      buf[o] = 0x20; // B
      buf[o + 1] = 0x80; // G
      buf[o + 2] = 0xe0; // R
    }
  }
  return buf;
}
