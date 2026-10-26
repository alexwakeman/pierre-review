import { SPRINT_CODE_JUDGE_REASON_MAX } from '@pierre-review/shared';

// THE "NEEDS CODE" ANSWER, VALIDATED (sprint-code.test.ts). Per ticket, never a repaired guess:
//
//   • `tickets`: `{key, code, reason}`. A key not in the batch is DROPPED (case-insensitive match). `code`
//     must be a boolean (or the strings "true" / "false"); anything else drops THAT entry.
//   • A key given twice with two different answers is dropped (no answer for it this call).
//   • `reason` is OPTIONAL and never drops the entry: missing, blank, over SPRINT_CODE_JUDGE_REASON_MAX
//     characters, or carrying ANY numeral (`\p{Nd}\p{No}\p{Nl}` — figures are code's) → null.
//   • A batch key with no surviving entry is simply NOT judged: the pass retries the missing ones once,
//     then the next sprint read tries again.

export type CodeJudgeValidation =
  | { ok: true; judgements: Map<string, { needsCode: boolean; reason: string | null }> }
  | { ok: false; reason: 'not_json' | 'shape' };

const asRecord = (v: unknown): Record<string, unknown> | null =>
  typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null;

// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/g;
const NUMERAL = /[\p{Nd}\p{No}\p{Nl}]/u;

function reasonOf(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const t = v.replace(CONTROL, ' ').replace(/\s+/g, ' ').trim();
  if (t === '' || t.length > SPRINT_CODE_JUDGE_REASON_MAX || NUMERAL.test(t)) return null;
  return t;
}

function boolOf(v: unknown): boolean | null {
  if (typeof v === 'boolean') return v;
  if (typeof v === 'string') {
    const t = v.trim().toLowerCase();
    if (t === 'true') return true;
    if (t === 'false') return false;
  }
  return null;
}

/** Parse and validate one completion against the batch's keys (as sent). The map is keyed by the
 *  key AS SENT. */
export function validateSprintCode(raw: string, keys: readonly string[]): CodeJudgeValidation {
  const a = raw.indexOf('{');
  const b = raw.lastIndexOf('}');
  if (a < 0 || b <= a) return { ok: false, reason: 'not_json' };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.slice(a, b + 1));
  } catch {
    return { ok: false, reason: 'not_json' };
  }
  const o = asRecord(parsed);
  if (o == null || !Array.isArray(o.tickets)) return { ok: false, reason: 'shape' };
  const canon = new Map(keys.map((k) => [k.toUpperCase(), k]));
  const out = new Map<string, { needsCode: boolean; reason: string | null }>();
  const conflicted = new Set<string>();
  for (const x of o.tickets) {
    const r = asRecord(x);
    if (r == null || typeof r.key !== 'string') continue;
    const key = canon.get(r.key.trim().toUpperCase());
    if (key == null) continue;
    const code = boolOf(r.code);
    if (code == null) continue;
    const prev = out.get(key);
    if (prev != null && prev.needsCode !== code) conflicted.add(key);
    if (prev == null) out.set(key, { needsCode: code, reason: reasonOf(r.reason) });
  }
  for (const k of conflicted) out.delete(k);
  return { ok: true, judgements: out };
}
