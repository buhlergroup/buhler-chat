import "server-only";

// Not a "use server" module: nothing here is callable from the client.

import { SqlQuerySpec } from "@azure/cosmos";
import { userHashedId } from "@/features/auth-page/helpers";
import { HistoryContainer } from "@/features/common/services/cosmos";
import { isValidId } from "@/features/common/odata-filter";
import {
  PERSONA_ATTRIBUTE,
  PERSONA_CI_DOCUMENT_ATTRIBUTE,
  PERSONA_DOCUMENT_ATTRIBUTE,
  PersonaModel,
} from "./models";
import { FindPersonaByID } from "./persona-service";

type PersonaDocumentType =
  | typeof PERSONA_DOCUMENT_ATTRIBUTE
  | typeof PERSONA_CI_DOCUMENT_ATTRIBUTE;

// The persona field that lists documents of each type. Fixed in code, never
// taken from input.
const PERSONA_LIST_QUERY: Record<PersonaDocumentType, string> = {
  [PERSONA_DOCUMENT_ATTRIBUTE]:
    "SELECT r.id FROM root r WHERE r.type=@type AND r.userId=@userId AND ARRAY_CONTAINS(r.personaDocumentIds, @documentId)",
  [PERSONA_CI_DOCUMENT_ATTRIBUTE]:
    "SELECT r.id FROM root r WHERE r.type=@type AND r.userId=@userId AND ARRAY_CONTAINS(r.codeInterpreterDocumentIds, @documentId)",
};

const PERSONA_LIST_FIELD: Record<
  PersonaDocumentType,
  "personaDocumentIds" | "codeInterpreterDocumentIds"
> = {
  [PERSONA_DOCUMENT_ATTRIBUTE]: "personaDocumentIds",
  [PERSONA_CI_DOCUMENT_ATTRIBUTE]: "codeInterpreterDocumentIds",
};

// Caches the personas the caller can open (undefined: cannot open) across
// several document lookups of one request.
export type PersonaAccessCache = Map<string, Promise<PersonaModel | undefined>>;

const openPersona = (
  personaId: string,
  cache?: PersonaAccessCache
): Promise<PersonaModel | undefined> => {
  const cached = cache?.get(personaId);
  if (cached) {
    return cached;
  }

  // FindPersonaByID applies the rule for who may open an agent.
  const result = FindPersonaByID(personaId).then((response) =>
    response.status === "OK" ? response.response : undefined
  );

  cache?.set(personaId, result);
  return result;
};

const canOpenPersonaListingDocument = async (
  personaId: string,
  ownerId: string,
  documentId: string,
  type: PersonaDocumentType,
  cache?: PersonaAccessCache
): Promise<boolean> => {
  const persona = await openPersona(personaId, cache);
  if (!persona) {
    return false;
  }
  const listed = persona[PERSONA_LIST_FIELD[type]] ?? [];
  return persona.userId === ownerId && listed.includes(documentId);
};

/**
 * Returns the persona document (or Code Interpreter document) with this id
 * when the current user may use it, otherwise undefined.
 *
 * The user may use a document when it is in the user's own partition, or when
 * it belongs to an agent the user can open. A document belongs to an agent
 * when the agent lists the document id and both are in the same partition
 * (the agent owner's).
 */
export const FindAccessiblePersonaDocument = async <
  T extends { id: string; userId: string },
>(
  id: string,
  type: PersonaDocumentType,
  cache?: PersonaAccessCache
): Promise<T | undefined> => {
  if (!isValidId(id)) {
    return undefined;
  }

  const querySpec: SqlQuerySpec = {
    query: "SELECT * FROM root r WHERE r.type=@type AND r.id=@id",
    parameters: [
      { name: "@type", value: type },
      { name: "@id", value: id },
    ],
  };

  const { resources } = await HistoryContainer()
    .items.query<T>(querySpec)
    .fetchAll();

  const documents = resources.filter(
    (document) => document.id === id && typeof document.userId === "string"
  );
  if (documents.length === 0) {
    return undefined;
  }

  const currentUserId = await userHashedId();
  const own = documents.find((document) => document.userId === currentUserId);
  if (own) {
    return own;
  }

  for (const document of documents) {
    const personaQuery: SqlQuerySpec = {
      query: PERSONA_LIST_QUERY[type],
      parameters: [
        { name: "@type", value: PERSONA_ATTRIBUTE },
        { name: "@userId", value: document.userId },
        { name: "@documentId", value: id },
      ],
    };

    const { resources: personas } = await HistoryContainer()
      .items.query<{ id: string }>(personaQuery, {
        partitionKey: document.userId,
      })
      .fetchAll();

    for (const persona of personas) {
      if (
        await canOpenPersonaListingDocument(
          persona.id,
          document.userId,
          id,
          type,
          cache
        )
      ) {
        return document;
      }
    }
  }

  return undefined;
};
