"use server";
import "server-only";

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
    `personaDocumentId eq '${personaDocumentId}'`
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

export const IndexDocuments = async (
  docs: string[],
  fileName?: string,
  chatThreadId?: string,
  personaDocumentId?: string
): Promise<Array<ServerActionResponse<boolean>>> => {
  const response: ServerActionResponse<boolean>[] = [];

  try {
    logDebug("IndexDocuments starting", {
      docCount: docs.length,
      fileName,
      chatThreadId,
      personaDocumentId,
    });
    
    const documentsToIndex: AzureSearchDocumentIndex[] = [];

    for (const doc of docs.filter((d) => d.trim().length > 0)) {
      const docToAdd: AzureSearchDocumentIndex = {
        id: uniqueId(),
        chatThreadId: chatThreadId || null,
        user: await userHashedId(),
        pageContent: doc,
        metadata: fileName || null,
        embedding: [],
        personaDocumentId: personaDocumentId || null,
      };

      documentsToIndex.push(docToAdd);
    }

    const instance = AzureAISearchInstance();

    for (let start = 0; start < documentsToIndex.length; start += INDEX_BATCH_SIZE) {
      const batch = documentsToIndex.slice(start, start + INDEX_BATCH_SIZE);

      logDebug("Creating embeddings for documents", {
        batchStart: start,
        documentCount: batch.length,
        totalCount: documentsToIndex.length,
      });

      const embeddingsResponse = await EmbedDocuments(batch);

      if (embeddingsResponse.status !== "OK") {
        response.push(embeddingsResponse);
        return response;
      }

      logDebug("Uploading documents to Azure AI Search", {
        batchStart: start,
        documentCount: embeddingsResponse.response.length,
      });

      const uploadResponse = await instance.uploadDocuments(
        embeddingsResponse.response
      );

      logDebug("Upload response received", {
        resultCount: uploadResponse.results.length,
        successCount: uploadResponse.results.filter(r => r.succeeded).length,
      });

      uploadResponse.results.forEach((r) => {
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

      if (uploadResponse.results.some((r) => !r.succeeded)) {
        return response;
      }
    }

    return response;
  } catch (e) {
    logError("IndexDocuments failed", {
      error: e instanceof Error ? e.message : String(e),
      stack: e instanceof Error ? e.stack : undefined,
      errorType: (e as any)?.constructor?.name,
    });
    return [
      ...response,
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

export const DeleteDocumentsOfChatThread = async (
  chatThreadId: string
): Promise<Array<ServerActionResponse<boolean>>> => {
  try {
    // find all documents for chat thread
    const documentsInChatResponse = await SimpleSearch(
      undefined,
      `chatThreadId eq '${chatThreadId} and userid eq '${await userHashedId()}'`
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

export const DeleteSearchDocumentByPersonaDocumentId = async (
  personaDocumentId: string
): Promise<ServerActionResponse<boolean>> => {
  try {
    // Find the document using personaDocumentId
    const documentResponse = await SimpleSearch(
      undefined,
      `personaDocumentId eq '${personaDocumentId}' and user eq '${await userHashedId()}'`
    );

    if (
      documentResponse.status === "OK" &&
      documentResponse.response.length > 0
    ) {
      const documents = documentResponse.response.map((r) => r.document);
      const instance = AzureAISearchInstance();

      const deletedResponse = await instance.deleteDocuments(documents);

      if (deletedResponse.results.every((r) => r.succeeded)) {
        return {
          status: "OK",
          response: true,
        };
      } else {
        return {
          status: "ERROR",
          errors: deletedResponse.results
            .filter((r) => !r.succeeded)
            .map((r) => ({
              message: r.errorMessage || "Unknown error",
            })),
        };
      }
    } else {
      return {
        status: "ERROR",
        errors: [
          {
            message: `No document found with personaDocumentId: ${personaDocumentId}`,
          },
        ],
      };
    }
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
