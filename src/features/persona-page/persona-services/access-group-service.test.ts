import { describe, it, expect, vi, beforeEach } from "vitest";
import { setSession, defaultSession } from "@/__tests__/helpers/session-mock";

// ── auth-api mock ────────────────────────────────────────────────────────────
vi.mock("@/features/auth-page/auth-api", () => ({ options: {}, authOptions: {} }));

vi.mock("@/features/common/services/logger", () => ({
  logInfo: vi.fn(),
  logError: vi.fn(),
  logDebug: vi.fn(),
}));

// ── graph client mock ─────────────────────────────────────────────────────────
// We mock the whole graph client module. Each test controls what `.get()` returns
// by overriding the mock's return behavior.
const graphGetFn = vi.fn();

vi.mock("@/features/common/services/microsoft-graph-client", () => ({
  getGraphClient: vi.fn(() => ({
    api: vi.fn(() => ({
      filter: vi.fn().mockReturnThis(),
      select: vi.fn().mockReturnThis(),
      get: graphGetFn,
    })),
  })),
}));

import { UserAccessGroups, AccessGroupById } from "./access-group-service";

beforeEach(async () => {
  vi.clearAllMocks();
  // reset graphGetFn queue explicitly (clearAllMocks doesn't clear "once" queue)
  graphGetFn.mockReset();
  graphGetFn.mockResolvedValue({ value: [] });
  await setSession(defaultSession);
});

describe("access-group-service.ts — UserAccessGroups", () => {
  // 001 – short-circuits for local dev user
  it("001 returns [] for isLocalDevUser", async () => {
    await setSession({
      ...defaultSession!,
      user: { ...defaultSession!.user, isLocalDevUser: true } as any,
    });
    const result = await UserAccessGroups();
    expect(result.status).toBe("OK");
    if (result.status === "OK") expect(result.response).toEqual([]);
  });

  // 002 – returns UNAUTHORIZED + SESSION_EXPIRED when token missing
  it("002 returns UNAUTHORIZED when token empty", async () => {
    await setSession({
      ...defaultSession!,
      user: { ...defaultSession!.user, accessToken: "" },
    });
    const result = await UserAccessGroups();
    expect(result.status).toBe("UNAUTHORIZED");
    if (result.status === "UNAUTHORIZED") {
      expect(result.errors[0].code).toBe("SESSION_EXPIRED");
      expect(result.errors[0].message).toMatch(/session expired/i);
    }
  });

  // 003 – maps Graph response into AccessGroup[]
  it("003 maps Graph response into AccessGroup[]", async () => {
    graphGetFn.mockResolvedValueOnce({
      value: [{ id: "1", displayName: "X", description: "D" }],
    });
    const result = await UserAccessGroups();
    expect(result.status).toBe("OK");
    if (result.status === "OK") {
      expect(result.response).toEqual([{ id: "1", name: "X", description: "D" }]);
    }
  });

  // 004 – maps 401 statusCode error to UNAUTHORIZED
  it("004 maps 401 statusCode error to UNAUTHORIZED", async () => {
    graphGetFn.mockRejectedValueOnce({ statusCode: 401 });
    const result = await UserAccessGroups();
    expect(result.status).toBe("UNAUTHORIZED");
    if (result.status === "UNAUTHORIZED") {
      expect(result.errors[0].code).toBe("SESSION_EXPIRED");
    }
  });

  // 005 – maps "Access token is undefined" to UNAUTHORIZED
  it('005 maps "Access token is undefined" Error to UNAUTHORIZED', async () => {
    graphGetFn.mockRejectedValueOnce(new Error("Access token is undefined or empty"));
    const result = await UserAccessGroups();
    expect(result.status).toBe("UNAUTHORIZED");
    if (result.status === "UNAUTHORIZED") {
      expect(result.errors[0].code).toBe("SESSION_EXPIRED");
    }
  });

  // 006 – other errors map to ERROR with message
  it("006 other errors map to ERROR with message", async () => {
    graphGetFn.mockRejectedValueOnce(new Error("Network"));
    const result = await UserAccessGroups();
    expect(result.status).toBe("ERROR");
    if (result.status === "ERROR") {
      expect(result.errors[0].message).toMatch(/Network/);
    }
  });
});

describe("access-group-service.ts — AccessGroupById", () => {
  // 007 – returns OK group when found
  it("007 AccessGroupById returns OK when found", async () => {
    graphGetFn.mockResolvedValueOnce({
      value: [{ id: "11111111-2222-3333-4444-555555555555", displayName: "X", description: "D" }],
    });
    const result = await AccessGroupById("11111111-2222-3333-4444-555555555555");
    expect(result.status).toBe("OK");
    if (result.status === "OK") {
      expect(result.response.id).toBe("11111111-2222-3333-4444-555555555555");
      expect(result.response.name).toBe("X");
    }
  });

  // 008 – returns ERROR when Graph throws 404
  it("008 AccessGroupById returns ERROR on Graph 404", async () => {
    graphGetFn.mockRejectedValueOnce({ statusCode: 404, message: "Not found" });
    const result = await AccessGroupById("aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee");
    // 404 is not 401 so should be mapped to ERROR
    expect(result.status).toBe("ERROR");
  });
});

describe("access-group-service.ts — AccessGroupById id check", () => {
  it("009 refuses a group id that is not a GUID and never calls Graph", async () => {
    for (const id of ["g", "x' or 1 eq 1 or id eq 'y", "11111111-2222-3333-4444-555555555555 ", "11111111-2222-3333-4444-555555555555'"]) {
      const result = await AccessGroupById(id);
      expect(result.status).toBe("ERROR");
    }
    expect(graphGetFn).not.toHaveBeenCalled();
  });
});
