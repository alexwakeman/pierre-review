import type {
  CourtDirective,
  CourtShare,
  FlowCoverage,
  FlowResponse,
  PrCourt,
  RepoCourtProfile,
} from '@pierre-review/shared';
import type { InsightsInnerTab } from '../../store/filters.js';

// The render model for "Chronology" — the COURT LEDGER panel on the Reports rail.
//
// ⚠ WHAT THIS REPLACED. The pane used to render path-bucket findings and say things like
// "src/** is a bottleneck". A directory is four proxies from anything a manager can change, and on
// a conventional single-package repo `src/**` IS the repository. The unit is now a WAITING
// INTERVAL charged to whoever was holding the ball, which carries the three things a unit needs to
// be actionable: an owner, a duration, and an exit condition.
//
// ⚠ THE PANEL RENDERS NO PERSON. Not a name, not an avatar, not a count per head. The courts are
// about the flow; the moment a row's subject becomes an engineer this is a performance dashboard,
// which is a different product. The server does not even send actor ids any more — that is
// deliberate and this file must not reintroduce them.

/** Fixed order everywhere on screen, so the legend, the bars and the sections all agree. */
export const COURT_ORDER: readonly PrCourt[] = ['reviewer', 'author', 'landing'] as const;

/** What each court is called on screen. Plain English — an EM should not have to learn a word. */
export const COURT_LABEL: Record<PrCourt, string> = {
  reviewer: 'Waiting for a reviewer',
  author: 'Waiting for the author',
  landing: 'Approved, waiting to land',
};

/** The compact form, for a legend or a chip where the full label will not fit. */
export const COURT_SHORT: Record<PrCourt, string> = {
  reviewer: 'Reviewer',
  author: 'Author',
  landing: 'Landing',
};

/**
 * DERIVE the visible tab; never write a correction back to the store.
 *
 * The only degradation left is a value outside the union — a hand-edited `?insightsTab=`, or a
 * member removed in a later build whose literal still sits in a history entry a browser Back
 * replays. It normalises FOR THE RENDER only: a `set…()` here would permanently forget the
 * reader's choice, which is the bug `botsInnerTab` / `feedInnerTab` carry the same comment against.
 */
export function effectiveInsightsTab(raw: string | null | undefined): InsightsInnerTab {
  return raw === 'bottlenecks' ? 'bottlenecks' : 'overview';
}

// ── Formatting ───────────────────────────────────────────────────────────────────────────────
//
// ⚠ THE WIRE CARRIES RAW HOURS AND THIS IS THE ONLY PLACE THEY BECOME TEXT. The server's templated
// sentences do their own formatting for prose; every FIGURE on screen comes through here, so a
// duration can never appear in two spellings on one row.

function oneDp(n: number): string {
  return n.toFixed(1).replace(/\.0$/, '');
}

/** A duration, at the scale a reader can hold in their head. */
export function formatHours(h: number): string {
  if (!Number.isFinite(h) || h <= 0) return '0h';
  if (h < 1) return `${Math.max(1, Math.round(h * 60))}m`;
  if (h < 10) return `${oneDp(h)}h`;
  if (h < 48) return `${Math.round(h)}h`;
  return `${oneDp(h / 24)}d`;
}

export function formatPct(share: number): string {
  return `${Math.round(share * 100)}%`;
}

/** A share of a whole, for a bar segment's width. Clamped so a rounding artefact cannot overflow. */
export function barWidth(share: number): string {
  return `${Math.max(0, Math.min(100, share * 100)).toFixed(2)}%`;
}

export interface CourtSection {
  court: PrCourt;
  label: string;
  directive: string;
  repos: RepoCourtProfile[];
}

export interface BottlenecksModel {
  /** The window the SERVER measured, echoed back — it clamps to [7, 90], so a bookmarked
   *  `?days=400` is answered over 90 and every sentence on screen must say 90. */
  windowDays: number;
  measuredPrs: number;
  headline: string | null;
  courts: CourtShare[];
  medianLeadHours: number;
  p75LeadHours: number;
  /** Repos WITH a named court, grouped under it. The advice is stated once per section. */
  sections: CourtSection[];
  /** Repos measured but not lopsided-and-slow. Rendered quietly — they are the healthy ones, and
   *  showing them is what stops the panel reading as "everything is on fire". */
  quiet: RepoCourtProfile[];
  unreviewed: FlowResponse['unreviewed'];
  refusals: FlowResponse['refusals'];
  coverage: FlowCoverage;
  /** Nothing was measurable at all — distinct from "measured, nothing stood out". */
  nothingMeasured: boolean;
}

export function buildBottlenecksModel(resp: FlowResponse | undefined): BottlenecksModel | null {
  if (resp == null) return null;
  const byCourt = new Map<PrCourt, CourtDirective>(resp.directives.map((d) => [d.court, d]));
  const sections: CourtSection[] = [];
  for (const court of COURT_ORDER) {
    const repos = resp.repos.filter((r) => r.dominant === court);
    if (repos.length === 0) continue;
    sections.push({
      court,
      label: COURT_LABEL[court],
      // A directive the server did not send is not invented here. An older build simply renders
      // the section with its figures and no advice, which is honest.
      directive: byCourt.get(court)?.directive ?? '',
      repos,
    });
  }
  return {
    windowDays: resp.windowDays,
    measuredPrs: resp.measuredPrs,
    headline: resp.headline,
    courts: resp.courts,
    medianLeadHours: resp.medianLeadHours,
    p75LeadHours: resp.p75LeadHours,
    sections,
    quiet: resp.repos.filter((r) => r.dominant == null),
    unreviewed: resp.unreviewed,
    refusals: resp.refusals,
    coverage: resp.coverage,
    nothingMeasured: resp.measuredPrs === 0,
  };
}

/**
 * "Measured N of M repositories · N pull requests · last D days."
 *
 * ⚠ ALWAYS RENDERED. Retroactive history is coverage-biased — a workspace that onboarded repos
 * across the window produces figures that are partly onboarding, and `reposWithData` is the only
 * defence a reader has against believing otherwise.
 */
export function coverageLineFor(c: FlowCoverage, windowDays: number): string {
  const repos = `${c.reposWithData} of ${c.reposInWorkspace} ${
    c.reposInWorkspace === 1 ? 'repository' : 'repositories'
  }`;
  const prs = `${c.prsScanned} merged pull ${c.prsScanned === 1 ? 'request' : 'requests'}`;
  return `Measured ${repos} · ${prs} · last ${windowDays} days.`;
}

/**
 * What was set aside, and why. ⚠ BOTH EXCLUSIONS ARE LOAD-BEARING and a reader who does not know
 * about them will mis-read every share on the page:
 *
 *   • bot-authored — 43% of merges on a real workspace, and SLOWER than human ones, so blending
 *     them moved every figure. Without this line the reader cannot tell that this screen is about
 *     work a person wrote.
 *   • never-human-touched — their ledger is 100% reviewer by construction, so including them would
 *     drive the reviewer share towards 100% on any repo that merges unreviewed work.
 */
export function exclusionLineFor(c: FlowCoverage): string | null {
  const parts: string[] = [];
  if (c.excludedBotAuthored > 0) {
    parts.push(`${c.excludedBotAuthored} opened by automation`);
  }
  if (c.excludedNoHumanTouch > 0) {
    parts.push(`${c.excludedNoHumanTouch} that no person ever reviewed or commented on`);
  }
  if (parts.length === 0) return null;
  return `Set aside: ${parts.join(', and ')}.`;
}

/** A scan hit its cap, so the figures cover a PREFIX of the window — a claim about the period
 *  itself, and much stronger than the exclusions above. Kept separate for that reason. */
export function truncationLineFor(c: FlowCoverage): string | null {
  return c.truncated
    ? 'A scan reached its cap, so these figures come from part of the window only.'
    : null;
}
