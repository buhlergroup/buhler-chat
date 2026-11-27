import { describe, expect, it } from "vitest";
import { workspaceFileUrl, workspaceLinkTarget } from "./workspace-file-url";

const T = "thread-1";
const url = (relative: string) => `/api/workspace/file?t=${T}&p=${encodeURIComponent(relative)}`;

describe("workspaceFileUrl", () => {
  it("encodes the thread id and the path relative to /workspace", () => {
    expect(workspaceFileUrl("a b", "/workspace/out/x y.csv")).toBe("/api/workspace/file?t=a%20b&p=out%2Fx%20y.csv");
  });
});

describe("workspaceLinkTarget", () => {
  it.each([
    ["absolute path", "/workspace/squares.csv", "squares.csv"],
    ["sandbox: link", "sandbox:/workspace/squares.csv", "squares.csv"],
    ["sandbox: link, upper case", "SANDBOX:/workspace/squares.csv", "squares.csv"],
    ["file: link", "file:///workspace/squares.csv", "squares.csv"],
    ["file: link, one slash", "file:/workspace/squares.csv", "squares.csv"],
    ["sandbox: relative path", "sandbox:outputs/squares.csv", "outputs/squares.csv"],
    ["sandbox: dot relative path", "sandbox:./outputs/squares.csv", "outputs/squares.csv"],
    ["sub folder", "/workspace/outputs/deck.pptx", "outputs/deck.pptx"],
    ["percent-encoded name", "/workspace/my%20data.csv", "my data.csv"],
    ["query and fragment dropped", "/workspace/a.csv?x=1#top", "a.csv"],
  ])("rewrites a %s", (_label, href, relative) => {
    expect(workspaceLinkTarget(T, href)).toBe(url(relative));
  });

  it("takes the thread id from the caller only", () => {
    expect(workspaceLinkTarget("other", "sandbox:/workspace/a.csv")).toBe("/api/workspace/file?t=other&p=a.csv");
  });

  it.each([
    ["parent segment", "/workspace/../session-state/events.jsonl"],
    ["parent segment, encoded", "/workspace/%2e%2e/session-state/events.jsonl"],
    ["sandbox: relative parent", "sandbox:../secret.txt"],
    ["session state", "/session-state/events.jsonl"],
    ["sandbox: session state", "sandbox:/session-state/workspace.yaml"],
    ["file: session state", "file:///session-state/events.jsonl"],
    ["the workspace itself", "/workspace"],
    ["a folder", "/workspace/outputs/"],
    ["file: with a host", "file://server/share/a.csv"],
    ["empty sandbox: link", "sandbox:"],
    ["backslashes", "sandbox:/workspace/..\\session-state\\x"],
    ["broken percent-encoding", "/workspace/100%.csv"],
    ["directory marker", "/workspace/outputs/.~dir"],
  ])("refuses a %s (null: block it)", (_label, href) => {
    expect(workspaceLinkTarget(T, href)).toBeNull();
  });

  it.each([
    ["https link", "https://example.com/a.csv"],
    ["http link", "http://example.com/workspace/a.csv"],
    ["mailto link", "mailto:someone@example.com"],
    ["protocol-relative link", "//example.com/workspace/a.csv"],
    ["app route", "/api/workspace/file?t=thread-1&p=a.csv"],
    ["image route", "/api/images?t=thread-1&img=a.png"],
    ["code interpreter path", "sandbox:/mnt/data/a.csv"],
    ["other absolute path", "/workspaces/a.csv"],
    ["fragment", "#section"],
    ["bare relative path", "squares.csv"],
    ["dot relative path", "./outputs/squares.csv"],
    ["relative parent", "../secret.txt"],
    ["host without scheme", "www.example.com"],
    ["path that only starts like the workspace", "/workspace?x=1"],
    ["data URL", "data:text/plain,hi"],
    ["javascript URL", "javascript:alert(1)"],
  ])("leaves a %s to the sanitizer (undefined)", (_label, href) => {
    expect(workspaceLinkTarget(T, href)).toBeUndefined();
  });
});
