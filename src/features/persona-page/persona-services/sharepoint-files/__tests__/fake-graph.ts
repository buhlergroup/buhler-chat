/**
 * A small in-memory Microsoft Graph for the SharePoint files tests: drives
 * with folders and files, item metadata, /children (with paging) and
 * /content. Any other host or path answers 404 and is recorded, so tests can
 * assert which calls were made.
 */

const GRAPH = "https://graph.microsoft.com/v1.0";

export interface FakeItem {
  id: string;
  name: string;
  /** Parent folder id; undefined for the drive root. */
  parent?: string;
  folder?: boolean;
  content?: Buffer;
  /** Reported size (default: content length). */
  size?: number;
  /** Answer every call about this item with this status. */
  status?: number;
  /** Answer only /content with this status. */
  contentStatus?: number;
  /** parentReference.driveId to report instead of the real drive. */
  reportedDriveId?: string;
  /** Stream /content in chunks of this size, without content-length. */
  chunkSize?: number;
}

export class FakeGraph {
  readonly drives = new Map<string, Map<string, FakeItem>>();
  readonly calls: string[] = [];
  /** Chunks handed out by streamed /content answers. */
  pulledChunks = 0;
  pageSize = 200;

  add(driveId: string, item: FakeItem): this {
    if (!this.drives.has(driveId)) this.drives.set(driveId, new Map());
    this.drives.get(driveId)!.set(item.id, item);
    return this;
  }

  private meta(driveId: string, item: FakeItem) {
    return {
      id: item.id,
      name: item.name,
      webUrl: `https://contoso.sharepoint.com/sites/demo/${encodeURIComponent(item.name)}`,
      size: item.size ?? item.content?.length ?? 0,
      lastModifiedDateTime: "2026-11-01T10:00:00Z",
      ...(item.folder ? { folder: { childCount: 0 } } : { file: { mimeType: "application/octet-stream" } }),
      parentReference: { driveId: item.reportedDriveId ?? driveId, ...(item.parent ? { id: item.parent } : {}) },
    };
  }

  readonly fetch = async (input: string | URL | Request): Promise<Response> => {
    const url = String(input instanceof Request ? input.url : input);
    this.calls.push(url);
    if (!url.startsWith(`${GRAPH}/`)) return new Response("{}", { status: 404 });
    const u = new URL(url);
    const m = u.pathname.match(/^\/v1\.0\/drives\/([^/]+)\/items\/([^/]+)(\/children|\/content)?$/);
    if (!m) return new Response("{}", { status: 404 });
    const [, driveId, itemId, suffix] = m;
    const item = this.drives.get(driveId)?.get(itemId);
    if (!item) return new Response("{}", { status: 404 });
    if (item.status) return new Response("{}", { status: item.status });

    if (suffix === "/children") {
      const children = [...this.drives.get(driveId)!.values()].filter((i) => i.parent === itemId);
      const skip = Number(u.searchParams.get("$skiptoken") ?? "0");
      const page = children.slice(skip, skip + this.pageSize);
      const next = skip + this.pageSize < children.length
        ? `${GRAPH}/drives/${driveId}/items/${itemId}/children?$skiptoken=${skip + this.pageSize}`
        : undefined;
      return Response.json({
        value: page.map((c) => this.meta(driveId, c)),
        ...(next ? { "@odata.nextLink": next } : {}),
      });
    }
    if (suffix === "/content") {
      if (item.contentStatus) return new Response("{}", { status: item.contentStatus });
      const content = item.content ?? Buffer.alloc(0);
      if (item.chunkSize) {
        let offset = 0;
        const size = item.chunkSize;
        const stream = new ReadableStream<Uint8Array>({
          pull: (controller) => {
            if (offset >= content.length) {
              controller.close();
              return;
            }
            this.pulledChunks++;
            controller.enqueue(new Uint8Array(content.subarray(offset, offset + size)));
            offset += size;
          },
        });
        return new Response(stream, { status: 200 });
      }
      return new Response(new Uint8Array(content), {
        status: 200,
        headers: { "content-length": String(content.length) },
      });
    }
    return Response.json(this.meta(driveId, item));
  };

  /** Number of recorded calls whose URL contains `part`. */
  count(part: string): number {
    return this.calls.filter((c) => c.includes(part)).length;
  }
}
