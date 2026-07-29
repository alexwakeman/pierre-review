// The wordmark — the ONLY place the product name is rendered as identity in the
// app, mirroring the marketing site's <Wordmark/>. Plain Archivo 600 plus a
// vermilion full stop; no logotype, no image, no custom letterforms, so a rename
// is a one-line change here and in the site's lib/site.ts.
//
// (This replaced an ornate cursive "Pierre" set in a bundled Great Vibes face,
// whose entire reason for existing was that one word.)
//
// The full stop takes the darker vermilion on light grounds and the lighter one
// on dark — #E2492C is only 3.85:1 on paper, so it may never carry a glyph.

export const APP_NAME = 'Limn';

export function Wordmark({ className = '' }: { className?: string }): JSX.Element {
  return (
    <span className={`brand-title ${className}`}>
      {APP_NAME}
      <span className="text-[#C13A20] dark:text-[#F26B4E]">.</span>
    </span>
  );
}
