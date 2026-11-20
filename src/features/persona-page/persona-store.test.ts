import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockCreatePersona, mockUpsertPersona } = vi.hoisted(() => ({
  mockCreatePersona: vi.fn(),
  mockUpsertPersona: vi.fn(),
}));

vi.mock("./persona-services/persona-service", () => ({
  CreatePersona: mockCreatePersona,
  UpsertPersona: mockUpsertPersona,
}));
vi.mock("./persona-services/persona-ci-documents-service", () => ({
  UpdateOrAddPersonaCIDocuments: vi.fn(async () => ({ status: "OK", response: [] })),
}));
vi.mock("../common/navigation-helpers", () => ({ RevalidateCache: vi.fn() }));

import { AddOrUpdatePersona } from "./persona-store";

const formData = (fields: Record<string, string>) => {
  const data = new FormData();
  data.set("name", "Agent");
  data.set("description", "d");
  data.set("personaMessage", "m");
  data.set("personaDocumentIds", "[]");
  data.set("selectedSharePointDocumentIds", "");
  data.set("selectedCIDocumentIds", "");
  data.set("accessGroupId", "");
  for (const [k, v] of Object.entries(fields)) data.set(k, v);
  return data;
};

beforeEach(() => {
  vi.clearAllMocks();
  mockCreatePersona.mockResolvedValue({ status: "OK", response: {} });
  mockUpsertPersona.mockResolvedValue({ status: "OK", response: {} });
});

// Pinned: the "Anyone with the link can use this agent" switch (name
// linkAccess) is saved from the editor form like isPublished.
describe("AddOrUpdatePersona — linkAccess from the form", () => {
  it("a new agent with the switch on is created with linkAccess true", async () => {
    await AddOrUpdatePersona(null, formData({ id: "", linkAccess: "on" }));
    expect(mockCreatePersona.mock.calls[0][0].linkAccess).toBe(true);
  });

  it("a saved agent with the switch off is updated with linkAccess false", async () => {
    await AddOrUpdatePersona(null, formData({ id: "p1" }));
    expect(mockUpsertPersona.mock.calls[0][0].linkAccess).toBe(false);
  });
});
