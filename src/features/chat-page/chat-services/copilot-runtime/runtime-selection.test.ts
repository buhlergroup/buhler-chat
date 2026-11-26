import { describe, it, expect, vi, beforeEach } from "vitest";

const user = { email: "alice@example.com", token: "tok", isLocalDevUser: false, name: "", image: "", isAdmin: false };
const getCurrentUser = vi.fn(async () => user);
vi.mock("@/features/auth-page/helpers", () => ({
  getCurrentUser: () => getCurrentUser(),
  hashValue: (v: string) => `hash-of-${v}`,
}));
const post = vi.fn();
vi.mock("@/features/common/services/microsoft-graph-client", () => ({
  getGraphClient: () => ({ api: () => ({ post }) }),
}));
vi.mock("@/features/common/services/logger", () => ({ logError: vi.fn() }));

import { resolveAgentRuntimeForCurrentUser } from "./runtime-selection";

describe("resolveAgentRuntimeForCurrentUser", () => {
  beforeEach(() => {
    getCurrentUser.mockClear();
    post.mockReset();
  });

  it("global AGENT_RUNTIME=copilot serves everybody without a user lookup", async () => {
    expect(await resolveAgentRuntimeForCurrentUser({ AGENT_RUNTIME: "copilot" })).toBe("copilot");
    expect(getCurrentUser).not.toHaveBeenCalled();
  });

  it("nothing configured: AI SDK path, no user lookup", async () => {
    expect(await resolveAgentRuntimeForCurrentUser({})).toBe("ai-sdk");
    expect(getCurrentUser).not.toHaveBeenCalled();
  });

  it("opt-in list by e-mail or hashed id", async () => {
    expect(await resolveAgentRuntimeForCurrentUser({ COPILOT_RUNTIME_USERS: "ALICE@example.com" })).toBe("copilot");
    expect(await resolveAgentRuntimeForCurrentUser({ COPILOT_RUNTIME_USERS: "hash-of-alice@example.com" })).toBe("copilot");
    expect(await resolveAgentRuntimeForCurrentUser({ COPILOT_RUNTIME_USERS: "bob@example.com" })).toBe("ai-sdk");
  });

  it("opt-in group via Graph checkMemberGroups, cached; fails closed on errors", async () => {
    post.mockResolvedValueOnce({ value: ["group-1"] });
    expect(await resolveAgentRuntimeForCurrentUser({ COPILOT_RUNTIME_GROUP_ID: "group-1" })).toBe("copilot");
    expect(post).toHaveBeenCalledWith({ groupIds: ["group-1"] });
    expect(await resolveAgentRuntimeForCurrentUser({ COPILOT_RUNTIME_GROUP_ID: "group-1" })).toBe("copilot");
    expect(post).toHaveBeenCalledTimes(1);

    getCurrentUser.mockResolvedValueOnce({ ...user, email: "bob@example.com" });
    post.mockRejectedValueOnce(new Error("graph down"));
    expect(await resolveAgentRuntimeForCurrentUser({ COPILOT_RUNTIME_GROUP_ID: "group-1" })).toBe("ai-sdk");
  });

  it("a local dev user without Graph stays on the AI SDK path for a group", async () => {
    getCurrentUser.mockResolvedValueOnce({ ...user, email: "dev@example.com", isLocalDevUser: true });
    expect(await resolveAgentRuntimeForCurrentUser({ COPILOT_RUNTIME_GROUP_ID: "group-1" })).toBe("ai-sdk");
    expect(post).not.toHaveBeenCalled();
  });
});
