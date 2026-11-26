import "server-only";

import { BlobServiceClient, RestError, type ContainerClient } from "@azure/storage-blob";
import { getAzureDefaultCredential } from "@/features/common/services/azure-default-credential";
import { logInfo } from "@/features/common/services/logger";
import type { BlobProps, BlobStore } from "./blob-session-fs";
import type { LeaseBackend } from "./thread-lease";

/** Container for the agent workspaces and Copilot session state. */
export const agentWorkspaceContainerName = (): string =>
  process.env.COPILOT_WORKSPACE_CONTAINER || "agent-workspaces";

const isNotFound = (err: unknown) =>
  err instanceof RestError && (err.statusCode === 404 || err.code === "BlobNotFound");
const isPrecondition = (err: unknown) =>
  err instanceof RestError && (err.statusCode === 412 || err.code === "ConditionNotMet");

const mapError = (err: unknown, name: string): never => {
  if (isNotFound(err)) {
    throw Object.assign(new Error(`ENOENT: ${name}`), { code: "ENOENT" });
  }
  if (isPrecondition(err)) {
    throw Object.assign(new Error(`Precondition failed: ${name}`), { code: "PRECONDITION" });
  }
  throw err;
};

/** BlobStore on one Azure Blob container, with the app's Entra credential. */
export class AzureBlobStore implements BlobStore {
  constructor(private readonly container: ContainerClient) {}

  async getProperties(name: string): Promise<BlobProps | undefined> {
    try {
      const p = await this.container.getBlobClient(name).getProperties();
      return {
        etag: p.etag ?? "",
        metadata: p.metadata ?? {},
        contentLength: p.contentLength ?? 0,
        lastModified: p.lastModified ?? new Date(0),
        createdOn: p.createdOn,
      };
    } catch (err) {
      if (isNotFound(err)) return undefined;
      throw err;
    }
  }

  async download(name: string): Promise<Buffer> {
    try {
      return await this.container.getBlobClient(name).downloadToBuffer();
    } catch (err) {
      return mapError(err, name);
    }
  }

  async createAppendBlob(name: string): Promise<void> {
    await this.container.getAppendBlobClient(name).create();
  }

  async appendBlock(name: string, data: Buffer): Promise<void> {
    if (data.length === 0) return;
    try {
      await this.container.getAppendBlobClient(name).appendBlock(data, data.length);
    } catch (err) {
      mapError(err, name);
    }
  }

  async upload(
    name: string,
    data: Buffer,
    metadata: Record<string, string>,
    conditions?: { ifMatch?: string; ifNoneMatch?: string },
  ): Promise<string> {
    try {
      const res = await this.container.getBlockBlobClient(name).upload(data, data.length, {
        metadata,
        conditions,
      });
      return res.etag ?? "";
    } catch (err) {
      return mapError(err, name);
    }
  }

  async delete(name: string, conditions?: { ifMatch?: string }): Promise<boolean> {
    try {
      await this.container.getBlobClient(name).delete({ conditions });
      return true;
    } catch (err) {
      if (isNotFound(err)) return false;
      return mapError(err, name);
    }
  }

  async listNames(prefix: string): Promise<string[]> {
    const names: string[] = [];
    for await (const blob of this.container.listBlobsFlat({ prefix })) names.push(blob.name);
    return names;
  }

  async listHierarchy(prefix: string): Promise<{ prefixes: string[]; names: string[] }> {
    const prefixes: string[] = [];
    const names: string[] = [];
    for await (const item of this.container.listBlobsByHierarchy("/", { prefix })) {
      if (item.kind === "prefix") prefixes.push(item.name);
      else names.push(item.name);
    }
    return { prefixes, names };
  }
}

/** Blob leases on the same container (one lease blob per thread). */
export class AzureLeaseBackend implements LeaseBackend {
  constructor(private readonly container: ContainerClient) {}

  async ensureBlob(name: string): Promise<void> {
    try {
      await this.container.getBlockBlobClient(name).upload(Buffer.alloc(0), 0, {
        conditions: { ifNoneMatch: "*" },
      });
    } catch (err) {
      // Exists already (possibly leased): that is the normal case.
      if (err instanceof RestError && (err.statusCode === 409 || err.statusCode === 412)) return;
      throw err;
    }
  }

  async acquire(name: string, durationSeconds: number): Promise<string | undefined> {
    try {
      const res = await this.container.getBlobClient(name).getBlobLeaseClient().acquireLease(durationSeconds);
      return res.leaseId;
    } catch (err) {
      if (err instanceof RestError && err.statusCode === 409) return undefined;
      throw err;
    }
  }

  async renew(name: string, leaseId: string): Promise<void> {
    await this.container.getBlobClient(name).getBlobLeaseClient(leaseId).renewLease();
  }

  async release(name: string, leaseId: string, metadata: Record<string, string>): Promise<void> {
    const blob = this.container.getBlobClient(name);
    await blob.setMetadata(metadata, { conditions: { leaseId } });
    await blob.getBlobLeaseClient(leaseId).releaseLease();
  }

  async readMetadata(name: string): Promise<Record<string, string>> {
    return (await this.container.getBlobClient(name).getProperties()).metadata ?? {};
  }
}

let cached: Promise<AzureBlobStore> | undefined;
let leaseBackend: AzureLeaseBackend | undefined;

/** Lease backend on the workspace container (after getAgentWorkspaceStore). */
export async function getAgentWorkspaceLeases(): Promise<AzureLeaseBackend> {
  await getAgentWorkspaceStore();
  if (!leaseBackend) throw new Error("Agent workspace store is not initialised");
  return leaseBackend;
}

/**
 * The workspace store on the app's storage account (AZURE_STORAGE_ACCOUNT_NAME,
 * Entra auth like the rest of the app). The container is created when it is
 * missing; set COPILOT_WORKSPACE_CREATE_CONTAINER=false where the identity may
 * not create containers.
 */
export function getAgentWorkspaceStore(): Promise<AzureBlobStore> {
  cached ??= (async () => {
    const account = process.env.AZURE_STORAGE_ACCOUNT_NAME;
    if (!account) throw new Error("AZURE_STORAGE_ACCOUNT_NAME is not set");
    const service = new BlobServiceClient(
      `https://${account}.blob.core.windows.net`,
      getAzureDefaultCredential(),
    );
    const container = service.getContainerClient(agentWorkspaceContainerName());
    if (process.env.COPILOT_WORKSPACE_CREATE_CONTAINER !== "false") {
      const res = await container.createIfNotExists();
      if (res.succeeded) {
        logInfo("copilot-runtime: created agent workspace container", {
          container: container.containerName,
        });
      }
    }
    leaseBackend = new AzureLeaseBackend(container);
    return new AzureBlobStore(container);
  })().catch((err) => {
    cached = undefined;
    throw err;
  });
  return cached;
}
