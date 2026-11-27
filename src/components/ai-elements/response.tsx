'use client';

import { cn } from '@/features/ui/lib';
import { type ComponentProps, memo, useMemo } from 'react';
import { Streamdown, defaultRemarkPlugins, type LinkSafetyConfig, type StreamdownProps } from 'streamdown';
import { remarkWorkspaceLinks } from './remark-workspace-links';

type ResponseProps = ComponentProps<typeof Streamdown> & {
  /**
   * The thread on screen, when it has a chat workspace (Copilot path): links
   * and images to workspace files become its download URLs. Absent: links
   * are left to the sanitizer as they are.
   */
  workspaceThreadId?: string | undefined;
};

type RemarkPlugins = NonNullable<StreamdownProps['remarkPlugins']>;

/** Streamdown's own remark plugins plus the workspace link rewrite. */
function workspaceRemarkPlugins(threadId: string): RemarkPlugins {
  return [...Object.values(defaultRemarkPlugins), [remarkWorkspaceLinks, { threadId }]];
}

/**
 * Whether a link target stays on the current origin. Relative URLs resolve
 * against the page origin; protocol-relative and absolute URLs are compared by
 * their parsed origin. Anything unparsable is treated as external.
 */
export function isSameOriginUrl(url: string): boolean {
  if (typeof window === 'undefined') return false;
  try {
    return new URL(url, window.location.origin).origin === window.location.origin;
  } catch {
    return false;
  }
}

// Same-origin links (for example file downloads served by this app) open
// directly. Every other link keeps the Streamdown confirmation dialog.
const defaultLinkSafety: LinkSafetyConfig = {
  enabled: true,
  onLinkCheck: isSameOriginUrl,
};

export const Response = memo(
  ({ className, workspaceThreadId, ...props }: ResponseProps) => {
    const remarkPlugins = useMemo(
      () => (workspaceThreadId ? workspaceRemarkPlugins(workspaceThreadId) : undefined),
      [workspaceThreadId]
    );
    return (
      <Streamdown
        linkSafety={defaultLinkSafety}
        {...(remarkPlugins ? { remarkPlugins } : {})}
        className={cn(
          'size-full [&>*:first-child]:mt-0 [&>*:last-child]:mb-0',
          // Add list + typography styling (avoid max-width clamp)
          'prose prose-neutral dark:prose-invert max-w-none',
          // Ensure ul/ol bullets & spacing even if global reset removed them
          '[&_ul]:list-disc [&_ul]:pl-6 [&_ol]:list-decimal [&_ol]:pl-6',
          // Tighten paragraph spacing inside list items
          '[&_li>p]:m-0',
          className
        )}
        {...props}
      />
    );
  },
  (prevProps, nextProps) =>
    prevProps.children === nextProps.children &&
    prevProps.workspaceThreadId === nextProps.workspaceThreadId
);

Response.displayName = 'Response';
