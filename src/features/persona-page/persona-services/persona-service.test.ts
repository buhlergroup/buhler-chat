import { describe, it, expect, vi, beforeEach } from "vitest";
import { createHash } from "crypto";
import { defaultSession, adminSession, setSession } from "@/__tests__/helpers/session-mock";

const hashEmail = (e: string) => createHash("sha256").update(e).digest("hex");
const USER_HASH = hashEmail(defaultSession!.user.email);

// ── Cosmos mock (direct module mock, bypasses singleton) ─────────────────────
let historyItems: any[] = [];

const historyContainer = {
  items: {
    create: vi.fn(async (doc: any) => ({ resource: { ...doc } })),
    upsert: vi.fn(async (doc: any) => ({ resource: { ...doc } })),
    query: vi.fn((_q: any) => ({
      fetchAll: async () => ({ resources: historyItems }),
    })),
  },
  item: vi.fn((id: string, _pk?: string) => ({
    read: vi.fn(async () => ({ resource: historyItems.find((i: any) => i.id === id) })),
    delete: vi.fn(async () => {
      const idx = historyItems.findIndex((i: any) => i.id === id);
      if (idx >= 0) historyItems.splice(idx, 1);
      return { resource: undefined };
    }),
  })),
};

vi.mock("@/features/common/services/cosmos", () => ({
  HistoryContainer: () => historyContainer,
  ConfigContainer: () => historyContainer,
}));

// ── auth-api mock (must export 'options') ────────────────────────────────────
vi.mock("@/features/auth-page/auth-api", () => ({ options: {}, authOptions: {} }));

// ── persona-documents-service mock ──────────────────────────────────────────
vi.mock("@/features/persona-page/persona-services/persona-documents-service", () => ({
  DeletePersonaDocumentsByPersonaId: vi.fn(async () => undefined),
  UpdateOrAddPersonaDocuments: vi.fn(async () => ({ status: "OK", response: [] })),
}));

// ── persona-ci-documents-service mock ───────────────────────────────────────
vi.mock("@/features/persona-page/persona-services/persona-ci-documents-service", () => ({
  PersonaCIDocumentsByIds: vi.fn(async () => ({ status: "OK", response: [] })),
  DownloadSharePointFile: vi.fn(async () => ({
    status: "OK",
    response: { buffer: Buffer.from("data"), name: "file.csv", contentType: "text/csv" },
  })),
}));

// ── code-interpreter-service mock ────────────────────────────────────────────
vi.mock("@/features/chat-page/chat-services/code-interpreter-service", () => ({
  UploadFileForCodeInterpreter: vi.fn(async () => ({
    status: "OK",
    response: { id: "openai-file-1", name: "file.csv" },
  })),
}));

// ── chat-thread-service mock ─────────────────────────────────────────────────
vi.mock("@/features/chat-page/chat-services/code-interpreter-file-access", () => ({
  createChatThreadWithServerFiles: vi.fn(async (payload: any) => ({ ...payload })),
}));

// ── access-group-service mock ────────────────────────────────────────────────
vi.mock("@/features/persona-page/persona-services/access-group-service", () => ({
  AccessGroupById: vi.fn(async () => ({ status: "OK", response: { id: "g1", name: "G", description: "" } })),
  UserAccessGroups: vi.fn(async () => ({ status: "OK", response: [] })),
}));

// ── logger mock ──────────────────────────────────────────────────────────────
vi.mock("@/features/common/services/logger", () => ({
  logInfo: vi.fn(),
  logError: vi.fn(),
  logDebug: vi.fn(),
}));

// ── imports after mocks ──────────────────────────────────────────────────────
import {
  CreatePersona,
  FindPersonaByID,
  EnsurePersonaOperation,
  DeletePersona,
  UpsertPersona,
  FindAllPersonaForCurrentUser,
  CreatePersonaChat,
} from "./persona-service";

import {
  DeletePersonaDocumentsByPersonaId,
  UpdateOrAddPersonaDocuments,
} from "./persona-documents-service";

import {
  PersonaCIDocumentsByIds,
  DownloadSharePointFile,
} from "./persona-ci-documents-service";

import { UploadFileForCodeInterpreter } from "@/features/chat-page/chat-services/code-interpreter-service";
import { createChatThreadWithServerFiles } from "@/features/chat-page/chat-services/code-interpreter-file-access";
import { AccessGroupById, UserAccessGroups } from "./access-group-service";

// ── helpers ──────────────────────────────────────────────────────────────────
const validPersonaInput = () => ({
  name: "Test Persona",
  description: "A description",
  personaMessage: "System message",
  isPublished: false,
  extensionIds: [],
});

const seedPersona = (overrides: Record<string, any> = {}) => {
  const doc = {
    id: "p1",
    name: "Seed Persona",
    description: "desc",
    personaMessage: "msg",
    isPublished: false,
    userId: USER_HASH,
    createdAt: new Date(),
    extensionIds: [],
    type: "PERSONA" as const,
    personaDocumentIds: [],
    codeInterpreterDocumentIds: [],
    subAgentIds: [],
    ...overrides,
  };
  historyItems.push(doc);
  return doc;
};

beforeEach(() => {
  historyItems.length = 0;
  vi.clearAllMocks();
  setSession(defaultSession);

  // restore default mock implementations after clearAllMocks
  vi.mocked(UpdateOrAddPersonaDocuments).mockResolvedValue({ status: "OK", response: [] });
  vi.mocked(AccessGroupById).mockResolvedValue({ status: "OK", response: { id: "g1", name: "G", description: "" } });
  vi.mocked(UserAccessGroups).mockResolvedValue({ status: "OK", response: [] });
  vi.mocked(PersonaCIDocumentsByIds).mockResolvedValue({ status: "OK", response: [] });
  vi.mocked(DownloadSharePointFile).mockResolvedValue({
    status: "OK",
    response: { buffer: Buffer.from("data"), name: "file.csv", contentType: "text/csv" },
  });
  vi.mocked(UploadFileForCodeInterpreter).mockResolvedValue({
    status: "OK",
    response: { id: "openai-file-1", name: "file.csv" },
  });
  vi.mocked(createChatThreadWithServerFiles).mockImplementation(async (payload: any) => ({
    ...payload,
  }));
  historyContainer.items.create.mockImplementation(async (doc: any) => ({ resource: { ...doc } }));
  historyContainer.items.upsert.mockImplementation(async (doc: any) => ({ resource: { ...doc } }));
  historyContainer.items.query.mockImplementation((_q: any) => ({
    fetchAll: async () => ({ resources: historyItems }),
  }));
});

// ── tests ─────────────────────────────────────────────────────────────────────

describe("persona-service.ts", () => {
  // 001 – CreatePersona lets any user publish; fresh publish starts as community
  it("001 CreatePersona lets any user publish as community", async () => {
    await setSession(defaultSession);
    const result = await CreatePersona({ ...validPersonaInput(), isPublished: true }, []);
    expect(result.status).toBe("OK");
    if (result.status === "OK") {
      expect(result.response.isPublished).toBe(true);
      expect(result.response.trustLevel).toBe("community");
      expect(result.response.publishedAt).toBeInstanceOf(Date);
      expect(result.response.userId).toBe(USER_HASH);
      expect(result.response.creatorName).toBe("Test User");
      expect(result.response.id).toBeTruthy();
      expect(result.response.type).toBe("PERSONA");
    }
  });

  // 002 – CreatePersona without publish stores no trust metadata
  it("002 CreatePersona unpublished has no trustLevel/publishedAt", async () => {
    await setSession(defaultSession);
    const result = await CreatePersona(validPersonaInput(), []);
    expect(result.status).toBe("OK");
    if (result.status === "OK") {
      expect(result.response.isPublished).toBe(false);
      expect(result.response.trustLevel).toBeUndefined();
      expect(result.response.publishedAt).toBeUndefined();
    }
  });

  // 003 – CreatePersona returns ERROR on invalid input
  it("003 CreatePersona returns ERROR with Zod messages on invalid input", async () => {
    await setSession(defaultSession);
    const result = await CreatePersona(
      { name: "", description: "", personaMessage: "", isPublished: false, extensionIds: [] },
      []
    );
    expect(result.status).toBe("ERROR");
    if (result.status === "ERROR") {
      expect(result.errors.length).toBeGreaterThan(0);
    }
  });

  // 004 – CreatePersona propagates persona-documents ERROR
  it("004 CreatePersona propagates persona-documents ERROR", async () => {
    vi.mocked(UpdateOrAddPersonaDocuments).mockResolvedValueOnce({
      status: "ERROR",
      errors: [{ message: "sp fail" }],
    });
    const result = await CreatePersona(validPersonaInput(), []);
    expect(result.status).toBe("ERROR");
    if (result.status === "ERROR") {
      expect(result.errors[0].message).toBe("sp fail");
    }
  });

  // 005 – FindPersonaByID returns NOT_FOUND when no rows
  it("005 FindPersonaByID returns NOT_FOUND when no rows", async () => {
    const result = await FindPersonaByID("nonexistent");
    expect(result.status).toBe("NOT_FOUND");
  });

  // 006 – FindPersonaByID returns UNAUTHORIZED when accessGroup denies
  it("006 FindPersonaByID returns UNAUTHORIZED when accessGroup denies", async () => {
    seedPersona({ id: "p-ag", accessGroup: { id: "g1", source: "SHAREPOINT" } });
    vi.mocked(AccessGroupById).mockResolvedValueOnce({
      status: "ERROR",
      errors: [{ message: "no access" }],
    });
    const result = await FindPersonaByID("p-ag");
    expect(result.status).toBe("UNAUTHORIZED");
    if (result.status === "UNAUTHORIZED") {
      expect(result.errors[0].message).toMatch(/access/i);
    }
  });

  // 007 – FindAllPersonaForCurrentUser SQL includes published OR ownerId OR group membership
  it("007 FindAllPersonaForCurrentUser SQL scoping", async () => {
    vi.mocked(UserAccessGroups).mockResolvedValueOnce({
      status: "OK",
      response: [{ id: "g1", name: "G1", description: "" }],
    });

    let capturedQuerySpec: any;
    historyContainer.items.query.mockImplementationOnce((q: any) => {
      capturedQuerySpec = q;
      return { fetchAll: async () => ({ resources: [] }) };
    });

    await FindAllPersonaForCurrentUser();

    expect(capturedQuerySpec).toBeDefined();
    expect(capturedQuerySpec.query).toContain("isPublished=@isPublished");
    expect(capturedQuerySpec.query).toContain("r.userId=@userId");
    expect(capturedQuerySpec.query).toContain("ARRAY_CONTAINS(@groupIds, r.accessGroup.id)");

    const userParam = capturedQuerySpec.parameters.find((p: any) => p.name === "@userId");
    expect(userParam?.value).toBe(USER_HASH);

    const groupIdsParam = capturedQuerySpec.parameters.find((p: any) => p.name === "@groupIds");
    expect(groupIdsParam?.value).toEqual(["g1"]);
  });

  // 008 – FindAllPersonaForCurrentUser filters out personas with denied access group
  it("008 FindAllPersonaForCurrentUser filters out inaccessible personas", async () => {
    const deniedPersona = {
      id: "p-denied",
      name: "Denied",
      description: "d",
      personaMessage: "m",
      isPublished: true,
      userId: USER_HASH,
      createdAt: new Date(),
      extensionIds: [],
      type: "PERSONA",
      accessGroup: { id: "g-denied", source: "SHAREPOINT" },
      personaDocumentIds: [],
    };
    historyItems.push(deniedPersona);

    vi.mocked(AccessGroupById).mockResolvedValueOnce({
      status: "ERROR",
      errors: [{ message: "no access" }],
    });

    const result = await FindAllPersonaForCurrentUser();
    expect(result.status).toBe("OK");
    if (result.status === "OK") {
      expect(result.response.find((p: any) => p.id === "p-denied")).toBeUndefined();
    }
  });

  // 009 – EnsurePersonaOperation returns UNAUTHORIZED for non-owner non-admin
  it("009 EnsurePersonaOperation returns UNAUTHORIZED for non-owner non-admin", async () => {
    await setSession(defaultSession);
    seedPersona({ id: "p-other", userId: "other-hash" });
    const result = await EnsurePersonaOperation("p-other");
    expect(result.status).toBe("UNAUTHORIZED");
  });

  // 010 – EnsurePersonaOperation returns OK for admin
  it("010 EnsurePersonaOperation returns OK for admin", async () => {
    await setSession(adminSession);
    seedPersona({ id: "p-admin-test", userId: "some-other-hash" });
    const result = await EnsurePersonaOperation("p-admin-test");
    expect(result.status).toBe("OK");
  });

  // 011 – DeletePersona deletes documents then the persona
  it("011 DeletePersona deletes associated documents then the persona", async () => {
    await setSession(defaultSession);
    seedPersona({ id: "p-del" });

    const result = await DeletePersona("p-del");
    expect(result.status).toBe("OK");
    expect(DeletePersonaDocumentsByPersonaId).toHaveBeenCalledWith("p-del");
    expect(historyItems.find((i: any) => i.id === "p-del")).toBeUndefined();
  });

  // 012 – UpsertPersona lets the owner publish/unpublish
  it("012a UpsertPersona fresh publish stamps community + publishedAt", async () => {
    await setSession(defaultSession);
    const p = seedPersona({ id: "p-upsert", isPublished: false });

    const result = await UpsertPersona({ ...p, isPublished: true }, []);
    expect(result.status).toBe("OK");
    if (result.status === "OK") {
      expect(result.response.isPublished).toBe(true);
      expect(result.response.trustLevel).toBe("community");
      expect(result.response.publishedAt).toBeInstanceOf(Date);
    }
  });

  it("012b UpsertPersona owner can unpublish; trustLevel is retained", async () => {
    await setSession(defaultSession);
    const p = seedPersona({
      id: "p-unpub",
      isPublished: true,
      trustLevel: "community",
      publishedAt: new Date("2026-01-01"),
    });

    const result = await UpsertPersona({ ...p, isPublished: false }, []);
    expect(result.status).toBe("OK");
    if (result.status === "OK") {
      expect(result.response.isPublished).toBe(false);
      // Stored classification survives an unpublish/republish cycle.
      expect(result.response.trustLevel).toBe("community");
      expect(result.response.publishedAt).toEqual(new Date("2026-01-01"));
    }
  });

  it("012c UpsertPersona materializes legacy published agents as verified", async () => {
    await setSession(defaultSession);
    // Legacy: published via the old admin-only gate, before trustLevel existed.
    const p = seedPersona({ id: "p-legacy", isPublished: true });

    const result = await UpsertPersona({ ...p, isPublished: true }, []);
    expect(result.status).toBe("OK");
    if (result.status === "OK") {
      expect(result.response.trustLevel).toBe("verified");
    }
  });

  it("012d UpsertPersona keeps a stored verified level on edit", async () => {
    await setSession(defaultSession);
    const p = seedPersona({
      id: "p-verified",
      isPublished: true,
      trustLevel: "verified",
    });

    const result = await UpsertPersona({ ...p, name: "Renamed" }, []);
    expect(result.status).toBe("OK");
    if (result.status === "OK") {
      expect(result.response.trustLevel).toBe("verified");
    }
  });

  it("012e UpsertPersona preserves createdAt and stamps updatedAt", async () => {
    await setSession(defaultSession);
    const created = new Date("2025-03-03T12:00:00Z");
    const p = seedPersona({ id: "p-times", createdAt: created.toISOString() });

    const result = await UpsertPersona({ ...p, createdAt: created }, []);
    expect(result.status).toBe("OK");
    if (result.status === "OK") {
      expect(result.response.createdAt).toEqual(created);
      expect(result.response.updatedAt).toBeInstanceOf(Date);
      expect(result.response.updatedAt!.getTime()).toBeGreaterThan(
        created.getTime()
      );
    }
  });

  // 013 – CreatePersonaChat returns UNAUTHORIZED when user lacks access group
  it("013 CreatePersonaChat returns UNAUTHORIZED when user lacks access group", async () => {
    seedPersona({ id: "p-chat-ag", accessGroup: { id: "g1", source: "SHAREPOINT" } });
    vi.mocked(AccessGroupById).mockResolvedValue({
      status: "ERROR",
      errors: [{ message: "no access" }],
    });
    const result = await CreatePersonaChat("p-chat-ag");
    expect(result.status).toBe("UNAUTHORIZED");
  });

  // 014 – CreatePersonaChat uploads SharePoint CI docs and attaches files
  it("014 CreatePersonaChat uploads CI docs and attaches files", async () => {
    seedPersona({ id: "p-chat-ci", codeInterpreterDocumentIds: ["d1"] });

    vi.mocked(PersonaCIDocumentsByIds).mockResolvedValueOnce({
      status: "OK",
      response: [
        {
          id: "d1",
          fileName: "file.csv",
          userId: USER_HASH,
          source: "SHAREPOINT",
          type: "PERSONA_CI_DOCUMENT",
          externalFile: {
            documentId: "sp-doc-1",
            parentReference: { driveId: "drive-1" },
          },
        },
      ],
    });

    await CreatePersonaChat("p-chat-ci");

    expect(createChatThreadWithServerFiles).toHaveBeenCalled();
    const callArg = vi.mocked(createChatThreadWithServerFiles).mock.calls[0][0] as any;
    expect(callArg.attachedFiles).toBeDefined();
    expect(callArg.attachedFiles!.length).toBe(1);
    expect(callArg.attachedFiles![0].id).toBe("openai-file-1");
    expect(callArg.attachedFiles![0].type).toBe("code-interpreter");
    expect(callArg.attachedFiles![0].uploadedAt).toBeInstanceOf(Date);
    // Recorded as the agent's document: users may not delete it.
    expect(callArg.attachedFiles![0].source).toBe("agent-document");
  });

  // 015 – CreatePersonaChat continues after a single CI doc fails to download
  it("015 CreatePersonaChat continues after a single CI doc fails to download", async () => {
    seedPersona({ id: "p-chat-ci-partial", codeInterpreterDocumentIds: ["d1", "d2"] });

    vi.mocked(PersonaCIDocumentsByIds).mockResolvedValueOnce({
      status: "OK",
      response: [
        {
          id: "d1",
          fileName: "fail.csv",
          userId: USER_HASH,
          source: "SHAREPOINT",
          type: "PERSONA_CI_DOCUMENT",
          externalFile: { documentId: "sp-fail", parentReference: { driveId: "drive-1" } },
        },
        {
          id: "d2",
          fileName: "ok.csv",
          userId: USER_HASH,
          source: "SHAREPOINT",
          type: "PERSONA_CI_DOCUMENT",
          externalFile: { documentId: "sp-ok", parentReference: { driveId: "drive-1" } },
        },
      ],
    });

    vi.mocked(DownloadSharePointFile)
      .mockResolvedValueOnce({ status: "ERROR", errors: [{ message: "download failed" }] })
      .mockResolvedValueOnce({
        status: "OK",
        response: { buffer: Buffer.from("data"), name: "ok.csv", contentType: "text/csv" },
      });

    const result = await CreatePersonaChat("p-chat-ci-partial");
    expect(result.status).toBe("OK");

    const callArg = vi.mocked(createChatThreadWithServerFiles).mock.calls[0][0] as any;
    // Only one file should be attached (the one that downloaded successfully)
    expect(callArg.attachedFiles?.length).toBe(1);
    // The name comes from UploadFileForCodeInterpreter which returns the file.name from the upload
    // The second doc's download succeeds with name "ok.csv"; that becomes the File name passed to UploadFileForCodeInterpreter
    // Our UploadFileForCodeInterpreter mock always returns {name:"file.csv"}, so check id instead
    expect(callArg.attachedFiles![0].id).toBe("openai-file-1");
  });

  // 016 – DeletePersona UNAUTHORIZED when not owner
  it("016 DeletePersona UNAUTHORIZED when not owner/non-admin", async () => {
    await setSession(defaultSession);
    seedPersona({ id: "p-del-unauth", userId: "another-user" });

    const result = await DeletePersona("p-del-unauth");
    expect(result.status).toBe("UNAUTHORIZED");
    // persona should NOT be deleted
    expect(historyItems.find((i: any) => i.id === "p-del-unauth")).toBeDefined();
  });

  // 017 – UpsertPersona ERROR when Cosmos throws
  it("017 UpsertPersona ERROR when Cosmos throws", async () => {
    await setSession(defaultSession);
    const p = seedPersona({ id: "p-upsert-err" });
    historyContainer.items.upsert.mockRejectedValueOnce(new Error("cosmos boom"));

    const result = await UpsertPersona(p, []);
    expect(result.status).toBe("ERROR");
  });

  // 018 – UpsertPersona validation ERROR on empty fields
  it("018 UpsertPersona validation ERROR on empty fields", async () => {
    await setSession(defaultSession);
    const p = seedPersona({ id: "p-upsert-val" });

    const result = await UpsertPersona({ ...p, name: "", description: "" }, []);
    expect(result.status).toBe("ERROR");
    if (result.status === "ERROR") {
      expect(result.errors.length).toBeGreaterThan(0);
    }
  });

  // 019 – FindAllPersonaForCurrentUser returns ERROR on Cosmos throw
  it("019 FindAllPersonaForCurrentUser returns ERROR on Cosmos throw", async () => {
    historyContainer.items.query.mockImplementationOnce(() => ({
      fetchAll: async () => { throw new Error("cosmos error"); },
    }));

    const result = await FindAllPersonaForCurrentUser();
    expect(result.status).toBe("ERROR");
  });

  // 020 – CreatePersonaChat returns ERROR when the thread cannot be created
  it("020 CreatePersonaChat returns ERROR when the thread cannot be created", async () => {
    seedPersona({ id: "p-chat-err" });
    vi.mocked(createChatThreadWithServerFiles).mockRejectedValueOnce(new Error("thread fail"));

    const result = await CreatePersonaChat("p-chat-err");
    expect(result.status).toBe("ERROR");
  });
});
