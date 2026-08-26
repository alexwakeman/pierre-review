import { memo, type CSSProperties } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeHighlight from 'rehype-highlight';
import rehypeRaw from 'rehype-raw';
import rehypeSanitize, { defaultSchema } from 'rehype-sanitize';

/**
 * HAST property names React refuses — subtracted from every allowlist below.
 *
 * `rehype-sanitize`'s default `attributes` are written in HAST property names (camelCase, from
 * `property-information`), and the `'*'` list still carries the legacy presentational attributes
 * of 1997: `hspace`, `valign`, `charoff`, `nowrap`, `noshade`, `nohref`, `ismap`, `compact`
 * (plus `<img longdesc>`). Whatever survives the sanitizer is handed to React under that
 * camelCase property name — react-markdown emits `hastToReact[property] || property` for
 * html-space properties — and React has never heard of any of them, so a single `<img hspace=…>`
 * pasted into a PR body costs a runtime warning:
 *
 *   "React does not recognize the `hSpace` prop on a DOM element … spell it as lowercase `hspace`"
 *
 * (`compact` is the one non-camelCase member: React refuses it with the sibling wording,
 * "Received `true` for a non-boolean attribute `compact`", and drops it.)
 *
 * ⚠ This is NOT an `<img>` problem — patching the `img` renderer below would leave `<td valign>`,
 * `<td nowrap>` and `<hr noshade>` warning exactly as before. The allowlist is the ONE choke
 * point every tag passes through, so the subtraction belongs here.
 *
 * Dropping them costs nothing: markdown bodies are styled by CSS (`.md-body` in index.css), never
 * by presentational HTML attributes — and React was already refusing to render most of them.
 * Everything React DOES understand is KEPT, because the kept list is DERIVED by FILTERING the
 * inherited arrays rather than retyped: `colSpan`, `rowSpan`, `cellPadding`, `cellSpacing`,
 * `charSet`, `dateTime`, `encType`, `htmlFor`, `hrefLang`, `maxLength`, `readOnly`, `tabIndex`,
 * `itemProp`, `useMap`, `width`/`height`/`alt`/`title`, and the all-lowercase legacy names
 * (`align`, `border`, `size`, `frame`, `rules`, …) React passes straight through — as does
 * anything a future rehype-sanitize bump adds.
 *
 * `aria*`/`data*` names in the default schema are deliberately NOT here: `property-information`
 * gives them no `space`, so react-markdown hands React the dashed `aria-label` /
 * `data-footnote-ref` it wants. They are not a warning source.
 * Pinned by `apps/frontend/test/markdownSanitizeSchema.test.ts`.
 */
const REACT_UNRECOGNISED_ATTRS = new Set([
  'charOff',
  'compact',
  'hSpace',
  'isMap',
  'longDesc',
  'noHref',
  'noShade',
  'noWrap',
  'vAlign',
]);

type AttributeAllowlists = NonNullable<typeof defaultSchema.attributes>;

/** Filter every tag's allowlist (including `'*'`) through {@link REACT_UNRECOGNISED_ATTRS}. */
function withoutReactUnrecognised(attributes: AttributeAllowlists): AttributeAllowlists {
  return Object.fromEntries(
    Object.entries(attributes).map(([tagName, definitions]) => [
      tagName,
      definitions.filter((definition) => {
        // An entry is either a bare property name or `[name, ...allowedValues]`.
        const name = Array.isArray(definition) ? definition[0] : definition;
        return typeof name !== 'string' || !REACT_UNRECOGNISED_ATTRS.has(name);
      }),
    ]),
  );
}

// Tightened sanitize schema: extend the rehype-sanitize default to permit <img>
// with a minimal attribute allowlist. We do NOT widen the default protocol
// allowlist, so img src stays restricted to http/https (no data:/blob:), and we
// deliberately omit onerror/onload/style/srcset. The narrowed `img` list goes THROUGH the
// filter with everything else, so it can never reintroduce a name React refuses either.
export const sanitizeSchema = {
  ...defaultSchema,
  tagNames: [...(defaultSchema.tagNames ?? []), 'img'],
  attributes: withoutReactUnrecognised({
    ...defaultSchema.attributes,
    img: ['src', 'alt', 'title', 'width', 'height'],
  }),
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
