// CREATING A RELEASE (docs/RELEASES.md § Releases tab 5–7). Two entry points:
//
//   previewRelease  POST /api/releases/preview — the dialog: the snapshot Confirm sends back, the notes
//                   (code-built; a model summary per story when AI is on), the comment preview and the
//                   selection problems. Reads the DB (and the model); never GitHub or the tracker.
//   createRelease   POST /api/releases — Confirm. FIRST re-reads every ticket in the release from the
//                   tracker (the reader's press: the documented exception to "read when RECEIVED, never
//                   when VIEWED", docs/TRACKERS.md § Releases) and re-checks each version tag's commit on
//                   GitHub; ANY change stops it and returns the changes — NOTHING is written. Then, in
//                   order:
//                     1. an annotated release tag per repo (a name that exists is REFUSED, never moved);
//                     2. a GitHub pre-release on each tag that landed, carrying that repo's notes;
//                     3. a tracker comment per shipped ticket whose repos ALL tagged in this release
//                        (Jira; other trackers: "not supported yet", recorded per ticket);
//                     4. settle-and-verify: the tags step re-reads each tagged repo's tags.
//
// ⚠ CLAIM BEFORE WRITE, NEVER RETRIED: every write's row is moved 'pending' → 'claimed' by
// compare-and-set BEFORE the network call, and its outcome recorded; a failure stays failed. The
// PARTIAL UNIQUE (account, repo, release_tag_name) index on release_items' LIVE rows (pending /
// claimed / done, migration 0197) makes a second press for the same tag a no-op (the claim is the
// row), and a ticket is commented on only when its repos tagged in THIS release — so pressing again
// writes nothing new. A FAILED or REFUSED row holds no name: a later press (a reader's press, never an
// automatic retry) is a new claim on a new row. A press where no repo gets a row records no release.
// ⚠ The check is folded over the WHOLE workspace, the selection applied after (`releasable`,
// `releaseShippedTickets`, `releaseSelectionProblems`) — a ticket's other repos must be seen.
// ⚠ One failure never undoes the steps that worked.
// ⚠ No transaction spans a network call: `runTransaction` only for the rows written before the writes.
import { and, asc, eq, inArray } from 'drizzle-orm';
import {
  RELEASE_NOTES_SECTION_MAX,
  foldReleaseCheck,
  parseTicketIdent,
  releaseCommentLines,
  releaseCommentWiki,
  releaseFinalState,
  releaseNotesDocument,
  releaseNotesInputOf,
  releaseNotesSection,
  releaseSelectionProblems,
  releaseSettingsConfigured,
  releaseShippedTickets,
  releaseSnapshotChanges,
  releaseSnapshotOf,
  releaseStepLines,
  releaseTagMessage,
  type CreateReleaseBody,
  type CreateReleaseResponse,
  type ReleaseCheckResult,
  type ReleaseDetail,
  type ReleaseDetailItem,
  type ReleasePreviewBody,
  type ReleasePreviewResponse,
  type ReleaseSettings,
  type ReleaseSnapshot,
} from '@pierre-review/shared';
import { db, runTransaction, schema } from '../db/client.js';
import { resolveWorkspaceScope } from '../db/queries.js';
import { loadReleaseCheckInput } from '../db/release-check.js';
import { getReleaseSettings } from '../db/release-settings.js';
import type { ReleaseGithub } from './github.js';
import { storySummaries, storySummaryInputs, summariesAvailable, type StorySummariser } from './notes.js';

const { releases, releaseItems, releaseTicketComments, repos, repoTags, accounts } = schema;

/** A refusal before anything is read or written (400 / 404). */
export class ReleaseRequestError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export interface ReleaseCheckLoad {
  result: ReleaseCheckResult;
  /** repoId → owner / name. */
  repoNames: Map<number, { owner: string; name: string }>;
}

/** Everything outside this module (tests replace them). */
export interface ReleaseWriteDeps {
  now(): Date;
  check(accountId: number, workspaceId: number, repoIds: readonly number[], settings: ReleaseSettings): Promise<ReleaseCheckLoad>;
  /** Read ONE ticket again from the tracker, through the worker's own path. True = it answered. */
  rereadTicket(accountId: number, a: { ident: string; key: string; prIds: number[] }): Promise<boolean>;
  github(accountId: number): Promise<ReleaseGithub>;
  postComment(accountId: number, a: { workspaceId: number; ident: string; wiki: string }): Promise<{ ok: true } | { ok: false; message: string }>;
  /** Settle: re-read one repo's tags (never throws). */
  settleTags(accountId: number, repo: { repoId: number; owner: string; name: string }): Promise<void>;
  approverName(accountId: number): Promise<string>;
  summarise?: StorySummariser;
  summariesAvailable(): Promise<boolean>;
  trackerSite(accountId: number, workspaceId: number): Promise<{ provider: string; apiRoot: string } | null>;
}

const splitFullName = (fullName: string): { owner: string; name: string } => {
  const i = fullName.indexOf('/');
  return { owner: fullName.slice(0, i), name: fullName.slice(i + 1) };
};

export async function defaultCheck(
  accountId: number,
  workspaceId: number,
  repoIds: readonly number[],
  settings: ReleaseSettings,
): Promise<ReleaseCheckLoad> {
  const input = await loadReleaseCheckInput(accountId, workspaceId, repoIds, settings);
  return {
    result: foldReleaseCheck(input),
    repoNames: new Map(input.repos.map((r) => [r.repoId, splitFullName(r.fullName)])),
  };
}

export function defaultReleaseWriteDeps(): ReleaseWriteDeps {
  return {
    now: () => new Date(),
    check: defaultCheck,
    async rereadTicket(accountId, a) {
      const prId = a.prIds[0];
      if (prId == null) return false;
      // LAZY: tracker/runtime.ts opens the database at import.
      const [{ trackerContext }, { syncOnePrNow }] = await Promise.all([import('../tracker/runtime.js'), import('../tracker/worker.js')]);
      try {
        const stats = await syncOnePrNow(trackerContext(), accountId, prId, [a.key], { force: true });
        return stats.fetched > 0 && stats.failed === 0;
      } catch {
        return false;
      }
    },
    async github(accountId) {
      const [{ getAccessToken }, { releaseGithubFor }] = await Promise.all([import('../auth/account.js'), import('./github.js')]);
      return releaseGithubFor(await getAccessToken(accountId));
    },
    async postComment(accountId, a) {
      const [{ trackerContext }, { postTicketComment }] = await Promise.all([
        import('../tracker/runtime.js'),
        import('../tracker/ticket-update.js'),
      ]);
      const out = await postTicketComment(trackerContext(), { accountId, ...a });
      return out.ok ? { ok: true } : { ok: false, message: out.message };
    },
    async settleTags(accountId, repo) {
      try {
        const [{ getAccessToken }, { runTagsStep }] = await Promise.all([import('../auth/account.js'), import('../sync/tags-step.js')]);
        await runTagsStep({ ...repo, accountId, token: await getAccessToken(accountId) });
      } catch {
        // Non-fatal: the settle sweep finds the tag push later.
      }
    },
    async approverName(accountId) {
      const row = (
        await db.select({ displayName: accounts.displayName, login: accounts.githubLogin }).from(accounts).where(eq(accounts.id, accountId)).execute()
      )[0];
      return row?.displayName?.trim() || row?.login || 'the release manager';
    },
    summariesAvailable,
    async trackerSite(accountId, workspaceId) {
      const { workspaceSite } = await import('../db/stories.js');
      return workspaceSite(accountId, workspaceId);
    },
  };
}

interface Scoped {
  workspaceId: number;
  settings: ReleaseSettings;
  included: number[];
  /** Every repo of the workspace: the check ALWAYS folds over all of them (the ships-whole and
   *  open-work rules must see a ticket's other repos); the selection is applied after. */
  all: number[];
}

async function scoped(accountId: number, rawWorkspace: string | number | undefined | null, repoIds: readonly number[]): Promise<Scoped> {
  const scope = await resolveWorkspaceScope(accountId, rawWorkspace);
  const settings = (await getReleaseSettings(accountId, scope.workspaceId)) ?? { releaseSuffix: null, hotfixSuffix: null };
  if (!releaseSettingsConfigured(settings)) {
    throw new ReleaseRequestError(400, 'ReleasesNotSet', 'Set the release suffix and the hotfix suffix first.');
  }
  const members = new Set(scope.repoIds);
  const included = [...new Set(repoIds)].filter((id) => members.has(id));
  if (included.length === 0) throw new ReleaseRequestError(400, 'NothingToRelease', 'Choose at least one repository to release.');
  return { workspaceId: scope.workspaceId, settings, included, all: [...scope.repoIds] };
}

/** The repos of the selection that can be released: a candidate and write access. */
function releasable(result: ReleaseCheckResult, included: readonly number[]): number[] {
  const inc = new Set(included);
  return result.repos.filter((r) => inc.has(r.repoId) && r.candidate != null && r.writable).map((r) => r.repoId);
}

// ── Preview ─────────────────────────────────────────────────────────────────────────────────────

export async function previewRelease(
  accountId: number,
  rawWorkspace: string | number | undefined | null,
  body: ReleasePreviewBody,
  deps: ReleaseWriteDeps = defaultReleaseWriteDeps(),
): Promise<ReleasePreviewResponse> {
  const s = await scoped(accountId, rawWorkspace, body.repoIds);
  const { result } = await deps.check(accountId, s.workspaceId, s.all, s.settings);
  const included = releasable(result, s.included);
  const shipped = releaseShippedTickets(result, included);
  const ai = shipped.length > 0 && (await deps.summariesAvailable());
  let summaries = new Map<string, string | null>();
  if (ai) {
    const prsByIdent = new Map<string, number[]>();
    for (const r of releaseNotesInputOf(result, included)) for (const st of r.stories) prsByIdent.set(st.ident, st.prs.map((p) => p.id));
    const inputs = await storySummaryInputs(
      accountId,
      shipped.map((t) => ({ ident: t.ident, key: t.key, title: t.title, prIds: prsByIdent.get(t.ident) ?? [] })),
      await deps.trackerSite(accountId, s.workspaceId),
    );
    summaries = await storySummaries(accountId, inputs, deps.summarise ? { summarise: deps.summarise } : {});
  }
  const facts = releaseNotesInputOf(result, included, summaries);
  const sections = facts.map((r) => ({ repoId: r.repoId, repoName: r.repoName, releaseTagName: r.releaseTagName, markdown: releaseNotesSection(r) }));
  const first = shipped[0];
  let commentPreview: string | null = null;
  if (first != null) {
    const tags = facts
      .filter((r) => first.repos.some((x) => x.repoId === r.repoId && x.state === 'in_candidate'))
      .map((r) => ({ repoName: r.repoName, releaseTagName: r.releaseTagName }));
    const lines = releaseCommentLines({ approverName: await deps.approverName(accountId), at: deps.now(), tags, notesUrl: null });
    commentPreview = [...lines, 'Release notes: (the link to the GitHub pre-release)'].join('\n');
  }
  const written = [...summaries.values()].filter((v) => v != null).length;
  return {
    workspaceId: s.workspaceId,
    snapshot: releaseSnapshotOf(result, included),
    sections,
    notesMarkdown: releaseNotesDocument(sections.map((x) => x.markdown)),
    commentPreview,
    problems: releaseSelectionProblems(result, included),
    summaries: { written, missing: shipped.length - written, ai },
  };
}

// ── Create ──────────────────────────────────────────────────────────────────────────────────────

/** The repos and tickets the re-check must cover: the snapshot's plus what the check ships now. */
function ticketsToReread(
  result: ReleaseCheckResult,
  included: readonly number[],
  snapshot: ReleaseSnapshot,
): Array<{ ident: string; key: string; prIds: number[] }> {
  const byIdent = new Map(result.tickets.map((t) => [t.ident, t]));
  const out = new Map<string, { ident: string; key: string; prIds: number[] }>();
  const add = (ident: string, key: string): void => {
    if (out.has(ident)) return;
    const t = byIdent.get(ident);
    const prIds = t == null ? [] : [...new Set(t.repos.flatMap((r) => r.prIds))];
    if (prIds.length === 0) {
      for (const p of result.prs) if (p.ticketIdents.includes(ident)) prIds.push(p.id);
    }
    out.set(ident, { ident, key: t?.key ?? key, prIds });
  };
  for (const t of snapshot.tickets) add(t.ident, t.key);
  for (const t of releaseShippedTickets(result, included)) add(t.ident, t.key);
  return [...out.values()];
}

async function pool<T>(items: readonly T[], n: number, fn: (x: T) => Promise<void>): Promise<void> {
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(n, items.length) }, async () => {
      while (next < items.length) await fn(items[next++]!);
    }),
  );
}

const TRACKER_WORDS: Record<string, string> = { github: 'GitHub Issues', linear: 'Linear', notion: 'Notion' };

export async function createRelease(
  accountId: number,
  rawWorkspace: string | number | undefined | null,
  body: CreateReleaseBody,
  deps: ReleaseWriteDeps = defaultReleaseWriteDeps(),
): Promise<CreateReleaseResponse> {
  const s = await scoped(accountId, rawWorkspace, body.repoIds);
  const snapshot = body.snapshot;

  // ── 1. The re-check: tickets from the tracker, then the fold, then each version tag on GitHub ──
  const before = await deps.check(accountId, s.workspaceId, s.all, s.settings);
  const toRead = ticketsToReread(before.result, s.included, snapshot);
  const unread: Array<{ ident: string; key: string }> = [];
  await pool(toRead, 4, async (t) => {
    if (!(await deps.rereadTicket(accountId, t))) unread.push({ ident: t.ident, key: t.key });
  });
  const after = await deps.check(accountId, s.workspaceId, s.all, s.settings);
  const included = releasable(after.result, s.included);
  const gh = await deps.github(accountId);
  const liveShaChanged: Array<{ repoId: number; tagName: string }> = [];
  const extraChanges: string[] = [];
  const existsLive = new Set<number>();
  const nameOf = (id: number): string => after.result.repos.find((r) => r.repoId === id)?.name ?? after.repoNames.get(id)?.name ?? 'a repository';
  for (const r of snapshot.repos) {
    const names = after.repoNames.get(r.repoId);
    if (names == null) continue;
    try {
      const live = await gh.readTagSha(names.owner, names.name, r.tagName);
      if (live !== r.sha) liveShaChanged.push({ repoId: r.repoId, tagName: r.tagName });
    } catch {
      extraChanges.push(`${r.tagName} in ${nameOf(r.repoId)} could not be checked on GitHub.`);
    }
  }
  const snapRepoIds = new Set(snapshot.repos.map((r) => r.repoId));
  for (const id of included) if (!snapRepoIds.has(id)) extraChanges.push(`${nameOf(id)} now has a version tag to release.`);
  for (const p of releaseSelectionProblems(after.result, included)) {
    extraChanges.push(`${p.key} also needs ${p.missingRepoIds.map(nameOf).join(' and ')}.`);
  }
  const changes = [
    ...releaseSnapshotChanges(
      { repos: snapshot.repos.filter((r) => s.included.includes(r.repoId)), tickets: snapshot.tickets },
      after.result,
      { liveShaChanged, unread },
    ),
    ...extraChanges,
  ];
  if (changes.length > 0) return { workspaceId: s.workspaceId, outcome: 'stopped', changes, release: null };
  if (included.length === 0) throw new ReleaseRequestError(400, 'NothingToRelease', 'There is no version tag to release.');

  // The release tag names that exist on GitHub already: refused for that repo, the others go ahead.
  const repoChecks = after.result.repos.filter((r) => included.includes(r.repoId));
  for (const r of repoChecks) {
    const names = after.repoNames.get(r.repoId)!;
    try {
      if ((await gh.readTagSha(names.owner, names.name, r.candidate!.releaseTagName)) != null) existsLive.add(r.repoId);
    } catch {
      // Unknown: the ref write answers it (a 422 for a name that exists).
    }
  }

  // ── 2. The rows, then the writes ──
  const now = deps.now();
  const edited = new Map((body.sections ?? []).map((x) => [x.repoId, x.markdown.slice(0, RELEASE_NOTES_SECTION_MAX)]));
  const facts = releaseNotesInputOf(after.result, included);
  const sectionOf = new Map(facts.map((f) => [f.repoId, edited.get(f.repoId) ?? releaseNotesSection(f)]));
  const login = (await db.select({ login: accounts.githubLogin }).from(accounts).where(eq(accounts.id, accountId)).execute())[0]?.login ?? null;
  const earlier: string[] = [];
  const ITEM_WORDS: Record<string, string> = {
    done: 'was already made by an earlier release',
    claimed: 'is being made by an earlier release, or that release stopped part way (check GitHub)',
    pending: 'is being made by an earlier release',
  };
  const releaseId = await runTransaction(async (tx) => {
    const [rel] = await tx
      .insert(releases)
      .values({
        accountId,
        workspaceId: s.workspaceId,
        createdByLogin: login,
        createdAt: now,
        releaseSuffix: s.settings.releaseSuffix!,
        notesMarkdown: releaseNotesDocument(repoChecks.map((r) => sectionOf.get(r.repoId) ?? '')),
        state: 'writing',
      })
      .returning({ id: releases.id })
      .execute();
    let inserted = 0;
    for (const r of repoChecks) {
      // The tag name is in an EARLIER release's LIVE row (pending / claimed / done — the partial unique
      // index, migration 0197): that press owns it (claimed, never retried) — nothing is recorded for
      // it here. A failed or refused row holds no name, so a new press is a new claim on a new row.
      const livePrior = async (): Promise<string | null> =>
        (
          await tx
            .select({ tagState: releaseItems.tagState })
            .from(releaseItems)
            .where(
              and(
                eq(releaseItems.accountId, accountId),
                eq(releaseItems.repoId, r.repoId),
                eq(releaseItems.releaseTagName, r.candidate!.releaseTagName),
                inArray(releaseItems.tagState, ['pending', 'claimed', 'done']),
              ),
            )
            .limit(1)
            .execute()
        )[0]?.tagState ?? null;
      const owned = (state: string | null): void => {
        const words = ITEM_WORDS[state ?? 'done'] ?? ITEM_WORDS.done!;
        earlier.push(`${r.name} ${r.candidate!.releaseTagName} ${words}. Nothing was written for it.`);
      };
      const prior = await livePrior();
      if (prior != null) {
        owned(prior);
        continue;
      }
      const got = await tx
        .insert(releaseItems)
        .values({
          accountId,
          releaseId: rel!.id,
          repoId: r.repoId,
          versionTag: r.candidate!.name,
          sha: r.candidate!.sha,
          releaseTagName: r.candidate!.releaseTagName,
          notesMarkdown: sectionOf.get(r.repoId) ?? '',
          tagState: existsLive.has(r.repoId) ? 'refused' : 'pending',
          prereleaseState: existsLive.has(r.repoId) ? 'skipped' : 'pending',
          error: existsLive.has(r.repoId) ? 'the tag already exists' : null,
          updatedAt: now,
        })
        .onConflictDoNothing()
        .returning({ id: releaseItems.id })
        .execute();
      if (got.length === 0) owned(await livePrior());
      else inserted += 1;
    }
    // Nothing of this press holds a row: no release is recorded (it would become the tab's "latest").
    if (inserted === 0) {
      await tx.delete(releases).where(and(eq(releases.id, rel!.id), eq(releases.accountId, accountId))).execute();
      return null;
    }
    return rel!.id;
  });
  if (releaseId == null) return { workspaceId: s.workspaceId, outcome: 'stopped', changes: earlier, release: null };

  const items = await db
    .select()
    .from(releaseItems)
    .where(and(eq(releaseItems.accountId, accountId), eq(releaseItems.releaseId, releaseId)))
    .execute();

  /** Compare-and-set one column of one item. True = this call owns the write. */
  const claimItem = async (id: number, col: 'tag' | 'prerelease'): Promise<boolean> => {
    const set = col === 'tag' ? { tagState: 'claimed' as const, updatedAt: deps.now() } : { prereleaseState: 'claimed' as const, updatedAt: deps.now() };
    const where = col === 'tag' ? eq(releaseItems.tagState, 'pending') : eq(releaseItems.prereleaseState, 'pending');
    return (await db.update(releaseItems).set(set).where(and(eq(releaseItems.id, id), eq(releaseItems.accountId, accountId), where)).returning({ id: releaseItems.id }).execute()).length === 1;
  };

  // 2.1 The annotated release tags.
  const tagged = new Set<number>();
  for (const it of items) {
    if (it.tagState !== 'pending' || !(await claimItem(it.id, 'tag'))) continue;
    const names = after.repoNames.get(it.repoId)!;
    let out: Awaited<ReturnType<ReleaseGithub['createReleaseTag']>>;
    try {
      out = await gh.createReleaseTag(names.owner, names.name, {
        tag: it.releaseTagName,
        sha: it.sha,
        message: releaseTagMessage(names.name, it.releaseTagName, it.versionTag),
      });
    } catch {
      out = { ok: false, exists: false, message: 'GitHub could not be reached' };
    }
    if (out.ok) tagged.add(it.repoId);
    await db
      .update(releaseItems)
      .set(
        out.ok
          ? { tagState: 'done', tagObjectOid: out.tagObjectOid, updatedAt: deps.now() }
          : { tagState: out.exists ? 'refused' : 'failed', error: out.message, updatedAt: deps.now() },
      )
      .where(and(eq(releaseItems.id, it.id), eq(releaseItems.accountId, accountId)))
      .execute();
  }

  // 2.2 The pre-releases (only on a tag that landed in THIS release).
  const releaseUrl = new Map<number, string>();
  for (const it of items) {
    if (!tagged.has(it.repoId)) {
      await db
        .update(releaseItems)
        .set({ prereleaseState: 'skipped', updatedAt: deps.now() })
        .where(and(eq(releaseItems.id, it.id), eq(releaseItems.accountId, accountId), eq(releaseItems.prereleaseState, 'pending')))
        .execute();
      continue;
    }
    if (!(await claimItem(it.id, 'prerelease'))) continue;
    const names = after.repoNames.get(it.repoId)!;
    let out: Awaited<ReturnType<ReleaseGithub['createPrerelease']>>;
    try {
      out = await gh.createPrerelease(names.owner, names.name, {
        tag: it.releaseTagName,
        title: `${names.name} ${it.releaseTagName}`,
        body: it.notesMarkdown,
      });
    } catch {
      out = { ok: false, message: 'GitHub could not be reached' };
    }
    if (out.ok) releaseUrl.set(it.repoId, out.url);
    await db
      .update(releaseItems)
      .set(
        out.ok
          ? { prereleaseState: 'done', githubReleaseId: out.id, githubReleaseUrl: out.url, updatedAt: deps.now() }
          : { prereleaseState: 'failed', error: out.message, updatedAt: deps.now() },
      )
      .where(and(eq(releaseItems.id, it.id), eq(releaseItems.accountId, accountId)))
      .execute();
  }

  // 2.3 The tracker comments: a shipped ticket whose repos ALL tagged in this release.
  const shipped = releaseShippedTickets(after.result, included);
  const approver = shipped.length > 0 ? await deps.approverName(accountId) : '';
  const repoById = new Map(after.result.repos.map((r) => [r.repoId, r]));
  for (const t of shipped) {
    const its = t.repos
      .filter((r) => r.state === 'in_candidate' && included.includes(r.repoId))
      .sort((a, b) => (repoById.get(a.repoId)?.name ?? '').localeCompare(repoById.get(b.repoId)?.name ?? ''));
    const provider = parseTicketIdent(t.ident)?.provider ?? (/^([a-z]+):/.exec(t.ident)?.[1] ?? null);
    const [row] = await db
      .insert(releaseTicketComments)
      .values({ accountId, releaseId, ticketKey: t.key, trackerKind: provider, state: 'pending' })
      .onConflictDoNothing()
      .returning({ id: releaseTicketComments.id })
      .execute();
    if (row == null) continue;
    const settle = async (set: Partial<typeof releaseTicketComments.$inferInsert>, from: 'pending' | 'claimed'): Promise<boolean> =>
      (
        await db
          .update(releaseTicketComments)
          .set(set)
          .where(and(eq(releaseTicketComments.id, row.id), eq(releaseTicketComments.accountId, accountId), eq(releaseTicketComments.state, from)))
          .returning({ id: releaseTicketComments.id })
          .execute()
      ).length === 1;
    const notTagged = its.filter((r) => !tagged.has(r.repoId)).map((r) => repoById.get(r.repoId)?.name ?? 'a repository');
    if (notTagged.length > 0) {
      await settle({ state: 'skipped', error: `${notTagged.join(' and ')} ${notTagged.length > 1 ? 'were' : 'was'} not tagged` }, 'pending');
      continue;
    }
    if (provider !== 'jira') {
      await settle({ state: 'skipped', error: `comments on ${TRACKER_WORDS[provider ?? ''] ?? 'this tracker'} are not supported yet` }, 'pending');
      continue;
    }
    if (!(await settle({ state: 'claimed', claimedAt: deps.now() }, 'pending'))) continue;
    const wiki = releaseCommentWiki({
      approverName: approver,
      at: now,
      tags: its.map((r) => {
        const rc = repoById.get(r.repoId)!;
        return { repoName: rc.name, releaseTagName: rc.candidate!.releaseTagName };
      }),
      notesUrl: its.map((r) => releaseUrl.get(r.repoId)).find((u) => u != null) ?? null,
    });
    let out: { ok: true } | { ok: false; message: string };
    try {
      out = await deps.postComment(accountId, { workspaceId: s.workspaceId, ident: t.ident, wiki });
    } catch {
      out = { ok: false, message: 'the tracker could not be reached' };
    }
    await settle(out.ok ? { state: 'posted', postedAt: deps.now() } : { state: 'failed', error: out.message }, 'claimed');
  }

  // ── 3. Settle and verify: re-read the tagged repos' tags (the new tags become the baseline) ──
  const unverified: string[] = [];
  await Promise.all(
    [...tagged].map(async (repoId) => {
      const names = after.repoNames.get(repoId)!;
      await deps.settleTags(accountId, { repoId, ...names });
      const it = items.find((i) => i.repoId === repoId)!;
      if (!(await releaseTagStored(accountId, repoId, it.releaseTagName, it.sha))) {
        unverified.push(`${names.name} ${it.releaseTagName} is on GitHub. It will show up here shortly.`);
      }
    }),
  );

  const detail = (await getReleaseDetail(accountId, releaseId))!;
  const state = releaseFinalState(detail);
  await db
    .update(releases)
    .set({ state, finishedAt: deps.now() })
    .where(and(eq(releases.id, releaseId), eq(releases.accountId, accountId)))
    .execute();
  return {
    workspaceId: s.workspaceId,
    outcome: 'written',
    changes: [],
    release: { ...detail, state, steps: [...detail.steps, ...earlier.map((text) => ({ ok: false, text })), ...unverified.map((text) => ({ ok: true, text }))] },
  };
}

/** GET /api/releases/:id — the stored release, this account only (null ⇒ 404). */
export async function getReleaseDetail(accountId: number, releaseId: number): Promise<ReleaseDetail | null> {
  const rel = (
    await db.select().from(releases).where(and(eq(releases.id, releaseId), eq(releases.accountId, accountId))).execute()
  )[0];
  if (rel == null) return null;
  const itemRows = await db
    .select()
    .from(releaseItems)
    .where(and(eq(releaseItems.accountId, accountId), eq(releaseItems.releaseId, releaseId)))
    .orderBy(asc(releaseItems.id))
    .execute();
  const repoRows =
    itemRows.length === 0
      ? []
      : await db
          .select({ id: repos.id, name: repos.name })
          .from(repos)
          .where(and(eq(repos.accountId, accountId), inArray(repos.id, itemRows.map((i) => i.repoId))))
          .execute();
  const nameOf = new Map(repoRows.map((r) => [r.id, r.name]));
  const commentRows = await db
    .select()
    .from(releaseTicketComments)
    .where(and(eq(releaseTicketComments.accountId, accountId), eq(releaseTicketComments.releaseId, releaseId)))
    .orderBy(asc(releaseTicketComments.ticketKey))
    .execute();
  const items: ReleaseDetailItem[] = itemRows
    .map((i) => ({
      repoId: i.repoId,
      repoName: nameOf.get(i.repoId) ?? '',
      versionTag: i.versionTag,
      sha: i.sha,
      releaseTagName: i.releaseTagName,
      tagState: i.tagState,
      prereleaseState: i.prereleaseState,
      releaseUrl: i.githubReleaseUrl,
      error: i.error,
    }))
    .sort((a, b) => a.repoName.localeCompare(b.repoName));
  const comments = commentRows.map((c) => ({ ticketKey: c.ticketKey, state: c.state, error: c.error }));
  return {
    id: rel.id,
    workspaceId: rel.workspaceId,
    createdAt: rel.createdAt.toISOString(),
    createdBy: rel.createdByLogin,
    state: rel.state,
    releaseSuffix: rel.releaseSuffix,
    notesMarkdown: rel.notesMarkdown,
    items,
    comments,
    steps: releaseStepLines({ items, comments }),
  };
}

/** Verify after the settle: the release tag is stored at its commit. Used by the tests and the log. */
export async function releaseTagStored(accountId: number, repoId: number, name: string, sha: string): Promise<boolean> {
  const row = (
    await db
      .select({ sha: repoTags.sha })
      .from(repoTags)
      .where(and(eq(repoTags.accountId, accountId), eq(repoTags.repoId, repoId), eq(repoTags.name, name)))
      .execute()
  )[0];
  return row?.sha === sha;
}
