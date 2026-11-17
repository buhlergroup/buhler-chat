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
  canContinuePersonaThread,
  currentPersonaViewer,
} from "./persona-access";
import { AccessGroupById } from "./access-group-service";

const persona = (overrides: Record<string, any> = {}) => ({
  id: "p1",
  userId: OTHER_HASH,
  isPublished: false,
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

describe("currentPersonaViewer", () => {
  it("uses the hashed e-mail and the session admin flag", async () => {
    expect(await currentPersonaViewer()).toEqual({ userId: USER_HASH, isAdmin: false });
    await setSession(adminSession);
    expect((await currentPersonaViewer()).isAdmin).toBe(true);
  });
});

describe("canContinuePersonaThread (existing chat threads)", () => {
  it("a thread without an agent always continues", async () => {
    expect(await canContinuePersonaThread(undefined)).toBe(true);
    expect(historyContainer.items.query).not.toHaveBeenCalled();
  });

  it("a thread whose agent was deleted continues (snapshot, as before)", async () => {
    expect(await canContinuePersonaThread("gone")).toBe(true);
  });

  it("a thread with another user's private agent cannot continue", async () => {
    historyItems = [persona({ id: "p-private" })];
    expect(await canContinuePersonaThread("p-private")).toBe(false);
  });

  it("a thread continues while the user is still in the share group, and stops after removal", async () => {
    historyItems = [persona({ id: "p-group", accessGroup: group("g1") })];
    memberOf = ["g1"];
    expect(await canContinuePersonaThread("p-group")).toBe(true);
    memberOf = [];
    expect(await canContinuePersonaThread("p-group")).toBe(false);
  });

  it("the owner's own thread continues", async () => {
    historyItems = [persona({ id: "p-own", userId: USER_HASH })];
    expect(await canContinuePersonaThread("p-own")).toBe(true);
  });
});
