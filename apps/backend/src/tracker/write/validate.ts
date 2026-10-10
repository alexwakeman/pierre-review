import { SPRINT_WRITE_TEXT_MAX } from '@pierre-review/shared';

// The write-back's text check — the text the reader CONFIRMED is what is sent, so it is checked once,
// server-side, before any claim or tracker call. Trimmed; 1..SPRINT_WRITE_TEXT_MAX characters; no NUL
// and no lone surrogate (neither survives a round trip through Jira, Linear or GitHub intact).

const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

export function validateWriteText(raw: unknown): { ok: true; text: string } | { ok: false; message: string } {
  if (typeof raw !== 'string') return { ok: false, message: 'There is no text to write.' };
  const text = raw.trim();
  if (text === '') return { ok: false, message: 'There is no text to write.' };
  if (text.length > SPRINT_WRITE_TEXT_MAX) {
    return { ok: false, message: `The text is too long. The limit is ${SPRINT_WRITE_TEXT_MAX.toLocaleString('en-GB')} characters.` };
  }
  if (text.includes('\u0000')) return { ok: false, message: 'The text contains a character that cannot be written.' };
  if (LONE_SURROGATE.test(text)) return { ok: false, message: 'The text contains a character that cannot be written.' };
  return { ok: true, text };
}
