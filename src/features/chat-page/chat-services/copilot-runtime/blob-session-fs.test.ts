import { describe, it, expect, beforeEach } from "vitest";

import { BlobSessionFs, type BlobProps, type BlobStore } from "./blob-session-fs";
import { buildNamespace, normalizeSessionPath, SessionPathError } from "./session-path";

/** In-memory BlobStore with ETags, conditions and hierarchy listing. */
class FakeBlobStore implements BlobStore {
  blobs = new Map<string, { data: Buffer; metadata: Record<string, string>; etag: string; append: boolean; at: Date }>();
  calls: string[] = [];
  private n = 0;
  /** Set to make the next delete with ifMatch fail like a concurrent writer. */
  failNextConditionalDelete = false;
  private etag() {
    return `"e${++this.n}"`;
  }
  async getProperties(name: string): Promise<BlobProps | undefined> {
    const b = this.blobs.get(name);
    if (!b) return undefined;
    return { etag: b.etag, metadata: b.metadata, contentLength: b.data.length, lastModified: b.at, createdOn: b.at };
  }
  async download(name: string) {
    const b = this.blobs.get(name);
    if (!b) throw Object.assign(new Error("nf"), { code: "ENOENT" });
    return Buffer.from(b.data);
  }
  async createAppendBlob(name: string) {
    this.calls.push(`createAppend ${name}`);
    this.blobs.set(name, { data: Buffer.alloc(0), metadata: {}, etag: this.etag(), append: true, at: new Date() });
  }
  async appendBlock(name: string, data: Buffer) {
    const b = this.blobs.get(name);
    if (!b) throw Object.assign(new Error("nf"), { code: "ENOENT" });
    b.data = Buffer.concat([b.data, data]);
    b.etag = this.etag();
  }
  async upload(name: string, data: Buffer, metadata: Record<string, string>, conditions?: { ifMatch?: string; ifNoneMatch?: string }) {
    this.calls.push(`upload ${name}`);
    const existing = this.blobs.get(name);
    if (conditions?.ifMatch && existing?.etag !== conditions.ifMatch) {
      throw Object.assign(new Error("412"), { code: "PRECONDITION" });
    }
    const etag = this.etag();
    this.blobs.set(name, { data, metadata, etag, append: false, at: new Date() });
    return etag;
  }
  async delete(name: string, conditions?: { ifMatch?: string }) {
    this.calls.push(`delete ${name}${conditions?.ifMatch ? " ifMatch" : ""}`);
    const b = this.blobs.get(name);
    if (!b) return false;
    if (conditions?.ifMatch && (this.failNextConditionalDelete || b.etag !== conditions.ifMatch)) {
      this.failNextConditionalDelete = false;
      throw Object.assign(new Error("412"), { code: "PRECONDITION" });
    }
    this.blobs.delete(name);
    return true;
  }
  async listNames(prefix: string) {
    return [...this.blobs.keys()].filter((k) => k.startsWith(prefix)).sort();
  }
  async listHierarchy(prefix: string) {
    const prefixes = new Set<string>();
    const names: string[] = [];
    for (const key of this.blobs.keys()) {
      if (!key.startsWith(prefix)) continue;
      const rest = key.slice(prefix.length);
      const slash = rest.indexOf("/");
      if (slash >= 0) prefixes.add(prefix + rest.slice(0, slash + 1));
      else names.push(key);
    }
    return { prefixes: [...prefixes].sort(), names: names.sort() };
  }
}

describe("normalizeSessionPath (path jail)", () => {
  it("keeps paths inside the two roots and canonicalises them", () => {
    expect(normalizeSessionPath("/workspace/a/./b.txt")).toBe("/workspace/a/b.txt");
    expect(normalizeSessionPath("/workspace//a///b.txt")).toBe("/workspace/a/b.txt");
    expect(normalizeSessionPath("/session-state/events.jsonl")).toBe("/session-state/events.jsonl");
    expect(normalizeSessionPath("/workspace")).toBe("/workspace");
  });

  it("reads back-slash paths from the runtime as posix", () => {
    expect(normalizeSessionPath("\\session-state\\workspace.yaml")).toBe("/session-state/workspace.yaml");
  });

  it("resolves a relative path against the workspace", () => {
    expect(normalizeSessionPath("notes/plan.txt")).toBe("/workspace/notes/plan.txt");
  });

  it.each([
    "/workspace/../session-state/x",
    "/workspace/a/../../etc/passwd",
    "..\\..\\Windows\\win.ini",
    "../other-thread/workspace/a.txt",
  ])("rejects any .. segment: %s", (p) => {
    expect(() => normalizeSessionPath(p)).toThrow(SessionPathError);
  });

  it.each([
    "/etc/passwd",
    "C:\\Windows\\win.ini",
    "c:/Windows/win.ini",
    "\\\\server\\share\\x",
    "//server/share/x",
    "/",
    "/workspaces/x",
    "/session-statex/y",
    "/tmp/x",
  ])("rejects paths outside the workspace: %s", (p) => {
    expect(() => normalizeSessionPath(p)).toThrow(SessionPathError);
  });

  it("rejects control characters and the reserved marker name", () => {
    expect(() => normalizeSessionPath("/workspace/a\u0000b")).toThrow(SessionPathError);
    expect(() => normalizeSessionPath("/workspace/.~dir")).toThrow(SessionPathError);
    expect(() => normalizeSessionPath("")).toThrow(SessionPathError);
  });

  it("validates namespace segments", () => {
    expect(buildNamespace("abc123", "thread-1")).toBe("abc123/thread-1");
    expect(() => buildNamespace("a/b", "t")).toThrow(SessionPathError);
    expect(() => buildNamespace("..", "t")).toThrow(SessionPathError);
    expect(() => buildNamespace("u", "")).toThrow(SessionPathError);
  });
});

describe("BlobSessionFs", () => {
  let store: FakeBlobStore;
  let fs: BlobSessionFs;
  beforeEach(() => {
    store = new FakeBlobStore();
    fs = new BlobSessionFs(store, "userA/thread1");
  });

  it("writes, reads, appends and stats a file inside its namespace", async () => {
    await fs.writeFile("/workspace/notes/a.txt", "hello");
    await fs.appendFile("/workspace/notes/a.txt", " world");
    expect(await fs.readFile("/workspace/notes/a.txt")).toBe("hello world");
    const st = await fs.stat("/workspace/notes/a.txt");
    expect(st).toMatchObject({ isFile: true, isDirectory: false, size: 11 });
    expect(await fs.exists("/workspace/notes")).toBe(true);
    expect((await fs.stat("/workspace/notes")).isDirectory).toBe(true);
    for (const key of store.blobs.keys()) expect(key.startsWith("userA/thread1/")).toBe(true);
  });

  it("round-trips binary content exactly", async () => {
    const bytes = new Uint8Array([0, 255, 137, 80, 78, 71, 13, 10]);
    await fs.writeFileBytes("/workspace/img.png", bytes);
    expect(Array.from(await fs.readFileBytes("/workspace/img.png"))).toEqual(Array.from(bytes));
  });

  it("lists directories with types and hides the directory marker", async () => {
    await fs.mkdir("/workspace/empty", false);
    await fs.writeFile("/workspace/a.txt", "1");
    await fs.writeFile("/workspace/sub/b.txt", "2");
    expect(await fs.readdirWithTypes("/workspace")).toEqual([
      { name: "a.txt", type: "file" },
      { name: "empty", type: "directory" },
      { name: "sub", type: "directory" },
    ]);
    expect(await fs.readdir("/workspace/empty")).toEqual([]);
    await expect(fs.readdir("/workspace/missing")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("removes files and directories", async () => {
    await fs.writeFile("/workspace/d/a.txt", "1");
    await expect(fs.rm("/workspace/d", false, false)).rejects.toMatchObject({ code: "ENOTEMPTY" });
    await fs.rm("/workspace/d", true, false);
    expect(await fs.exists("/workspace/d/a.txt")).toBe(false);
    await expect(fs.rm("/workspace/none", false, false)).rejects.toMatchObject({ code: "ENOENT" });
    await fs.rm("/workspace/none", false, true);
    // No orphaned data blobs.
    expect([...store.blobs.keys()].filter((k) => k.includes("/d/"))).toEqual([]);
  });

  it("never reaches the disk: OS paths fail in the provider, exists() is false", async () => {
    await expect(fs.readFile("/etc/passwd")).rejects.toBeInstanceOf(SessionPathError);
    await expect(fs.readFile("C:\\Windows\\win.ini")).rejects.toBeInstanceOf(SessionPathError);
    await expect(fs.writeFile("/tmp/x", "x")).rejects.toBeInstanceOf(SessionPathError);
    expect(await fs.exists("/etc/passwd")).toBe(false);
    expect(store.blobs.size).toBe(0);
  });

  describe("atomic rename (pointer swap)", () => {
    it("moves a file by rewriting the destination pointer, not the data", async () => {
      await fs.writeFile("/session-state/workspace.yaml.tmp.1", "v2");
      const dataBefore = [...store.blobs.keys()].filter((k) => k.includes("/d/"));
      store.calls = [];
      await fs.rename("/session-state/workspace.yaml.tmp.1", "/session-state/workspace.yaml");
      expect(await fs.readFile("/session-state/workspace.yaml")).toBe("v2");
      expect(await fs.exists("/session-state/workspace.yaml.tmp.1")).toBe(false);
      // Same data blob, no copy: one pointer PUT, then a conditional delete.
      expect([...store.blobs.keys()].filter((k) => k.includes("/d/"))).toEqual(dataBefore);
      expect(store.calls).toEqual([
        "upload userA/thread1/f/session-state/workspace.yaml",
        "delete userA/thread1/f/session-state/workspace.yaml.tmp.1 ifMatch",
      ]);
    });

    it("replaces an existing destination and frees its old data", async () => {
      await fs.writeFile("/session-state/events.jsonl", "old");
      await fs.writeFile("/session-state/events.jsonl.tmp.9", "new");
      await fs.rename("/session-state/events.jsonl.tmp.9", "/session-state/events.jsonl");
      expect(await fs.readFile("/session-state/events.jsonl")).toBe("new");
      expect([...store.blobs.keys()].filter((k) => k.includes("/d/"))).toHaveLength(1);
    });

    it("the destination is complete at every step: a crash after the pointer PUT leaves old-or-new, never torn", async () => {
      await fs.writeFile("/session-state/workspace.yaml", "old");
      await fs.writeFile("/session-state/workspace.yaml.tmp.2", "new");
      // Crash simulation: the store fails every call after the pointer PUT.
      const realDelete = store.delete.bind(store);
      store.delete = async () => {
        throw new Error("process died");
      };
      await expect(
        fs.rename("/session-state/workspace.yaml.tmp.2", "/session-state/workspace.yaml"),
      ).rejects.toThrow("process died");
      store.delete = realDelete;
      // The reader sees the NEW content in full; the old source is a harmless duplicate.
      expect(await fs.readFile("/session-state/workspace.yaml")).toBe("new");
      expect(await fs.readFile("/session-state/workspace.yaml.tmp.2")).toBe("new");
    });

    it("leaves a source that changed meanwhile in place (If-Match)", async () => {
      await fs.writeFile("/workspace/a.txt", "1");
      store.failNextConditionalDelete = true;
      await fs.rename("/workspace/a.txt", "/workspace/b.txt");
      expect(await fs.readFile("/workspace/b.txt")).toBe("1");
      expect(await fs.exists("/workspace/a.txt")).toBe(true);
    });

    it("renames a directory entry by entry", async () => {
      await fs.writeFile("/workspace/x/1.txt", "a");
      await fs.writeFile("/workspace/x/y/2.txt", "b");
      await fs.rename("/workspace/x", "/workspace/z");
      expect(await fs.readFile("/workspace/z/1.txt")).toBe("a");
      expect(await fs.readFile("/workspace/z/y/2.txt")).toBe("b");
      expect(await fs.exists("/workspace/x")).toBe(false);
    });

    it("rejects a rename that escapes the jail", async () => {
      await fs.writeFile("/workspace/a.txt", "1");
      await expect(fs.rename("/workspace/a.txt", "/workspace/../../userB/t/f/workspace/a.txt")).rejects.toBeInstanceOf(SessionPathError);
      await expect(fs.rename("/workspace/a.txt", "/etc/a.txt")).rejects.toBeInstanceOf(SessionPathError);
    });
  });

  it("two namespaces on one store never see each other's files", async () => {
    const other = new BlobSessionFs(store, "userB/thread2");
    await fs.writeFile("/workspace/secret.txt", "A only");
    expect(await other.exists("/workspace/secret.txt")).toBe(false);
    await expect(other.readFile("/workspace/secret.txt")).rejects.toMatchObject({ code: "ENOENT" });
    expect(await other.readdir("/workspace")).toEqual([]);
    for (const attempt of [
      "/workspace/../../userA/thread1/f/workspace/secret.txt",
      "../userA/thread1/workspace/secret.txt",
      "/userA/thread1/f/workspace/secret.txt",
    ]) {
      await expect(other.readFile(attempt)).rejects.toBeInstanceOf(Error);
    }
    // B's files land under B's prefix only.
    await other.writeFile("/workspace/b.txt", "B");
    expect(await fs.exists("/workspace/b.txt")).toBe(false);
  });

  it("ignores a pointer whose target is outside its namespace", async () => {
    await store.upload("userA/thread1/f/workspace/evil.txt", Buffer.alloc(0), { target: "userB/thread2/d/x" });
    await store.upload("userB/thread2/d/x", Buffer.from("B data"), {});
    await expect(fs.readFile("/workspace/evil.txt")).rejects.toMatchObject({ code: "ENOENT" });
  });
});
