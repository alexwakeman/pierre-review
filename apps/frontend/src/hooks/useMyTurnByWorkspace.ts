import { useMemo } from 'react';
import type { DailyBriefCounts } from '@pierre-review/shared';
import {
  myTurnPersonalCapDisclosure,
  personalMyTurnCount,
  type MyTurnCapDisclosure,
} from '../components/Activity/AttentionView.js';
import { useFilters } from '../store/filters.js';
import { useDailyBrief } from './useDailyBrief.js';
import { useWorkspaces } from './useWorkspaces.js';

/**
 * PER-WORKSPACE "MY TURN" COUNTS — the one source behind the Welcome-back banner's lines and the
 * Workspace dropdown's yellow badges.
 *
 * ── THE POPULATION IS THE PERSONAL ONE ────────────────────────────────────────────────────────
 * These two surfaces NOTIFY: they reach for the reader rather than waiting to be opened. So they
 * count `DailyBriefCounts.myTurnPersonal` — the my_turn cards that personally involve the viewer
 * (a review requested of them, their own PRs, threads awaiting their reply, plus new PRs in repos
 * they MAINTAIN or were @-mentioned on) — not the broad `myTurn`. Before this, adding a repo you
 * had never touched put every open PR in it on your welcome-back banner: 425 of 459 items were
 * "someone opened a PR somewhere you happen to track".
 *
 * ⚠ THE BOARD ITSELF KEEPS THE BROAD POPULATION — those PRs do still need a review, and hiding
 * them would delete work rather than route it. Which makes the divergence rule below load-bearing.
 *
 * ── ONE POPULATION, EVERYWHERE ────────────────────────────────────────────────────────────────
 * The figure is the STANDING `my_turn` CARD COUNT — the things on your plate right now — and NOT
 * "new feed events since you last looked". That distinction is the whole point of this hook: the
 * banner used to render `MeResponse.newFeedItems`, an ACCOUNT-WIDE tally of feed events cleared by
 * one account-wide `accounts.feedLastSeenAt` column, while the feed that bumped that column was
 * WORKSPACE-scoped. So the banner counted workspace B's events, you cleared them by reading
 * workspace A, and no click anywhere opened the list it named. Every number this hook returns is
 * `DailyBriefCounts.myTurn`, which is literally the number of `my_turn` cards
 * `GET /api/attention` paints for that workspace, narrowed by the same `personal` flag — and
 * `openMyTurnInWorkspace` seats `attentionPersonalOnly`, so the board the click opens paints
 * exactly those cards. Banner line, dropdown badge and destination board are therefore one fold
 * and one number.
 *
 * ⚠ THAT LAST CLAUSE IS THE WHOLE CONTRACT. A line that says 4 opening a board of 50 is the
 * "the strip says 5, the board lists 3" defect (747c9c9) in a new place — so a NARROW count may
 * only ever navigate through the gesture that seats the narrow lens.
 *
 * ── FRESHNESS: THE ACTIVE WORKSPACE IS NEVER READ FROM A CACHE ────────────────────────────────
 * `GET /api/daily-brief?rollup=1` deliberately serves its two halves differently (see
 * db/daily-brief.ts): the ACTIVE workspace's `counts` are computed FRESH on every request because
 * they sit above a live list, while the `rollup` lines describing OTHER workspaces ride a 5-min
 * TTL. This hook preserves that split rather than flattening it — `fresh` says which half a line
 * came from. A stale badge on the workspace you are LOOKING AT would disagree with the board on
 * screen (the exact defect the server-side cache split fixed); a ≤5-min-old badge on a workspace
 * you are not in cannot be contradicted by anything, because switching there re-derives it before
 * any list renders.
 *
 * ── NO SILENT CAPS, IN EITHER DIRECTION ───────────────────────────────────────────────────────
 *  • The CARD cap (50) is disclosed through the ONE `myTurnCapDisclosure` rule, so a badge and the
 *    brief and the board cannot phrase the same cap three ways. `count` always stays the CARD
 *    count — the list a click opens — never the uncapped total.
 *  • The ROLL-UP cap (the route returns at most N other workspaces) is surfaced as `uncounted`.
 *    A badge whose entire purpose is "you have work you cannot see from here" must not itself
 *    omit workspaces silently, and rendering those rows as a ZERO would be worse than omitting
 *    them — callers render absence, plus the `uncounted` disclosure.
 *
 * ⚠ `workspaceId === null` means UNRESOLVED. `useDailyBrief` holds itself idle (skipToken) until
 * then, so everything here is empty and NOTHING claims a workspace is uncounted while the brief
 * has not landed — "we haven't asked yet" must never render as "we asked and it wasn't there".
 *
 * ⚠ COST: this rides the EXISTING `['daily-brief', ws:<id>]` key, so the Feed's BriefStrip and the
 * attention board's cap disclosure share one request with it. Mounting it in the always-visible
 * FilterBar/banner does mean the Timeline now pays for one `search`-tier request per staleTime
 * window where it previously paid none — a counts-only fold, and the price of the badge being
 * visible from the board you are actually on. Never add a second query key for these numbers.
 */
// ⚠ THE SHARED CAP SENTENCE IS WRITTEN FOR THE BOARD YOU ARE STANDING ON — it says "…in this
// Workspace" — and this hook hands the very same disclosure to lines describing OTHER
// workspaces, on the two surfaces whose entire job is telling workspaces apart. Hovering the
// "Platform" row while scoped to Default and reading "148 items are on your plate in this
// Workspace" names Default, which is on screen right now with a different, smaller count.
//
// So the RULE still has exactly one owner — `myTurnCapDisclosure` decides whether a cap exists
// and owns the shown/total pair, which is what "one rule, not three phrasings" protects. The only
// thing re-homed here is the PLACE NAME. The phrase is pinned by test/myTurnCapDisclosure.test.ts
// so a reword of the shared sentence fails there, rather than silently reverting these lines to
// naming the wrong workspace.
const ACTIVE_WORKSPACE_PHRASE = 'in this Workspace';

// ⚠ AND IT IS THE **PERSONAL** RULE. The figure on these two surfaces is `myTurnPersonal`, so its
// denominator has to be `myTurnPersonalTotal`: the broad rule gates on `shown === counts.myTurn`,
// which a narrow figure fails on precisely the workspaces this narrowing exists for — the badge
// would silently lose its "+" and, if it hadn't, would have printed a narrow count over a broad
// total. Pair narrow with narrow.
export function workspaceCapDisclosure(
  counts: DailyBriefCounts,
  isActive: boolean,
  name: string,
): MyTurnCapDisclosure | null {
  const cap = myTurnPersonalCapDisclosure(personalMyTurnCount(counts), counts);
  if (cap == null || isActive) return cap;
  return { ...cap, title: cap.title.replace(ACTIVE_WORKSPACE_PHRASE, `in ${name}`) };
}

export interface WorkspaceMyTurnLine {
  workspaceId: number;
  name: string;
  /** The workspace the user is currently scoped to (the one they CAN see from here). */
  isActive: boolean;
  /** The PERSONAL my_turn CARD count — the list `openMyTurnInWorkspace(workspaceId)` opens, which
   *  seats the matching lens on the board. Falls back to the broad count on a response that
   *  predates the narrowing (and `openMyTurnInWorkspace`'s lens is then a no-op filter, so the
   *  two still agree). */
  count: number;
  /** Set only when that fold is capped; rendered as a "+" plus the exact pair in a title. The
   *  title names THIS line's workspace (see `workspaceCapDisclosure`), because a caller renders
   *  it on a row for a workspace the user is not in. */
  cap: MyTurnCapDisclosure | null;
  /** true = computed on this request; false = from the roll-up's ≤5-min server cache. */
  fresh: boolean;
}

export interface MyTurnByWorkspace {
  /** Every workspace we have a number for, INCLUDING zeros. Absent = not counted, not zero. */
  byWorkspace: Map<number, WorkspaceMyTurnLine>;
  /** Only the non-zero lines, active workspace first, then alphabetical. */
  lines: WorkspaceMyTurnLine[];
  /** Sum over `lines`. Capped card counts, so `anyCapped` qualifies it. */
  total: number;
  /** Sum over the non-active lines — "work you cannot see from where you are". */
  elsewhereCount: number;
  /** True when ANY contributing line is capped, so a summed figure can say "N+". */
  anyCapped: boolean;
  /** The same, restricted to the lines `elsewhereCount` sums — the two must not be crossed, or
   *  a capped ACTIVE workspace would put a "+" on a figure it contributes nothing to. */
  elsewhereCapped: boolean;
  /** Workspaces the roll-up did not cover. Disclosed by the caller, never dropped. */
  uncounted: { id: number; name: string }[];
}

const EMPTY: MyTurnByWorkspace = {
  byWorkspace: new Map(),
  lines: [],
  total: 0,
  elsewhereCount: 0,
  anyCapped: false,
  elsewhereCapped: false,
  uncounted: [],
};

export function useMyTurnByWorkspace(): MyTurnByWorkspace {
  const workspaceId = useFilters((s) => s.workspaceId);
  const { data: workspaces } = useWorkspaces();
  const { data: brief } = useDailyBrief(workspaceId);

  return useMemo(() => {
    if (brief == null) return EMPTY;
    const all = workspaces ?? [];
    const nameById = new Map(all.map((w) => [w.id, w.name]));
    const byWorkspace = new Map<number, WorkspaceMyTurnLine>();

    // The ACTIVE line's identity comes from the RESPONSE, not the store: `?workspace=` degrades a
    // foreign/dead id to the account's Default rather than 404ing, so the id that was actually
    // folded is the one the server echoed. Using the store's id here would mark the wrong row
    // active for the one render before useWorkspaceSync repairs it.
    const activeId = brief.workspaceId;
    const add = (id: number, counts: DailyBriefCounts, fresh: boolean, fallback: string): void => {
      const isActive = id === activeId;
      const name = nameById.get(id) ?? fallback;
      byWorkspace.set(id, {
        workspaceId: id,
        name,
        isActive,
        count: personalMyTurnCount(counts),
        // Named for THIS line's workspace, never "this Workspace" — see the note above.
        cap: workspaceCapDisclosure(counts, isActive, name),
        fresh,
      });
    };
    add(activeId, brief.counts, true, 'This Workspace');
    for (const line of brief.rollup ?? []) add(line.workspaceId, line.counts, false, line.name);

    const lines = [...byWorkspace.values()]
      .filter((l) => l.count > 0)
      .sort((a, b) => {
        if (a.isActive !== b.isActive) return a.isActive ? -1 : 1;
        return a.name.localeCompare(b.name);
      });

    let total = 0;
    let elsewhereCount = 0;
    let anyCapped = false;
    let elsewhereCapped = false;
    for (const l of lines) {
      total += l.count;
      if (l.cap != null) anyCapped = true;
      if (l.isActive) continue;
      elsewhereCount += l.count;
      if (l.cap != null) elsewhereCapped = true;
    }

    // The roll-up's own cap, made visible. Only computable once the brief has landed — see the
    // unresolved-workspace rule in the header.
    const uncounted = all
      .filter((w) => !byWorkspace.has(w.id))
      .map((w) => ({ id: w.id, name: w.name }));

    return { byWorkspace, lines, total, elsewhereCount, anyCapped, elsewhereCapped, uncounted };
  }, [brief, workspaces]);
}
