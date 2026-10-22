import { createHash } from 'node:crypto';
import type {
  AutomatedReviewerKind,
  BotThemeAreaCount,
  BotThemeBotRollup,
  BotThemeCoverage,
  BotWindowKind,
  ThemeThreadRef,
} from '@pierre-review/shared';
import type { BotScopeWire, ProContext } from '../contract.js';

// The DETERMINISTIC funnel for the Bots "What they're flagging" AI summary. It turns the raw,
// high-volume, WORKSPACE-scoped bot review + PR comments into (a) a BOUNDED payload for one Haiku
// pass and (b) the exact aggregates that do NOT need a model (per-bot volume + acted-on %, area
// distribution, per-cluster counts, coverage). This is the "keep the prompt small" work — the LLM
// only ever sees the deduped, stripped, capped clusters, never the firehose — and the reason every
// figure the panel renders is a code fold (D4): the model contributes themes + narrative, nothing
// numeric.

// RE-DECLARED verbatim from the host's getBotReviewComments return (open-core boundary — the plugin
// imports no host internals). KEEP IN LOCKSTEP with apps/backend/src/db/queries.ts BotReviewCommentRow.
interface BotReviewCommentRow {
  id: number;
  source: 'review' | 'issue';
  prId: number;
  prNumber: number;
  repoId: number;
  repoFullName: string;
  path: string | null;
  authorUserId: number;
  reviewerKey: string; // `u<userId>`
  label: string;
  login: string | null;
  kind: AutomatedReviewerKind;
  body: string | null;
  createdAt: string; // ISO
  derivedState: string | null;
  threadId: number | null;
}

// A coarse severity/category prior read straight off the comment text (mirrors core inferSeverity +
// a light category scan). Only a HINT — it prioritises which clusters survive the cap and seeds the
// model; the model makes the final call. Kept tiny + deterministic.
type SeverityHint = 'issue' | 'refactor' | 'nitpick' | null;
function severityHint(text: string): SeverityHint {
  if (/\bnit(?:pick|:)|🧹/i.test(text)) return 'nitpick';
  if (/⚠️|potential issue|\bbug\b|security|vulnerab|\berror\b|\bnull\b|\bcrash|\brace\b/i.test(text))
    return 'issue';
  if (/🛠️|refactor|\bsuggestion\b|\bconsider\b|\bstyle\b|\btypo\b/i.test(text)) return 'refactor';
  return null;
}
const HINT_RANK: Record<Exclude<SeverityHint, null> | 'none', number> = {
  issue: 3,
  refactor: 2,
  nitpick: 1,
  none: 0,
};

// Strip a bot comment body down to its "what + why" sentence(s): drop fenced code blocks + the
// suggested-fix diff (the biggest token sink), blockquotes, HTML comments, images/badges, collapse
// whitespace, and clamp. Bots wrap a one-line point in a wall of code — this keeps the point.
const SNIPPET_MAX = 240;
function stripBody(body: string | null): string {
  if (!body) return '';
  let s = body;
  s = s.replace(/```[\s\S]*?```/g, ' '); // fenced code / suggestions
  s = s.replace(/<!--[\s\S]*?-->/g, ' '); // HTML comments / hidden markers
  s = s.replace(/!\[[^\]]*\]\([^)]*\)/g, ' '); // images / badges
  s = s.replace(/^\s{0,3}>.*$/gm, ' '); // blockquotes (quoted diff/context)
  s = s.replace(/`([^`]+)`/g, '$1'); // inline code → its text
  s = s.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1'); // links → their text
  s = s.replace(/[#*_>|]+/g, ' '); // markdown punctuation
  s = s.replace(/\s+/g, ' ').trim();
  return s.length > SNIPPET_MAX ? `${s.slice(0, SNIPPET_MAX).trimEnd()}…` : s;
}

// The dedup key: aggressively normalise so "add a null check for user" and "add a null check for
// account" collapse to one theme (bots repeat a point across files). Lowercase, letters-only,
// clamp — distinct classes of issue keep distinct keys.
function dedupKey(snippet: string): string {
  const norm = snippet
    .toLowerCase()
    .replace(/[^a-z]+/g, ' ')
    .trim()
    .slice(0, 100);
  return norm || snippet.slice(0, 40).toLowerCase();
}

// Top-level codebase area (first path segment) — the same "where" grouping the core "Where bots
// work" chart uses. PR-level (issue) comments have no path.
function areaOf(path: string | null): string {
  if (path == null) return '(pr-level)';
  const seg = path.split('/')[0] ?? '';
  return seg === '' ? '(root)' : seg;
}

const ACTED_ON = new Set(['resolved', 'likely_addressed']);

// One deduped cluster of near-identical comments — the LLM's unit of input. `members` retains a few
// concrete thread/comment refs so a theme (which cites cluster ids) can be expanded to real threads
// for the drill-down; `prRefs` maps prNumber → a ref so the resolver can build clickable PR chips.
interface Cluster {
  key: string;
  rep: string; // representative stripped snippet
  count: number;
  hint: SeverityHint;
  prs: Set<number>;
  areas: Set<string>;
  bots: Set<string>;
  members: ThemeThreadRef[]; // capped concrete member refs (see MEMBERS_PER_CLUSTER)
}

export interface BotThemesBuild {
  empty: boolean; // no bot comments in scope/window
  payload: unknown; // the bounded LLM input
  hash: string; // $0-on-unchanged payload hash
  windowKind: BotWindowKind;
  // Deterministic aggregates (NOT model-derived) surfaced verbatim in the result.
  bots: BotThemeBotRollup[];
  byArea: BotThemeAreaCount[];
  coverage: BotThemeCoverage;
  // payload cluster id (0-based, matches payload.clusters[i].id) → its concrete member thread refs.
  // The resolver expands a theme's memberIds through this into `prs` + `threads`.
  memberIndex: Map<number, ThemeThreadRef[]>;
  // payload cluster id → its deterministic member count (near-identical comments folded in).
  // routes.ts sums this over a theme's VALIDATED memberIds → BotTheme.commentCount, so the number
  // the card renders is a code fold of code-derived counts (D4) — never the model's `occurrences`.
  countIndex: Map<number, number>;
}

const CLUSTER_CAP = 140; // clusters sent to the model (post-dedup, prioritised by severity + volume)
const PRS_PER_CLUSTER = 5;
const AREAS_PER_CLUSTER = 4;
const BOTS_PER_CLUSTER = 3;
const AREA_ROLLUP_CAP = 12;
const MEMBERS_PER_CLUSTER = 6; // concrete thread refs retained per cluster for the drill-down

// `scope` arrives ALREADY NARROWED from routes.ts (workspace membership ∩ any `?repoIds=`
// narrowing — resolveThemesScope, the behaviour-routes pattern), so the `repoIds ⊆ membership`
// BotScopeWire invariant is the caller's to uphold and the workspace still decides who counts as
// an automated reviewer (inside the host getter). `scopeKey` is the routes' canonical serialised
// key for the same scope — folded into the payload + hash so a per-repo narrowing can never be a
// cache hit against the cross-repo report.
export async function buildBotThemes(
  ctx: ProContext,
  accountId: number,
  scope: BotScopeWire,
  window: BotWindowKind,
  scopeKey: string,
): Promise<BotThemesBuild | null> {
  // `repoIds: []` is an ordinary state — an empty workspace, or a narrowing that intersects to
  // nothing: there is nothing in scope to answer about, so nothing is queried and nothing billed.
  if (scope.repoIds.length === 0) return null;

  const { comments, truncated } = (await ctx.queries.getBotReviewComments(
    accountId,
    window,
    scope,
  )) as { comments: BotReviewCommentRow[]; truncated: boolean };

  const emptyCoverage: BotThemeCoverage = {
    totalComments: 0,
    deduped: 0,
    analyzed: 0,
    truncated: false,
  };
  if (comments.length === 0) {
    return {
      empty: true,
      payload: null,
      hash: '',
      windowKind: window,
      bots: [],
      byArea: [],
      coverage: emptyCoverage,
      memberIndex: new Map(),
      countIndex: new Map(),
    };
  }

  // ── deterministic aggregates over the FULL analyzed set ──────────────────────────────────────
  const botAcc = new Map<
    string,
    {
      label: string;
      login: string | null;
      kind: AutomatedReviewerKind;
      comments: number;
      actedDenom: number; // rows carrying a derivedState (inline threads)
      actedNum: number;
    }
  >();
  const areaAcc = new Map<string, number>();
  const clusters = new Map<string, Cluster>();

  for (const c of comments) {
    // Per-bot volume + acted-on (acted-on only defined for inline-thread comments).
    let b = botAcc.get(c.reviewerKey);
    if (!b) {
      b = { label: c.label, login: c.login, kind: c.kind, comments: 0, actedDenom: 0, actedNum: 0 };
      botAcc.set(c.reviewerKey, b);
    }
    b.comments += 1;
    if (c.source === 'review' && c.derivedState != null) {
      b.actedDenom += 1;
      if (ACTED_ON.has(c.derivedState)) b.actedNum += 1;
    }

    const area = areaOf(c.path);
    areaAcc.set(area, (areaAcc.get(area) ?? 0) + 1);

    // Cluster the stripped body (dedup).
    const snippet = stripBody(c.body);
    if (!snippet) continue; // a body-less / all-code comment carries no theme signal
    const key = dedupKey(snippet);
    let cl = clusters.get(key);
    if (!cl) {
      cl = { key, rep: snippet, count: 0, hint: severityHint(snippet), prs: new Set(), areas: new Set(), bots: new Set(), members: [] };
      clusters.set(key, cl);
    }
    cl.count += 1;
    cl.prs.add(c.prNumber);
    cl.areas.add(area);
    cl.bots.add(c.label);
    if (cl.members.length < MEMBERS_PER_CLUSTER) {
      cl.members.push({
        prId: c.prId,
        prNumber: c.prNumber,
        repoFullName: c.repoFullName,
        source: c.source,
        threadId: c.source === 'review' ? c.threadId : null,
        commentId: c.source === 'issue' ? c.id : null,
        path: c.path,
      });
    }
  }

  const bots: BotThemeBotRollup[] = [...botAcc.entries()]
    .map(([key, v]) => ({
      key,
      label: v.label,
      login: v.login,
      kind: v.kind,
      comments: v.comments,
      actedOnPct: v.actedDenom > 0 ? Math.round((v.actedNum / v.actedDenom) * 100) : null,
    }))
    .sort((a, b) => b.comments - a.comments);

  const byArea: BotThemeAreaCount[] = [...areaAcc.entries()]
    .map(([area, count]) => ({ area, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, AREA_ROLLUP_CAP);

  // ── prioritise + cap the clusters that go to the model ───────────────────────────────────────
  const allClusters = [...clusters.values()].sort((a, b) => {
    const ra = HINT_RANK[a.hint ?? 'none'];
    const rb = HINT_RANK[b.hint ?? 'none'];
    if (rb !== ra) return rb - ra; // severity hint first (keep the critical few)
    return b.count - a.count; // then volume
  });
  const capped = allClusters.slice(0, CLUSTER_CAP);

  const coverage: BotThemeCoverage = {
    totalComments: comments.length,
    deduped: clusters.size,
    analyzed: capped.length,
    truncated,
  };

  // ── the bounded LLM payload ──────────────────────────────────────────────────────────────────
  const payload = {
    window,
    scope: scopeKey,
    bots: bots.map((b) => ({ label: b.label, kind: b.kind, comments: b.comments })),
    clusters: capped.map((c, i) => ({
      id: i,
      text: c.rep,
      count: c.count,
      severityHint: c.hint,
      areas: [...c.areas].slice(0, AREAS_PER_CLUSTER),
      bots: [...c.bots].slice(0, BOTS_PER_CLUSTER),
      prs: [...c.prs].slice(0, PRS_PER_CLUSTER),
    })),
  };

  // The $0-on-unchanged key — NOTHING VOLATILE in the sig (the synthesis hash rule: a dormant
  // scope must stay a cache hit forever; the legacy formula's day-quantised `windowKey` re-billed
  // every dormant scope daily and is DROPPED). The SET of cluster keys is content-derived, so
  // membership drift regenerates while pure volume drift is a $0 hit; counts stay deliberately
  // excluded (they slide with the clock as comments arrive). `bt2` is the version literal
  // (schema + prompt fold — bumping it self-invalidates every stored row on the next click; rows
  // hashed under the legacy formula simply miss once and regenerate). Deliberate consequence,
  // stated: with generation manual-only there is NO time-based staleness at all — a Regenerate on
  // an unchanged corpus is free forever.
  const sig = [
    'bt2',
    'w',
    window,
    's',
    scopeKey,
    'b',
    ...bots.map((b) => b.key).sort(),
    'c',
    ...capped.map((c) => c.key).sort(),
  ].join('|');
  const hash = createHash('sha256').update(sig).digest('hex');

  // payload cluster id (i) → its concrete member thread refs (for theme-ref resolution) + its
  // deterministic count (for the per-theme commentCount fold in routes.ts).
  const memberIndex = new Map<number, ThemeThreadRef[]>();
  const countIndex = new Map<number, number>();
  capped.forEach((c, i) => {
    memberIndex.set(i, c.members);
    countIndex.set(i, c.count);
  });

  return {
    empty: false,
    payload,
    hash,
    windowKind: window,
    bots,
    byArea,
    coverage,
    memberIndex,
    countIndex,
  };
}
