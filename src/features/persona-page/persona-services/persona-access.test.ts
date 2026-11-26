import { describe, it, expect, vi, beforeEach } from "vitest";
import { createHash } from "crypto";
import { defaultSession, adminSession, setSession } from "@/__tests__/helpers/session-mock";

const hashEmail = (e: string) => createHash("sha256").update(e).digest("hex");
const USER_HASH = hashEmail(defaultSession!.user.email);
const OTHER_HASH = "other-user-hash";

// ── Cosmos mock ──────────────────────────────────────────────────────────────
let historyItems: any[] = [];
const historyContainer = {
  items: {
    query: vi.fn((q: any) => ({
      fetchAll: async () => ({
        resources: historyItems.filter(
          (i) => i.id === q.parameters.find((p: any) => p.name === "@id")?.value
        ),
      }),
    })),
  },
};
vi.mock("@/features/common/services/cosmos", () => ({
  HistoryContainer: () => historyContainer,
}));

vi.mock("@/features/auth-page/auth-api", () => ({ options: {}, authOptions: {} }));

// ── Graph group membership mock ──────────────────────────────────────────────
let memberOf: string[] = [];
vi.mock("@/features/persona-page/persona-services/access-group-service", () => ({
  AccessGroupById: vi.fn(async (id: string) =>
    memberOf.includes(id)
      ? { status: "OK", response: { id, name: "G", description: "" } }
      : { status: "ERROR", errors: [{ message: "not a member" }] }
  ),
}));

import {
  canOpenPersona,
  resolveThreadAgent,
  currentPersonaViewer,
  isListedForViewer,
} from "./persona-access";
import { AccessGroupById } from "./access-group-service";

const persona = (overrides: Record<string, any> = {}) => ({
  id: "p1",
  userId: OTHER_HASH,
  isPublished: false,
  // Private: link access turned off (undefined means on, see the link tests).
  linkAccess: false as boolean | undefined,
  accessGroup: undefined as { id: string; source: "SHAREPOINT" } | undefined,
  ...overrides,
});
const group = (id: string) => ({ id, source: "SHAREPOINT" as const });

const viewer = { userId: USER_HASH, isAdmin: false };
const admin = { userId: "admin-hash", isAdmin: true };

beforeEach(async () => {
  historyItems = [];
  memberOf = [];
  vi.mocked(AccessGroupById).mockClear();
  historyContainer.items.query.mockClear();
  await setSession(defaultSession);
});

describe("canOpenPersona", () => {
  it("owner can open a private agent with no group", async () => {
    expect(await canOpenPersona(viewer, persona({ userId: USER_HASH }))).toBe(true);
  });

  it("owner can open own agent even when not a member of its share group", async () => {
    const p = persona({ userId: USER_HASH, accessGroup: group("g1") });
    expect(await canOpenPersona(viewer, p)).toBe(true);
    expect(AccessGroupById).not.toHaveBeenCalled();
  });

  it("member of the share group can open it", async () => {
    memberOf = ["g1"];
    expect(await canOpenPersona(viewer, persona({ accessGroup: group("g1") }))).toBe(true);
    expect(AccessGroupById).toHaveBeenCalledWith("g1");
  });

  it("non-member cannot open a group-shared agent", async () => {
    memberOf = ["g-other"];
    expect(await canOpenPersona(viewer, persona({ accessGroup: group("g1") }))).toBe(false);
  });

  it("everyone can open a published agent with no group", async () => {
    expect(await canOpenPersona(viewer, persona({ isPublished: true }))).toBe(true);
  });

  it("a published agent with a share group stays member-only (unchanged rule)", async () => {
    const p = persona({ isPublished: true, accessGroup: group("g1") });
    expect(await canOpenPersona(viewer, p)).toBe(false);
    memberOf = ["g1"];
    expect(await canOpenPersona(viewer, p)).toBe(true);
  });

  it("private agent with no group is denied to another user", async () => {
    expect(await canOpenPersona(viewer, persona())).toBe(false);
    expect(AccessGroupById).not.toHaveBeenCalled();
  });

  it("an empty group id counts as no group", async () => {
    expect(await canOpenPersona(viewer, persona({ accessGroup: group("") }))).toBe(false);
    expect(
      await canOpenPersona(viewer, persona({ isPublished: true, accessGroup: group("") }))
    ).toBe(true);
  });

  it("admin can open a private agent and a group agent without membership", async () => {
    expect(await canOpenPersona(admin, persona())).toBe(true);
    expect(await canOpenPersona(admin, persona({ accessGroup: group("g1") }))).toBe(true);
  });
});

// Pinned: "Anyone with the link can use this agent" is on unless
// linkAccess === false; a share group wins over it.
describe("canOpenPersona — link access", () => {
  it("undefined (agents saved before the field) opens for any signed-in user", async () => {
    expect(await canOpenPersona(viewer, persona({ linkAccess: undefined }))).toBe(true);
  });

  it("true opens for any signed-in user", async () => {
    expect(await canOpenPersona(viewer, persona({ linkAccess: true }))).toBe(true);
  });

  it("false keeps the agent private (owner and admin only)", async () => {
    expect(await canOpenPersona(viewer, persona({ linkAccess: false }))).toBe(false);
    expect(await canOpenPersona(viewer, persona({ linkAccess: false, userId: USER_HASH }))).toBe(true);
    expect(await canOpenPersona(admin, persona({ linkAccess: false }))).toBe(true);
  });

  it("a share group wins: link access undefined or true does not open it for a non-member", async () => {
    for (const linkAccess of [undefined, true]) {
      const p = persona({ linkAccess, accessGroup: group("g1") });
      memberOf = [];
      expect(await canOpenPersona(viewer, p)).toBe(false);
      memberOf = ["g1"];
      expect(await canOpenPersona(viewer, p)).toBe(true);
    }
  });

  it("published opens for everyone also when link access is false", async () => {
    expect(await canOpenPersona(viewer, persona({ isPublished: true, linkAccess: false }))).toBe(true);
  });

  it("a thread with another user's link agent continues", async () => {
    historyItems = [persona({ id: "p-link", linkAccess: undefined })];
    expect((await resolveThreadAgent("p-link")).allowed).toBe(true);
  });
});

describe("isListedForViewer", () => {
  it("lists own, published and group agents, never another user's link agent", () => {
    expect(isListedForViewer(viewer, persona({ userId: USER_HASH }))).toBe(true);
    expect(isListedForViewer(viewer, persona({ isPublished: true }))).toBe(true);
    expect(isListedForViewer(viewer, persona({ accessGroup: group("g1") }))).toBe(true);
    expect(isListedForViewer(viewer, persona({ linkAccess: undefined }))).toBe(false);
    expect(isListedForViewer(viewer, persona({ linkAccess: true }))).toBe(false);
  });
});

describe("currentPersonaViewer", () => {
  it("uses the hashed e-mail and the session admin flag", async () => {
    expect(await currentPersonaViewer()).toEqual({ userId: USER_HASH, isAdmin: false });
    await setSession(adminSession);
    expect((await currentPersonaViewer()).isAdmin).toBe(true);
  });
});

describe("resolveThreadAgent (existing chat threads)", () => {
  it("a thread without an agent always continues, without a lookup", async () => {
    expect(await resolveThreadAgent(undefined)).toEqual({ allowed: true, persona: undefined });
    expect(historyContainer.items.query).not.toHaveBeenCalled();
  });

  it("a thread whose agent was deleted continues, without agent lists", async () => {
    expect(await resolveThreadAgent("gone")).toEqual({ allowed: true, persona: undefined });
  });

  it("a thread with another user's private agent cannot continue, and gets no agent row", async () => {
    historyItems = [persona({ id: "p-private", personaDocumentIds: ["d1"], subAgentIds: ["s1"] })];
    expect(await resolveThreadAgent("p-private")).toEqual({ allowed: false });
  });

  it("a thread continues while the user is still in the share group, and stops after removal", async () => {
    historyItems = [persona({ id: "p-group", accessGroup: group("g1") })];
    memberOf = ["g1"];
    expect((await resolveThreadAgent("p-group")).allowed).toBe(true);
    memberOf = [];
    expect((await resolveThreadAgent("p-group")).allowed).toBe(false);
  });

  it("an allowed thread gets the agent's current row with its lists, from one lookup", async () => {
    const row = persona({
      id: "p-own",
      userId: USER_HASH,
      personaDocumentIds: ["d1", "d2"],
      subAgentIds: ["s1"],
    });
    historyItems = [row];
    const result = await resolveThreadAgent("p-own");
    expect(result.allowed).toBe(true);
    if (!result.allowed) return;
    expect(result.persona?.personaDocumentIds).toEqual(["d1", "d2"]);
    expect(result.persona?.subAgentIds).toEqual(["s1"]);
    expect(historyContainer.items.query).toHaveBeenCalledTimes(1);
  });
});
