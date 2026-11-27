"use client";
import React from 'react';
import { Response } from './response';
import { CodeBlock, CodeBlockCopyButton } from './code-block';
import { GenUI } from './genui';
import { resolveBlobReferenceToPath } from '@/features/chat-page/chat-services/chat-image-persistence-utils';

export interface RichResponseProps {
  content: string;
  /**
   * True while this message's turn is still streaming. We do NOT mount the
   * generative-UI card (json-render + recharts) mid-stream: a tall card growing
   * inside the auto-scroll Conversation thrashes the stick-to-bottom resize
   * loop ("Maximum update depth"). While streaming we show the raw spec block
   * and only swap to the rendered card once the turn completes.
   */
  streaming?: boolean;
  /**
   * The thread on screen, when it has a chat workspace (Copilot path): links
   * to workspace files become download links (see Response).
   */
  workspaceThreadId?: string | undefined;
}

/**
 * Replaces every `blob://threadId/filename` token in markdown text with
 * the same-origin `/api/images?…` URL the image service resolves it to.
 * The server-side path keeps `blob://` everywhere (so the model can't
 * see a URL it might echo back as a duplicate markdown image link) — the
 * only translation lives here, in the client renderer, right before the
 * text reaches Streamdown. Without this pass, `![alt](blob://...)`
 * markdown coming back from the model renders as `[blocked]` because
 * Streamdown's link sanitizer rejects the `blob:` scheme.
 *
 * Code-fenced blocks are split out by `parse()` before this runs, so
 * literal `blob://` inside ```code``` is left untouched.
 */
const BLOB_REF_PATTERN = /blob:\/\/[A-Za-z0-9_-]+\/[^\s)"'>]+/g;
function resolveBlobRefsInMarkdown(text: string): string {
  return text.replace(BLOB_REF_PATTERN, (m) => resolveBlobReferenceToPath(m) ?? m);
}

type Segment = { type: 'code'; language: string; code: string } | { type: 'text'; text: string };

function parse(content: string): Segment[] {
  const segments: Segment[] = [];
  const regex = /```([a-zA-Z0-9_-]*)?\n([\s\S]*?)```/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(content)) !== null) {
    const language = (match[1] || 'text').toLowerCase();
    if (['mermaid', 'plantuml', 'dot', 'graphviz'].includes(language)) {
      continue;
    }

    if (match.index > lastIndex) {
      segments.push({ type: 'text', text: content.slice(lastIndex, match.index) });
    }
    segments.push({
      type: 'code',
      language: match[1] || 'text',
      code: match[2].replace(/\n$/,'')
    });
    lastIndex = regex.lastIndex;
  }
  if (lastIndex < content.length) {
    segments.push({ type: 'text', text: content.slice(lastIndex) });
  }
  return segments;
}

const RichResponseImpl: React.FC<RichResponseProps> = ({ content, streaming, workspaceThreadId }) => {
  // While the turn is still streaming, render the whole message through
  // Streamdown only. Streamdown highlights code incrementally per block and
  // does NOT re-highlight the full message each chunk, so it stays smooth.
  // We must NOT mount the react-syntax-highlighter CodeBlock split mid-stream:
  // the moment a fenced block closes, CodeBlock highlights the entire block
  // (twice — light + dark) in one synchronous render, pinning the main thread
  // for >1s on a large block (the page can't even scroll). The heavy split —
  // and the genui card — only mount once the turn completes. Reproduced and
  // guarded by e2e/markdown-stream-jank.spec.ts (big-code-block fixture).
  if (streaming) {
    return <Response workspaceThreadId={workspaceThreadId}>{resolveBlobRefsInMarkdown(content)}</Response>;
  }
  const segments = parse(content);
  // If no code segments, render whole content once to preserve full markdown context
  const hasCode = segments.some(s => s.type === 'code');
  if (!hasCode) {
    return <Response workspaceThreadId={workspaceThreadId}>{resolveBlobRefsInMarkdown(content)}</Response>;
  }

  return (
    <div className="flex flex-col gap-4">
      {segments.map((seg, i) => {
        if (seg.type === 'code') {
          // Generative UI: a ```genui (or ```json-render) fenced block renders
          // as real Bühler components, once the turn is no longer streaming
          // (see RichResponseProps.streaming). Detection is by explicit language
          // tag only — never by sniffing arbitrary JSON content — so a normal
          // ```json block the user wants to read stays a code block.
          if (
            !streaming &&
            (seg.language === 'genui' || seg.language === 'json-render')
          ) {
            return <GenUI key={i} json={seg.code} />;
          }
          return (
            <CodeBlock key={i} code={seg.code} language={seg.language}>
              <CodeBlockCopyButton />
            </CodeBlock>
          );
        }
        // Preserve original spacing; don't trim to keep markdown structure (headings, lists, tables)
        if (seg.text.length === 0) return null;
        return <Response key={i} workspaceThreadId={workspaceThreadId}>{resolveBlobRefsInMarkdown(seg.text)}</Response>;
      })}
    </div>
  );
};

// Memoize so a COMPLETED prior message does not re-render — and re-highlight
// its code blocks — every time a NEW message streams. The chat list re-renders
// every message on each ~60ms chunk (chat-page.tsx maps messages inline with no
// per-item memo); without this, a thread with earlier code-heavy answers
// re-highlights ALL of their blocks on every chunk → multi-second main-thread
// freeze that starts on the first chunk, before the new answer's own content
// even appears (reproduced: 6.1s timer drift; e2e/markdown-stream-jank.spec.ts
// "followup"). `content`, `streaming` and `workspaceThreadId` are primitives, so
// React.memo's shallow equality skips any message whose text is unchanged.
export const RichResponse = React.memo(RichResponseImpl);
RichResponse.displayName = "RichResponse";
