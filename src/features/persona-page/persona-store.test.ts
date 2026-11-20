import { describe, it, expect, vi, beforeEach } from "vitest";

const service = vi.hoisted(() => ({
  CreatePersona: vi.fn(),
  UpsertPersona: vi.fn(),
}));
vi.mock("./persona-services/persona-service", () => service);
vi.mock("../common/navigation-helpers", () => ({ RevalidateCache: vi.fn(async () => {}) }));

import { AddOrUpdatePersona, personaStore } from "./persona-store";

const form = (fields: Record<string, string>) => {
  const fd = new FormData();
  fd.set("name", "Agent");
  fd.set("description", "Does things");
  fd.set("personaMessage", "Be helpful");
  fd.set("defaultTools", JSON.stringify({ codeInterpreter: true }));
  // Left over from an old client: the store must not pass these on.
  fd.set("personaDocumentIds", JSON.stringify(["doc-from-client"]));
  fd.set("ciDocumentIds", JSON.stringify(["ci-from-client"]));
  for (const [k, v] of Object.entries(fields)) fd.set(k, v);
  return fd;
};

const saved = (id: string) => ({
  id,
  name: "Agent",
  description: "Does things",
  personaMessage: "Be helpful",
  isPublished: false,
  userId: "owner",
  extensionIds: [],
  createdAt: new Date(),
  type: "PERSONA" as const,
});

beforeEach(() => {
  personaStore.newPersona();
});

describe("AddOrUpdatePersona", () => {
  it("after the first save of a new agent the editor stays open on the saved agent (decision 7)", async () => {
    service.CreatePersona.mockResolvedValue({ status: "OK", response: saved("new-id") });
    const res = await AddOrUpdatePersona(undefined, form({ id: "" }));
    expect(res.status).toBe("OK");
    expect(service.CreatePersona).toHaveBeenCalledTimes(1);
    expect(service.CreatePersona.mock.calls[0]).toHaveLength(1);
    expect(personaStore.isOpened).toBe(true);
    expect(personaStore.persona.id).toBe("new-id");
  });

  it("a save of an existing agent closes the editor", async () => {
    personaStore.updatePersona(saved("p1"));
    service.UpsertPersona.mockResolvedValue({ status: "OK", response: saved("p1") });
    await AddOrUpdatePersona(undefined, form({ id: "p1" }));
    expect(service.UpsertPersona).toHaveBeenCalledTimes(1);
    expect(service.UpsertPersona.mock.calls[0]).toHaveLength(1);
    expect(personaStore.isOpened).toBe(false);
  });

  it("sends no file ids: only the file actions change them (decision 8)", async () => {
    service.UpsertPersona.mockResolvedValue({ status: "OK", response: saved("p1") });
    await AddOrUpdatePersona(undefined, form({ id: "p1" }));
    const sent = service.UpsertPersona.mock.calls[0][0];
    expect(sent).not.toHaveProperty("personaDocumentIds");
    expect(sent).not.toHaveProperty("codeInterpreterDocumentIds");
    expect(sent.defaultTools).toEqual({ codeInterpreter: true });
  });

  it("keeps the editor open with the error when the save fails", async () => {
    service.CreatePersona.mockResolvedValue({ status: "ERROR", errors: [{ message: "bad" }] });
    const res = await AddOrUpdatePersona(undefined, form({ id: "" }));
    expect(res.status).toBe("ERROR");
    expect(personaStore.isOpened).toBe(true);
    expect(personaStore.persona.id).toBe("");
  });
});
