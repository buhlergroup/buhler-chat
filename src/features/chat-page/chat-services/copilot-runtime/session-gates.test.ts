import { describe, it, expect, vi } from "vitest";

vi.mock("@/features/common/services/logger", () => ({ logInfo: vi.fn(), logWarn: vi.fn(), logError: vi.fn() }));

import { insideWorkspace, patchPaths, permissionGate, preToolGate, writeTargets, type SubAgentHookGate } from "./session-gates";

const apps = () => new Set(["get_current_time"]);
const hook = (toolName: string, toolArgs: unknown, extra: Record<string, unknown> = {}) =>
  ({ toolName, toolArgs, timestamp: 0, cwd: "/workspace", ...extra }) as never;
const inv = { sessionId: "s" };

describe("journal access: read yes, write no", () => {
  it("permission gate: reads anywhere in the jail, writes only in /workspace", async () => {
    const gate = permissionGate({ appToolNames: apps });
    const ask = (req: unknown) => gate(req as never, {} as never);
    expect(await ask({ kind: "read", path: "/session-state/events.jsonl" })).toEqual({ kind: "approve-once" });
    expect(await ask({ kind: "read", path: "/workspace/a.txt" })).toEqual({ kind: "approve-once" });
    expect(await ask({ kind: "read", path: "/etc/passwd" })).toEqual({ kind: "reject" });
    expect(await ask({ kind: "write", fileName: "/workspace/a.txt" })).toEqual({ kind: "approve-once" });
    expect(await ask({ kind: "write", fileName: "/session-state/events.jsonl" })).toEqual({ kind: "reject" });
    expect(await ask({ kind: "write", fileName: "/session-state/workspace.yaml" })).toEqual({ kind: "reject" });
    // A multi-file patch: one target in the journal rejects the whole write.
    expect(
      await ask({
        kind: "write",
        fileName: "/workspace/a.txt",
        fileEdits: [{ after: { path: "/workspace/a.txt", content: "" } }, { after: { path: "/session-state/x", content: "" } }],
      }),
    ).toEqual({ kind: "reject" });
  });

  it("pre-tool hook: create / edit / apply_patch outside /workspace are denied", async () => {
    const gate = preToolGate({ appToolNames: apps });
    const decision = async (name: string, args: unknown) => (await gate(hook(name, args), inv))?.permissionDecision;
    expect(await decision("create", { path: "/workspace/n.md", file_text: "x" })).toBe("allow");
    expect(await decision("create", { path: "/session-state/events.jsonl", file_text: "x" })).toBe("deny");
    expect(await decision("edit", { path: "/session-state/workspace.yaml", old_str: "a", new_str: "b" })).toBe("deny");
    expect(await decision("edit", { path: "notes/plan.md", old_str: "a", new_str: "b" })).toBe("allow");
    expect(await decision("apply_patch", "*** Begin Patch\n*** Add File: /workspace/a.txt\n+alpha\n*** End Patch\n")).toBe("allow");
    expect(
      await decision("apply_patch", "*** Begin Patch\n*** Update File: /session-state/events.jsonl\n@@\n-a\n+b\n*** End Patch\n"),
    ).toBe("deny");
    expect(
      await decision("apply_patch", "*** Begin Patch\n*** Update File: /workspace/a.txt\n*** Move to: /session-state/a.txt\n*** End Patch\n"),
    ).toBe("deny");
    // Unreadable arguments fail closed.
    expect(await decision("apply_patch", { something: 1 })).toBe("deny");
    expect(await decision("view", { path: "/session-state/events.jsonl" })).toBe("allow");
    expect(await decision("powershell", { command: "ls" })).toBe("deny");
    expect(await decision("get_current_time", {})).toBe("allow");
    expect(await decision("task", { agent_type: "general" })).toBe("deny");
  });

  it("pre-tool hook: sub-agent tool calls go through the turn gate", async () => {
    const sub: SubAgentHookGate = {
      checkTask: () => ({ permissionDecision: "allow" }),
      toolAllowed: (input) => input.toolName !== "get_current_time",
    };
    const gate = preToolGate({ appToolNames: apps, subAgents: () => sub });
    expect((await gate(hook("task", { agent_type: "general" }), inv))?.permissionDecision).toBe("allow");
    expect((await gate(hook("get_current_time", {}, { agentId: "a1" }), inv))?.permissionDecision).toBe("deny");
    expect((await gate(hook("get_current_time", {}), inv))?.permissionDecision).toBe("allow");
  });

  it("pre-tool hook: indented, tab, CRLF and loosely spaced patch headers are read too", async () => {
    const gate = preToolGate({ appToolNames: apps });
    const decision = async (patch: string) => (await gate(hook("apply_patch", patch), inv))?.permissionDecision;
    const variants = [
      "*** Begin Patch\n  *** Update File: /session-state/events.jsonl\n@@\n-a\n+b\n*** End Patch\n",
      "*** Begin Patch\n\t*** Add File: /session-state/x.txt\n+a\n*** End Patch\n",
      "*** Begin Patch\r\n*** Add File: /session-state/x.txt\r\n+a\r\n*** End Patch\r\n",
      "*** Begin Patch\r\n \t*** Delete File: /session-state/workspace.yaml\r\n*** End Patch\r\n",
      "*** Begin Patch\n*** Update File: /workspace/a.txt\n    *** Move to: /session-state/a.txt\n*** End Patch\n",
      "*** Begin Patch\n***Add File:/session-state/x.txt\n+a\n*** End Patch\n",
      "*** Begin Patch\n*** add file: /session-state/x.txt\n+a\n*** End Patch\n",
      "*** Begin Patch\n \v*** Update  File : /session-state/events.jsonl\n@@\n-a\n+b\n*** End Patch\n",
    ];
    for (const patch of variants) expect(await decision(patch), JSON.stringify(patch)).toBe("deny");
    // The same shapes inside /workspace stay allowed.
    expect(await decision("*** Begin Patch\r\n  *** Add File: /workspace/a.txt\r\n+a\r\n*** End Patch\r\n")).toBe("allow");
    expect(patchPaths("  *** Add File: a.txt\r\n\t*** Delete File: /workspace/b\r\n")).toEqual(["a.txt", "/workspace/b"]);
  });

  it("helpers", () => {
    expect(patchPaths("*** Add File: a.txt\n*** Delete File: /workspace/b\n")).toEqual(["a.txt", "/workspace/b"]);
    expect(writeTargets("create", { path: "x" })).toEqual(["x"]);
    expect(insideWorkspace("/workspace")).toBe(true);
    expect(insideWorkspace("/workspace/../session-state/x")).toBe(false);
    expect(insideWorkspace("/session-state/x")).toBe(false);
  });
});
