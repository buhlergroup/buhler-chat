'use client';

import { cn } from '@/features/ui/lib';
import { type ComponentProps, memo } from 'react';
import { Streamdown, type LinkSafetyConfig } from 'streamdown';

type ResponseProps = ComponentProps<typeof Streamdown>;

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
  ({ className, ...props }: ResponseProps) => (
    <Streamdown
      linkSafety={defaultLinkSafety}
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
  ),
  (prevProps, nextProps) => prevProps.children === nextProps.children
);

Response.displayName = 'Response';
