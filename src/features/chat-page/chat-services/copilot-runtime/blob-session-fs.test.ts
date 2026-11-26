import { describe, it, expect, beforeEach } from "vitest";

import { createSessionFsAdapter } from "@microsoft/copilot-sdk";
import {
  BlobSessionFs,
  FileTooLargeError,
  readFileLimitBytes,
  SessionStateFullError,
  sessionStateLimitBytes,
} from "./blob-session-fs";
import { FakeBlobStore } from "./fake-blob-store.test-helper";
import { buildNamespace, normalizeSessionPath, SessionPathError } from "./session-path";

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

describe("BlobSessionFs: /session-state has a byte limit", () => {
  const NS = "userA/thread1";
  const stateLimit = 4096;
  const fsWith = (store: FakeBlobStore, limit = stateLimit) => new BlobSessionFs(store, NS, undefined, undefined, 1024, limit);

  it("refuses a journal append over the limit with a clear error and appends nothing", async () => {
    const store = new FakeBlobStore();
    const fs = fsWith(store);
    await fs.writeFile("/session-state/events.jsonl", "a".repeat(1000));
    await fs.appendFile("/session-state/events.jsonl", "b".repeat(2000));
    await fs.writeFile("/session-state/workspace.yaml", "c".repeat(500));
    const err = await fs.appendFile("/session-state/events.jsonl", "d".repeat(1000)).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SessionStateFullError);
    expect((err as { code?: string }).code).toBe("ENOSPC");
    expect((err as Error).message).toMatch(/session history of this chat is full/i);
    expect((await fs.stat("/session-state/events.jsonl")).size).toBe(3000);
    // Another instance measures the state from Blob and refuses too.
    await expect(fsWith(store).appendFile("/session-state/events.jsonl", "d".repeat(1000))).rejects.toMatchObject({ code: "ENOSPC" });
    // A write that replaces a file counts only its new size; a removed file frees its bytes.
    await fs.writeFile("/session-state/workspace.yaml", "c".repeat(100));
    await fs.rm("/session-state/workspace.yaml", false, true);
    await fs.appendFile("/session-state/events.jsonl", "d".repeat(1000));
    expect((await fs.stat("/session-state/events.jsonl")).size).toBe(4000);
    // The workspace quota is separate.
    await fs.writeFile("/workspace/big.txt", "w".repeat(stateLimit * 2));
  });

  it("a rename into /session-state counts the moved file", async () => {
    const store = new FakeBlobStore();
    const fs = fsWith(store);
    await fs.writeFile("/session-state/events.jsonl", "a".repeat(500));
    await fs.writeFile("/session-state/events.jsonl.tmp.1", "n".repeat(3500));
    await fs.rename("/session-state/events.jsonl.tmp.1", "/session-state/events.jsonl");
    expect(await fs.readFile("/session-state/events.jsonl")).toHaveLength(3500);
    await fs.appendFile("/session-state/events.jsonl", "x".repeat(500));
    await expect(fs.appendFile("/session-state/events.jsonl", "x".repeat(200))).rejects.toMatchObject({ code: "ENOSPC" });
  });

  it("whole reads of a session-state file over the limit fail; the limit comes from COPILOT_SESSION_STATE_MAX_MB", async () => {
    const store = new FakeBlobStore();
    await fsWith(store, 1_000_000).writeFile("/session-state/events.jsonl", "e".repeat(stateLimit + 10));
    const fs = fsWith(store);
    await expect(fs.readFile("/session-state/events.jsonl")).rejects.toBeInstanceOf(FileTooLargeError);
    await expect(fs.readFileBytes("/session-state/events.jsonl")).rejects.toBeInstanceOf(FileTooLargeError);
    await expect(fs.readFileRange("/session-state/events.jsonl", 0)).rejects.toBeInstanceOf(FileTooLargeError);
    expect((await fs.readFileRange("/session-state/events.jsonl", 0, 10)).content.length).toBe(10);
    expect(sessionStateLimitBytes({})).toBe(50 * 1024 * 1024);
    expect(sessionStateLimitBytes({ COPILOT_SESSION_STATE_MAX_MB: "8" })).toBe(8 * 1024 * 1024);
  });
});

describe("BlobSessionFs bounded reads for the runtime", () => {
  const NS = "userA/thread1";
  const limit = 1000;
  let store: FakeBlobStore;
  let fs: BlobSessionFs;
  beforeEach(() => {
    store = new FakeBlobStore();
    fs = new BlobSessionFs(store, NS, undefined, undefined, limit);
  });

  it("readFile of a workspace file over the cap fails before any download and points to view_range / rg", async () => {
    await fs.writeFile("/workspace/big.log", "x".repeat(limit + 1));
    await fs.writeFile("/workspace/ok.log", "y".repeat(limit));
    store.requests = [];
    const err = await fs.readFile("/workspace/big.log").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(FileTooLargeError);
    expect((err as Error).message).toBe(
      "File too large to read whole: /workspace/big.log is 0.0 MB, the limit is 0.0 MB. " +
        "Use view with view_range to read a range of lines, or rg / grep to search it.",
    );
    expect(store.requests.filter((r) => r.startsWith("download"))).toEqual([]);
    expect(await fs.readFile("/workspace/ok.log")).toHaveLength(limit);
    // The runtime's own session state has its own, larger limit (it must resume).
    await fs.writeFile("/session-state/events.jsonl", "e".repeat(limit * 3));
    expect(await fs.readFile("/session-state/events.jsonl")).toHaveLength(limit * 3);
    // Binary reads (images for view, run_code inputs) keep the SDK's own limit.
    expect((await fs.readFileBytes("/workspace/big.log")).length).toBe(limit + 1);
  });

  it("the cap error reaches the runtime as the error message of the RPC", async () => {
    await fs.writeFile("/workspace/big.log", "x".repeat(2 * 1024 * 1024));
    const res = await createSessionFsAdapter(fs).readFile({ sessionId: "s", path: "/workspace/big.log" });
    expect(res.error?.message).toMatch(/^File too large to read whole: \/workspace\/big\.log is 2\.0 MB.*view_range.*rg/);
  });

  it("the limit comes from COPILOT_READFILE_MAX_MB, 10 MB by default", () => {
    expect(readFileLimitBytes({})).toBe(10 * 1024 * 1024);
    expect(readFileLimitBytes({ COPILOT_READFILE_MAX_MB: "25" })).toBe(25 * 1024 * 1024);
    expect(readFileLimitBytes({ COPILOT_READFILE_MAX_MB: "nonsense" })).toBe(10 * 1024 * 1024);
  });

  it("readFileRange reads only the requested bytes with one ranged GET and reports the total size", async () => {
    const text = "0123456789".repeat(10_000); // 100,000 bytes
    await fs.writeFile("/workspace/r.txt", text);
    const key = (await store.getProperties(`${NS}/f/workspace/r.txt`))!.metadata.target;
    store.chunkSize = 4096;
    store.requests = [];
    const r = await fs.readFileRange("/workspace/r.txt", 50_000, 20);
    expect(Buffer.from(r.content).toString()).toBe(text.slice(50_000, 50_020));
    expect(r.byteLength).toBe(100_000);
    expect(store.requests.filter((x) => x.startsWith("download"))).toEqual([`download ${key} bytes=50000+20`]);
    expect(store.chunksServed.get(key)).toBe(1);
    // Past the end: no bytes; length 0: only the size.
    expect((await fs.readFileRange("/workspace/r.txt", 200_000, 10)).content.length).toBe(0);
    const sizeOnly = await fs.readFileRange("/workspace/r.txt", 0, 0);
    expect([sizeOnly.content.length, sizeOnly.byteLength]).toEqual([0, 100_000]);
    // Through the end: capped like readFile under /workspace.
    await expect(fs.readFileRange("/workspace/r.txt", 0)).rejects.toBeInstanceOf(FileTooLargeError);
    expect(Buffer.from((await fs.readFileRange("/workspace/r.txt", 99_990)).content).toString()).toBe("0123456789");
    await expect(fs.readFileRange("/workspace/none.txt", 0, 1)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("readFileRange satisfies the SDK adapter contract (exact length, base64)", async () => {
    const body = "grüße\nzeile 2\n";
    await fs.writeFile("/workspace/u.txt", body);
    const adapter = createSessionFsAdapter(fs);
    const res = await adapter.readFileRange!({ sessionId: "s", path: "/workspace/u.txt", offset: 3, length: 4 });
    expect(res.error).toBeUndefined();
    expect(Buffer.from(res.content, "base64")).toEqual(Buffer.from(body).subarray(3, 7));
    expect(res.byteLength).toBe(Buffer.byteLength(body));
  });
});
