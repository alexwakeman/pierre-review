// ── The synthesis seam's INPUT ASSEMBLY (plan P2.1; the D3 grains) ──────────────────────────
//
// One function, four scope kinds, and ONE RULE (§8.3): for every kind, the item set the model
// sees is read from THE SAME core query that produces the drill-down's list and count — never a
// second predicate. A synthesis that folded its own SQL would summarise a population subtly
// different from the receipt list rendered under its card (the bots-flagging
// tile-number-vs-hydration lesson generalised), and nothing would ever error about it.
//
// Where each kind's ONE query lives:
//   'bot-flagging'   → ml-labels.ts `foldBotFlaggingPopulation` (+ `hydrateFlaggingPage`) — the
//                      exact fold behind GET /api/bot-analytics/flagging (`total`/`filteredTotal`
//                      and the paged list are slices of the same population this reads).
//   'bot-threads'    → queries.ts `getResolvableBotThreadPrs` — the exact rows behind
//                      GET /api/bot-threads/resolvable (`totalThreads` is this set's size); text
//                      hydration then goes through `getResolvableBotThreadsForScope(threadIds)`,
//                      the SAME re-derive the confirm-gated resolve route runs (those two are
//                      contractually one predicate — the resolve flow already depends on it).
//   'bot-volume'     → bot-volume.ts `foldPrBotVolumePopulation` — the exact scored fold behind
//                      GET /api/bot-analytics/volume/prs (`filteredTotal` is its length).
//   'workspace-bots' → queries.ts `getBotReviewComments` — the deterministic collection query the
//                      Pro Themes fold has always read (the C6 union of the workspace's bot
//                      comments). It is ALREADY core, so the "smaller honest change" of the two
//                      the plan offered is simply calling it — no lift, no new seam.
//   'brief'          → daily-brief.ts `getDailyBriefCounts` — the strip's OWN fold (which itself
//                      reuses each line's owning-surface fold). ORDERING grain: one item per
//                      NONZERO brief line, and the item id ENCODES the computed count
//                      (`myTurn:3`) so the plugin's unchanged hash formula (sorted ids +
//                      created-at) IS "the counts + item ids" — content-hash, never the date
//                      (`createdAt` is pinned to epoch 0: an unchanged workspace is a $0 cache
//                      hit however many days pass).
//   'rollup'         → the same fold looped over the account's OTHER workspaces (listWorkspaces
//                      order, nonzero lines only, capped) — one item per workspace, its id
//                      encoding that workspace's count vector for the same content-hash reason.
//   'person'         → person-period.ts `getPersonPeriod` — the 1:1 tab's OWN vector (the person
//                      route serves the same fold). ORDERING grain: one item per NON-NULL vector
//                      line, ids `pm<schema-version>:<key>:<value>` so the hash IS "the vector
//                      values + PERSON_METRICS_SCHEMA_VERSION"; the WINDOW rides the scope key's
//                      person slots (`u:`/`pw:`), so window+values+version are all in the hash.
//   'person_report'  → person-period.ts `getPersonPeriod(…, {evidence:true})` — the People
//                      report section's OWN fold. SECTIONS grain: the `pm…` vector items
//                      byte-identical to 'person', plus the evidence rows the section's cards
//                      render (`pe<PERSON_REPORT_VERSION>:` ids — same fold, same caps), so the
//                      model summarises precisely the rows shown under it.
//
// ⚠ THE CAP IS DISCLOSED, NEVER SILENT (the themes-cap precedent): `items` is capped at
// SYNTHESIS_INPUT_CAP in the population's own order, and `analyzedCount`/`totalCount` travel so
// the card can render "Summarised X of Y". `totalCount` IS the drill-down's own number.
//
// ⚠ NOTHING HERE IS HYDRATED FROM GITHUB. Every field — including each item's `createdAt`, the
// payload hash's per-item stable field — is a plain DB read, so the plugin's free cached GET can
// recompute the hash by calling this again at zero external cost.
//
// ⚠ Item BODIES are bot/PR-authored, i.e. attacker-authored in cloud. This module only collapses
// whitespace and caps length; FENCING them before a model sees them is the plugin prompt's job.
import type {
  BotFlaggingRefine,
  BotFlaggingSelector,
  DailyBriefCounts,
  PersonMetricValue,
  PersonPeriod,
  SynthesisInput,
  SynthesisInputItem,
  SynthesisScope,
} from '@pierre-review/shared';
import {
  getPersonPeriod,
  PERSON_METRIC_META,
  PERSON_METRICS_SCHEMA_VERSION,
} from './person-period.js';
import {
  foldBotFlaggingPopulation,
  hydrateFlaggingPage,
} from './ml-labels.js';
import { foldPrBotVolumePopulation, loadBotIdentities } from './bot-volume.js';
import { getDailyBriefCounts } from './daily-brief.js';
import {
  getBotReviewComments,
  getResolvableBotThreadPrs,
  getResolvableBotThreadsForScope,
  listWorkspaces,
  type BotScope,
} from './queries.js';

/**
 * The input cap (the themes CLUSTER_CAP precedent — bound the prompt, disclose the bound). 250
 * items × ≤ SYNTHESIS_BODY_CAP chars ≈ 80k chars of item text, a comfortable single Haiku call.
 * The plugin folds analyzed/total into the stored row so the card's coverage line cannot lie.
 */
export const SYNTHESIS_INPUT_CAP = 250;

/** Per-item body budget. Whitespace-collapsed first, so the cap buys real words. */
export const SYNTHESIS_BODY_CAP = 320;

function capBody(raw: string | null | undefined): string {
  if (!raw) return '';
  const s = raw.replace(/\s+/g, ' ').trim();
  return s.length > SYNTHESIS_BODY_CAP ? `${s.slice(0, SYNTHESIS_BODY_CAP).trimEnd()}…` : s;
}

// The flagging selector, rebuilt from the descriptor exactly as the route builds it from its
// query string. An unsatisfiable combination THROWS (the severities-400 rule: silently falling
// back would name a DIFFERENT population than the drill-down the card sits beside); the plugin
// route validates first, so a throw here is a programmer error surfacing loudly, not a user path.
function flaggingSelectorOf(
  scope: SynthesisScope,
): Exclude<BotFlaggingSelector, { kind: 'overlap' }> {
  const select = scope.select ?? 'findings';
  if (select === 'severity') {
    if (!scope.severities || scope.severities.length === 0) {
      throw new Error('synthesis scope: select=severity requires a non-empty `severities`');
    }
    return { kind: 'severity', severities: scope.severities };
  }
  if (select === 'category') {
    if (!scope.category) {
      throw new Error('synthesis scope: select=category requires `category`');
    }
    return { kind: 'category', category: scope.category };
  }
  return { kind: select };
}

async function flaggingInput(
  accountId: number,
  scope: SynthesisScope,
  botScope: BotScope,
): Promise<SynthesisInput> {
  const selector = flaggingSelectorOf(scope);
  // The drill-down's refine, verbatim: `botUserId` is the store-seed's one-bot narrowing (a
  // one-element list — `[]` would mean "no bots"), `direction` the inflation charts' over/under.
  // The matrix-CELL refine is deliberately not part of the synthesis descriptor (P2.2 mounts the
  // verdict at tile/bot/direction grain; a per-cell synthesis has no surface).
  const refine: BotFlaggingRefine = {
    cell: null,
    disagree: scope.direction ?? null,
    authorUserIds: scope.botUserId != null ? [scope.botUserId] : null,
  };
  const pop = await foldBotFlaggingPopulation(accountId, selector, refine, scope.window, botScope);
  const capped = pop.narrowed.slice(0, SYNTHESIS_INPUT_CAP);
  // Hydration BY ID of the capped rows — the same helper the route's page hydration uses. A label
  // whose parent row is gone is dropped here exactly as it is dropped from the page (and stays in
  // `totalCount`, exactly as it stays in `filteredTotal`).
  const hydrated = await hydrateFlaggingPage(accountId, botScope, capped);
  const items: SynthesisInputItem[] = hydrated.map((c) => ({
    // `targetId` is namespaced by targetKind — the ref prefixes keep the three id spaces apart.
    id:
      c.targetKind === 'review_comment'
        ? `rc:${c.targetId}`
        : c.targetKind === 'pr_comment'
          ? `pc:${c.targetId}`
          : `rv:${c.targetId}`,
    kind: c.targetKind,
    authorLabel: c.authorLabel,
    createdAt: c.createdAt,
    body: capBody(c.body),
    path: c.path,
    // OUR severity, from the same fold that admitted the row — never the vendor badge. (The wire
    // type allows a null label; hydrateFlaggingPage always sets it, but degrade rather than trust.)
    severity: c.mlLabel?.severity ?? null,
  }));
  return {
    kind: 'bot-flagging',
    workspaceId: scope.workspaceId,
    items,
    totalCount: pop.narrowed.length,
    analyzedCount: items.length,
    truncated: pop.truncated || items.length < pop.narrowed.length,
  };
}

async function threadsInput(
  accountId: number,
  scope: SynthesisScope,
  botScope: BotScope,
): Promise<SynthesisInput> {
  // The drill-down's OWN fold: the uncapped PR-grouped backlog. `totalThreads` is the tab's
  // number; the flattened thread ids (group order, then scan order within a group) are the set.
  // NOTE the backlog is windowless — `scope.window` is ignored for this kind, and the plugin's
  // scope key canonicalises it out so two windows cannot mint two cache rows for one set.
  const { prs, totalThreads } = await getResolvableBotThreadPrs(accountId, botScope);
  const orderedIds: number[] = [];
  for (const pr of prs) orderedIds.push(...pr.threadIds);
  const cappedIds = orderedIds.slice(0, SYNTHESIS_INPUT_CAP);
  if (cappedIds.length === 0) {
    return {
      kind: 'bot-threads',
      workspaceId: scope.workspaceId,
      items: [],
      totalCount: totalThreads,
      analyzedCount: 0,
      truncated: totalThreads > 0,
    };
  }
  // Text hydration through the resolve route's OWN re-derive (same predicate by contract — the
  // listing offers ids that getResolvableBotThreadsForScope re-verifies, exactly as the resolve
  // flow does). Passing `threadIds` bypasses the page cap, so no capped id is silently dropped;
  // a thread that stopped being eligible between the two reads simply falls out, which shrinks
  // `analyzedCount` honestly rather than summarising a row the list no longer shows.
  const { threads } = await getResolvableBotThreadsForScope(accountId, botScope, cappedIds);
  const items: SynthesisInputItem[] = threads.map((t) => ({
    id: `th:${t.threadId}`,
    kind: 'thread',
    authorLabel: t.botLabel,
    createdAt: t.threadCreatedAt,
    body: capBody(t.excerpt),
    path: t.path,
  }));
  return {
    kind: 'bot-threads',
    workspaceId: scope.workspaceId,
    items,
    totalCount: totalThreads,
    analyzedCount: items.length,
    truncated: items.length < totalThreads,
  };
}

async function volumeInput(
  accountId: number,
  scope: SynthesisScope,
  botScope: BotScope,
): Promise<SynthesisInput> {
  // Sort is FIXED at 'comments' — the route's default. The descriptor carries no sort on purpose:
  // the cap slices the fold, so a per-sort synthesis would be two different populations wearing
  // one card, and 'comments' is the ordering the drill-down opens on.
  const pop = await foldPrBotVolumePopulation(
    accountId,
    scope.window,
    botScope,
    { authorUserIds: scope.botUserId != null ? [scope.botUserId] : null },
    'comments',
  );
  const capped = pop.scored.slice(0, SYNTHESIS_INPUT_CAP);
  // Identities only for the bots on the CAPPED rows (the page-assembly rule).
  const botIds = new Set<number>();
  for (const s of capped) {
    for (const [userId] of s.pr.byBot) {
      if (!pop.only || pop.only.has(userId)) botIds.add(userId);
    }
  }
  const identities = await loadBotIdentities(accountId, botScope, [...botIds]);
  const items: SynthesisInputItem[] = capped.map((s) => {
    // The row's "author" is its bot mix — top three by comment count, deterministic order.
    const shares = [...s.pr.byBot.entries()]
      .filter(([userId]) => !pop.only || pop.only.has(userId))
      .map(([userId, comments]) => ({
        label: identities.get(userId)?.label ?? `#${userId}`,
        comments,
      }))
      .sort((a, b) => b.comments - a.comments || a.label.localeCompare(b.label))
      .slice(0, 3);
    return {
      id: `pr:${s.pr.id}`,
      kind: 'pr',
      authorLabel: shares.map((x) => x.label).join(' · ') || 'Bots',
      // `mergedAt` — the population is merged PRs and merge time is the row's stable anchor.
      createdAt: s.pr.mergedAt.toISOString(),
      body: capBody(s.pr.title),
    };
  });
  return {
    kind: 'bot-volume',
    workspaceId: scope.workspaceId,
    items,
    totalCount: pop.scored.length,
    analyzedCount: items.length,
    truncated: pop.truncated || items.length < pop.scored.length,
  };
}

async function workspaceBotsInput(
  accountId: number,
  scope: SynthesisScope,
  botScope: BotScope,
): Promise<SynthesisInput> {
  // The C6 grain: the union of the workspace's review-bot comments (inline + issue-level), from
  // the ONE collection query the Themes fold reads. Each source arrives newest-first; the merge
  // re-sorts so the cap keeps the newest overall.
  const { comments, truncated } = await getBotReviewComments(accountId, scope.window, botScope);
  const ordered = [...comments].sort((a, b) => {
    const d = b.createdAt.localeCompare(a.createdAt);
    if (d !== 0) return d;
    // Total tiebreak so the capped set is stable under re-reads (the hash depends on it).
    if (a.source !== b.source) return a.source < b.source ? -1 : 1;
    return a.id - b.id;
  });
  const capped = ordered.slice(0, SYNTHESIS_INPUT_CAP);
  const items: SynthesisInputItem[] = capped.map((c) => ({
    // `id` is namespaced by `source` — the two id spaces collide numerically (the
    // BotReviewCommentRow contract says so in as many words).
    id: c.source === 'review' ? `rc:${c.id}` : `pc:${c.id}`,
    kind: c.source === 'review' ? 'review_comment' : 'pr_comment',
    authorLabel: c.label,
    createdAt: c.createdAt,
    body: capBody(c.body),
    path: c.path,
  }));
  return {
    kind: 'workspace-bots',
    workspaceId: scope.workspaceId,
    items,
    totalCount: comments.length,
    analyzedCount: items.length,
    truncated: truncated || items.length < comments.length,
  };
}

// ── The ORDERING grains ('brief' / 'rollup' — plan P3.1/P3.3) ───────────────────────────────
//
// These two are NOT drill-down populations: their "items" are the deterministic brief's LINES,
// their refs are what the model orders + phrases (digit-free, validated plugin-side), and the
// figures are appended by the CLIENT from GET /api/daily-brief (D4 — the model authors no
// number). The unchanged plugin hash formula folds sorted item ids + created-at, so:
//   - each id ENCODES its computed count(s) — a count change changes the id changes the hash;
//   - `createdAt` is EPOCH ZERO, a constant — the hash is a CONTENT hash, never a date hash. An
//     unchanged workspace is a permanent $0 cache hit and the strip says "unchanged since <day>"
//     from the stored row's generatedAt.
// Bodies are the templated lines (numbers included — that is model INPUT, not output).

/** Epoch-zero createdAt: the per-item "stable field" slot, deliberately date-free. */
const BRIEF_EPOCH = new Date(0).toISOString();

function briefLine(id: string, body: string): SynthesisInputItem {
  return { id, kind: 'brief_line', authorLabel: 'brief', createdAt: BRIEF_EPOCH, body };
}

/** One item per NONZERO line, ids count-encoded (`myTurn:3` / `anomaly:u42` / `trunk:r7`). */
export function briefLineItems(counts: DailyBriefCounts): SynthesisInputItem[] {
  const items: SynthesisInputItem[] = [];
  if (counts.myTurn > 0)
    items.push(briefLine(`myTurn:${counts.myTurn}`, `${counts.myTurn} items need your review or reply (My Turn)`));
  if (counts.stalled > 0)
    items.push(briefLine(`stalled:${counts.stalled}`, `${counts.stalled} PRs stalled awaiting review`));
  if (counts.untouchedThreads > 0)
    items.push(briefLine(`untouched:${counts.untouchedThreads}`, `${counts.untouchedThreads} review threads untouched`));
  if (counts.needsReviewer > 0)
    items.push(briefLine(`needsReviewer:${counts.needsReviewer}`, `${counts.needsReviewer} PRs still need a reviewer`));
  if (counts.resolveBacklog > 0)
    items.push(briefLine(`resolveBacklog:${counts.resolveBacklog}`, `${counts.resolveBacklog} likely-addressed bot threads ready to resolve`));
  for (const a of counts.botAnomalies)
    items.push(briefLine(`anomaly:u${a.userId}`, `${a.label}'s comment volume is unusual this week`));
  for (const r of counts.trunkRed)
    items.push(briefLine(`trunk:r${r.repoId}`, `the default branch of ${r.name} is red`));
  return items;
}

async function briefInput(accountId: number, scope: SynthesisScope): Promise<SynthesisInput> {
  const counts = await getDailyBriefCounts(accountId, scope.workspaceId);
  const items = briefLineItems(counts);
  return {
    kind: 'brief',
    workspaceId: scope.workspaceId,
    items,
    totalCount: items.length,
    analyzedCount: items.length,
    truncated: false,
  };
}

/** Matches the roll-up route's own cap (workspaces are few; bounded all the same). */
const ROLLUP_WORKSPACE_CAP = 12;

/** A stable one-token signature of a workspace's count vector — the content the ws item's id
 *  carries into the hash. Anomalies/trunk fold as their id lists (membership changes count). */
function rollupSig(c: DailyBriefCounts): string {
  return [
    c.myTurn,
    c.stalled,
    c.untouchedThreads,
    c.needsReviewer,
    c.resolveBacklog,
    c.botAnomalies.map((a) => `u${a.userId}`).join('+') || '-',
    c.trunkRed.map((r) => `r${r.repoId}`).join('+') || '-',
  ].join('.');
}

function rollupHasAnything(c: DailyBriefCounts): boolean {
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

async function rollupInput(accountId: number, scope: SynthesisScope): Promise<SynthesisInput> {
  // The OTHER workspaces relative to the viewed one — the Elsewhere line's population. Counts
  // ride the brief fold's own TTL cache; NO cost fields exist anywhere in the vector (§8.18).
  const others = (await listWorkspaces(accountId))
    .filter((w) => w.id !== scope.workspaceId)
    .slice(0, ROLLUP_WORKSPACE_CAP);
  const items: SynthesisInputItem[] = [];
  for (const w of others) {
    const counts = await getDailyBriefCounts(accountId, w.id);
    if (!rollupHasAnything(counts)) continue;
    const bits: string[] = [];
    if (counts.myTurn > 0) bits.push(`${counts.myTurn} need you`);
    if (counts.stalled > 0) bits.push(`${counts.stalled} stalled`);
    if (counts.untouchedThreads > 0) bits.push(`${counts.untouchedThreads} untouched threads`);
    if (counts.needsReviewer > 0) bits.push(`${counts.needsReviewer} need a reviewer`);
    if (counts.resolveBacklog > 0) bits.push(`${counts.resolveBacklog} resolvable bot threads`);
    if (counts.botAnomalies.length > 0) bits.push(`${counts.botAnomalies.length} bot anomalies`);
    if (counts.trunkRed.length > 0) bits.push(`trunk red on ${counts.trunkRed.map((r) => r.name).join(', ')}`);
    items.push({
      id: `ws:${w.id}:${rollupSig(counts)}`,
      kind: 'brief_line',
      authorLabel: w.name,
      createdAt: BRIEF_EPOCH,
      body: `${w.name}: ${bits.join(' · ')}`,
    });
  }
  return {
    kind: 'rollup',
    workspaceId: scope.workspaceId,
    items,
    totalCount: items.length,
    analyzedCount: items.length,
    truncated: false,
  };
}

// ── The 'person' ORDERING grain (plan P4.2 / N4 — the 1:1-prep narration) ───────────────────
//
// The third ordering grain, and the brief's content-hash trick at the person grain: one item per
// NON-NULL vector line, each id encoding `pm<PERSON_METRICS_SCHEMA_VERSION>:<key>:<value>` — so
// the plugin's unchanged hash formula (sorted ids + created-at) IS "the vector values + the
// schema version", and the WINDOW rides the scope key (the plugin appends the person grain's
// `u:`/`pw:` slots). An unchanged fortnight is a $0 cache hit forever; a schema-version bump
// changes every id and flips the stored row stale in place. `createdAt` stays epoch zero —
// content hash, never a date hash. Bodies are the templated lines WITH their figures (model
// INPUT, fenced as JSON by the prompt); phrases come back digit-free and the client re-appends
// the live figures (D4).

/** The templated line per key — numbers included (input, not output). Kept tiny and literal;
 *  the SPA renders its own labels, so this only has to read well inside the prompt. */
function personLineBody(v: PersonMetricValue, p: PersonPeriod): string {
  const n = v.value ?? 0;
  switch (v.key) {
    case 'merged_prs_authored':
      return `${p.login} merged ${n} PRs they authored this period`;
    case 'opened_prs_authored':
      return `${p.login} opened ${n} PRs this period`;
    case 'reviews_given':
      return `${p.login} gave ${n} reviews this period`;
    case 'review_comments_written':
      return `${p.login} wrote ${n} inline review comments this period`;
    case 'median_review_response_hours':
      return `median ${n}h from a review request to their review`;
    case 'median_first_human_review_hours_their_prs':
      return `their PRs waited a median ${n}h for a first human review`;
    case 'review_threads_on_their_prs':
      return `${n} review threads were opened on their PRs this period`;
    case 'their_pr_threads_addressed':
      return `${n} of the ${v.sampleSize} threads on their PRs are addressed by now`;
    case 'awaiting_their_review':
      return `${n} open PRs are waiting on their review right now`;
    case 'open_prs_authored':
      return `${n} of their PRs are open right now`;
  }
}

/** Epoch-zero createdAt + count-encoded ids (see the header above). Null lines are OMITTED —
 *  a null→value transition changes the id set, which changes the hash, which is the point. */
export function personMetricItems(p: PersonPeriod): SynthesisInputItem[] {
  const items: SynthesisInputItem[] = [];
  for (const v of p.metrics) {
    if (v.value == null) continue;
    items.push({
      id: `pm${PERSON_METRICS_SCHEMA_VERSION}:${v.key}:${v.value}`,
      kind: 'person_metric',
      authorLabel: p.login,
      createdAt: BRIEF_EPOCH,
      // The meta note travels as context so the model phrases the LIVE keys as "now" facts.
      body:
        PERSON_METRIC_META[v.key].basis === 'live'
          ? `${personLineBody(v, p)} (a live reading, not a period figure)`
          : personLineBody(v, p),
    });
  }
  return items;
}

async function personInput(accountId: number, scope: SynthesisScope): Promise<SynthesisInput> {
  // The plugin route validates these three before this runs (they name a POPULATION — its 400
  // rule); a miss here is a programmer error surfacing loudly, exactly like flaggingSelectorOf.
  if (scope.userId == null || scope.fromMs == null || scope.toMs == null) {
    throw new Error("synthesis scope: kind 'person' requires `userId`, `fromMs` and `toMs`");
  }
  const person = await getPersonPeriod(accountId, scope.workspaceId, scope.userId, {
    fromMs: scope.fromMs,
    toMs: scope.toMs,
  });
  // No admissible person (a stranger, a bot, an empty workspace) → an EMPTY input: the POST
  // answers `empty: true`, nothing is stored or billed, the panel renders its own null state.
  const items = person == null ? [] : personMetricItems(person);
  return {
    kind: 'person',
    workspaceId: scope.workspaceId,
    items,
    totalCount: items.length,
    analyzedCount: items.length,
    truncated: false,
  };
}

// ── The 'person_report' SECTIONS grain (the People report's per-person narrative) ────────────
//
// The seam's third output mode's input: the person vector's `pm…` items VERBATIM (byte-identical
// to the 'person' grain — two kinds must not describe two vectors) plus the EVIDENCE rows the
// report section's cards render, read through THE SAME fold with `evidence: true` — same
// predicates, same caps, so the model summarises precisely the rows shown under it (§8.3 at the
// person grain). The WINDOW rides the scope key's `u:`/`pw:` slots exactly like 'person'.
//
// `pe<PERSON_REPORT_VERSION>:` prefixes every evidence id: ONE kind-scoped literal covering the
// evidence-item vocabulary AND the plugin's person_report section prompt — a bump changes every
// `pe…` id, so every stored person_report row flips `stale` honestly on the free GET while NO
// other kind is re-billed (the `pm<version>` trick; SYNTHESIS_PROMPT_VERSION stays untouched,
// and future person_report prompt edits bump THIS literal instead of the global one).
//
// Hash discipline inherited: every id + createdAt is a plain DB read (pr/comment/thread rows
// carry their real GitHub timestamps; the count-encoded area lines pin epoch zero), nothing is
// `Date.now()`-derived, and bodies are NOT folded. A closed period's set is stable; a late
// backfill that lands new rows flips `stale` honestly.
// 1 → 2: the author vocabulary made honest — figure lines are labelled 'brief' (the legend's
// own word for them, not the login: a dashboard line is not something the subject wrote),
// thread roots the subject authored carry their login instead of 'reviewer' (a self-review
// note is not feedback they received — and it already travels as their own `pe:rc:` item, so
// the old label handed the model the same text twice under contradictory attribution), and a
// zero-evidence input now mints the `:none` sentinel so this literal reaches its hash at all.
export const PERSON_REPORT_VERSION = 2;

async function personReportInput(
  accountId: number,
  scope: SynthesisScope,
): Promise<SynthesisInput> {
  // Same required-triple rule as 'person' (the plugin route 400s first; a miss here is loud).
  if (scope.userId == null || scope.fromMs == null || scope.toMs == null) {
    throw new Error(
      "synthesis scope: kind 'person_report' requires `userId`, `fromMs` and `toMs`",
    );
  }
  const person = await getPersonPeriod(
    accountId,
    scope.workspaceId,
    scope.userId,
    { fromMs: scope.fromMs, toMs: scope.toMs },
    { evidence: true },
  );
  // No admissible person → EMPTY input → the POST answers `empty: true`, nothing billed.
  if (person == null) {
    return {
      kind: 'person_report',
      workspaceId: scope.workspaceId,
      items: [],
      totalCount: 0,
      analyzedCount: 0,
      truncated: false,
    };
  }
  const ev = person.evidence;
  const pe = `pe${PERSON_REPORT_VERSION}`;
  // The vector lines, verbatim ids/bodies (figures are model INPUT, fenced as JSON by the
  // prompt) — but re-labelled 'brief': the person_report legend defines author as
  // login | 'reviewer' | 'brief', and a dashboard figure line is a brief line, not a quote from
  // the subject. (The 1:1 'person' kind keeps the login — its own prompt defines author that
  // way. authorLabel is not hashed, so the ids stay byte-identical across the two kinds.)
  const items: SynthesisInputItem[] = personMetricItems(person).map((i) => ({
    ...i,
    authorLabel: 'brief',
  }));
  // Authored-PR titles: the merged ∪ opened evidence rows, deduped, cards' own order.
  const seenPr = new Set<number>();
  for (const r of [
    ...(ev?.prs.merged_prs_authored?.rows ?? []),
    ...(ev?.prs.opened_prs_authored?.rows ?? []),
  ]) {
    if (r.prId == null || seenPr.has(r.prId)) continue;
    seenPr.add(r.prId);
    items.push({
      id: `${pe}:pr:${r.prId}`,
      kind: 'pr',
      authorLabel: person.login,
      createdAt: r.openedAt ?? BRIEF_EPOCH,
      body: capBody(r.title),
    });
  }
  // Their own comment excerpts, split by target kind (two id spaces — the BotReviewCommentRow
  // numeric-collision lesson).
  for (const c of ev?.comments.rows ?? []) {
    const rc = c.targetKind === 'review_comment';
    items.push({
      id: rc ? `${pe}:rc:${c.targetId}` : `${pe}:pc:${c.targetId}`,
      kind: rc ? 'review_comment' : 'pr_comment',
      authorLabel: person.login,
      createdAt: c.createdAt,
      body: capBody(c.body),
      path: c.path,
    });
  }
  // Thread roots on their PRs — usually feedback they RECEIVED ('reviewer', which the prompt
  // legend defines as exactly that). A SELF-authored root (the "flagging this for reviewers"
  // pattern) is the subject's own note and often also travels above as their `pe:rc:` comment
  // item — so it carries their login, or the model reads the same text twice under
  // contradictory attribution and honestly-cites their note as feedback received.
  for (const t of ev?.threads.rows ?? []) {
    items.push({
      id: `${pe}:th:${t.threadId}`,
      kind: 'thread',
      authorLabel: t.selfAuthoredRoot ? person.login : 'reviewer',
      createdAt: t.createdAt,
      body: capBody(t.excerpt),
      path: t.path,
    });
  }
  // Path-area lines — count-encoded ids (the brief's content-hash trick: an area-mix change
  // changes the id changes the hash), epoch-zero createdAt.
  for (const area of ev?.pathAreas ?? []) {
    items.push({
      id: `${pe}:area:${area.bucket}:${area.files}`,
      kind: 'path_area',
      authorLabel: person.login,
      createdAt: BRIEF_EPOCH,
      body: `their commits touched ${area.files} files under ${area.bucket} (${area.commits} commits)`,
    });
  }
  // The kind-version literal rides the hash ONLY via `pe…` ids, and two ordinary shapes carry
  // ZERO evidence items: an awaiting-only admission (every count cell a non-null zero) and a
  // reviewer-only period (the response-median sample PRs are deliberately not minted as items).
  // Without a `pe…` id a PERSON_REPORT_VERSION bump would leave such stored rows `stale: false`
  // forever, serving the old prompt's sections at $0. One CONSTANT sentinel line for exactly
  // that slice (an evidence-carrying input already versions every id): epoch-zero createdAt,
  // digit-free, and honestly citable — it states the absence rather than smuggling a marker.
  if (!items.some((i) => i.id.startsWith(`${pe}:`))) {
    items.push({
      id: `${pe}:none`,
      kind: 'brief_line',
      authorLabel: 'brief',
      createdAt: BRIEF_EPOCH,
      body: 'no PR, comment or thread excerpts are available for this period',
    });
  }
  // `truncated` discloses the evidence caps (each card group's own "and N more"); the item list
  // itself is the analyzed set — ≈ ≤90 items, far under SYNTHESIS_INPUT_CAP by construction.
  const truncated =
    (ev?.prs.merged_prs_authored?.more ?? 0) > 0 ||
    (ev?.prs.opened_prs_authored?.more ?? 0) > 0 ||
    (ev?.comments.more ?? 0) > 0 ||
    (ev?.threads.more ?? 0) > 0;
  return {
    kind: 'person_report',
    workspaceId: scope.workspaceId,
    items,
    totalCount: items.length,
    analyzedCount: items.length,
    truncated,
  };
}

/**
 * The ONE synthesis-input fold (ProHostQueries.getSynthesisInput's real body — bind.ts swaps its
 * declared-inert throw for this). `scope.workspaceId` decides who counts as a bot;
 * `scope.repoIds` narrows what is measured and is resolver-produced (`⊆` the workspace's
 * membership — the plugin route intersects exactly as core's resolveWorkspaceScope does).
 * The ordering grains ('brief'/'rollup') take the WHOLE workspace/account — `repoIds` and
 * `window` are canonicalised out of their scope keys plugin-side and ignored here.
 */
export async function getSynthesisInput(
  accountId: number,
  scope: SynthesisScope,
): Promise<SynthesisInput> {
  const botScope: BotScope = { workspaceId: scope.workspaceId, repoIds: scope.repoIds };
  switch (scope.kind) {
    case 'bot-flagging':
      return flaggingInput(accountId, scope, botScope);
    case 'bot-threads':
      return threadsInput(accountId, scope, botScope);
    case 'bot-volume':
      return volumeInput(accountId, scope, botScope);
    case 'workspace-bots':
      return workspaceBotsInput(accountId, scope, botScope);
    case 'brief':
      return briefInput(accountId, scope);
    case 'rollup':
      return rollupInput(accountId, scope);
    case 'person':
      return personInput(accountId, scope);
    case 'person_report':
      return personReportInput(accountId, scope);
  }
}
