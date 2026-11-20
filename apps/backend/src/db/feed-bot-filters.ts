// THE FEED'S BOTS-SIDE FILTERS — severity and bot type (GET /api/activity/feed `severities` /
// `botRoles`). See packages/shared/src/feed-severity.ts for the scale.
//
// Applied by getConsolidatedFeed on the Bots side only, BEFORE the plain-activity cap and the page
// slice: the feed is offset-paginated over a capped stream, so a narrowing done on the client
// would leave a page of 50 bot rows with nothing left in it (a Dependabot-heavy window read as an
// empty Review-bot feed).
//
// Two facts per item:
//   - SEVERITY: the comment's own declared severity (an Ensemble finding's lead line,
//     `limnFindingPost`) wins; else its ML label (`ml_comment_labels`); else `unscored`.
//     ONE mapping, shared `feedSeverityOf`.
//   - ROLE: the actor's STORED workspace role (`reviewerRoleForUser`: the row's role, else the
//     quality-check seed) beats the login seed (`defaultRoleFor`). A row with no actor has no role.
import { and, eq, inArray } from 'drizzle-orm';
import {
  feedSeverityOf,
  limnFindingPost,
  type ConsolidatedFeedItem,
  type FeedSeverity,
  type MlLabelTargetKind,
  type MlSeverity,
  type ReviewerRole,
} from '@pierre-review/shared';
import { db, schema } from './client.js';
import { defaultRoleFor } from '../sync/reviewer-classify.js';

const { mlCommentLabels, users } = schema;

/** The ML label target behind a feed item (comment row, PR comment row, or review row). */
export interface FeedMlTarget {
  kind: MlLabelTargetKind;
  id: number;
}

export interface FeedBotFacts {
  severity: FeedSeverity;
  role: ReviewerRole | null;
}

export interface FeedBotFilter {
  /** null = every severity. */
  severities: readonly FeedSeverity[] | null;
  /** null = every bot type. */
  botRoles: readonly ReviewerRole[] | null;
}

const CHUNK = 500;

/** Read the ML severity of each target, account-scoped. */
async function mlSeverityByTarget(
  accountId: number,
  targets: readonly FeedMlTarget[],
): Promise<Map<string, MlSeverity>> {
  const out = new Map<string, MlSeverity>();
  const byKind = new Map<MlLabelTargetKind, number[]>();
  for (const t of targets) {
    const arr = byKind.get(t.kind) ?? [];
    arr.push(t.id);
    byKind.set(t.kind, arr);
  }
  for (const [kind, ids] of byKind) {
    const unique = [...new Set(ids)];
    for (let i = 0; i < unique.length; i += CHUNK) {
      const rows = await db
        .select({ targetId: mlCommentLabels.targetId, severity: mlCommentLabels.severity })
        .from(mlCommentLabels)
        .where(
          and(
            eq(mlCommentLabels.accountId, accountId),
            eq(mlCommentLabels.targetKind, kind),
            inArray(mlCommentLabels.targetId, unique.slice(i, i + CHUNK)),
          ),
        )
        .execute();
      for (const r of rows) out.set(`${kind}:${r.targetId}`, r.severity as MlSeverity);
    }
  }
  return out;
}

/** The severity + role of every item, keyed by item id. `storedRoleOf` is the workspace's
 *  `reviewerRoleForUser` map (passed in so this module does not import queries.ts). */
export async function feedBotFacts(
  accountId: number,
  items: readonly ConsolidatedFeedItem[],
  mlTargetOf: ReadonlyMap<string, FeedMlTarget>,
  storedRoleOf: ReadonlyMap<number, ReviewerRole>,
): Promise<Map<string, FeedBotFacts>> {
  const targets: FeedMlTarget[] = [];
  for (const it of items) {
    const t = mlTargetOf.get(it.id);
    if (t) targets.push(t);
  }
  const mlOf = targets.length > 0 ? await mlSeverityByTarget(accountId, targets) : new Map<string, MlSeverity>();

  // Logins only for the actors with no stored role (the login seed decides those).
  const needLogin = [
    ...new Set(
      items
        .map((i) => i.actorId)
        .filter((id): id is number => id != null && !storedRoleOf.has(id)),
    ),
  ];
  const loginOf = new Map<number, string>();
  for (let i = 0; i < needLogin.length; i += CHUNK) {
    for (const r of await db
      .select({ id: users.id, login: users.githubLogin })
      .from(users)
      .where(inArray(users.id, needLogin.slice(i, i + CHUNK)))
      .execute())
      loginOf.set(r.id, r.login);
  }

  const out = new Map<string, FeedBotFacts>();
  for (const it of items) {
    const t = mlTargetOf.get(it.id);
    const isComment = it.kind === 'review_comment' || it.kind === 'pr_comment';
    const limnSeverity = isComment ? (limnFindingPost(it.content)?.severity ?? null) : null;
    const severity = feedSeverityOf({
      limnSeverity,
      mlSeverity: t ? (mlOf.get(`${t.kind}:${t.id}`) ?? null) : null,
    });
    let role: ReviewerRole | null = null;
    if (it.actorId != null) {
      const stored = storedRoleOf.get(it.actorId);
      const login = loginOf.get(it.actorId);
      role = stored ?? (login != null ? defaultRoleFor(login) : null);
    }
    out.set(it.id, { severity, role });
  }
  return out;
}

/** Does an item pass the severity half? Pure. */
export function passesSeverity(f: FeedBotFacts | undefined, severities: readonly FeedSeverity[] | null): boolean {
  if (severities == null) return true;
  return severities.includes(f?.severity ?? 'unscored');
}

/** Does an item pass the bot-type half? A row with no role never passes a narrowed filter. Pure. */
export function passesBotRole(f: FeedBotFacts | undefined, botRoles: readonly ReviewerRole[] | null): boolean {
  if (botRoles == null) return true;
  return f?.role != null && botRoles.includes(f.role);
}

/** Count `list` by the given key. Pure. */
export function countBy(
  list: readonly ConsolidatedFeedItem[],
  facts: ReadonlyMap<string, FeedBotFacts>,
  key: (f: FeedBotFacts | undefined) => string | null,
): Record<string, number> {
  const out: Record<string, number> = {};
  for (const it of list) {
    const k = key(facts.get(it.id));
    if (k != null) out[k] = (out[k] ?? 0) + 1;
  }
  return out;
}
