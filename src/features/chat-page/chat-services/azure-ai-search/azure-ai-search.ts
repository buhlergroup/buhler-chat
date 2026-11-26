import "server-only";

// Server code only. Not a "use server" module: the functions here take raw
// filters and ids, so none of them may be a Server Action. The client indexes
// chat documents through UploadChatDocument in chat-document-service.

import { userHashedId } from "@/features/auth-page/helpers";
import { ServerActionResponse } from "@/features/common/server-action-response";
import {
  AzureAISearchIndexClientInstance,
  AzureAISearchInstance,
} from "@/features/common/services/ai-search";
import { OpenAIEmbeddingInstance } from "@/features/common/services/openai";
import { uniqueId } from "@/features/common/util";
import { AzureKeyCredential, SearchClient, SearchIndex } from "@azure/search-documents";
import { logDebug, logError } from "@/features/common/services/logger";
import { odataEq, odataSearchIn } from "@/features/common/odata-filter";
import { documentTooLongMessage, maxDocumentChunks } from "../chat-document-chunks";

export interface AzureSearchDocumentIndex {
  id: string;
  pageContent: string;
  embedding?: number[];
  user: string;
  chatThreadId: string | null;
  metadata: string | null;
  personaDocumentId: string | null;
}

// Embeddings accept max 2048 inputs per call and Azure AI Search max 16 MB per
// upload. One chunk with a 3072-dim vector is ~63 KB, so 100 stays well below both.
const INDEX_BATCH_SIZE = 100;
// Most actions in one index batch request.
const DELETE_BATCH_SIZE = 1000;
// Most chunks FindChatDocumentChunkIds reads from one thread.
const MAX_THREAD_CHUNKS = 100_000;

export type DocumentSearchResponse = {
  score: number;
  document: AzureSearchDocumentIndex;
};

// SimpleSearch is an internal search primitive. It is intentionally NOT
// exported, so it is never registered as a callable Next.js Server Action and
// cannot be invoked by an unauthenticated request. Every in-file caller supplies
// a trusted, scoped filter.
const SimpleSearch = async (
  searchText?: string,
  filter?: string
): Promise<ServerActionResponse<Array<DocumentSearchResponse>>> => {
  try {
    const instance = AzureAISearchInstance<AzureSearchDocumentIndex>();
    const searchResults = await instance.search(searchText, { filter: filter });

    const results: Array<DocumentSearchResponse> = [];
    for await (const result of searchResults.results) {
      results.push({
        score: result.score,
        document: result.document,
      });
    }

    return {
      status: "OK",
      response: results,
    };
  } catch (e) {
    return {
      status: "ERROR",
      errors: [
        {
          message: `${e}`,
        },
      ],
    };
  }
};

export const SimilaritySearch = async (
  searchText: string,
  k: number,
  filter?: string,
  skip: number = 0,
  shouldCreateEmbedding: boolean = true
): Promise<ServerActionResponse<Array<DocumentSearchResponse>>> => {
  try {
    let embeddings;
    
    if (shouldCreateEmbedding) {
      const openai = OpenAIEmbeddingInstance();
      embeddings = await openai.embeddings.create({
        input: searchText,
        model: "",
      });
    }

    const searchClient = AzureAISearchInstance<AzureSearchDocumentIndex>();

    const searchOptions: any = {
      top: k,
      filter: filter,
      skip: skip,
    };

    // Only add vector search if embeddings were created
    if (shouldCreateEmbedding && embeddings) {
      searchOptions.vectorSearchOptions = {
        queries: [
          {
            vector: embeddings.data[0].embedding,
            fields: ["embedding"],
            kind: "vector",
            kNearestNeighborsCount: k
          },
        ],
      };
    }

    const searchResults = await searchClient.search(searchText, searchOptions);

    const results: Array<DocumentSearchResponse> = [];
    for await (const result of searchResults.results) {
      results.push({
        score: result.score,
        document: result.document,
      });
    }

    return {
      status: "OK",
      response: results,
    };
  } catch (e) {
    return {
      status: "ERROR",
      errors: [
        {
          message: `${e}`,
        },
      ],
    };
  }
};

export const PersonaDocumentExistsInIndex = async (
  personaDocumentId: string
): Promise<ServerActionResponse<AzureSearchDocumentIndex>> => {
  const result = await SimpleSearch(
    personaDocumentId,
    odataEq("personaDocumentId", personaDocumentId)
  );

  if (result.status === "OK") {
    const documents = result.response;
    if (documents.length > 0) {
      return {
        status: "OK",
        response: documents[0].document,
      };
    } else {
      return {
        status: "NOT_FOUND",
        errors: [
          {
            message: `No document found with id ${personaDocumentId}`,
          },
        ],
      };
    }
  }

  return {
    status: "ERROR",
    errors: [
      {
        message: `Unexpected error occurred while checking persona document index.`,
      },
    ],
  };
};

// Azure AI Search resource naming rules. A valid name begins and ends with a
// letter or digit, uses only lowercase letters, digits and single dashes, and
// contains no consecutive dashes. Enforcing this keeps the constructed request
// host as exactly `<name>.search.windows.net`. A "/" or "?" in the value can no
// longer relocate the request to an attacker host, and cannot move the fixed
// suffix into the URL path or query.
const SEARCH_SERVICE_NAME_PATTERN = /^(?!-)(?!.*--)[a-z0-9-]{2,60}(?<!-)$/;
const SEARCH_INDEX_NAME_PATTERN = /^(?!-)(?!.*--)[a-z0-9-]{2,128}(?<!-)$/;

const isValidSearchServiceName = (value: unknown): value is string =>
  typeof value === "string" && SEARCH_SERVICE_NAME_PATTERN.test(value);

const isValidSearchIndexName = (value: unknown): value is string =>
  typeof value === "string" && SEARCH_INDEX_NAME_PATTERN.test(value);

const searchConfigError = (
  message: string
): ServerActionResponse<Array<DocumentSearchResponse>> => ({
  status: "ERROR",
  errors: [{ message }],
});

export const ExtensionSimilaritySearch = async (props: {
  searchText: string;
  vectors: string[];
  apiKey?: string;
  searchName: string;
  indexName: string;
  shouldCreateEmbedding?: boolean;
}): Promise<ServerActionResponse<Array<DocumentSearchResponse>>> => {
  try {
    const { searchText, vectors, apiKey, searchName, indexName, shouldCreateEmbedding = true } = props;

    // Security controls for this endpoint:
    //   1. Reject any searchName or indexName that is not a strict Azure name,
    //      so the request host and path cannot be attacker-controlled.
    //   2. Require an apiKey. The application managed identity is never used
    //      here, so this endpoint cannot leak the application identity token.
    if (!isValidSearchServiceName(searchName)) {
      return searchConfigError("Invalid searchName for Azure AI Search.");
    }
    if (!isValidSearchIndexName(indexName)) {
      return searchConfigError("Invalid indexName for Azure AI Search.");
    }
    if (!apiKey) {
      return searchConfigError(
        "An apiKey is required. This endpoint does not use the application identity."
      );
    }

    let embeddings;
    if (shouldCreateEmbedding) {
      const openai = OpenAIEmbeddingInstance();
      embeddings = await openai.embeddings.create({
        input: searchText,
        model: "",
      });
    }

    // searchName is validated above, so this host is exactly
    // `<searchName>.search.windows.net` and cannot be relocated.
    const endpoint = `https://${searchName}.search.windows.net`;
    const credential = new AzureKeyCredential(apiKey);
    const searchClient = new SearchClient(endpoint, indexName, credential);

    const searchOptions: any = {
      top: 3,
    };

    // Only add vector search if embeddings were created
    if (shouldCreateEmbedding && embeddings) {
      searchOptions.vectorSearchOptions = {
        queries: [
          {
            vector: embeddings.data[0].embedding,
            fields: vectors,
            kind: "vector",
            kNearestNeighborsCount: 10,
          },
        ],
      };
    }

    const searchResults = await searchClient.search(searchText, searchOptions);

    const results: Array<any> = [];
    for await (const result of searchResults.results) {
      const item = {
        score: result.score,
        document: result.document,
      };

      // exclude the all the fields that are not in the fields array
      const document = item.document as any;
      const newDocument: any = {};

      // iterate over the object entries in document
      // and only include the fields that are in the fields array

      for (const key in document) {
        const hasKey = vectors.includes(key);
        if (!hasKey) {
          newDocument[key] = document[key];
        }
      }

      results.push({
        score: result.score,
        document: newDocument, // Use the newDocument object instead of the original document
      });
    }

    return {
      status: "OK",
      response: results,
    };
  } catch (e) {
    return {
      status: "ERROR",
      errors: [
        {
          message: `${e}`,
        },
      ],
    };
  }
};

/**
 * Indexes text chunks. `user` of each chunk is the current user, or
 * `ownerUserId` when given: the chunks of an agent's Search file carry the
 * agent owner's id, like the file's row (DeleteSearchDocumentByPersonaDocumentId
 * finds them by it).
 */
export const IndexDocuments = async (
  docs: string[],
  fileName?: string,
  chatThreadId?: string,
  personaDocumentId?: string,
  ownerUserId?: string
): Promise<Array<ServerActionResponse<boolean>>> => {
  const texts = docs.filter((d) => d.trim().length > 0);

  // Refused before the first embedding call: nothing is spent, nothing written.
  const maxChunks = maxDocumentChunks();
  if (texts.length > maxChunks) {
    return [
      { status: "ERROR", errors: [{ message: documentTooLongMessage(texts.length, maxChunks) }] },
    ];
  }

  const response: ServerActionResponse<boolean>[] = [];
  // Ids of the chunks this call has written. When a later batch fails, they
  // are deleted again: the index never keeps half a document.
  const written: string[] = [];
  // Ids of the batch whose upload is running; written or not when it throws.
  let uploading: string[] = [];

  const rollBack = async (
    failure: ServerActionResponse<boolean>[]
  ): Promise<ServerActionResponse<boolean>[]> => {
    const ids = [...written, ...uploading];
    if (ids.length === 0) return failure;
    try {
      await DeleteChunksByIds(ids);
      return failure;
    } catch (e) {
      logError("IndexDocuments: chunks of the failed upload could not be deleted", {
        chunkCount: ids.length,
        error: e instanceof Error ? e.message : String(e),
      });
      return [
        ...failure,
        {
          status: "ERROR",
          errors: [
            { message: `${ids.length} chunks written before the error could not be deleted: ${e}` },
          ],
        },
      ];
    }
  };

  try {
    const user = ownerUserId ?? (await userHashedId());
    logDebug("IndexDocuments starting", {
      docCount: texts.length,
      fileName,
      chatThreadId,
      personaDocumentId,
    });

    const instance = AzureAISearchInstance();

    for (let start = 0; start < texts.length; start += INDEX_BATCH_SIZE) {
      // Only the documents of this batch exist. Their embeddings are dropped
      // after the upload, so memory does not grow with the document length.
      const batch: AzureSearchDocumentIndex[] = texts
        .slice(start, start + INDEX_BATCH_SIZE)
        .map((text) => ({
          id: uniqueId(),
          chatThreadId: chatThreadId || null,
          user,
          pageContent: text,
          metadata: fileName || null,
          embedding: [],
          personaDocumentId: personaDocumentId || null,
        }));

      logDebug("Creating embeddings for documents", {
        batchStart: start,
        documentCount: batch.length,
        totalCount: texts.length,
      });

      const embeddingsResponse = await EmbedDocuments(batch);

      if (embeddingsResponse.status !== "OK") {
        return await rollBack([embeddingsResponse]);
      }

      logDebug("Uploading documents to Azure AI Search", {
        batchStart: start,
        documentCount: batch.length,
      });

      uploading = batch.map((d) => d.id);
      const uploadResponse = await instance.uploadDocuments(batch);
      uploading = [];
      for (const doc of batch) doc.embedding = undefined;

      logDebug("Upload response received", {
        resultCount: uploadResponse.results.length,
        successCount: uploadResponse.results.filter(r => r.succeeded).length,
      });

      const failed: ServerActionResponse<boolean>[] = [];
      uploadResponse.results.forEach((r, i) => {
        if (r.succeeded) {
          written.push(r.key ?? batch[i].id);
          response.push({
            status: "OK",
            response: r.succeeded,
          });
        } else {
          failed.push({
            status: "ERROR",
            errors: [
              {
                message: `${r.errorMessage}`,
              },
            ],
          });
        }
      });

      if (failed.length > 0) {
        return await rollBack(failed);
      }
    }

    return response;
  } catch (e) {
    logError("IndexDocuments failed", {
      error: e instanceof Error ? e.message : String(e),
      stack: e instanceof Error ? e.stack : undefined,
      errorType: (e as any)?.constructor?.name,
    });
    return await rollBack([
      {
        status: "ERROR",
        errors: [
          {
            message: `${e}`,
          },
        ],
      },
    ]);
  }
};

export const DeleteDocumentsOfChatThread = async (
  chatThreadId: string
): Promise<Array<ServerActionResponse<boolean>>> => {
  try {
    // find all documents for chat thread
    const documentsInChatResponse = await SimpleSearch(
      undefined,
      `${odataEq("chatThreadId", chatThreadId)} and ${odataEq("user", await userHashedId())}`
    );

    if (documentsInChatResponse.status === "OK") {
      const instance = AzureAISearchInstance();
      const deletedResponse = await instance.deleteDocuments(
        documentsInChatResponse.response.map((r) => r.document)
      );
      const response: Array<ServerActionResponse<boolean>> = [];
      deletedResponse.results.forEach((r) => {
        if (r.succeeded) {
          response.push({
            status: "OK",
            response: r.succeeded,
          });
        } else {
          response.push({
            status: "ERROR",
            errors: [
              {
                message: `${r.errorMessage}`,
              },
            ],
          });
        }
      });

      return response;
    }

    return [documentsInChatResponse];
  } catch (e) {
    return [
      {
        status: "ERROR",
        errors: [
          {
            message: `${e}`,
          },
        ],
      },
    ];
  }
};

/**
 * Ids of the chunks of the chat document `fileName` in a thread of `userId`.
 * `metadata` (the file name) is not filterable in the index: the thread and
 * user filter selects, the name is compared here.
 */
export const FindChatDocumentChunkIds = async (
  chatThreadId: string,
  userId: string,
  fileName: string
): Promise<string[]> => {
  const instance = AzureAISearchInstance<AzureSearchDocumentIndex>();
  const filter = `${odataEq("chatThreadId", chatThreadId)} and ${odataEq("user", userId)}`;
  const ids: string[] = [];
  // Above 1000 results the service answers in pages of 1000, which the
  // client follows: a document of more than 1000 chunks is found whole.
  const found = await instance.search("*", {
    filter,
    select: ["id", "metadata"],
    top: MAX_THREAD_CHUNKS,
  });
  for await (const result of found.results) {
    if (result.document.metadata === fileName) ids.push(result.document.id);
  }
  return ids;
};

/**
 * Deletes index chunks by id, at most 1000 per request (the limit of one
 * index batch).
 */
export const DeleteChunksByIds = async (ids: string[]): Promise<void> => {
  if (ids.length === 0) return;
  const instance = AzureAISearchInstance<AzureSearchDocumentIndex>();
  const errors: string[] = [];
  for (let start = 0; start < ids.length; start += DELETE_BATCH_SIZE) {
    const deleted = await instance.deleteDocuments("id", ids.slice(start, start + DELETE_BATCH_SIZE));
    for (const r of deleted.results) {
      if (!r.succeeded) errors.push(r.errorMessage || "Unknown error");
    }
  }
  if (errors.length > 0) {
    throw new Error(errors.join("; "));
  }
};

// Largest page of one search request (Azure AI Search allows up to 1000),
// and the most rounds of one delete (100 000 chunks).
const DELETE_PAGE_SIZE = 1000;
const MAX_DELETE_ROUNDS = 100;

/**
 * Deletes every index chunk of a persona document whose `user` is
 * `ownerUserId` (default: the current user). Round by round: read one page
 * of chunk ids, delete them, and read the next page with the ids deleted so
 * far excluded. That needs no sort order (the key field need not be
 * sortable) and no `skip` over a result that changes, and a chunk the index
 * still shows for a moment after its delete is not read twice. No chunk left
 * is OK: nothing was to delete.
 */
export const DeleteSearchDocumentByPersonaDocumentId = async (
  personaDocumentId: string,
  ownerUserId?: string
): Promise<ServerActionResponse<boolean>> => {
  try {
    const base = `${odataEq("personaDocumentId", personaDocumentId)} and ${odataEq(
      "user",
      ownerUserId ?? (await userHashedId())
    )}`;
    const instance = AzureAISearchInstance<AzureSearchDocumentIndex>();
    const deleted = new Set<string>();
    const failed: { message: string }[] = [];

    for (let round = 0; round < MAX_DELETE_ROUNDS; round++) {
      const exclude = odataSearchIn("id", [...deleted]);
      const page = await instance.search(undefined, {
        filter: exclude ? `${base} and not ${exclude}` : base,
        top: DELETE_PAGE_SIZE,
        select: ["id"],
      });
      const ids: string[] = [];
      for await (const result of page.results) {
        const id = result.document.id;
        if (!deleted.has(id)) ids.push(id);
      }
      if (ids.length === 0) break;
      for (const id of ids) deleted.add(id);

      const deletedResponse = await instance.deleteDocuments("id", ids);
      for (const r of deletedResponse.results) {
        if (!r.succeeded) failed.push({ message: r.errorMessage || "Unknown error" });
      }
      if (ids.length < DELETE_PAGE_SIZE) break;
    }

    return failed.length === 0
      ? { status: "OK", response: true }
      : { status: "ERROR", errors: failed };
  } catch (e) {
    return {
      status: "ERROR",
      errors: [
        {
          message: `${e}`,
        },
      ],
    };
  }
};

export const EmbedDocuments = async (
  documents: Array<AzureSearchDocumentIndex>
): Promise<ServerActionResponse<Array<AzureSearchDocumentIndex>>> => {
  try {
    logDebug("EmbedDocuments starting", {
      documentCount: documents.length,
      model: process.env.AZURE_OPENAI_API_EMBEDDINGS_DEPLOYMENT_NAME,
    });
    
    const openai = OpenAIEmbeddingInstance();

    const contentsToEmbed = documents.map((d) => d.pageContent);

    logDebug("Calling OpenAI embeddings API");
    
    const embeddings = await openai.embeddings.create({
      input: contentsToEmbed,
      model: process.env.AZURE_OPENAI_API_EMBEDDINGS_DEPLOYMENT_NAME,
    });
    
    logDebug("OpenAI embeddings created", {
      embeddingCount: embeddings.data.length,
    });

    embeddings.data.forEach((embedding, index) => {
      documents[index].embedding = embedding.embedding;
    });

    return {
      status: "OK",
      response: documents,
    };
  } catch (e) {
    logError("EmbedDocuments failed", {
      error: e instanceof Error ? e.message : String(e),
      stack: e instanceof Error ? e.stack : undefined,
      errorType: (e as any)?.constructor?.name,
    });
    return {
      status: "ERROR",
      errors: [
        {
          message: `${e}`,
        },
      ],
    };
  }
};

export const EnsureIndexIsCreated = async (): Promise<
  ServerActionResponse<SearchIndex>
> => {
  try {
    const client = AzureAISearchIndexClientInstance();
    const result = await client.getIndex(process.env.AZURE_SEARCH_INDEX_NAME);
    return {
      status: "OK",
      response: result,
    };
  } catch (e) {
    return await CreateSearchIndex();
  }
};

const CreateSearchIndex = async (): Promise<
  ServerActionResponse<SearchIndex>
> => {
  try {
    const client = AzureAISearchIndexClientInstance();
    const result = await client.createIndex({
      name: process.env.AZURE_SEARCH_INDEX_NAME,
      vectorSearch: {
        algorithms: [
          {
            name: "hnsw-vector",
            kind: "hnsw",
            parameters: {
              m: 4,
              efConstruction: 200,
              efSearch: 200,
              metric: "cosine",
            },
          },
        ],
        profiles: [
          {
            name: "hnsw-vector",
            algorithmConfigurationName: "hnsw-vector",
          },
        ],
      },

      fields: [
        {
          name: "id",
          type: "Edm.String",
          key: true,
          filterable: true,
        },
        {
          name: "user",
          type: "Edm.String",
          searchable: true,
          filterable: true,
        },
        {
          name: "chatThreadId",
          type: "Edm.String",
          searchable: true,
          filterable: true,
        },
        {
          name: "personaDocumentId",
          type: "Edm.String",
          searchable: true,
          filterable: true,
        },
        {
          name: "pageContent",
          searchable: true,
          type: "Edm.String",
        },
        {
          name: "metadata",
          type: "Edm.String",
        },
        {
          name: "embedding",
          type: "Collection(Edm.Single)",
          searchable: true,
          filterable: false,
          sortable: false,
          facetable: false,
          vectorSearchDimensions: 1536,
          vectorSearchProfileName: "hnsw-vector",
        },
      ],
    });

    return {
      status: "OK",
      response: result,
    };
  } catch (e) {
    return {
      status: "ERROR",
      errors: [
        {
          message: `${e}`,
        },
      ],
    };
  }
};
