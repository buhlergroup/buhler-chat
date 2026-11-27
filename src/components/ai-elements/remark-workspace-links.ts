import { workspaceLinkTarget } from '@/features/chat-page/chat-services/copilot-runtime/workspace-file-url';

/** The part of an mdast node this plugin reads. */
interface MarkdownNode {
  type: string;
  url?: unknown;
  children?: MarkdownNode[];
}

function rewrite(node: MarkdownNode, threadId: string): void {
  // No 'definition': Streamdown renders each block alone, so reference links never resolve.
  if ((node.type === 'link' || node.type === 'image') && typeof node.url === 'string') {
    const target = workspaceLinkTarget(threadId, node.url);
    // null: a refused workspace path. An empty URL is always blocked by the sanitizer.
    if (target !== undefined) node.url = target ?? '';
  }
  node.children?.forEach((child) => rewrite(child, threadId));
}

/**
 * remark plugin (Copilot path): links and images that point into the chat
 * workspace (`/workspace/a.csv`, `sandbox:/workspace/a.csv`, ...) become the
 * download URL of that file in the thread on screen. See workspaceLinkTarget.
 * Runs on the markdown tree, so a path in inline code or a code block stays
 * text.
 */
export function remarkWorkspaceLinks(options: { threadId: string }) {
  return (tree: MarkdownNode) => rewrite(tree, options.threadId);
}
