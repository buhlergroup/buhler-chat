import { describe, it, expect } from "vitest";

import { isInUserList } from "./runtime-users";

describe("isInUserList (COPILOT_RUNTIME_USERS)", () => {
  it("matches e-mail addresses case-insensitively and hashed ids", () => {
    const list = " Alice@Example.com, bob@example.com;0f1e2d ";
    expect(isInUserList(list, { email: "alice@example.com" })).toBe(true);
    expect(isInUserList(list, { email: "BOB@example.com" })).toBe(true);
    expect(isInUserList(list, { email: "carol@example.com", hashedId: "0F1E2D" })).toBe(true);
    expect(isInUserList(list, { email: "carol@example.com", hashedId: "ffff" })).toBe(false);
  });

  it("an empty list matches nobody", () => {
    expect(isInUserList("", { email: "a@example.com" })).toBe(false);
    expect(isInUserList(" , ;", { email: "" })).toBe(false);
  });
});
