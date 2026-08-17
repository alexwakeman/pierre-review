import { memo, type CSSProperties } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeHighlight from 'rehype-highlight';
import rehypeRaw from 'rehype-raw';
import rehypeSanitize, { defaultSchema } from 'rehype-sanitize';

// Tightened sanitize schema: extend the rehype-sanitize default to permit <img>
// with a minimal attribute allowlist. We do NOT widen the default protocol
// allowlist, so img src stays restricted to http/https (no data:/blob:), and we
// deliberately omit onerror/onload/style/srcset.
const sanitizeSchema = {
  ...defaultSchema,
  tagNames: [...(defaultSchema.tagNames ?? []), 'img'],
  attributes: {
    ...defaultSchema.attributes,
    img: ['src', 'alt', 'title', 'width', 'height'],
  },
};

/**
 * An `<img>`'s declared size, handed to CSS as an upper bound.
 *
 * HTML `width`/`height` are non-negative integers in CSS pixels, so anything else — a
 * percentage, `auto`, junk, a value react-markdown passed through as a number — is ignored
 * rather than guessed at. Each side is independent: a tag declaring only `width` still gets
 * its width honoured, and the missing var falls back to the plain cap in the stylesheet.
 *
 * ⚠ These become `max-width`/`max-height` (see `.md-body img` in index.css), NEVER a pinned
 * `width`. Pinning one dimension while the other is capped is what squashes an image; as
 * bounds with both used dimensions `auto`, the aspect ratio survives every combination.
 */
function declaredSizeVars(width: unknown, height: unknown): CSSProperties | undefined {
  const px = (v: unknown): string | null => {
    const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v.trim()) : NaN;
    return Number.isFinite(n) && n > 0 ? `${n}px` : null;
  };
  const w = px(width);
  const h = px(height);
  if (!w && !h) return undefined;
  return {
    ...(w ? { '--md-img-w': w } : {}),
    ...(h ? { '--md-img-h': h } : {}),
  } as CSSProperties;
}

// Comment bodies: GFM (tables, strikethrough, task lists, autolinks) plus
// syntax highlighting for fenced code blocks. Raw HTML (e.g. <img> in a PR body)
// is parsed by rehype-raw, then allowlisted by rehype-sanitize BEFORE
// rehype-highlight runs — so highlight's hljs/code classNames survive the
// sanitizer. Plugin order is load-bearing: raw → sanitize → highlight.
// Memoized on its single string child: markdown+syntax-highlight parsing is expensive,
// and this component renders in hot, frequently-re-rendering places (the Feed's rows, PR
// comments, thread bodies, Insights). With a stable body string, a parent re-render (e.g. a
// Back-flash highlight on the Feed) no longer re-parses every visible markdown body.
export const Markdown = memo(function Markdown({
  children,
}: {
  children: string;
}): JSX.Element {
  return (
    <div className="md-body">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[
          rehypeRaw,
          [rehypeSanitize, sanitizeSchema],
          [rehypeHighlight, { detect: true, ignoreMissing: true }],
        ]}
        components={{
          a: ({ node, ...props }) => (
            <a {...props} target="_blank" rel="noreferrer noopener" />
          ),
          // `width`/`height` stay ON the element as well as feeding the CSS bounds: they are
          // what gives the browser an aspect ratio before the bytes arrive, which is what
          // reserves the right box and keeps the surrounding text from reflowing on load.
          img: ({ node, ...props }) => (
            <img
              {...props}
              style={declaredSizeVars(props.width, props.height)}
              loading="lazy"
              referrerPolicy="no-referrer"
            />
          ),
        }}
      >
        {children}
      </ReactMarkdown>
    </div>
  );
});
