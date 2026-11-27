// The files of a chat workspace (Copilot path) as the browser sees them.
// Types only: shared by the server listing (copilot-runtime/workspace-listing.ts)
// and the client (upload chips, Files panel).

/** One workspace file. */
export interface WorkspaceFileInfo {
  /** Path relative to /workspace, e.g. "uploads/report.pdf". */
  path: string;
  /** Last path segment. */
  name: string;
  /** Bytes, when the workspace records them. */
  size?: number;
  /** Time of the last write (ISO 8601). */
  modified: string;
  /** "uploaded": a file the user uploaded (uploads/, not a text extract); "created": everything else. */
  group: "uploaded" | "created";
}

/** What the chat page gets from the server: the upload chips and the file count. */
export interface WorkspaceSummary {
  uploads: WorkspaceFileInfo[];
  /** Files under /workspace (all groups). */
  fileCount: number;
  /**
   * Pasted text over this many UTF-8 bytes becomes a text file upload, not
   * message text. The server's inline limit (inline-limit.ts), passed here
   * because the browser cannot read the setting.
   */
  pastedTextLimitBytes?: number;
}

/** The Files panel: newest first, bounded. */
export interface WorkspaceListing {
  files: WorkspaceFileInfo[];
  /** Files under /workspace, also those past the bound. */
  total: number;
  /** True when more files exist than `files` holds. */
  truncated: boolean;
}
