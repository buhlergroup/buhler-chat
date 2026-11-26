import "server-only";

import { BlobServiceClient, ContainerClient, RestError } from "@azure/storage-blob";
import { isSafeBlobPath } from "@/features/common/blob-path";
import { getAzureDefaultCredential } from "../azure-default-credential";
import type { ContentBlobBackend } from "./content-store";

/**
 * Blob container of the content store. AZURE_STORAGE_CONTENT_CONTAINER_NAME
 * (set by the Bicep); the default matches the Bicep default.
 */
export const contentBlobContainer = (): string =>
  process.env.AZURE_STORAGE_CONTENT_CONTAINER_NAME || "content";

const statusOf = (error: unknown): number | undefined =>
  error instanceof RestError
    ? error.statusCode
    : (error as { statusCode?: number })?.statusCode;

const assertSafe = (key: string) => {
  if (!isSafeBlobPath(key)) throw new Error("Invalid content blob name");
};

const lowercaseKeys = (metadata: Record<string, string> | undefined) =>
  Object.fromEntries(
    Object.entries(metadata ?? {}).map(([k, v]) => [k.toLowerCase(), v])
  );

/** The content store on Azure Blob Storage (managed identity). */
export function createAzureContentBlobBackend(): ContentBlobBackend {
  let containerPromise: Promise<ContainerClient> | undefined;

  const container = (): Promise<ContainerClient> => {
    containerPromise ??= (async () => {
      const account = process.env.AZURE_STORAGE_ACCOUNT_NAME;
      if (!account) {
        throw new Error(
          "Azure Storage Account not configured correctly, check environment variables."
        );
      }
      const client = new BlobServiceClient(
        `https://${account}.blob.core.windows.net`,
        getAzureDefaultCredential()
      ).getContainerClient(contentBlobContainer());
      // Private container; created on first use when the deployment has
      // none yet.
      await client.createIfNotExists();
      return client;
    })().catch((error) => {
      containerPromise = undefined;
      throw error;
    });
    return containerPromise;
  };

  const blob = async (key: string) => {
    assertSafe(key);
    return (await container()).getBlockBlobClient(key);
  };

  return {
    async head(key) {
      try {
        const props = await (await blob(key)).getProperties();
        return {
          size: props.contentLength ?? 0,
          lastModified: props.lastModified ?? new Date(0),
          metadata: lowercaseKeys(props.metadata),
          contentType: props.contentType,
        };
      } catch (error) {
        if (statusOf(error) === 404) return undefined;
        throw error;
      }
    },

    async createIfAbsent(key, data, options) {
      try {
        await (await blob(key)).uploadData(data, {
          conditions: { ifNoneMatch: "*" },
          blobHTTPHeaders: options.contentType
            ? { blobContentType: options.contentType }
            : undefined,
          metadata: options.metadata,
        });
        return "created";
      } catch (error) {
        const status = statusOf(error);
        // 409 BlobAlreadyExists; 412 when a writer finished in between.
        if (status === 409 || status === 412) return "exists";
        throw error;
      }
    },

    async read(key) {
      try {
        return await (await blob(key)).downloadToBuffer();
      } catch (error) {
        if (statusOf(error) === 404) return undefined;
        throw error;
      }
    },

    async setMetadata(key, metadata) {
      await (await blob(key)).setMetadata(metadata);
    },

    async delete(key) {
      await (await blob(key)).deleteIfExists();
    },

    async *list(prefix) {
      const client = await container();
      for await (const item of client.listBlobsFlat({ prefix })) {
        yield {
          key: item.name,
          lastModified: item.properties.lastModified ?? new Date(0),
        };
      }
    },
  };
}
