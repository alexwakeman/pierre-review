import type { z as Zod } from 'zod';
import {
  CLAUDE_REVIEW_CHAT_MAX_PINS,
  type ClaudeFinding,
  type ClaudeReviewChatExplanation,
  type ClaudeReviewChatPin,
  type ClaudeReviewChatPinRef,
  type TicketCriterion,
  type TicketReview,
  type TicketReviewItem,
} from '@pierre-review/shared';
import { loadZod } from '../../ai/runtime.js';

// REVIEW CHAT — "EXPLAIN THESE" (docs/CLAUDE-REVIEW.md § Review chat). The reader pins findings and
// story items to the chat; ONE agent turn answers with one card per pin through the in-process
// `submit_explanations` tool. This module is the PURE half — pin parsing, labels, the prompt
// section, the tool's schema and the validation of what came back. chat.ts owns the DB and the run.
//
// What it guarantees:
//   • THE CLIENT SENDS REFERENCES ONLY. `parsePinRefs` accepts ids and nothing else; the text of each
//     pinned item is read by chat.ts from rows the account owns, and every byte of it is fenced.
//   • EVERY CARD NAMES A PIN. The model sees each pin as 'P1'…'Pn' and must answer by that ref; a
//     card naming any other ref, or a pin twice, is dropped (`validateExplanations`). The card's
//     label is the SERVER's, copied from the pin — never model text.

type ZodNs = typeof Zod;

// Per-field caps on what the model sends back (it is stored and rendered as plain text).
const CARD_FIELD_CHARS = 4_000;
const WHERE_MAX = 8;
const PATH_CHARS = 400;
const LABEL_TITLE_CHARS = 120;
// Caps on what each pin contributes to the prompt.
const PIN_BODY_CHARS = 3_000;

export type PinParse =
  | { ok: true; refs: ClaudeReviewChatPinRef[] }
  | { ok: false; error: string; message: string };

const isId = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v > 0;

export const pinRefKey = (r: ClaudeReviewChatPinRef): string =>
  r.kind === 'finding' ? `f:${r.findingId}` : `s:${r.ticketReviewId}:${r.itemId}`;

/**
 * The request's pins, validated as REFERENCES: a known kind with positive integer ids and nothing
 * else (any other key is dropped). Duplicates collapse to one. Over the cap is refused, never cut.
 */
export function parsePinRefs(raw: unknown): PinParse {
  if (raw == null) return { ok: true, refs: [] };
  if (!Array.isArray(raw)) return { ok: false, error: 'BadPins', message: 'Pins must be a list.' };
  const out: ClaudeReviewChatPinRef[] = [];
  const seen = new Set<string>();
  for (const p of raw) {
    if (p == null || typeof p !== 'object') {
      return { ok: false, error: 'BadPins', message: 'Each pin must name a finding or a story item.' };
    }
    const o = p as Record<string, unknown>;
    let ref: ClaudeReviewChatPinRef;
    if (o.kind === 'finding' && isId(o.findingId)) ref = { kind: 'finding', findingId: o.findingId };
    else if (o.kind === 'story_item' && isId(o.ticketReviewId) && isId(o.itemId)) {
      ref = { kind: 'story_item', ticketReviewId: o.ticketReviewId, itemId: o.itemId };
    } else {
      return { ok: false, error: 'BadPins', message: 'Each pin must name a finding or a story item.' };
    }
    const key = pinRefKey(ref);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(ref);
  }
  if (out.length > CLAUDE_REVIEW_CHAT_MAX_PINS) {
    return {
      ok: false,
      error: 'TooManyPins',
      message: `Send at most ${CLAUDE_REVIEW_CHAT_MAX_PINS} items at a time.`,
    };
  }
  return { ok: true, refs: out };
}

const oneLine = (s: string, max: number): string => {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
};

const SEVERITY_WORD: Record<ClaudeFinding['severity'], string> = {
  blocker: 'Blocker',
  warning: 'Warning',
  nit: 'Nit',
  question: 'Question',
  praise: 'Praise',
};

const STORY_STATUS_WORD: Record<TicketReviewItem['status'], string> = {
  not_met: 'Not done',
  partly_met: 'Partly done',
  missing: 'Not done',
};

export function findingPinLabel(f: Pick<ClaudeFinding, 'severity' | 'title'>): string {
  return `${SEVERITY_WORD[f.severity] ?? 'Finding'} · ${oneLine(f.title, LABEL_TITLE_CHARS)}`;
}

export function storyPinLabel(
  item: Pick<TicketReviewItem, 'ref' | 'status' | 'title'>,
  ticketKey: string | null,
): string {
  const head = ticketKey ? `${ticketKey} ${item.ref}` : item.ref;
  return `${head} · ${STORY_STATUS_WORD[item.status]} · ${oneLine(item.title, LABEL_TITLE_CHARS)}`;
}

/** One pin, resolved from stored rows: its label and the text the model reads (fenced by the caller). */
export interface ResolvedPin {
  ref: ClaudeReviewChatPinRef;
  label: string;
  // 'P1'… — the handle the model answers by.
  promptRef: string;
  text: string;
}

const clip = (t: string, max: number): string => {
  const s = t.replace(/\s+$/, '');
  return s.length > max ? `${s.slice(0, max)}\n…(shortened)` : s;
};

export function findingPinText(f: ClaudeFinding, reviewRef: string): string {
  const where = f.path === '' ? '(the whole change)' : f.line != null ? `${f.path}:${f.line}` : f.path;
  const parts = [
    `A finding of your review (${reviewRef} in the Findings list), severity ${f.severity}, at ${where}.`,
    `Title: ${f.title}`,
  ];
  if (f.body.trim()) parts.push(clip(f.body, PIN_BODY_CHARS));
  if (f.suggestion) parts.push(`Suggested code:\n${clip(f.suggestion, PIN_BODY_CHARS)}`);
  return parts.join('\n');
}

export function storyPinText(
  review: Pick<TicketReview, 'ticketKey' | 'ticketTitle' | 'assessment'>,
  item: TicketReviewItem,
): string {
  const criterion: TicketCriterion | undefined = review.assessment?.criteria.find((c) => c.ref === item.ref);
  const story = [review.ticketKey, review.ticketTitle].filter(Boolean).join(' ');
  const parts = [
    item.status === 'missing'
      ? `Something the user story${story ? ` (${story})` : ''} asks for that no pull request does (${item.ref}).`
      : `An acceptance criterion of the user story${story ? ` (${story})` : ''} that is ${item.status === 'partly_met' ? 'only partly' : 'not'} done (${item.ref}).`,
    `${item.status === 'missing' ? 'What is missing' : 'Criterion'}: ${criterion?.text ?? item.title}`,
  ];
  if (item.path) parts.push(`Where it belongs: ${item.line != null ? `${item.path}:${item.line}` : item.path}`);
  const why = item.body.trim() || criterion?.explanation?.trim() || '';
  if (why) parts.push(`What the story check said:\n${clip(why, PIN_BODY_CHARS)}`);
  return parts.join('\n');
}

/** The prompt section listing the pins (the caller fences each item's text). */
export function explainSectionLines(pins: readonly ResolvedPin[], nonce: string): string[] {
  const lines: string[] = [];
  lines.push(`## Items the developer wants explained (${pins.length})`);
  lines.push(`---BEGIN ITEMS ${nonce}---`);
  lines.push(pins.map((p) => `${p.promptRef}\n${p.text}`).join('\n\n'));
  lines.push(`---END ITEMS ${nonce}---`);
  return lines;
}

export const EXPLAIN_INSTRUCTION = (refs: readonly string[]): string =>
  `Answer by calling submit_explanations EXACTLY once, with one card per item: ${refs.join(', ')}. Each card says what the item means, why it matters, where in the code (file path and line), and what would fix it or what is still needed. Be concise and concrete; check the code before you answer when you can. Put nothing outside the tool call.`;

export const EXPLAIN_SYSTEM_ADDENDUM = `

# Explaining pinned items
When the message lists "Items the developer wants explained", answer ONLY through the submit_explanations tool, one card per item, naming each item by its ref (P1, P2, …). Never invent a ref. If an item looks wrong now that you look again, say so in its card.`;

// ---- the submit tool's schema ------------------------------------------------------------------

export function buildSubmitExplanationsShape(z: ZodNs) {
  return {
    cards: z
      .array(
        z.object({
          ref: z.string().describe("The item's ref from the list, e.g. 'P1'."),
          meaning: z.string().describe('What the item means, in plain words. Two to four sentences.'),
          whyItMatters: z.string().describe('Why it matters: what goes wrong, for whom, and when.'),
          where: z
            .array(z.object({ path: z.string(), line: z.number().int().nullable().optional() }))
            .optional()
            .describe('The places in the repository it is about, with a line when known.'),
          fix: z.string().describe('What would fix it, or what is still needed. Code only if it is short.'),
        }),
      )
      .describe('One card per item in the list, each ref once.'),
  };
}

export type SubmitExplanationsShape = ReturnType<typeof buildSubmitExplanationsShape>;

/** The raw shape `tool()` wants, built from the runtime's zod (review/schema.ts explains why). */
export async function submitExplanationsShape(): Promise<SubmitExplanationsShape> {
  return buildSubmitExplanationsShape(await loadZod());
}

const str = (v: unknown, max: number): string =>
  typeof v === 'string' ? clip(v.trim(), max) : '';

/**
 * What the model submitted, kept ONLY where it answers a pin: a card whose ref is not one of the
 * pins' 'P1'…'Pn', or names a pin a second time, is dropped. Output is in PIN order and carries the
 * pin's own reference and server label. A card with no text at all is dropped too.
 */
export function validateExplanations(
  payload: unknown,
  pins: readonly ResolvedPin[],
): ClaudeReviewChatExplanation[] {
  const cards = (payload as { cards?: unknown } | null)?.cards;
  if (!Array.isArray(cards)) return [];
  const byRef = new Map(pins.map((p) => [p.promptRef.toUpperCase(), p]));
  const got = new Map<string, ClaudeReviewChatExplanation>();
  for (const c of cards) {
    if (c == null || typeof c !== 'object') continue;
    const o = c as Record<string, unknown>;
    const key = typeof o.ref === 'string' ? o.ref.trim().toUpperCase() : '';
    const pin = byRef.get(key);
    if (!pin || got.has(key)) continue;
    const where: Array<{ path: string; line: number | null }> = [];
    if (Array.isArray(o.where)) {
      for (const w of o.where) {
        if (where.length >= WHERE_MAX) break;
        const wo = (w ?? {}) as Record<string, unknown>;
        const path = typeof wo.path === 'string' ? wo.path.trim() : '';
        if (path === '' || path.length > PATH_CHARS) continue;
        const line = typeof wo.line === 'number' && Number.isInteger(wo.line) && wo.line > 0 ? wo.line : null;
        where.push({ path, line });
      }
    }
    const card: ClaudeReviewChatExplanation = {
      ref: pin.ref,
      label: pin.label,
      meaning: str(o.meaning, CARD_FIELD_CHARS),
      whyItMatters: str(o.whyItMatters, CARD_FIELD_CHARS),
      where,
      fix: str(o.fix, CARD_FIELD_CHARS),
    };
    if (card.meaning === '' && card.whyItMatters === '' && card.fix === '') continue;
    got.set(key, card);
  }
  return pins.flatMap((p) => {
    const c = got.get(p.promptRef.toUpperCase());
    return c ? [c] : [];
  });
}

/** The answer as markdown — what the transcript of a later turn reads, and a plain fallback. */
export function explanationsMarkdown(
  cards: readonly ClaudeReviewChatExplanation[],
  pins: readonly Pick<ClaudeReviewChatPin, 'ref' | 'label'>[],
): string {
  const out: string[] = [];
  for (const p of pins) {
    const c = cards.find((x) => pinRefKey(x.ref) === pinRefKey(p.ref));
    out.push(`### ${p.label}`);
    if (!c) {
      out.push('No explanation came back for this one.');
      out.push('');
      continue;
    }
    if (c.meaning) out.push(`**What it means.** ${c.meaning}`);
    if (c.whyItMatters) out.push(`**Why it matters.** ${c.whyItMatters}`);
    if (c.where.length > 0) {
      out.push(`**Where.** ${c.where.map((w) => (w.line != null ? `${w.path}:${w.line}` : w.path)).join(', ')}`);
    }
    if (c.fix) out.push(`**What would fix it.** ${c.fix}`);
    out.push('');
  }
  return out.join('\n').trim();
}

/** The question as the transcript of a later turn reads it: with the pins' labels. */
export function questionWithPins(question: string, pins: readonly ClaudeReviewChatPin[] | null | undefined): string {
  if (!pins || pins.length === 0) return question;
  return `${question}\n\nItems: ${pins.map((p) => p.label).join('; ')}`;
}
