import { and, eq, gte, inArray, isNotNull, or } from 'drizzle-orm';
import {
  STORIES_MAX,
  STORY_HEALTH_SPAN_LABEL,
  STORY_HEALTH_WEEKS,
  STORY_RUBRIC_VERSION,
  trackerTicketIdent,
  type StoryCriterionLabel,
  type StoryHealthResponse,
  type StoryLabelRunStatus,
  type StoryLevelLabels,
  type TrackerProvider,
} from '@pierre-review/shared';
import { db, schema } from './client.js';
import type { BotScope } from './queries.js';
import { foldStories, workspaceSite } from './stories.js';
import type { StoredTicketRow } from '../tracker/store.js';
import { getResolvedFlowSettings } from './flow-settings.js';
import { localWeeksEndingAt } from './working-hours.js';
import { textCriteriaCount } from './story-criteria.js';
import { storyLabelInput, type StoryLabelInput } from './story-label-input.js';
import { userValueStated } from './story-user-value.js';
import { foldStoryHealth, refinementWeekOf, type StoryHealthStoryInput, type StoryHealthWeekBound } from './story-health-fold.js';

// REPORTS → STORIES → STORY HEALTH — the READS (docs/API.md § GET /api/story-health). The pure fold
// is db/story-health-fold.ts; this gathers its inputs:
//
//   • THE SPAN is STORY_HEALTH_WEEKS Monday-start weeks in the workspace's WORKING time zone
//     (`getResolvedFlowSettings` + `localWeeksEndingAt`, Chronology's "Over time" convention), the
//     current partial week last. FIXED and labelled — it follows no window picker.
//   • TWO POPULATIONS, one list. DELIVERY is the stories fold (db/stories.ts `foldStories`) over
//     [first Monday, now): every ticket with a pull request in the workspace's repos MERGED in the span
//     — the same stories, read the same way, as the rest of Reports → Stories. REFINEMENT is every
//     ticket with an OPEN or MERGED pull request in the workspace's repos whose created week (else
//     first PR opened) falls in the span, merged or not — so a recent week is not only the stories
//     that already shipped (which would keep the small, quick ones and fake a shift at the right
//     edge). A refinement-only story rides the list with `lastMergedMs: null`.
//   • CREATED DATE: `tracker_tickets` is one row per (account, PR, key), so several rows can carry a
//     ticket's `issue_created_at`; the freshest-read non-null one wins.
//   • LABELS: a `story_labels` row counts only when its rubric version is STORY_RUBRIC_VERSION and
//     its `text_hash` equals today's hash of the text the labeller would be sent
//     (db/story-label-input.ts). Anything else is not current and the story counts as unlabelled.
//
// ⚠ Every read predicates on accountId; `scope.repoIds` is the resolved workspace's membership. No
// GitHub, no tracker, no model — the `read` tier.

const CHUNK = 400;

/** One story with everything the fold and the label run need. */
export interface StoryHealthStory extends StoryHealthStoryInput {
  key: string;
  provider: TrackerProvider;
  /** What the labeller would be sent (null = no criteria text). */
  input: StoryLabelInput | null;
}

export interface StoryHealthInputs {
  trackerOn: boolean;
  timeZone: string;
  weeks: StoryHealthWeekBound[];
  stories: StoryHealthStory[];
  truncated: boolean;
}

async function chunked<T, R>(items: readonly T[], read: (chunk: T[]) => Promise<R[]>): Promise<R[]> {
  const out: R[] = [];
  for (let i = 0; i < items.length; i += CHUNK) out.push(...(await read(items.slice(i, i + CHUNK))));
  return out;
}

/** The span's weeks and every story in it, with current labels attached. */
export async function loadStoryHealthInputs(accountId: number, scope: BotScope, nowMs: number): Promise<StoryHealthInputs> {
  const settings = await getResolvedFlowSettings(accountId, scope.workspaceId);
  const weeks: StoryHealthWeekBound[] = localWeeksEndingAt(nowMs, settings.timeZone, STORY_HEALTH_WEEKS).map((w) => ({
    key: w.key,
    startMs: w.startMs,
    endMs: w.endMs,
  }));
  const fromMs = weeks[0]?.startMs ?? nowMs;
  const fold = await foldStories(accountId, scope, nowMs, { fromMs, toMs: nowMs, mode: 'rolling_14' });
  const site = fold.trackerOn && scope.repoIds.length > 0 ? await workspaceSite(accountId, scope.workspaceId) : null;
  const deliveryIdents = new Set(fold.stories.map((s) => s.ident));
  const extras = site != null ? await refinementOnlyTickets(accountId, scope, site, fromMs, deliveryIdents) : [];
  const base = { trackerOn: fold.trackerOn, timeZone: settings.timeZone, weeks };
  if (fold.stories.length === 0 && extras.length === 0) return { ...base, stories: [], truncated: fold.truncated };

  const provider = site?.provider ?? fold.stories[0]!.provider;
  const keys = [...new Set([...fold.stories.map((s) => s.key), ...extras.map((x) => x.key)])];
  const idents = new Set([...deliveryIdents, ...extras.map((x) => x.ident)]);

  const created = await createdDatesFor(accountId, provider, keys, idents);

  type Draft = Omit<StoryHealthStory, 'label' | 'input'> & { ticket: StoredTicketRow | null };
  const textFields = (ticket: StoredTicketRow | null, p: TrackerProvider) => {
    const text = ticket != null ? [ticket.title, ticket.description, ticket.acceptanceCriteria].filter(Boolean).join('\n\n') : '';
    return {
      ticketKnown: ticket != null,
      criteriaInField: ticket != null && textCriteriaCount(ticket, p).source === 'acceptance_criteria',
      userValueStated: ticket != null && userValueStated(text),
    };
  };
  const drafts: Draft[] = [];
  for (const row of fold.stories) {
    const ticket = fold.internals.get(row.ident)?.ticket ?? null;
    drafts.push({
      ident: row.ident,
      key: row.key,
      provider: row.provider,
      createdMs: created.get(row.ident)?.ms ?? null,
      firstOpenedMs: Date.parse(row.firstOpenedAt),
      lastMergedMs: Date.parse(row.lastMergedAt),
      linesChanged: row.linesChanged,
      workingHours: row.workingHours,
      prsTotal: row.prs.total,
      review: row.review != null && row.review.total > 0 ? { met: row.review.met, total: row.review.total } : null,
      labellable: false,
      ...textFields(ticket, row.provider),
      ticket,
    });
  }
  // Refinement only: in the span by created week (else first PR opened), newest first, capped like
  // the delivery fold — and the cap is disclosed through the same `truncated`.
  const refinementOnly: Draft[] = [];
  for (const x of extras) {
    const d: Draft = {
      ident: x.ident,
      key: x.key,
      provider: x.provider,
      createdMs: created.get(x.ident)?.ms ?? null,
      firstOpenedMs: x.firstOpenedMs,
      lastMergedMs: null,
      linesChanged: null,
      workingHours: 0,
      prsTotal: x.prsTotal,
      review: null,
      labellable: false,
      ...textFields(x.ticket, x.provider),
      ticket: x.ticket,
    };
    if (refinementWeekOf(d, weeks).week >= 0) refinementOnly.push(d);
  }
  refinementOnly.sort(
    (a, b) => (b.createdMs ?? b.firstOpenedMs) - (a.createdMs ?? a.firstOpenedMs) || a.ident.localeCompare(b.ident),
  );
  const extrasTruncated = refinementOnly.length > STORIES_MAX;
  drafts.push(...refinementOnly.slice(0, STORIES_MAX));

  const labelsByIdent = await currentLabelRowsFor(accountId, drafts.map((d) => d.ident));
  const stories: StoryHealthStory[] = drafts.map(({ ticket, ...d }) => {
    const input = storyLabelInput(ticket, d.provider);
    const label = input != null ? (labelsByIdent.get(d.ident)?.get(input.textHash) ?? null) : null;
    return { ...d, labellable: input != null, label, input };
  });
  return { ...base, stories, truncated: fold.truncated || extrasTruncated };
}

/** One refinement-only ticket: what the fold needs beyond the delivery population. */
interface RefinementTicket {
  ident: string;
  key: string;
  provider: TrackerProvider;
  /** Earliest opened member PR (this account, any repo, as the stories fold reads it). */
  firstOpenedMs: number;
  prsTotal: number;
  /** Freshest stored row with content (`foldStories`' rule); null = never read. */
  ticket: StoredTicketRow | null;
}

/**
 * Tickets on the workspace's site with an OPEN or MERGED pull request in the workspace's repos that
 * could have been written in the span — the PR was opened in it, or its row carries a created date
 * in it — and are not already in the delivery population. The caller applies the exact week rule.
 * ⚠ Every read predicates on accountId; `scope.repoIds` is the resolved membership.
 */
async function refinementOnlyTickets(
  accountId: number,
  scope: BotScope,
  site: { provider: TrackerProvider; apiRoot: string },
  fromMs: number,
  exclude: ReadonlySet<string>,
): Promise<RefinementTicket[]> {
  const { trackerTickets: tt, pullRequests: pr } = schema;
  const siteWhere = and(
    eq(tt.accountId, accountId),
    eq(tt.provider, site.provider),
    eq(tt.apiRoot, site.apiRoot),
    eq(tt.state, 'ok'),
    isNotNull(tt.fetchedAt),
  );
  const from = new Date(fromMs);
  const seeds = await chunked([...scope.repoIds], async (chunk) =>
    db
      .select({ issueKey: tt.issueKey })
      .from(tt)
      .innerJoin(pr, and(eq(pr.id, tt.prId), eq(pr.accountId, accountId)))
      .where(
        and(
          siteWhere,
          inArray(pr.repoId, chunk),
          inArray(pr.state, ['open', 'merged']),
          or(gte(pr.openedAt, from), gte(tt.issueCreatedAt, from)),
        ),
      )
      .execute(),
  );
  const identOf = (key: string) => trackerTicketIdent(site.provider, site.apiRoot, key);
  const keys = [...new Set(seeds.map((r) => r.issueKey))].filter((k) => !exclude.has(identOf(k)));
  if (keys.length === 0) return [];

  // Every stored row of those tickets on the site (members, any workspace) and their PRs.
  const rows = (await chunked(keys, async (chunk) =>
    db.select().from(tt).where(and(siteWhere, inArray(tt.issueKey, chunk))).execute(),
  )) as StoredTicketRow[];
  const prIds = [...new Set(rows.map((r) => r.prId))];
  const prRows = await chunked(prIds, async (chunk) =>
    db
      .select({ id: pr.id, openedAt: pr.openedAt })
      .from(pr)
      .where(and(eq(pr.accountId, accountId), inArray(pr.id, chunk)))
      .execute(),
  );
  const openedOf = new Map(prRows.map((p) => [p.id, p.openedAt.getTime()]));

  const byKey = new Map<string, StoredTicketRow[]>();
  for (const r of rows) {
    const g = byKey.get(r.issueKey) ?? [];
    g.push(r);
    byKey.set(r.issueKey, g);
  }
  const out: RefinementTicket[] = [];
  for (const key of keys) {
    const g = byKey.get(key) ?? [];
    const opened = [...new Set(g.map((r) => r.prId))].flatMap((id) => {
      const ms = openedOf.get(id);
      return ms != null ? [ms] : [];
    });
    if (opened.length === 0) continue;
    const ticket =
      [...g]
        .filter((r) => r.fetchedAt != null && r.title != null)
        .sort((a, b) => b.fetchedAt!.getTime() - a.fetchedAt!.getTime() || b.id - a.id)[0] ?? null;
    out.push({ ident: identOf(key), key, provider: site.provider, firstOpenedMs: Math.min(...opened), prsTotal: opened.length, ticket });
  }
  return out;
}

/** Each ticket's created instant: of its stored rows (one per PR) on this account, the freshest-read
 *  non-null `issue_created_at`. Keyed by ident; tickets outside `idents` are ignored. */
export async function createdDatesFor(
  accountId: number,
  provider: TrackerProvider,
  keys: readonly string[],
  idents: ReadonlySet<string>,
): Promise<Map<string, { ms: number; at: number; id: number }>> {
  const tt = schema.trackerTickets;
  const dateRows = await chunked([...keys], async (chunk) =>
    db
      .select({
        provider: tt.provider,
        apiRoot: tt.apiRoot,
        issueKey: tt.issueKey,
        issueCreatedAt: tt.issueCreatedAt,
        fetchedAt: tt.fetchedAt,
        id: tt.id,
      })
      .from(tt)
      .where(
        and(
          eq(tt.accountId, accountId),
          eq(tt.provider, provider),
          inArray(tt.issueKey, chunk),
          isNotNull(tt.issueCreatedAt),
        ),
      )
      .execute(),
  );
  const created = new Map<string, { ms: number; at: number; id: number }>();
  for (const r of dateRows) {
    if (r.issueCreatedAt == null) continue;
    const ident = trackerTicketIdent(r.provider as TrackerProvider, r.apiRoot, r.issueKey);
    if (!idents.has(ident)) continue;
    const at = r.fetchedAt?.getTime() ?? 0;
    const prev = created.get(ident);
    if (prev == null || at > prev.at || (at === prev.at && r.id > prev.id)) {
      created.set(ident, { ms: r.issueCreatedAt.getTime(), at, id: r.id });
    }
  }
  return created;
}

/** This account's labels under the CURRENT rubric for these idents: ident → text hash → labels.
 *  (Whether one is current for today's text is the caller's comparison.) */
export async function currentLabelRowsFor(
  accountId: number,
  idents: readonly string[],
): Promise<Map<string, Map<string, { criteria: StoryCriterionLabel[]; story: StoryLevelLabels }>>> {
  const sl = schema.storyLabels;
  const labelRows = await chunked([...idents], async (chunk) =>
    db
      .select({ ident: sl.ident, textHash: sl.textHash, criteriaJson: sl.criteriaJson, storyJson: sl.storyJson })
      .from(sl)
      .where(and(eq(sl.accountId, accountId), eq(sl.rubricVersion, STORY_RUBRIC_VERSION), inArray(sl.ident, chunk)))
      .execute(),
  );
  const out = new Map<string, Map<string, { criteria: StoryCriterionLabel[]; story: StoryLevelLabels }>>();
  for (const r of labelRows) {
    const m = out.get(r.ident) ?? new Map();
    m.set(r.textHash, { criteria: r.criteriaJson as StoryCriterionLabel[], story: r.storyJson as StoryLevelLabels });
    out.set(r.ident, m);
  }
  return out;
}

/** GET /api/story-health's body. `labels` = `config.aiEnabled`; `labelRun` = the account's run. */
export async function getStoryHealth(
  accountId: number,
  scope: BotScope,
  nowMs: number,
  opts: { labels: boolean; labelRun: StoryLabelRunStatus | null },
): Promise<StoryHealthResponse> {
  const inputs = await loadStoryHealthInputs(accountId, scope, nowMs);
  const fold = foldStoryHealth(inputs.stories, inputs.weeks, { nowMs, labels: opts.labels });
  return {
    workspaceId: scope.workspaceId,
    trackerOn: inputs.trackerOn,
    span: {
      label: STORY_HEALTH_SPAN_LABEL,
      from: new Date(inputs.weeks[0]?.startMs ?? nowMs).toISOString(),
      to: new Date(nowMs).toISOString(),
      weeks: inputs.weeks.length,
    },
    timeZone: inputs.timeZone,
    weeks: fold.weeks,
    labels: opts.labels,
    series: fold.series,
    shifts: fold.shifts,
    createdFallbackTotal: fold.createdFallbackTotal,
    unsizedTotal: fold.unsizedTotal,
    unlabelled: opts.labels ? fold.unlabelled : 0,
    labelRun: opts.labels ? opts.labelRun : null,
    truncated: inputs.truncated,
  };
}
