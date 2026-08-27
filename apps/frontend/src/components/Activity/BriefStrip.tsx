import { useMemo, useState } from 'react';
import type {
  DailyBriefCounts,
  InsightKind,
  StoredSynthesis,
  SynthesisOrderingItem,
} from '@pierre-review/shared';
import { useDailyBrief } from '../../hooks/useDailyBrief.js';
import { useAutoNarration, type SynthesisDescriptor } from '../../hooks/useSynthesis.js';
import { useProCapabilities } from '../../hooks/useTriage.js';
import { useFilters, type AttentionRelevanceLens } from '../../store/filters.js';
import { usePinnedTabs, type TabBotMeta } from '../../store/pinnedTabs.js';
import {
  ciFailingCapDisclosure,
  myTurnCapDisclosure,
  myTurnOtherCapDisclosure,
  myTurnPersonalCapDisclosure,
  personalMyTurnCount,
  type MyTurnCapDisclosure,
} from './AttentionView.js';

// The daily-brief strip (plan P3.1/N1 + P3.3/N5) — the first thing the Feed shows: one compact
// line per thing that needs the viewer, each line DEEP-LINKING to the surface that owns its
// number (so the strip never grows its own drill-downs), plus a collapsed "Elsewhere" roll-up of
// per-workspace counts when other workspaces have something to say.
//
// ⚠ A LINE'S CLICK MUST LAND ON THE LIST ITS NUMBER COUNTS. The four workspace lines open the
// "Needs attention" board ISOLATED to their own card kind (`setAttentionIsolation`), because a
// figure that drops the reader on an undifferentiated board is a figure with no list behind it.
// The my-turn line used to be worse than that: it flipped a Feed pill sitting below three
// panels, through a setter that no-ops when the rail is already 'feed' — a click with no
// observable effect at all. The "Elsewhere" lines obey the same rule ACROSS workspaces, through
// `openMyTurnInWorkspace` — the one action the Welcome-back banner's lines use, so the app's two
// cross-workspace surfaces behave identically. (A bare `setWorkspace` here half-navigated: it
// changed scope and left the reader on that workspace's Feed, not on the cards it counted.)
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

type ScalarKey =
  | 'myTurn'
  // The second half of the my-turn split — its own line, its own figure, its own lens. ⚠ It is a
  // SIBLING of 'myTurn', not a variant of it: the two lines are mutually exclusive populations and
  // the Pro ordering map keys on this string, so sharing a key would let one phrase reword both.
  | 'myTurnOther'
  | 'ciFailing'
  | 'stalled'
  | 'untouched'
  | 'needsReviewer'
  | 'resolveBacklog';

interface BriefLine {
  /** The count-free ref key the ordering refs resolve to ('myTurn' / 'anomaly:u42' / 'trunk:r7'). */
  refKey: string;
  count: number | null; // null = the line carries no figure (anomaly/trunk lines)
  text: string; // templated wording (digit-free; the count renders separately)
  onOpen: () => void;
  /**
   * Render `text` VERBATIM — never let the Pro narration reword this line.
   *
   * ⚠ Only the "need your attention" line sets this, and it must. That wording is a precise
   * OWNERSHIP CLAIM about a specific population, and the ordering model cannot restate it: it
   * sees a ref and a label, has no idea whose work is whose, and is explicitly FORBIDDEN from
   * writing "you"/"your" (the ownership gate in the plugin's parseOrderingOutput — added because
   * it kept labelling workspace-wide backlogs as the reader's). So a phrase here can only ever be
   * LESS accurate than the template: it silently turned "4 need your attention" into "4 items
   * awaiting review or reply", which is the generic line's sentence over the personal line's
   * figure — exactly the conflation this split exists to undo.
   */
  verbatim?: true;
  /** The my_turn CAP DISCLOSURE (the `my_turn` line only — see myTurnCapDisclosure). Renders as a
   *  superscript "+" beside the figure, with the exact pair in the line's `title`. Deliberately
   *  NOT rendered as "50 of 148" inline: this line's wording is a SENTENCE ("50 items need your
   *  review or reply"), and "50 of 148 items need your review or reply" claims only 50 of them
   *  do. "50⁺ items need your review or reply" is true as written, and the title carries the
   *  rest. The figure itself stays the CARD count, which is the list the click opens. */
  cap?: MyTurnCapDisclosure;
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
    // ⚠ NOT covered by `trunkRed` below: a red build on your OWN open PR leaves trunk green, and
    // without this the strip would hide itself over a line it has something to say on.
    (c.ciFailing ?? 0) > 0 ||
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
  const setAttentionIsolation = useFilters((s) => s.setAttentionIsolation);
  const setAttentionRelevance = useFilters((s) => s.setAttentionRelevance);
  // The cross-workspace "Elsewhere" lines navigate through this one action — see the button.
  const openMyTurnInWorkspace = useFilters((s) => s.openMyTurnInWorkspace);
  const openBotThreadsTab = usePinnedTabs((s) => s.openBotThreadsTab);
  const openBotDetailTab = usePinnedTabs((s) => s.openBotDetailTab);
  const { botDepth } = useProCapabilities();
  // The cross-workspace roll-up is COLLAPSED by default: it is the least urgent line in the
  // strip and the only one that grows with the account. Local component state on purpose —
  // transient, not persisted, not URL-synced, like every other control on this strip.
  const [elsewhereOpen, setElsewhereOpen] = useState(false);

  const { data } = useDailyBrief(workspaceId);
  const counts = data?.counts ?? null;
  const rollup = data?.rollup ?? [];
  // The cross-workspace roll-up, pre-folded into the bits each row renders.
  //
  // ⚠ THE "need you" FIGURE HERE IS THE PERSONAL ONE, unlike the strip's own lines above. These
  // rows are the daily-brief spelling of the Welcome-back banner: they describe work in a
  // workspace the reader is NOT in, and they navigate through the same `openMyTurnInWorkspace`,
  // which seats the board's personal lens. Keeping the broad figure here would put back exactly
  // the divergence this phase exists to prevent — "52 need you" opening a board of 3.
  // A row whose only content was a non-personal my-turn count therefore folds to NO bits, and is
  // dropped rather than rendered as a bare workspace name.
  const elsewhereLines = useMemo(
    () =>
      rollup
        .filter((w) => hasAnything(w.counts))
        .map((w) => {
          const needYou = personalMyTurnCount(w.counts);
          const cap = myTurnPersonalCapDisclosure(needYou, w.counts);
          const bits: string[] = [];
          // The cap gets the same "N+" treatment the other surfaces use — a capped figure is a
          // floor, and the exact pair rides the row's title.
          if (needYou > 0) bits.push(`${needYou}${cap != null ? '+' : ''} need you`);
          // Personal by construction (your PR / your repo's trunk), so it belongs in the row that
          // describes what needs YOU in a workspace you are not in.
          if ((w.counts.ciFailing ?? 0) > 0) bits.push(`${w.counts.ciFailing} red`);
          if (w.counts.stalled > 0) bits.push(`${w.counts.stalled} stalled`);
          if (w.counts.needsReviewer > 0) bits.push(`${w.counts.needsReviewer} need a reviewer`);
          if (w.counts.untouchedThreads > 0) bits.push(`${w.counts.untouchedThreads} untouched`);
          if (w.counts.resolveBacklog > 0) bits.push(`${w.counts.resolveBacklog} resolvable`);
          if (w.counts.botAnomalies.length > 0) bits.push('bot anomaly');
          if (w.counts.trunkRed.length > 0) bits.push('trunk red');
          return { workspaceId: w.workspaceId, name: w.name, bits, cap };
        })
        .filter((w) => w.bits.length > 0),
    [rollup],
  );

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
    const scalar = (
      key: ScalarKey,
      count: number,
      text: string,
      onOpen: () => void,
      cap?: MyTurnCapDisclosure | null,
      verbatim?: true,
    ): void => {
      if (count > 0) {
        out.push({
          refKey: key,
          count,
          text,
          onOpen,
          ...(cap ? { cap } : {}),
          ...(verbatim ? { verbatim } : {}),
        });
      }
    };
    // Every line below lands on the "Needs attention" board ISOLATED to the one card kind the
    // line is about, so the number the user clicked and the list they land on are the same
    // population. Four brief lines used to drop the reader on one undifferentiated board.
    //
    // ⚠ ORDERING: `setActivityRepo` FIRST, `setAttentionIsolation` SECOND. `setActivityRepo`
    // clears the isolation, AND early-returns an empty patch when the rail id is unchanged — so
    // isolating first would be wiped on the click that switches rail and survive on the clicks
    // that don't. The same rule PrDetail / BotOnlyPrsDetail document for `feedIsolatedPrId`.
    //
    // ⚠ AND IT SEATS THE RELEVANCE LENS EXPLICITLY — INCLUDING `null`. Every line here opens the
    // list ITS OWN number counts, and for the two my-turn lines that list is one HALF of the
    // my_turn population, so each passes the lens that paints its half; every other line counts a
    // whole kind and passes `null`. Seating (rather than clearing) is what makes the two my-turn
    // lines mutually exclusive on the board as well as in the strip.
    // ⚠ AND IT IS NEVER CONDITIONAL. `setActivityRepo` early-returns an empty patch when the rail
    // is already 'attention' — the common case here — so a lens left over from an earlier
    // welcome-back/badge click would survive and open a different list than the number clicked.
    const openAttention =
      (kind: InsightKind, lens: AttentionRelevanceLens | null = null) =>
      (): void => {
        setActivityRepo('attention');
        setAttentionIsolation(kind);
        setAttentionRelevance(lens);
      };
    // ── THE MY-TURN SPLIT: TWO MUTUALLY EXCLUSIVE LINES ─────────────────────────────────────
    //
    // ⚠ "items", not "events". These numbers ARE my_turn card counts — one clickable card per
    // row of GET /api/my-turn. It used to be a tally of feed EVENTS in a rolling 14 days, and
    // the line pointed at a Feed pill below three panels: a number with no list behind it.
    //
    // ⚠ And they are CAPPED (50 cards). The figure stays the card count — swapping in the uncapped
    // total would put the old bug back, a number 98 items wider than anything the click opens —
    // so the cap is DISCLOSED instead: `cap` adds a superscript "+" and the exact pair in the
    // tooltip.
    //
    // ⚠ ONE LINE BECAME TWO BECAUSE ONE NUMBER ANSWERED TWO QUESTIONS. "149 items need review or
    // reply" is true and useless: 5 of them were the reader's. The split is by
    // `MyTurnCard.relevance` — "N need your attention" is direct + maintained (the same
    // population every notification surface counts), "M need review or reply" is the rest — and
    // the two are DISJOINT and EXHAUSTIVE over the same cards, so a reader can read one, act on
    // it, and ignore the other without wondering what overlaps.
    //
    // ⚠ EACH LINE PAIRS WITH ITS OWN TOTAL AND SEATS ITS OWN LENS. Handing the broad `counts`
    // object to a narrow line would both mix populations and silently drop the "of N" (the
    // disclosure gates on `shown === count`), and landing both lines on the same board would put
    // back the "the strip says 5, the board lists 3" defect in the very feature built to fix it.
    //
    // ⚠ AND `myTurnOther` IS NEVER `myTurn - myTurnPersonal` — see myTurnOtherCapDisclosure.
    const myTurnPersonal = counts.myTurnPersonal;
    const myTurnOther = counts.myTurnOther;
    if (myTurnPersonal != null && myTurnOther != null) {
      scalar(
        'myTurn',
        myTurnPersonal,
        // May say "your" because it means it: authored by you, requested of you, replying to you,
        // mentioning you — plus new PRs in repos you maintain, which is orbit rather than
        // ownership but is still a claim on your attention (the CARD says which; see
        // cardKindLabel).
        'need your attention',
        openAttention('my_turn', 'mine'),
        myTurnPersonalCapDisclosure(myTurnPersonal, counts),
        // VERBATIM — see BriefLine.verbatim. The narration cannot say "your" and must not be
        // allowed to relabel this line's figure with the generic sentence.
        true,
      );
      scalar(
        'myTurnOther',
        myTurnOther,
        // ⚠ NOT "your review or reply". Nobody has named the reader on any of these; they are
        // work that needs *someone*, and this board is where it is meant to be found.
        'need review or reply',
        openAttention('my_turn', 'others'),
        myTurnOtherCapDisclosure(myTurnOther, counts),
      );
    } else {
      // A response predating the split (or one whose my_turn fold did not run) carries neither
      // half. ⚠ DEGRADE TO THE SINGLE BROAD LINE — never render one half and imply the other is
      // zero, and never subtract one from the other. Broad figure, broad total, no lens.
      scalar(
        'myTurn',
        counts.myTurn,
        'items need review or reply',
        openAttention('my_turn'),
        myTurnCapDisclosure(counts.myTurn, counts),
      );
    }
    // ⚠ A DIFFERENT LINE FROM THE `trunk is red` ONES BELOW, and neither absorbs the other. Those
    // name EVERY red trunk in the workspace and open that repo's console; this counts the red builds
    // that are YOURS — your own open PRs, plus trunk in repos you maintain — and opens the board
    // isolated to `ci_failing`. Same rule as everywhere on this strip: a figure's click lands on the
    // list its number counts, so two populations get two lines.
    scalar(
      'ciFailing',
      counts.ciFailing ?? 0,
      'red builds are yours to fix',
      openAttention('ci_failing'),
      ciFailingCapDisclosure(counts.ciFailing ?? 0, counts),
    );
    scalar(
      'stalled',
      counts.stalled,
      'PRs stalled awaiting review',
      openAttention('stalled_review'),
    );
    scalar(
      'untouched',
      counts.untouchedThreads,
      'review threads untouched',
      openAttention('untouched_thread'),
    );
    scalar(
      'needsReviewer',
      counts.needsReviewer,
      'PRs still need a reviewer',
      openAttention('reviewer_routing'),
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
    setAttentionIsolation,
    setAttentionRelevance,
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
          // A verbatim line never consults the narration — its wording is load-bearing.
          const phrase = l.verbatim ? null : (briefPhrases.get(l.refKey)?.phrase ?? null);
          return (
            <li key={l.refKey}>
              <button
                type="button"
                onClick={l.onOpen}
                // The cap sentence rides the WHOLE line's title, not the 6px superscript: a
                // disclosure nobody can hover is the silent cap again with extra steps.
                title={l.cap?.title}
                className="group flex w-full items-baseline gap-2 rounded px-1.5 py-0.5 text-left hover:bg-gray-50 dark:hover:bg-gray-900/60"
              >
                {l.count != null && (
                  <span className="w-6 shrink-0 text-right font-semibold tabular-nums text-gray-800 dark:text-gray-100">
                    {l.count}
                    {/* "50⁺" — one column, one line, and true as written. The exact "50 of 148"
                        lives in the title above; the sr-only twin spells it out, because a bare
                        "+" is the silent cap again for anyone not looking at the glyph. (An
                        aria-label on the <sup> would NOT do it — a role-less generic element is
                        not guaranteed to have one announced.) */}
                    {l.cap != null && (
                      <>
                        <sup className="ml-px text-[8px] font-normal text-gray-400" aria-hidden>
                          +
                        </sup>
                        <span className="sr-only"> of {l.cap.total}</span>
                      </>
                    )}
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
          // The cross-workspace roll-up: COLLAPSED by default behind a summary that still carries
          // the only number that matters closed — how many OTHER workspaces have something. Open,
          // it is one bullet per workspace rather than a wrapped run of buttons, which ran the
          // workspaces together into a single sentence.
          <li className="mt-1 border-t border-gray-100 pt-1 dark:border-gray-900">
            <button
              type="button"
              onClick={() => setElsewhereOpen((o) => !o)}
              aria-expanded={elsewhereOpen}
              className="group flex w-full items-baseline gap-2 rounded px-1.5 py-0.5 text-left hover:bg-gray-50 dark:hover:bg-gray-900/60"
            >
              <span className="w-6 shrink-0 text-right text-gray-400" aria-hidden>
                {elsewhereOpen ? '▾' : '▸'}
              </span>
              <span className="min-w-0 flex-1 truncate font-medium text-gray-400 group-hover:underline">
                Elsewhere ({elsewhereLines.length})
              </span>
            </button>
            {elsewhereOpen && (
              <ul className="mt-0.5 list-disc space-y-0.5 pl-12 marker:text-gray-300 dark:marker:text-gray-600">
                {/* Roll-up narration (Pro): one digit-free phrase per workspace, figures ours. */}
                {elsewhereLines.map((w) => {
                  const phrase = rollupPhrases.get(`ws:${w.workspaceId}`)?.phrase ?? null;
                  const bits = w.bits;
                  return (
                    <li key={w.workspaceId} className="min-w-0">
                      <button
                        type="button"
                        // ⚠ THE SAME GESTURE AS THE WELCOME-BACK BANNER'S LINE, and therefore the
                        // same store action. This line names work sitting in a workspace you are
                        // not in, so a click has to change scope AND land on the list it named: a
                        // bare `setWorkspace` re-scoped everything and then dropped the reader on
                        // that workspace's FEED, leaving them to find the cards this line just
                        // counted. `openMyTurnInWorkspace` does the whole ordered sequence —
                        // scope, then console, then the `my_turn` isolation (two independent
                        // ordering traps live in its declaration) — and it is one gesture, so one
                        // Back undoes it.
                        onClick={() => openMyTurnInWorkspace(w.workspaceId)}
                        // The cap sentence wins the title when there is one: it is the only place
                        // the exact pair behind the "+" is written down.
                        title={w.cap?.title ?? phrase ?? `Show what needs you in ${w.name}`}
                        className="w-full truncate text-left text-gray-500 hover:text-gray-700 hover:underline dark:text-gray-400 dark:hover:text-gray-200"
                      >
                        <span className="font-medium">{w.name}</span>: {bits.join(' · ')}
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </li>
        )}
      </ul>
    </section>
  );
}
