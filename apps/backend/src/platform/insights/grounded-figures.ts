import type { PeriodReport } from '@pierre-review/shared';
import { movementPhrase, PERIOD_METRIC_LABEL } from './period-questions.js';

// ── The GROUNDED-FIGURE CHECK (plan D4, report grain) ────────────────────────────────────────
//
// "The model never authors a number." For the period-report narrative that is enforced here,
// server-side, at generation time: every numeral token in the returned prose must match a figure
// in the NARRATION PAYLOAD — the projection of the report the model was actually shown
// (`narrationPayload`, period-report.ts): the vector, the deltas, the forecasts, the coverage
// counts, the dates. A narrative that fails is NOT stored as the narrative; the caller stores the
// deterministic templated summary instead and logs the rejection. This is the report-grain twin
// of the synthesis seam's digit-free phrase validator (synthesis/prompt.ts) — there the phrases
// may carry no digits at all; here the prose is ABOUT figures, so the rule is "only the computed
// ones".
//
// ⚠ THE GROUNDING BASE IS THE PAYLOAD, NEVER THE RAW `PeriodReport`. The raw report carries two
// classes of numeral the prose must never be allowed to quote, and grounding on it made the
// check bypassable: `generatedAt` is the generation WALL-CLOCK (a `Date.now()`-derived value —
// exactly the class §8.2 bans from every grounding/hash gate; an ISO timestamp donates its
// year/month/day/hour/minute/second tokens, so "velocity up 37%" grounded whenever the report
// was generated at :37), and `comparison.subsetRepoIds` are INTERNAL DB ids (each one admitted
// a fully arbitrary integer). The payload contains neither — the model cannot quote what it was
// never shown — and the fail-open walk below therefore has the right semantics: fail-open on
// what the model saw, fail-closed on everything else. `UNQUOTABLE_KEYS` is a belt on top, so a
// future caller passing a report-shaped object still cannot reopen the hole.
//
// TOLERANCE RULES (exact, so the next reader does not widen them by guesswork):
//   • SIGN is ignored — the token regex starts at a digit, so "−33"/"+33" both tokenize as "33",
//     and every figure's absolute value is in the allowed set.
//   • THOUSANDS SEPARATORS are stripped — "1,204" matches 1204.
//   • FORMATTED RENDERINGS are accepted alongside the raw value: the integer rounding and the
//     1‑ and 2‑decimal renderings the SPA's formatters produce (countFmt/pctFmt round,
//     ratioFmt prints 2dp), so a stored 22.647 grounds "22.6", "22.65" and "23".
//   • HOUR figures additionally allow fmtDuration's units: minutes (×60, rounded — "45m"),
//     and days (÷24, 1dp and rounded — "2.5d"/"12d"). Applied only to values that live under an
//     hours-named key (`*_hours`, `*Hours`), never to counts.
//   • NUMERALS INSIDE THE PAYLOAD'S OWN STRINGS are allowed — the subset/forecast disclosures,
//     the period key and the ISO period bounds all carry digits the prose may legitimately quote
//     ("covers 17 of 19 repos", "18 Aug – 1 Sep").
//   • ARRAY LENGTHS are allowed — "3 metrics moved" is a computed count.
//   • UNITS ARE INVISIBLE TO THE TOKENIZER. The regex starts at a digit and stops at the first
//     character that is not one, so "50%", "19.56h" and "117 PRs" tokenize to 50 / 19.56 / 117 —
//     exactly what they tokenized to before `movementPhrase` started attaching the unit. Nothing
//     here had to move for that, and nothing here may assume a unit-free figure. It stays true
//     only while every unit is DIGIT-FREE — the rule is stated at `TIGHT_UNITS` in
//     period-questions.ts, next to the table a new unit gets added to.
// Anything else is an invented figure and rejects the narrative.

const NUMERAL_RE = /\d[\d,]*(?:\.\d+)?/g;

/** One number → its canonical comparison string ("22.60" and "22.6" both → "22.6"). */
const canon = (n: number): string => String(n);

function addVariants(set: Set<string>, n: number, hourly: boolean): void {
  if (!Number.isFinite(n)) return;
  const abs = Math.abs(n);
  set.add(canon(n));
  set.add(canon(abs));
  set.add(canon(Math.round(abs)));
  set.add(canon(Number(abs.toFixed(1))));
  set.add(canon(Number(abs.toFixed(2))));
  if (hourly) {
    set.add(canon(Math.round(abs * 60))); // fmtDuration's minutes rendering (< 1h)
    set.add(canon(Number((abs / 24).toFixed(1)))); // fmtDuration's days, 1dp (< 10d)
    set.add(canon(Math.round(abs / 24))); // fmtDuration's days, rounded (≥ 10d)
  }
}

function addStringNumerals(set: Set<string>, s: string): void {
  for (const m of s.match(NUMERAL_RE) ?? []) {
    set.add(canon(Number(m.replace(/,/g, ''))));
  }
}

// Fields whose numerals are NEVER quotable, whatever object the walk is handed: the generation
// wall-clock, the model id, and internal DB repo ids. `narrationPayload` contains none of these
// (that is the primary defence); this list is the belt for a report-shaped input.
const UNQUOTABLE_KEYS = new Set(['generatedAt', 'model', 'subsetRepoIds']);

/**
 * Every numeral the narrative is ALLOWED to contain, as canonical strings. A recursive walk of
 * the NARRATION PAYLOAD — the object the model was actually prompted with — so new payload
 * fields are grounded automatically rather than rejected until someone remembers to enumerate
 * them (fail-open on what the model saw, fail-closed on everything outside it — including the
 * raw report's `generatedAt` timestamp and `subsetRepoIds`, which the payload deliberately
 * omits; see the header note).
 */
export function groundingFigureSet(payload: unknown): Set<string> {
  const set = new Set<string>();
  const visit = (node: unknown, hourly: boolean): void => {
    if (typeof node === 'number') {
      addVariants(set, node, hourly);
      return;
    }
    if (typeof node === 'string') {
      addStringNumerals(set, node);
      return;
    }
    if (Array.isArray(node)) {
      set.add(canon(node.length));
      for (const item of node) visit(item, hourly);
      return;
    }
    if (node != null && typeof node === 'object') {
      // An object describing an hours metric ({key: 'median_lead_time_hours', value: …}) makes
      // its numeric fields hourly; so does an hours-named property (medianLeadTimeHours).
      const keyField = (node as { key?: unknown }).key;
      const keyedHourly = typeof keyField === 'string' && /hours/i.test(keyField);
      for (const [k, v] of Object.entries(node)) {
        if (UNQUOTABLE_KEYS.has(k)) continue;
        visit(v, hourly || keyedHourly || /hours/i.test(k));
      }
    }
  };
  visit(payload, false);
  return set;
}

/**
 * The numeral tokens in `text` with no matching figure in `allowed` — empty means the narrative
 * is grounded. Tokens are deduplicated; the caller logs them and falls back.
 */
export function ungroundedNumerals(text: string, allowed: ReadonlySet<string>): string[] {
  const out = new Set<string>();
  for (const m of text.match(NUMERAL_RE) ?? []) {
    if (!allowed.has(canon(Number(m.replace(/,/g, ''))))) out.add(m);
  }
  return [...out];
}

/**
 * The deterministic templated summary — what gets stored when the model's narrative fails the
 * check (D4: "a failed check falls back to the templated summary"). Every figure here is
 * computed, so it is grounded by construction; the reading is plain but the numbers are true,
 * which is the trade this feature makes everywhere. Mirrors the Advisor's templating discipline.
 */
export function templatedNarrative(report: PeriodReport): string {
  const lines: string[] = [];
  const c = report.coverage;
  lines.push(
    c.complete
      ? `All ${c.totalRepos} repos in this workspace were tracked across this period.`
      : `${c.trackedRepos} of ${c.totalRepos} repos were being tracked when this period started, so the figures under-count it.`,
  );
  const cmp = report.comparison;
  if (cmp.refusal != null) {
    lines.push(`No comparison against the prior period (${cmp.refusal.replace(/_/g, ' ')}).`);
  } else if (cmp.priorPeriodKey == null) {
    lines.push('No earlier period is stored, so there is nothing to compare against.');
  } else if (report.movements.length === 0) {
    lines.push(`Nothing moved significantly against ${cmp.priorPeriodKey}.`);
  } else {
    // ⚠ THE SAME RENDERER THE NARRATION PAYLOAD'S `phrase` USES — units and all. This file and
    // period-report.ts each had a private copy of the number spelling, so a figure could read
    // "38.55" in the model's write-up and "38.6" in the fallback that replaces it. One helper,
    // in period-questions.ts beside the unit table it reads.
    const phrased = report.movements.slice(0, 5).map(
      (m) => `${PERIOD_METRIC_LABEL[m.key]} ${movementPhrase(m, cmp.deltas.find((x) => x.key === m.key))}`,
    );
    lines.push(`Biggest movements vs the prior period: ${phrased.join('; ')}.`);
  }
  const refusedForecasts = report.forecasts.filter((f) => !f.available).length;
  if (report.forecasts.length > 0 && refusedForecasts === report.forecasts.length) {
    lines.push('No forecast was possible for any metric.');
  }
  lines.push(
    '_This summary is templated: the model write-up was rejected because it contained figures not present in the computed report._',
  );
  return lines.join('\n\n');
}
