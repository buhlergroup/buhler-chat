import { describe, it, expect, vi } from "vitest";

vi.mock("@/features/common/services/cosmos", () => ({ HistoryContainer: vi.fn() }));

import {
  canOpenAgent,
  decideExtensionAccess,
  type AgentForAccess,
} from "./extension-access";

const USER = "user-hash";
const OWNER = "agent-owner-hash";

const ext = (id: string, userId: string, isPublished = false) => ({ id, userId, isPublished });

const agent = (overrides: Partial<AgentForAccess> = {}): AgentForAccess => ({
  id: "agent-1",
  userId: OWNER,
  isPublished: false,
  accessGroup: null,
  extensionIds: ["mcp-1"],
  ...overrides,
});

const notMember = vi.fn(async () => false);
const member = vi.fn(async () => true);

describe("canOpenAgent", () => {
  it("lets the owner open a private agent", async () => {
    expect(await canOpenAgent(agent({ userId: USER }), USER, notMember)).toBe(true);
  });

  it("lets a group member open a group-shared agent", async () => {
    const isMember = vi.fn(async (g: string) => g === "group-1");
    expect(await canOpenAgent(agent({ accessGroup: { id: "group-1" } }), USER, isMember)).toBe(true);
    expect(isMember).toHaveBeenCalledWith("group-1");
  });

  it("keeps a group-shared agent closed for non-members, also when published", async () => {
    expect(
      await canOpenAgent(agent({ accessGroup: { id: "group-1" }, isPublished: true }), USER, notMember)
    ).toBe(false);
  });

  it("opens an agent published to the whole organization", async () => {
    expect(await canOpenAgent(agent({ isPublished: true }), USER, notMember)).toBe(true);
  });

  it("keeps a private agent of someone else closed", async () => {
    expect(await canOpenAgent(agent(), USER, member)).toBe(false);
  });
});

describe("decideExtensionAccess (the extension access rule)", () => {
  it("grants the owner their own extension without an agent", async () => {
    const d = await decideExtensionAccess({
      extensionIds: ["mine"],
      extensions: [ext("mine", USER)],
      userId: USER,
      isGroupMember: notMember,
    });
    expect(d.granted.map((g) => [g.extension.id, g.grant])).toEqual([["mine", "owner"]]);
    expect(d.denied).toEqual([]);
  });

  it("grants a published extension to everyone", async () => {
    const d = await decideExtensionAccess({
      extensionIds: ["pub"],
      extensions: [ext("pub", "someone", true)],
      userId: USER,
      isGroupMember: notMember,
    });
    expect(d.granted[0]).toMatchObject({ grant: "published" });
  });

  it("grants the extension of a group-shared agent to a group member", async () => {
    const d = await decideExtensionAccess({
      extensionIds: ["mcp-1"],
      extensions: [ext("mcp-1", OWNER)],
      agent: agent({ accessGroup: { id: "group-1" } }),
      userId: USER,
      isGroupMember: member,
    });
    expect(d.granted[0]).toMatchObject({ grant: "agent", extension: { id: "mcp-1" } });
  });

  it("grants the extension of a published agent", async () => {
    const d = await decideExtensionAccess({
      extensionIds: ["mcp-1"],
      extensions: [ext("mcp-1", OWNER)],
      agent: agent({ isPublished: true }),
      userId: USER,
      isGroupMember: notMember,
    });
    expect(d.granted[0]).toMatchObject({ grant: "agent" });
  });

  it("denies everything when the user cannot open the agent", async () => {
    const d = await decideExtensionAccess({
      extensionIds: ["mcp-1"],
      extensions: [ext("mcp-1", OWNER)],
      agent: agent({ accessGroup: { id: "group-1" } }),
      userId: USER,
      isGroupMember: notMember,
    });
    expect(d.granted).toEqual([]);
    expect(d.denied).toEqual([{ id: "mcp-1", reason: "no-access" }]);
  });

  it("denies an extension that was removed from the agent later (old thread still lists it)", async () => {
    const d = await decideExtensionAccess({
      extensionIds: ["mcp-1"],
      extensions: [ext("mcp-1", OWNER)],
      agent: agent({ isPublished: true, extensionIds: [] }),
      userId: USER,
      isGroupMember: notMember,
    });
    expect(d.denied).toEqual([{ id: "mcp-1", reason: "no-access" }]);
  });

  it("denies a deleted extension and keeps the others", async () => {
    const d = await decideExtensionAccess({
      extensionIds: ["gone", "mcp-1"],
      extensions: [ext("mcp-1", OWNER)],
      agent: agent({ isPublished: true, extensionIds: ["gone", "mcp-1"] }),
      userId: USER,
      isGroupMember: notMember,
    });
    expect(d.granted.map((g) => g.extension.id)).toEqual(["mcp-1"]);
    expect(d.denied).toEqual([{ id: "gone", reason: "not-found" }]);
  });

  it("does not let an agent grant an extension its owner does not own", async () => {
    // The agent owner attached someone else's private extension by id.
    const d = await decideExtensionAccess({
      extensionIds: ["foreign"],
      extensions: [ext("foreign", "third-party")],
      agent: agent({ isPublished: true, extensionIds: ["foreign"] }),
      userId: USER,
      isGroupMember: notMember,
    });
    expect(d.denied).toEqual([{ id: "foreign", reason: "no-access" }]);
  });

  it("denies an extension id a user put on their own thread without an agent", async () => {
    const d = await decideExtensionAccess({
      extensionIds: ["private-of-other"],
      extensions: [ext("private-of-other", "other")],
      agent: null,
      userId: USER,
      isGroupMember: member,
    });
    expect(d.denied).toEqual([{ id: "private-of-other", reason: "no-access" }]);
  });

  it("checks group membership once per decision", async () => {
    const isMember = vi.fn(async () => true);
    await decideExtensionAccess({
      extensionIds: ["a", "b"],
      extensions: [ext("a", OWNER), ext("b", OWNER)],
      agent: agent({ accessGroup: { id: "g" }, extensionIds: ["a", "b"] }),
      userId: USER,
      isGroupMember: isMember,
    });
    expect(isMember).toHaveBeenCalledTimes(1);
  });
});
