import { useMemo, useState } from 'react';
import type { JSX } from 'react';
import type {
  PersonMetricKey,
  PersonMetricValue,
  PersonPeriod,
  StoredSynthesis,
} from '@pierre-review/shared';
import { useFilters } from '../../store/filters.js';
import { useProCapabilities } from '../../hooks/useTriage.js';
import { usePeriodReportsList } from '../../hooks/usePeriodReports.js';
import { usePersonPeriod } from '../../hooks/usePersonPeriod.js';
import { useAutoNarration, type SynthesisDescriptor } from '../../hooks/useSynthesis.js';
import { ProBadge, ProLockPanel, useProGateState } from '../ProGate.js';
import { periodTitle } from './periodReportMarkdown.js';

// The 1:1 prep header (plan P4.2 / N4) — mounted at the top of the EXISTING user-activity
// drill-down tab (no new tab kind): the person-period vector in the period table's idiom, a
// period selector defaulting to the report's current period, the Pro narration phrases above
// it, and the coverage annotations beside it.
//
// PREP, NOT SCORING (non-negotiable): this section renders ONE person. It carries no
// comparison against anyone else, no rank, no percentile — and the caption below the title
// says what it is so nobody reads it as a scorecard.
//
// The honesty rules travel from the period table unchanged:
//  • null renders "—", never 0 (a median over nothing / a share of no threads is NOT a zero).
//  • a thin sample is FLAGGED (`lowSample`, computed core-side — the floors live there).
//  • the three live keys are labelled "now": they are today's reading, not a period figure.
//  • partial repo coverage and a person first observed mid-window both ANNOTATE — a
//    mid-window joiner's figures under-count their period exactly like an onboarding repo's.
//
// D4 in the phrases: the narration (synthesis seam, kind 'person', ordering mode) is digit-free
// by server validation; every figure rendered here comes from the VECTOR response, never from
// model prose. A missing/failed narration costs nothing — the table is the surface.
//
// ── ENTITLEMENT: VISIBLE-BUT-LOCKED (Pro `periodReports`) ────────────────────────────────────
// This section used to be ABSENT without the capability — no fetch, no markup, nothing. That was
// the right default for a control nobody went looking for, and it is still the right default for
// most of them. It is the WRONG one here, because this is the ONLY place an unentitled reader
// can meet the People report at all: its picker lives inside the Reports pane's Pro half, and
// its report tab can only be opened from that picker. Absence here meant the whole feature was
// invisible to everyone who does not already have it — including the developer running a
// flag-less `pnpm dev`, for whom `periodReports` is false too.
//
// So: the pane exists, wears a `Pro` mark, and an unentitled reader lands on the locked pane
// with one sentence about what it answers. The surrounding tab (a contributor's activity feed)
// is FREE and unaffected — this is one dashed box above it, not a wall in front of it.

const MUTED = 'text-gray-400';

// Presentation only (labels + how a value prints) — the floors/basis stay core-side and arrive
// on the wire. The ORDER comes from the response vector itself (PERSON_METRIC_KEYS order).
export const KEY_LABEL: Record<PersonMetricKey, string> = {
  merged_prs_authored: 'PRs merged (authored)',
  opened_prs_authored: 'PRs opened',
  reviews_given: 'Reviews given',
  review_comments_written: 'Review comments written',
  median_review_response_hours: 'Median review response',
  median_first_human_review_hours_their_prs: 'Their PRs’ wait for a human review',
  review_threads_on_their_prs: 'Threads opened on their PRs',
  their_pr_threads_addressed: '…of those, addressed',
  awaiting_their_review: 'Waiting on their review',
  open_prs_authored: 'Open PRs (WIP)',
};

export const KEY_TITLE: Partial<Record<PersonMetricKey, string>> = {
  median_review_response_hours:
    'First review request on a PR → their first review of it, over PRs they first reviewed in this period (only PRs with a recorded request)',
  median_first_human_review_hours_their_prs:
    'How long their PRs waited for a first review by a person — the same fold the period report uses, narrowed to their PRs',
  their_pr_threads_addressed:
    'Resolved or likely-addressed AS OF NOW — the threads are the period’s, the state is today’s',
};

export function fmtValue(m: PersonMetricValue): string {
  if (m.value == null) return '—';
  if (m.key === 'median_review_response_hours' || m.key === 'median_first_human_review_hours_their_prs') {
    return `${m.value}h`;
  }
  if (m.key === 'their_pr_threads_addressed') return `${m.value} of ${m.sampleSize}`;
  return String(m.value);
}

/** `pm<version>:<key>:<value>` → the metric key the ordering ref names (see synthesis-input). */
function refMetricKey(ref: string): string | null {
  const parts = ref.split(':');
  return parts.length >= 2 ? (parts[1] ?? null) : null;
}

function NarrationLines({
  synth,
  person,
}: {
  synth: StoredSynthesis | null;
  person: PersonPeriod;
}): JSX.Element | null {
  const byKey = useMemo(() => {
    const m = new Map<string, PersonMetricValue>();
    for (const v of person.metrics) m.set(v.key, v);
    return m;
  }, [person]);
  const items = synth?.ordering ?? [];
  if (items.length === 0) return null;
  return (
    <ul className="mb-2 flex flex-col gap-0.5">
      {items.slice(0, 4).map((it) => {
        const key = refMetricKey(it.ref);
        const metricValue = key != null ? byKey.get(key) : undefined;
        return (
          <li key={it.ref} className="flex items-baseline gap-2 text-xs">
            {/* The FIGURE comes from the vector response — the phrase is digit-free by server
                validation, and the number beside it must be ours (D4). */}
            {metricValue != null && (
              <span className="shrink-0 font-semibold tabular-nums text-gray-800 dark:text-gray-100">
                {fmtValue(metricValue)}
              </span>
            )}
            <span className="min-w-0 text-gray-600 dark:text-gray-300">{it.phrase}</span>
          </li>
        );
      })}
    </ul>
  );
}

export function PersonPeriodSection({ userId }: { userId: number }): JSX.Element | null {
  const { periodReports } = useProCapabilities();
  // Entitlement resolved against /api/me's flight (see the gate below). A hook, so it sits above
  // every early return.
  const gate = useProGateState(periodReports);
  const workspaceId = useFilters((s) => s.workspaceId);
  // "The report's current period" — the Reports selection is URL-mirrored store state, so the
  // section opens on whatever period the reader was just looking at over there.
  const reportKey = useFilters((s) => s.insightsReportKey);

  const list = usePeriodReportsList(periodReports, workspaceId);
  const periods = useMemo(() => list.data?.periods ?? [], [list.data]);

  // LOCAL selection, EFFECTIVE key derived (D7: a scalar may hold a key the list no longer
  // carries — compute, never write back): the user's own pick when still listed, else the
  // Reports selection, else the newest period.
  const [pickedKey, setPickedKey] = useState<string | null>(null);
  const effectiveKey = useMemo(() => {
    const has = (k: string | null): k is string =>
      k != null && periods.some((p) => p.periodKey === k);
    if (has(pickedKey)) return pickedKey;
    if (has(reportKey)) return reportKey;
    return periods[0]?.periodKey ?? null;
  }, [pickedKey, reportKey, periods]);

  const q = usePersonPeriod(periodReports, workspaceId, userId, effectiveKey);
  const person = q.data?.person ?? null;

  // The narration descriptor needs the REAL bounds, which the person response echoes.
  const fromMs = q.data?.periodStart != null ? Date.parse(q.data.periodStart) : null;
  const toMs = q.data?.periodEnd != null ? Date.parse(q.data.periodEnd) : null;
  const descriptor = useMemo<SynthesisDescriptor>(
    () => ({ kind: 'person', window: 'rolling_14', userId, fromMs, toMs }),
    [userId, fromMs, toMs],
  );
  const synth = useAutoNarration(
    workspaceId,
    descriptor,
    person != null && fromMs != null && toMs != null,
  );

  // Scope first: `null` is "not resolved yet", not "no workspace", and nothing workspace-scoped
  // may render — including the locked pane, whose copy would otherwise appear for a frame on a
  // tab that is about to render the real thing.
  if (workspaceId == null) return null;
  // Free tier / OSS / a flag-less local build: the LOCKED PANE, not absence (see the header).
  // `useProGateState` holds it at 'pending' while /api/me is in flight, so a paying account never
  // sees the lock flash — `useProCapabilities()` reads all-false until that query lands.
  // Still no request either way: the period list and the person vector both take the capability
  // as their `enabled`, and the narration holds on a resolved `person`.
  if (gate === 'pending') return null;
  if (gate === 'locked') {
    // ⚠ THE HEADING NAMES **THIS** SLOT, NOT THE RAIL FEATURE. `ProLockPanel`'s contract is "names
    // the VIEW", and the view this stands in for is the ONE-PERSON 1:1 prep section that renders
    // here when entitled — there is no picker anywhere on this tab. An earlier draft described the
    // multi-pick People report, which lives on a different rail entry: upgrading and coming back
    // to this tab would then have delivered something other than what the lock promised. The
    // multi-pick report is mentioned as a destination, not as this pane's contents.
    return (
      <ProLockPanel heading="1:1 prep" testId="person-period-locked">
        What one person did over a completed period — what they reviewed, what they authored, and
        how long others waited on them — in the shape of notes for a one-to-one. No rankings, and
        nobody is compared to anybody. Reports → People builds the same thing for several people or
        bots at once.
      </ProLockPanel>
    );
  }
  // ⚠ A DIFFERENT SITUATION, AND IT MUST STAY SILENT. `enabled: false` means the capability IS on
  // (this query only runs when it is) and the plugin has self-disabled its reports surface — a
  // stale /api/me, or `DIGEST_ENABLED` flipping. That is a PAYING account, and showing it the
  // locked pane would ask a customer to buy what they have already bought.
  if (list.data?.enabled === false) return null;

  const selected = periods.find((p) => p.periodKey === effectiveKey) ?? null;

  return (
    <section
      aria-label="1:1 prep"
      className="rounded-lg border border-gray-200 bg-white p-3 text-xs dark:border-gray-800 dark:bg-gray-950"
    >
      <div className="mb-1.5 flex flex-wrap items-baseline gap-2">
        <span className="text-[10px] font-semibold uppercase tracking-wide text-ai-ink">
          1:1 prep
        </span>
        {/* The Pro mark, rendered for the ENTITLED reader — the locked pane above says it with a
            padlock and a sentence, and once that is gone this chip is the only thing left saying
            which plan pays for the table below it. */}
        <ProBadge variant="heading" title="The People report is part of Pro." />
        {/* The design rule, in the UI's own words — one quiet line, always rendered. */}
        <span className={`text-[11px] ${MUTED}`}>
          prep for a 1:1, not a scorecard — one person, no rankings
        </span>
        {periods.length > 0 && (
          <select
            value={effectiveKey ?? ''}
            onChange={(e) => setPickedKey(e.target.value || null)}
            className="ml-auto rounded border border-gray-300 bg-white px-1 py-0.5 text-[11px] dark:border-gray-700 dark:bg-gray-950"
            title="The sprint period this vector covers (same cadence as Reports)"
          >
            {periods.map((p) => (
              <option key={p.periodKey} value={p.periodKey}>
                {periodTitle(p.periodStart, p.periodEnd)}
              </option>
            ))}
          </select>
        )}
      </div>

      {list.data != null && list.data.cadenceConfigured === false ? (
        <div className={`text-[11px] ${MUTED}`}>
          1:1 prep covers one sprint period — set a sprint cadence under Reports to unlock it.
        </div>
      ) : list.isLoading || q.isLoading ? (
        <div className={`py-1 text-[11px] ${MUTED}`}>Loading period figures…</div>
      ) : periods.length === 0 ? (
        <div className={`text-[11px] ${MUTED}`}>
          No completed periods yet — the first appears once a sprint boundary has passed.
        </div>
      ) : person == null ? (
        <div className={`text-[11px] ${MUTED}`}>
          Nothing to prep — no activity from them in this Workspace{selected ? ' ' : ''}
          {selected ? `(period ${periodTitle(selected.periodStart, selected.periodEnd)})` : ''}.
        </div>
      ) : (
        <>
          {/* Coverage honesty — both grains, stated beside the figures they qualify. */}
          {!person.coverage.complete && (
            <div className="mb-1.5 rounded-md border border-amber-300 bg-amber-50/50 px-2 py-1 text-[11px] text-amber-700 dark:border-amber-800 dark:bg-amber-950/20 dark:text-amber-300">
              Partial coverage: {person.coverage.trackedRepos} of {person.coverage.totalRepos}{' '}
              repos in this workspace were being tracked when this period started — these figures
              under-count it.
            </div>
          )}
          {person.firstObservedMidWindow && person.firstSeenAt != null && (
            <div className="mb-1.5 rounded-md border border-amber-300 bg-amber-50/50 px-2 py-1 text-[11px] text-amber-700 dark:border-amber-800 dark:bg-amber-950/20 dark:text-amber-300">
              First observed here {new Date(person.firstSeenAt).toLocaleDateString()} — after this
              period began, so the period figures under-count them.
            </div>
          )}

          <NarrationLines synth={synth} person={person} />

          <table className="w-full text-xs">
            <tbody>
              {person.metrics.map((m) => (
                <tr key={m.key} className="border-t border-gray-100 first:border-0 dark:border-gray-800">
                  <td className="py-1 pr-2 text-gray-500 dark:text-gray-400" title={KEY_TITLE[m.key]}>
                    {KEY_LABEL[m.key]}
                    {m.basis === 'live' && (
                      <span
                        className={`ml-1.5 rounded border border-gray-300 px-1 text-[9px] uppercase tracking-wide ${MUTED} dark:border-gray-700`}
                        title="A live reading — today’s state, not a period figure; it keeps moving after the period closes"
                      >
                        now
                      </span>
                    )}
                  </td>
                  <td className="py-1 text-right font-medium tabular-nums text-gray-800 dark:text-gray-100">
                    {/* null is "no data" and renders as a dash — NEVER as 0. */}
                    {fmtValue(m)}
                    {m.lowSample && m.value != null && (
                      <span
                        className={`ml-1 text-[10px] font-normal ${MUTED}`}
                        title="Below this metric’s sample floor — the figure is real, but thin"
                      >
                        · thin
                      </span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </section>
  );
}
