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
//   (REMOVED: the 'brief' / 'rollup' ordering grains — the morning-brief narration. Their stored
//    `pro_synthesis` rows are DORMANT; GET /api/daily-brief still serves the counts.)
//   (REMOVED 2026-10-22: the 'person' and 'person_report' grains — the 1:1 prep narration and the
//    People report's sections. Their stored `pro_synthesis` rows are DORMANT.)
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
  SynthesisInput,
  SynthesisInputItem,
  SynthesisScope,
} from '@pierre-review/shared';
import {
  foldBotFlaggingPopulation,
  hydrateFlaggingPage,
} from './ml-labels.js';
import { foldPrBotVolumePopulation, loadBotIdentities } from './bot-volume.js';
import {
  getBotReviewComments,
  getResolvableBotThreadPrs,
  getResolvableBotThreadsForScope,
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

/**
 * The ONE synthesis-input fold (ProHostQueries.getSynthesisInput's real body — bind.ts swaps its
 * declared-inert throw for this). `scope.workspaceId` decides who counts as a bot;
 * `scope.repoIds` narrows what is measured and is resolver-produced (`⊆` the workspace's
 * membership — the plugin route intersects exactly as core's resolveWorkspaceScope does).
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
  }
}
