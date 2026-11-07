import type {
  ClaudeOpenPoint,
  ClaudeOpenPointCode,
  ClaudeReviewOpenPoints,
  TicketOpenPointSource,
} from '@pierre-review/shared';

/** One open point as the prompt shows it. `ref` ('OP1'…) is what the reviewer reports against. */
export interface PromptOpenPoint {
  ref: string;
  ticketKey: string;
  text: string;
}

/** At most this many open points reach a prompt (the rest are not shown, and not stored). */
export const OPEN_POINTS_PROMPT_MAX = 30;

// THE TICKETS' OPEN POINTS IN A PR REVIEW (docs/CLAUDE-REVIEW.md § Open points). The run is given the
// open points of the PR's tickets (read again from the tracker just before it — tracker/open-points-pr.ts)
// and reports, per point, the code in the PR that depends on it. Pure helpers:
//   • `openPointsForPrompt` — the tracker's per-ticket lists → the prompt's numbered points (OP1…);
//   • `reconcileOpenPoints` — the model's raw `openPoints` → what is stored: EVERY point shown, each
//     with only the code the model tied to a ref it was sent (unknown refs dropped, notes clipped);
//   • `openPointsPostBlock` / `withOpenPointsBlock` — the section of the POSTED review body.
// ⚠ Open points NEVER move the verdict, the severity counts or "approved": nothing here is a finding.

/** One ticket's open points as the tracker source gives them (tracker/open-points-pr.ts). */
export interface TicketOpenPointsInput {
  key: string;
  points: ReadonlyArray<{ text: string; source: TicketOpenPointSource }>;
  fresh: boolean;
  fetchedAt: string | null;
}

/** What a run shows and keeps for reconciling. */
export interface OpenPointsPlan {
  prompt: PromptOpenPoint[];
  sources: Map<string, TicketOpenPointSource>;
  fresh: boolean;
  readAt: string | null;
}

const CODE_PER_POINT_MAX = 5;
const NOTE_MAX_CHARS = 300;
const PATH_MAX_CHARS = 500;

/** The tickets' points, numbered OP1… in ticket order, capped. null when there are none. */
export function openPointsForPrompt(tickets: readonly TicketOpenPointsInput[]): OpenPointsPlan | null {
  const prompt: PromptOpenPoint[] = [];
  const sources = new Map<string, TicketOpenPointSource>();
  let fresh = true;
  let readAt: string | null = null;
  for (const t of tickets) {
    if (t.points.length === 0) continue;
    fresh &&= t.fresh;
    if (t.fetchedAt != null && (readAt == null || t.fetchedAt < readAt)) readAt = t.fetchedAt;
    for (const p of t.points) {
      if (prompt.length >= OPEN_POINTS_PROMPT_MAX) break;
      const ref = `OP${prompt.length + 1}`;
      prompt.push({ ref, ticketKey: t.key, text: p.text });
      sources.set(ref, p.source);
    }
  }
  return prompt.length > 0 ? { prompt, sources, fresh, readAt } : null;
}

function clip(s: string, max: number): string {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 1).trimEnd()}…` : t;
}

/** The model's raw report → the stored section. Every point shown is kept; only known refs carry code. */
export function reconcileOpenPoints(plan: OpenPointsPlan, raw: unknown): ClaudeReviewOpenPoints {
  const codeByRef = new Map<string, ClaudeOpenPointCode[]>();
  if (Array.isArray(raw)) {
    for (const entry of raw) {
      if (entry == null || typeof entry !== 'object') continue;
      const ref = typeof (entry as { ref?: unknown }).ref === 'string' ? (entry as { ref: string }).ref.trim().toUpperCase() : '';
      if (!plan.sources.has(ref) || codeByRef.has(ref)) continue;
      const code: ClaudeOpenPointCode[] = [];
      const list = (entry as { code?: unknown }).code;
      for (const c of Array.isArray(list) ? list : []) {
        if (c == null || typeof c !== 'object' || code.length >= CODE_PER_POINT_MAX) continue;
        const path = typeof (c as { path?: unknown }).path === 'string' ? clip((c as { path: string }).path, PATH_MAX_CHARS) : '';
        const note = typeof (c as { note?: unknown }).note === 'string' ? clip((c as { note: string }).note, NOTE_MAX_CHARS) : '';
        if (path === '' || note === '') continue;
        const ln = (c as { line?: unknown }).line;
        const line = typeof ln === 'number' && Number.isInteger(ln) && ln > 0 ? ln : null;
        code.push({ path, line, note });
      }
      codeByRef.set(ref, code);
    }
  }
  const points: ClaudeOpenPoint[] = plan.prompt.map((p) => ({
    ref: p.ref,
    ticketKey: p.ticketKey,
    text: p.text,
    source: plan.sources.get(p.ref) ?? 'description',
    code: codeByRef.get(p.ref) ?? [],
  }));
  return { fresh: plan.fresh, readAt: plan.readAt, points };
}

/** GitHub's review body allows 65,536 characters; the section stays well under. */
const POST_BLOCK_MAX_CHARS = 8_000;

const shortDate = (iso: string | null): string | null => {
  if (iso == null) return null;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
};

/** A ticket line's text, safe for a markdown list item (one line, no HTML comment). */
function oneLine(s: string): string {
  return s.replace(/<!--|-->/g, '').replace(/\s+/g, ' ').trim();
}

/**
 * The "Open points" section of a posted review body ('' when there are none). Said plainly as NOT
 * affecting the outcome. What does not fit is counted, never cut mid-line.
 */
export function openPointsPostBlock(op: ClaudeReviewOpenPoints | null | undefined): string {
  if (op == null || op.points.length === 0) return '';
  const head = [
    '#### Open points on the ticket (not blocking)',
    '',
    `Not decided when the ticket was written. They do not affect this review's outcome.${
      op.fresh ? '' : ` From Limn's stored copy of the ticket${shortDate(op.readAt) ? ` (read ${shortDate(op.readAt)})` : ''}.`
    }`,
    '',
  ];
  const out = [...head];
  let used = out.join('\n').length;
  let left = 0;
  for (const p of op.points) {
    const lines = [`- **${oneLine(p.ticketKey)}:** ${oneLine(p.text)}`];
    for (const c of p.code) {
      lines.push(`  - \`${oneLine(c.path).replace(/`/g, "'")}${c.line != null ? `:${c.line}` : ''}\` ${oneLine(c.note)}`);
    }
    const chunk = lines.join('\n');
    if (used + chunk.length + 1 > POST_BLOCK_MAX_CHARS) {
      left += 1;
      continue;
    }
    out.push(chunk);
    used += chunk.length + 1;
  }
  if (left > 0) out.push(`- ${left} more ${left === 1 ? 'point' : 'points'} in Limn.`);
  return out.join('\n');
}

/** A review body with the open-points section added at its end (before the marker the seam adds). */
export function withOpenPointsBlock(body: string, op: ClaudeReviewOpenPoints | null | undefined): string {
  const block = openPointsPostBlock(op);
  if (block === '') return body;
  const b = body.replace(/\s+$/, '');
  return b === '' ? block : `${b}\n\n${block}`;
}

/** The auto body: the section goes just before the footer (after the lead and any reason line). A body
 *  without that footer gets it at the end. */
export function withOpenPointsBeforeFooter(body: string, footer: string, op: ClaudeReviewOpenPoints | null | undefined): string {
  const block = openPointsPostBlock(op);
  if (block === '') return body;
  const at = footer !== '' ? body.lastIndexOf(footer) : -1;
  if (at < 0) return withOpenPointsBlock(body, op);
  const before = body.slice(0, at).replace(/\s+$/, '');
  return `${before === '' ? '' : `${before}\n\n`}${block}\n\n${body.slice(at)}`;
}

/** A stored `open_points` value → the wire, or null (anything malformed reads as none). */
export function openPointsFromStored(v: unknown): ClaudeReviewOpenPoints | null {
  if (v == null || typeof v !== 'object') return null;
  const o = v as { fresh?: unknown; readAt?: unknown; points?: unknown };
  if (!Array.isArray(o.points)) return null;
  const points: ClaudeOpenPoint[] = [];
  for (const p of o.points) {
    if (p == null || typeof p !== 'object') continue;
    const q = p as Partial<ClaudeOpenPoint>;
    if (typeof q.ref !== 'string' || typeof q.ticketKey !== 'string' || typeof q.text !== 'string') continue;
    points.push({
      ref: q.ref,
      ticketKey: q.ticketKey,
      text: q.text,
      source: q.source === 'field' ? 'field' : 'description',
      code: Array.isArray(q.code)
        ? q.code.filter(
            (c): c is ClaudeOpenPointCode =>
              c != null && typeof c === 'object' && typeof c.path === 'string' && typeof c.note === 'string',
          ).map((c) => ({ path: c.path, line: typeof c.line === 'number' ? c.line : null, note: c.note }))
        : [],
    });
  }
  if (points.length === 0) return null;
  return { fresh: o.fresh === true, readAt: typeof o.readAt === 'string' ? o.readAt : null, points };
}

/**
 * A Claude + Codex pair's ONE open-points section: the half that was shown the most points is the
 * base, and each point gains the other half's code for the same point (same ref and text), without
 * repeats. null when neither half had any.
 */
export function mergeOpenPoints(halves: ReadonlyArray<ClaudeReviewOpenPoints | null | undefined>): ClaudeReviewOpenPoints | null {
  const present = halves.filter((h): h is ClaudeReviewOpenPoints => h != null && h.points.length > 0);
  if (present.length === 0) return null;
  const base = present.reduce((a, b) => (b.points.length > a.points.length ? b : a));
  const points = base.points.map((p) => {
    const code = [...p.code];
    for (const h of present) {
      if (h === base) continue;
      const twin = h.points.find((q) => q.ref === p.ref && q.text === p.text);
      for (const c of twin?.code ?? []) {
        if (code.length >= CODE_PER_POINT_MAX) break;
        if (!code.some((x) => x.path === c.path && x.line === c.line)) code.push(c);
      }
    }
    return { ...p, code };
  });
  return { fresh: present.every((h) => h.fresh), readAt: base.readAt, points };
}
