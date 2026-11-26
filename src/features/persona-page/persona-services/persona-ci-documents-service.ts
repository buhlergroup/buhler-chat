"use server";
import "server-only";

// Server action for Code files of an agent: the read with the access rule.
// Adding and removing a file (also when the agent is deleted) and the
// download at chat start are server code only (persona-ci-documents-store.ts,
// persona-file-rows.ts).

import { ServerActionResponse } from "@/features/common/server-action-response";
import { PERSONA_CI_DOCUMENT_ATTRIBUTE, PersonaCIDocument } from "./models";
import {
  FindAccessiblePersonaDocument,
  PersonaAccessCache,
} from "./persona-document-access";

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
