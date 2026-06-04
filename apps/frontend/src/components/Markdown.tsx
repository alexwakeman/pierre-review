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

// Comment bodies: GFM (tables, strikethrough, task lists, autolinks) plus
// syntax highlighting for fenced code blocks. Raw HTML (e.g. <img> in a PR body)
// is parsed by rehype-raw, then allowlisted by rehype-sanitize BEFORE
// rehype-highlight runs — so highlight's hljs/code classNames survive the
// sanitizer. Plugin order is load-bearing: raw → sanitize → highlight.
export function Markdown({ children }: { children: string }): JSX.Element {
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
          img: ({ node, ...props }) => (
            <img {...props} loading="lazy" referrerPolicy="no-referrer" />
          ),
        }}
      >
        {children}
      </ReactMarkdown>
    </div>
  );
}
