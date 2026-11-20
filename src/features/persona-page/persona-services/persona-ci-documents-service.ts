"use server";
import "server-only";

// Server actions for Code files of an agent. Only reads and the delete of a
// whole agent's rows are here; adding and removing one file, and the
// download at chat start, are server code only (persona-ci-documents-store.ts).

import { ServerActionResponse } from "@/features/common/server-action-response";
import { userHashedId } from "@/features/auth-page/helpers";
import { PERSONA_CI_DOCUMENT_ATTRIBUTE, PersonaCIDocument } from "./models";
import {
  FindAccessiblePersonaDocument,
  PersonaAccessCache,
} from "./persona-document-access";
import { checkPersonaEdit } from "./persona-access";
import { deleteCodeDocument } from "./persona-ci-documents-store";

const FindCIDocumentForCurrentUser = async (
  id: string,
  cache?: PersonaAccessCache
): Promise<ServerActionResponse<PersonaCIDocument>> => {
  try {
    const document = await FindAccessiblePersonaDocument<PersonaCIDocument>(
      id,
      PERSONA_CI_DOCUMENT_ATTRIBUTE,
      cache
    );

    if (!document) {
      return {
        status: "NOT_FOUND",
        errors: [{ message: "CI Document not found" }],
      };
    }

    return {
      status: "OK",
      response: document,
    };
  } catch (error) {
    return {
      status: "ERROR",
      errors: [{ message: `Error fetching CI document: ${error}` }],
    };
  }
};

/**
 * Get all Code Interpreter persona documents by IDs
 */
export const PersonaCIDocumentsByIds = async (
  ids: string[]
): Promise<ServerActionResponse<PersonaCIDocument[]>> => {
  if (!ids || ids.length === 0) {
    return { status: "OK", response: [] };
  }

  try {
    const cache: PersonaAccessCache = new Map();
    const results = await Promise.all(
      ids.map((id) => FindCIDocumentForCurrentUser(id, cache))
    );

    const documents = results
      .filter((r) => r.status === "OK")
      .map((r) => (r as { status: "OK"; response: PersonaCIDocument }).response);

    return { status: "OK", response: documents };
  } catch (error) {
    return {
      status: "ERROR",
      errors: [{ message: `Error fetching CI documents: ${error}` }],
    };
  }
};

/**
 * Delete Code Interpreter persona documents of a persona. Needs edit rights
 * on the persona (owner or admin, the rule of EnsurePersonaOperation), and
 * only ids that the persona references are deleted.
 */
export const DeletePersonaCIDocumentsByPersonaId = async (
  personaId: string,
  ciDocumentIds: string[]
): Promise<ServerActionResponse<boolean>> => {
  try {
    const persona = await checkPersonaEdit(personaId);
    if (persona.status !== "OK") {
      return persona;
    }
    const ownIds = new Set(persona.response.codeInterpreterDocumentIds || []);
    // In the caller's own partition, as before: a row of another user is
    // not found there.
    const userId = await userHashedId();
    await Promise.all(
      ciDocumentIds
        .filter((id) => ownIds.has(id))
        .map((id) => deleteCodeDocument({ id, userId }))
    );
    return { status: "OK", response: true };
  } catch (error) {
    return {
      status: "ERROR",
      errors: [{ message: `Error deleting CI documents: ${error}` }],
    };
  }
};
