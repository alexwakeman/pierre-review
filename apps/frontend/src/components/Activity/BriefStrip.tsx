import { useMemo } from 'react';
import type {
  DailyBriefCounts,
  StoredSynthesis,
  SynthesisOrderingItem,
} from '@pierre-review/shared';
import { useDailyBrief } from '../../hooks/useDailyBrief.js';
import { useAutoNarration, type SynthesisDescriptor } from '../../hooks/useSynthesis.js';
import { useProCapabilities } from '../../hooks/useTriage.js';
import { useFilters } from '../../store/filters.js';
import { usePinnedTabs, type TabBotMeta } from '../../store/pinnedTabs.js';

// The daily-brief strip (plan P3.1/N1 + P3.3/N5) — the first thing the Feed shows: one compact
// line per thing that needs the viewer, each line DEEP-LINKING to the surface that owns its
// number (so the strip never grows its own drill-downs), plus an "Elsewhere" line of
// per-workspace counts when other workspaces have something to say.
//
// FREE = the templated count lines (counts from GET /api/daily-brief — every figure is the
// owning surface's own fold). PRO (`activityDigest`) = the synthesis seam's ORDERING mode
// (`kind:'brief'` / `'rollup'`): the model orders the lines and phrases each one DIGIT-FREE; the
// figures rendered here always come from the counts response, never from the model (D4). A
// missing/failed narration renders the templated lines exactly — the strip never waits on AI
// (§8.20). Generation is LAZY ON READ (the digest pattern): at most one auto-POST per stale
// scope per mount, and the payload hash (content, not date) makes an unchanged workspace a $0
// cache hit — rendered as "unchanged since <weekday>".
//
// Self-hides when everything is zero. Renders INLINE at the top of the Feed branch — no new
// fixed-position element (the one-toast-column rule).

type ScalarKey = 'myTurn' | 'stalled' | 'untouched' | 'needsReviewer' | 'resolveBacklog';

interface BriefLine {
  /** The count-free ref key the ordering refs resolve to ('myTurn' / 'anomaly:u42' / 'trunk:r7'). */
  refKey: string;
  count: number | null; // null = the line carries no figure (anomaly/trunk lines)
  text: string; // templated wording (digit-free; the count renders separately)
  onOpen: () => void;
}

/** The ordering ref's count-free identity: scalar ids are `myTurn:3` (count-encoded server-side
 *  for the content hash), entity ids are `anomaly:u42` / `trunk:r7` / `ws:9:<sig>` — the first
 *  one/two segments are the identity, the rest is content. */
function refKeyOf(ref: string): string {
  const parts = ref.split(':');
  if (parts[0] === 'anomaly' || parts[0] === 'trunk' || parts[0] === 'ws') {
    return `${parts[0]}:${parts[1] ?? ''}`;
  }
  return parts[0] ?? ref;
}

function orderingByKey(s: StoredSynthesis | null | undefined): Map<string, SynthesisOrderingItem> {
  const map = new Map<string, SynthesisOrderingItem>();
  for (const it of s?.ordering ?? []) {
    const key = refKeyOf(it.ref);
    if (!map.has(key)) map.set(key, it);
  }
  return map;
}

function hasAnything(c: DailyBriefCounts): boolean {
  return (
    c.myTurn > 0 ||
    c.stalled > 0 ||
    c.untouchedThreads > 0 ||
    c.needsReviewer > 0 ||
    c.resolveBacklog > 0 ||
    c.botAnomalies.length > 0 ||
    c.trunkRed.length > 0
  );
}

const WEEKDAY = new Intl.DateTimeFormat(undefined, { weekday: 'short' });

// (`useAutoNarration` — the one-attempt-per-staleness lazy generation guard — moved to
// hooks/useSynthesis.ts so the 1:1 person section reuses the same guard instead of a second
// spelling of it. Behaviour here is unchanged.)

export function BriefStrip(): JSX.Element | null {
  const workspaceId = useFilters((s) => s.workspaceId);
  const setActivityRepo = useFilters((s) => s.setActivityRepo);
  const setFeedMyTurnOnly = useFilters((s) => s.setFeedMyTurnOnly);
  const setWorkspace = useFilters((s) => s.setWorkspace);
  const openBotThreadsTab = usePinnedTabs((s) => s.openBotThreadsTab);
  const openBotDetailTab = usePinnedTabs((s) => s.openBotDetailTab);
  const { botDepth } = useProCapabilities();

  const { data } = useDailyBrief(workspaceId);
  const counts = data?.counts ?? null;
  const rollup = data?.rollup ?? [];
  const elsewhereLines = useMemo(() => rollup.filter((w) => hasAnything(w.counts)), [rollup]);

  const briefDescriptor = useMemo<SynthesisDescriptor>(
    () => ({ kind: 'brief', window: 'rolling_14' }),
    [],
  );
  const rollupDescriptor = useMemo<SynthesisDescriptor>(
    () => ({ kind: 'rollup', window: 'rolling_14' }),
    [],
  );
  const briefSynth = useAutoNarration(
    workspaceId,
    briefDescriptor,
    counts != null && hasAnything(counts),
  );
  const rollupSynth = useAutoNarration(workspaceId, rollupDescriptor, elsewhereLines.length > 0);
  const briefPhrases = useMemo(() => orderingByKey(briefSynth), [briefSynth]);
  const rollupPhrases = useMemo(() => orderingByKey(rollupSynth), [rollupSynth]);

  const lines = useMemo<BriefLine[]>(() => {
    if (counts == null) return [];
    const out: BriefLine[] = [];
    const scalar = (key: ScalarKey, count: number, text: string, onOpen: () => void): void => {
      if (count > 0) out.push({ refKey: key, count, text, onOpen });
    };
    scalar('myTurn', counts.myTurn, 'need your review or reply', () => {
      setActivityRepo('feed');
      setFeedMyTurnOnly(true);
    });
    scalar('stalled', counts.stalled, 'PRs stalled awaiting review', () =>
      setActivityRepo('attention'),
    );
    scalar('untouched', counts.untouchedThreads, 'review threads untouched', () =>
      setActivityRepo('attention'),
    );
    scalar('needsReviewer', counts.needsReviewer, 'PRs still need a reviewer', () =>
      setActivityRepo('attention'),
    );
    for (const r of counts.trunkRed) {
      out.push({
        refKey: `trunk:r${r.repoId}`,
        count: null,
        text: `${r.name}: trunk is red`,
        onOpen: () => setActivityRepo(r.repoId),
      });
    }
    for (const a of counts.botAnomalies) {
      out.push({
        refKey: `anomaly:u${a.userId}`,
        count: null,
        text: `${a.label}: unusual volume this week`,
        onOpen: () => {
          if (botDepth) {
            const meta: TabBotMeta = {
              id: a.userId,
              login: a.login,
              label: a.label,
              kind: a.kind ?? 'in_house',
              repoId: null,
            };
            openBotDetailTab(a.userId, meta);
          } else {
            setActivityRepo('bots');
          }
        },
      });
    }
    scalar('resolveBacklog', counts.resolveBacklog, 'bot threads ready to resolve', () =>
      openBotThreadsTab(),
    );
    // Pro ordering: narrated lines first, in model order; the rest keep the deterministic order
    // above. A rejected/missing phrase costs nothing — its line just stays templated.
    if (briefPhrases.size > 0) {
      const rank = new Map([...briefPhrases.keys()].map((k, i) => [k, i]));
      out.sort((a, b) => {
        const ra = rank.get(a.refKey) ?? Number.MAX_SAFE_INTEGER;
        const rb = rank.get(b.refKey) ?? Number.MAX_SAFE_INTEGER;
        return ra - rb;
      });
    }
    return out;
  }, [
    counts,
    briefPhrases,
    botDepth,
    openBotDetailTab,
    openBotThreadsTab,
    setActivityRepo,
    setFeedMyTurnOnly,
  ]);

  // Self-hide: nothing to say here AND nothing elsewhere. (Also while the workspace/brief is
  // still resolving — the strip appears only with real content, never as a skeleton.)
  if (workspaceId == null || counts == null || (lines.length === 0 && elsewhereLines.length === 0)) {
    return null;
  }

  const unchangedSince =
    briefSynth != null && briefPhrases.size > 0
      ? WEEKDAY.format(new Date(briefSynth.generatedAt))
      : null;

  return (
    <section
      aria-label="Daily brief"
      className="rounded-lg border border-gray-200 bg-white p-2.5 text-xs dark:border-gray-800 dark:bg-gray-950"
    >
      <div className="mb-1 flex items-center gap-2 px-0.5">
        <span className="font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">
          Today
        </span>
        {unchangedSince != null && (
          <span
            className="text-[10px] text-gray-400"
            title="The narration is cached on the brief's content — it regenerates only when the counts change"
          >
            unchanged since {unchangedSince}
          </span>
        )}
      </div>
      <ul className="flex flex-col gap-0.5">
        {lines.map((l) => {
          const phrase = briefPhrases.get(l.refKey)?.phrase ?? null;
          return (
            <li key={l.refKey}>
              <button
                type="button"
                onClick={l.onOpen}
                className="group flex w-full items-baseline gap-2 rounded px-1.5 py-0.5 text-left hover:bg-gray-50 dark:hover:bg-gray-900/60"
              >
                {l.count != null && (
                  <span className="w-6 shrink-0 text-right font-semibold tabular-nums text-gray-800 dark:text-gray-100">
                    {l.count}
                  </span>
                )}
                <span
                  className={`min-w-0 flex-1 truncate text-gray-600 group-hover:underline dark:text-gray-300 ${
                    l.count == null ? 'pl-8' : ''
                  }`}
                >
                  {/* The Pro phrase rewords the line; the FIGURE always renders from counts. */}
                  {phrase ?? l.text}
                </span>
              </button>
            </li>
          );
        })}
        {elsewhereLines.length > 0 && (
          <li className="mt-1 border-t border-gray-100 pt-1 dark:border-gray-900">
            <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 px-1.5">
              <span className="shrink-0 font-medium text-gray-400">Elsewhere</span>
              {/* Roll-up narration (Pro): one digit-free phrase per workspace, figures ours. */}
              {elsewhereLines.map((w) => {
                const phrase = rollupPhrases.get(`ws:${w.workspaceId}`)?.phrase ?? null;
                const bits: string[] = [];
                if (w.counts.myTurn > 0) bits.push(`${w.counts.myTurn} need you`);
                if (w.counts.stalled > 0) bits.push(`${w.counts.stalled} stalled`);
                if (w.counts.needsReviewer > 0) bits.push(`${w.counts.needsReviewer} need a reviewer`);
                if (w.counts.untouchedThreads > 0) bits.push(`${w.counts.untouchedThreads} untouched`);
                if (w.counts.resolveBacklog > 0) bits.push(`${w.counts.resolveBacklog} resolvable`);
                if (w.counts.botAnomalies.length > 0) bits.push('bot anomaly');
                if (w.counts.trunkRed.length > 0) bits.push('trunk red');
                return (
                  <button
                    key={w.workspaceId}
                    type="button"
                    // A workspace switch re-scopes everything (repoIds reset to the whole
                    // workspace — the setWorkspace contract); the Feed then shows that
                    // workspace's own brief.
                    onClick={() => setWorkspace(w.workspaceId, null)}
                    title={phrase ?? `Switch to ${w.name}`}
                    className="text-gray-500 hover:text-gray-700 hover:underline dark:text-gray-400 dark:hover:text-gray-200"
                  >
                    <span className="font-medium">{w.name}</span>: {bits.join(' · ')}
                  </button>
                );
              })}
            </div>
          </li>
        )}
      </ul>
    </section>
  );
}
