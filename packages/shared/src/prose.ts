// PLAIN PROSE FROM MODEL TEXT — the few folds that cut a model's text down to what a reader sees,
// shared so the server (what it stores and posts) and the SPA (what it draws from OLDER stored rows)
// cut the same way.

/**
 * `text` cut to at most `max` characters at the last sentence end (". ", "! ", "? ") inside the
 * limit; with no sentence end there, at the last word, marked "…". Never mid-word.
 */
export function clipAtSentence(text: string, max: number): string {
  if (text.length <= max) return text;
  const head = text.slice(0, max);
  let cut = -1;
  for (const m of head.matchAll(/[.!?](?=\s)/g)) cut = m.index;
  if (cut > 0) return head.slice(0, cut + 1);
  const space = head.slice(0, max - 1).lastIndexOf(' ');
  return `${head.slice(0, space > 0 ? space : max - 1)}…`;
}

/** A markdown line that starts a list, a heading, a table, a quote or a code fence. */
const NOT_PROSE_LINE = /^(?:[-*+•]\s|\d+[.)]\s|#|\||>|```)/;

/** The ticket review summary's limit: two plain sentences fit with room to spare. */
export const STORY_SUMMARY_PROSE_CHARS = 600;

/**
 * THE STORY SUMMARY AS SHOWN: only the prose BEFORE the first list / heading / table line, its
 * lines joined into one paragraph, cut at a sentence end under `max`. The ticket review asks for two
 * plain sentences; this is the guarantee, and it also reads an OLDER stored summary (one sentence
 * and then a bullet per gap) the same way. null when no prose leads.
 */
export function storySummaryProse(text: string | null | undefined, max: number = STORY_SUMMARY_PROSE_CHARS): string | null {
  if (text == null) return null;
  const lines: string[] = [];
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (line === '') {
      if (lines.length > 0) lines.push('');
      continue;
    }
    if (NOT_PROSE_LINE.test(line)) break;
    lines.push(line);
  }
  const prose = lines
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (prose === '') return null;
  return clipAtSentence(prose, max);
}

/**
 * A criterion's text without a leading copy of its own ref ("AC3: The export …" → "The export …"):
 * the row already prints the ref, so the model's own numbering would read "AC3 AC3: …".
 */
export function criterionTextOnly(text: string): string {
  const t = text.replace(/^\s*AC\s?\d+(?:\s*[/,&]\s*AC\s?\d+)*\s*[:.)\-–—]\s*/i, '');
  if (t === text) return text;
  if (t.trim() === '') return text;
  // "AC3: baseline pages …" → "Baseline pages …" — a plain lower-case word only (never `npmTest`).
  return /^[a-z][a-z-]*[\s,]/.test(t) ? t.charAt(0).toUpperCase() + t.slice(1) : t;
}

/**
 * THE TICKET REVIEW'S MISSING ITEMS, named for a reader: what the ticket's title or description asks
 * for that no acceptance criterion covers and no pull request does. Their 'M1'… refs stay internal
 * (item refs, AI Fix's `S<t>-M<n>`); a reader sees this heading and each item's own title.
 */
export const STORY_MISSING_HEADING = 'Asked for outside the criteria';
export const STORY_MISSING_EXPLAINER =
  'The ticket’s title or description asks for these, no acceptance criterion covers them, and no pull request does them yet.';
