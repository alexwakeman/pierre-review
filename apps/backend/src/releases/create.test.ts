// CREATING A RELEASE (releases/create.ts; docs/RELEASES.md § Acceptance checks 18–23, 32): Confirm's
// re-check, the claimed writes, partial failure, the repeat press. A THROWAWAY sqlite DB holds the
// release rows (real tables, real unique indexes); GitHub, the tracker and the check's inputs are fakes.
//
// DATABASE_URL is set BEFORE importing config/client (they open the connection at module load), and
// every DB value import below is dynamic for the same reason.
import { rmSync } from 'node:fs';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { foldReleaseCheck, type ReleaseCheckInput, type ReleaseSnapshot } from '@pierre-review/shared';
import type { ReleaseGithub } from './github.js';
import type { ReleaseWriteDeps } from './create.js';

const DB_PATH = `${process.env.LIMN_TEST_RUN_DIR ?? '/tmp'}/pierre-release-create-test.sqlite`;
process.env.DATABASE_URL = DB_PATH;
process.env.DISABLE_SCHEDULER = 'true';

const day = (d: number) => new Date(Date.UTC(2026, 10, d, 12));
const sha = (c: string) => c.padEnd(40, '0');
const ident = (key: string) => `jira:https://acme.atlassian.net#${key}`;

/* eslint-disable @typescript-eslint/no-explicit-any */
let client: any;
let m: typeof import('./create.js');
let API = 0;
let WEB = 0;
let workspaceId = 0;

beforeAll(async () => {
  for (const s of ['', '-shm', '-wal']) rmSync(DB_PATH + s, { force: true });
  const { runMigrations } = await import('../db/run-migrations.js');
  client = await import('../db/client.js');
  await runMigrations();
  const q = await import('../db/queries.js');
  const { repos } = client.schema;
  const mk = async (name: string) =>
    (
      await client.db
        .insert(repos)
        .values({ accountId: 1, owner: 'acme', name, githubNodeId: `R_rc_${name}`, defaultBranch: 'main', viewerPermission: 'WRITE' })
        .returning()
        .execute()
    )[0].id as number;
  API = await mk('api');
  WEB = await mk('web');
  await q.ensureRepoMemberships(1);
  workspaceId = (await q.resolveWorkspaceScope(1, undefined)).workspaceId;
  const { setReleaseSettings } = await import('../db/release-settings.js');
  await setReleaseSettings(1, workspaceId, { releaseSuffix: '-rc', hotfixSuffix: '-hotfix' });
  // Both repos are released from this workspace (only ticked repos can be released).
  const { setReleaseRepos } = await import('../db/release-repos.js');
  await setReleaseRepos(1, workspaceId, [API, WEB]);
  m = await import('./create.js');
});

afterAll(async () => {
  await client?.closeDb?.();
  for (const s of ['', '-shm', '-wal']) rmSync(DB_PATH + s, { force: true });
});

// ── The world the fakes hold ────────────────────────────────────────────────────────────────────

interface World {
  /** Tracker truth (what a re-read returns). */
  tracker: Record<string, { done: boolean; provider?: 'jira' | 'linear' }>;
  /** What the stored rows say (moved to the tracker truth by a re-read). */
  stored: Record<string, boolean>;
  /** GitHub's tags: name → commit, per repo name. */
  tags: Record<string, Record<string, string>>;
  failTag: Set<string>;
  /** `repo@sha` no longer on the default branch (a release point). */
  offMain?: Set<string>;
  unreadable: Set<string>;
  calls: { tag: string[]; prerelease: Array<{ repo: string; tag: string; body: string }>; comment: Array<{ ident: string; wiki: string }>; reread: string[] };
  /** Linear ticket idents (another tracker). */
  linear: Set<string>;
}

let w: World;

beforeEach(async () => {
  w = {
    tracker: { 'PLAT-1': { done: true }, 'PLAT-2': { done: true }, 'PLAT-3': { done: true } },
    stored: { 'PLAT-1': true, 'PLAT-2': true, 'PLAT-3': true },
    tags: { api: { 'v1.0.0': sha('api1') }, web: { 'v1.0.0': sha('web1') } },
    failTag: new Set(),
    unreadable: new Set(),
    calls: { tag: [], prerelease: [], comment: [], reread: [] },
    linear: new Set(),
  };
  extraPrs = [];
  dropPrs = new Set();
  openPrs = [];
  // Each test starts with no release rows (the unique tag index spans releases).
  const { releases, releaseItems, releaseTicketComments } = client.schema;
  await client.db.delete(releaseTicketComments).execute();
  await client.db.delete(releaseItems).execute();
  await client.db.delete(releases).execute();
});

const identOf = (key: string): string => (w.linear.has(key) ? `linear:https://api.linear.app#${key}` : ident(key));

function input(): ReleaseCheckInput {
  const repo = (repoId: number, name: string, prIds: number[]) => {
    const tags = Object.entries(w.tags[name] ?? {}).map(([tag, s]) => ({
      name: tag,
      sha: s,
      committedAt: day(5),
      taggedAt: tag.endsWith('-rc') ? day(6) : null,
      onDefaultBranch: true,
      moved: false,
    }));
    const v = tags.find((t) => t.name === 'v1.0.0')!;
    return {
      repoId,
      name,
      fullName: `acme/${name}`,
      writable: true,
      tags,
      ranges: [
        { tagName: 'v1.0.0', sha: v.sha, baseTagName: null, baseSha: null, prIds, unresolvedPrNumbers: [], unmatchedCommits: 0 },
        ...tags
          .filter((t) => t.name !== 'v1.0.0')
          .map((t) => ({ tagName: t.name, sha: t.sha, baseTagName: 'v1.0.0', baseSha: v.sha, prIds: [], unresolvedPrNumbers: [], unmatchedCommits: 0 })),
      ],
    };
  };
  const pr = (id: number, repoId: number, title: string, keys: string[]) => ({
    id,
    repoId,
    number: id,
    title,
    url: `https://github.com/acme/${repoId === API ? 'api' : 'web'}/pull/${id}`,
    isBot: false,
    mergedAt: day(4),
    ticketIdents: keys.map(identOf),
  });
  return {
    settings: { releaseSuffix: '-rc', hotfixSuffix: '-hotfix' },
    repos: [repo(API, 'api', [10, 11]), repo(WEB, 'web', [20, 21])],
    prs: [
      pr(10, API, 'Login via SSO', ['PLAT-1']),
      pr(11, API, 'Rate limit the export', ['PLAT-2']),
      pr(20, WEB, 'SSO button', ['PLAT-1']),
      pr(21, WEB, 'Dark mode', ['PLAT-3']),
      ...extraPrs,
    ].filter((p) => !dropPrs.has(p.id)),
    openPrs: [...openPrs],
    tickets: Object.keys(w.stored).map((key) => ({
      ident: identOf(key),
      key,
      title: `Story ${key}`,
      url: `https://acme.atlassian.net/browse/${key}`,
      statusName: w.stored[key] ? 'Done' : 'In review',
      done: w.stored[key]!,
      readState: 'ok' as const,
    })),
  };
}

/** The loader's narrowing: only these repos and their PRs. */
function only(inp: ReleaseCheckInput, repoIds: readonly number[]): ReleaseCheckInput {
  const ids = new Set(repoIds);
  return { ...inp, repos: inp.repos.filter((r) => ids.has(r.repoId)), prs: inp.prs.filter((p) => ids.has(p.repoId)) };
}

/** Extra PRs a test adds to the world (an open PR opened after the dialog, …). */
let extraPrs: ReleaseCheckInput['prs'] = [];
let dropPrs = new Set<number>();
/** Open PRs in the releasable repos (what the DB half reads from `pull_requests`). */
let openPrs: NonNullable<ReleaseCheckInput['openPrs']> = [];

const github: ReleaseGithub = {
  async readTagSha(_owner, name, tag) {
    return w.tags[name]?.[tag] ?? null;
  },
  async commitOnBranch(_owner, name, sha) {
    return !(w.offMain?.has(`${name}@${sha}`) ?? false);
  },
  async createReleaseTag(_owner, name, a) {
    w.calls.tag.push(`${name} ${a.tag} ${a.sha} ${a.message}`);
    if (w.failTag.has(name)) return { ok: false, exists: false, message: 'GitHub did not answer' };
    if (w.tags[name]![a.tag] != null) return { ok: false, exists: true, message: 'the tag already exists' };
    w.tags[name]![a.tag] = a.sha;
    return { ok: true, tagObjectOid: sha(`obj${name}`) };
  },
  async createPrerelease(_owner, name, a) {
    w.calls.prerelease.push({ repo: name, tag: a.tag, body: a.body });
    return { ok: true, id: w.calls.prerelease.length, url: `https://github.com/acme/${name}/releases/tag/${a.tag}` };
  },
};

function deps(over: Partial<ReleaseWriteDeps> = {}): ReleaseWriteDeps {
  return {
    now: () => new Date(2026, 10, 14, 12),
    // Honours the repoIds it is given, like the real loader: only those repos' tags, ranges and PRs.
    async check(_accountId, _workspaceId, repoIds) {
      const inp = only(input(), repoIds);
      return { result: foldReleaseCheck(inp), repoNames: new Map(inp.repos.map((r) => [r.repoId, { owner: 'acme', name: r.name }])) };
    },
    async rereadTickets(_accountId, _workspaceId, tickets) {
      const answered = new Set<string>();
      for (const t of tickets) {
        w.calls.reread.push(t.key);
        if (w.unreadable.has(t.key)) continue;
        w.stored[t.key] = w.tracker[t.key]!.done;
        answered.add(t.ident);
      }
      return answered;
    },
    github: async () => github,
    async postComment(_accountId, a) {
      w.calls.comment.push({ ident: a.ident, wiki: a.wiki });
      return { ok: true };
    },
    async settleTags(_accountId, repo) {
      // The tags step stores what GitHub now has.
      const { repoTags } = client.schema;
      for (const [name, s] of Object.entries(w.tags[repo.name] ?? {})) {
        if (!name.endsWith('-rc')) continue;
        await client.db
          .insert(repoTags)
          .values({ accountId: 1, repoId: repo.repoId, name, sha: s, committedAt: day(5), onDefaultBranch: true, firstSeenAt: day(14), lastSeenAt: day(14) })
          .onConflictDoNothing()
          .execute();
      }
    },
    approverName: async () => 'Ada Lovelace',
    summariesAvailable: async () => false,
    trackerSite: async () => ({ provider: 'jira', apiRoot: 'https://acme.atlassian.net' }),
    ...over,
  };
}

async function snapshot(repoIds: number[]): Promise<ReleaseSnapshot> {
  return (await m.previewRelease(1, workspaceId, { repoIds }, deps())).snapshot;
}

async function create(repoIds: number[], snap?: ReleaseSnapshot, d = deps()) {
  return m.createRelease(1, workspaceId, { repoIds, snapshot: snap ?? (await snapshot(repoIds)) }, d);
}

async function rowCount(): Promise<number> {
  return (await client.db.select().from(client.schema.releases).execute()).length;
}

// ── Tests ───────────────────────────────────────────────────────────────────────────────────────

describe('createRelease — the writes, in order, each claimed', () => {
  it('acceptance 19: <version><release suffix>, annotated, on the version tag commit; pre-release with the notes; one comment per ticket; no product name', async () => {
    const res = await create([API, WEB]);
    expect(res.outcome).toBe('written');
    const rel = res.release!;
    expect(rel.state).toBe('done');
    expect(w.calls.tag).toEqual([`api v1.0.0-rc ${sha('api1')} api v1.0.0-rc\n\nRelease of v1.0.0.`, `web v1.0.0-rc ${sha('web1')} web v1.0.0-rc\n\nRelease of v1.0.0.`]);
    expect(w.calls.prerelease.map((p) => p.tag)).toEqual(['v1.0.0-rc', 'v1.0.0-rc']);
    expect(w.calls.prerelease[0]!.body).toContain('## api v1.0.0-rc');
    expect(w.calls.comment.map((c) => c.ident).sort()).toEqual([ident('PLAT-1'), ident('PLAT-2'), ident('PLAT-3')]);
    const plat1 = w.calls.comment.find((c) => c.ident === ident('PLAT-1'))!.wiki;
    expect(plat1.split('\n')).toEqual([
      'Approved for release by Ada Lovelace on 14 Nov 2026.',
      'api v1.0.0\\-rc · web v1.0.0\\-rc',
      'Release notes: https://github.com/acme/api/releases/tag/v1.0.0-rc',
    ]);
    const everything = [...w.calls.tag, ...w.calls.prerelease.map((p) => p.body), ...w.calls.comment.map((c) => c.wiki)].join('\n');
    expect(everything).not.toMatch(/limn|ensemble/i);
    // Every ticket in the release was read again from the tracker first.
    expect(w.calls.reread.sort()).toEqual(['PLAT-1', 'PLAT-2', 'PLAT-3']);
    // Stored and viewable again.
    const again = await m.getReleaseDetail(1, rel.id);
    expect(again?.notesMarkdown).toContain('## web v1.0.0-rc');
    expect(again?.items.map((i) => [i.repoName, i.tagState, i.prereleaseState])).toEqual([
      ['api', 'done', 'done'],
      ['web', 'done', 'done'],
    ]);
    // Settled: the release tag is stored at its commit (it is the baseline from now on).
    expect(await m.releaseTagStored(1, API, 'v1.0.0-rc', sha('api1'))).toBe(true);
  });

  it('a repository released from MERGED PULL REQUESTS: the date-named tag on the release point, and Confirm checks the commit is still on main', async () => {
    // api has no version tags: its v1.0.0 commit stands as release point #10 (the DB half's job).
    const byPoints = (inp: ReleaseCheckInput): ReleaseCheckInput => ({
      ...inp,
      repos: inp.repos.map((r) =>
        r.repoId !== API
          ? r
          : {
              ...r,
              basis: 'prs' as const,
              pointReleaseTagName: '2026.11.14-rc',
              tags: r.tags.map((t) => (t.name === 'v1.0.0' ? { ...t, name: '#10' } : t)),
              ranges: r.ranges.map((x) => (x.tagName === 'v1.0.0' ? { ...x, tagName: '#10' } : x)),
            },
      ),
    });
    const d = deps({
      async check(_a, _w, repoIds) {
        const inp = byPoints(only(input(), repoIds));
        return {
          result: foldReleaseCheck(inp),
          repoNames: new Map(inp.repos.map((r) => [r.repoId, { owner: 'acme', name: r.name, defaultBranch: 'main' }])),
        };
      },
    });
    const preview = await m.previewRelease(1, workspaceId, { repoIds: [API] }, d);
    expect(preview.snapshot.repos).toEqual([{ repoId: API, tagName: '#10', sha: sha('api1') }]);
    expect(preview.sections[0]!.markdown).toContain(`Built from \\#10 (${sha('api1').slice(0, 7)}).`);

    // The commit left main (a force-push): Confirm stops and writes nothing.
    w.offMain = new Set([`api@${sha('api1')}`]);
    const stopped = await create([API], preview.snapshot, d);
    expect(stopped).toMatchObject({ outcome: 'stopped', changes: ['#10 in api is no longer on main.'] });
    expect(w.calls.tag).toEqual([]);

    w.offMain = new Set();
    const res = await create([API], preview.snapshot, d);
    expect(res.outcome).toBe('written');
    expect(w.calls.tag).toEqual([`api 2026.11.14-rc ${sha('api1')} api 2026.11.14-rc\n\nRelease of #10.`]);
    expect(w.calls.prerelease.map((p) => p.tag)).toEqual(['2026.11.14-rc']);
    const detail = await m.getReleaseDetail(1, res.release!.id);
    expect(detail?.items.map((i) => [i.repoName, i.tagState])).toEqual([['api', 'done']]);
  });

  it('acceptance 20: an existing release tag name is refused for that repo (never moved); the others go ahead', async () => {
    const snap = await snapshot([API, WEB]);
    // Pushed by hand a moment ago (not stored yet), on another commit.
    w.tags.web!['v1.0.0-rc'] = sha('elsewhere');
    const res = await m.createRelease(1, workspaceId, { repoIds: [API, WEB], snapshot: snap }, deps({ check: stale }));
    expect(res.outcome).toBe('written');
    expect(w.calls.tag.map((t) => t.split(' ')[0])).toEqual(['api']);
    expect(w.tags.web!['v1.0.0-rc']).toBe(sha('elsewhere'));
    const items = res.release!.items;
    expect(items.find((i) => i.repoName === 'web')).toMatchObject({ tagState: 'refused', prereleaseState: 'skipped' });
    expect(items.find((i) => i.repoName === 'api')).toMatchObject({ tagState: 'done', prereleaseState: 'done' });
    expect(res.release!.steps).toContainEqual({ ok: false, text: 'web v1.0.0-rc already exists. It was not moved.' });
    expect(res.release!.state).toBe('partial');
  });

  it('acceptance 21: a ticket leaves Done between the dialog and Confirm → Confirm stops, shows it, writes nothing', async () => {
    const snap = await snapshot([API, WEB]);
    w.tracker['PLAT-2'] = { done: false };
    const before = await rowCount();
    const res = await create([API, WEB], snap);
    expect(res.outcome).toBe('stopped');
    if (res.outcome !== 'stopped') return;
    expect(res.changes).toContain('PLAT-2 “Story PLAT-2” is In review.');
    expect(w.calls.tag).toEqual([]);
    expect(w.calls.prerelease).toEqual([]);
    expect(w.calls.comment).toEqual([]);
    expect(await rowCount()).toBe(before);
  });

  it('acceptance 21: a pull request opens for a shipped ticket between the dialog and Confirm → Confirm stops (the open PRs re-read from the DB), writes nothing', async () => {
    const snap = await snapshot([API, WEB]);
    openPrs = [{ repoId: WEB, repoName: 'web', number: 88, url: 'https://github.com/acme/web/pull/88', prId: 88, ticketIdents: [identOf('PLAT-1')] }];
    const before = await rowCount();
    const res = await create([API, WEB], snap);
    expect(res.outcome).toBe('stopped');
    if (res.outcome !== 'stopped') return;
    expect(res.changes).toContain('PLAT-1 “Story PLAT-1” has an open pull request in web (#88).');
    expect(w.calls.tag).toEqual([]);
    expect(await rowCount()).toBe(before);
  });

  it('a ticket the tracker does not answer for again stops Confirm', async () => {
    const snap = await snapshot([API]);
    w.unreadable.add('PLAT-2');
    const res = await create([API, WEB], snap);
    expect(res.outcome).toBe('stopped');
    expect(res.changes).toContain('PLAT-2 could not be read again from the tracker.');
    expect(w.calls.tag).toEqual([]);
  });

  it('a version tag moved on GitHub since the dialog opened stops Confirm', async () => {
    const snap = await snapshot([API, WEB]);
    w.tags.api!['v1.0.0'] = sha('moved');
    const res = await create([API, WEB], snap);
    expect(res.outcome).toBe('stopped');
    expect(res.changes).toContain('v1.0.0 in api now points at another commit.');
    expect(w.calls.tag).toEqual([]);
  });

  it('each repo on its own: releasing api alone ships PLAT-1 there, its comment naming only the api tag', async () => {
    const res = await create([API]);
    expect(res.outcome).toBe('written');
    expect(w.calls.tag.map((t) => t.split(' ')[0])).toEqual(['api']);
    const plat1 = w.calls.comment.find((c) => c.ident === ident('PLAT-1'))!.wiki;
    expect(plat1.split('\n')[1]).toBe('api v1.0.0\\-rc');
  });

  it('a repo that is not released from this workspace is refused before anything is read or written', async () => {
    const { setReleaseRepos } = await import('../db/release-repos.js');
    await setReleaseRepos(1, workspaceId, [API]);
    try {
      await expect(m.createRelease(1, workspaceId, { repoIds: [API, WEB], snapshot: { repos: [], tickets: [] } }, deps())).rejects.toMatchObject({
        status: 400,
        code: 'NotReleasable',
      });
      expect(w.calls.reread).toEqual([]);
    } finally {
      await setReleaseRepos(1, workspaceId, [API, WEB]);
    }
  });

  it('acceptance 22: a repo fails to tag → its tickets get no comment; tickets only in other repos do; the result says so', async () => {
    w.failTag.add('web');
    const res = await create([API, WEB]);
    expect(res.outcome).toBe('written');
    const rel = res.release!;
    expect(rel.state).toBe('partial');
    expect(w.calls.comment.map((c) => c.ident)).toEqual([ident('PLAT-2')]);
    expect(w.calls.prerelease.map((p) => p.repo)).toEqual(['api']);
    expect(rel.comments).toEqual([
      { ticketKey: 'PLAT-1', state: 'skipped', error: 'web was not tagged' },
      { ticketKey: 'PLAT-2', state: 'posted', error: null },
      { ticketKey: 'PLAT-3', state: 'skipped', error: 'web was not tagged' },
    ]);
    expect(rel.steps).toContainEqual({ ok: false, text: 'Tagging web v1.0.0-rc failed: GitHub did not answer' });
    expect(rel.steps).toContainEqual({ ok: false, text: 'No comment on PLAT-1: web was not tagged.' });
  });

  it('acceptance 23: the comment is posted once per shipped ticket; pressing again writes nothing new', async () => {
    const snap = await snapshot([API, WEB]);
    const first = await create([API, WEB], snap);
    expect(first.outcome).toBe('written');
    expect(w.calls.comment).toHaveLength(3);
    const counts = { tag: w.calls.tag.length, pre: w.calls.prerelease.length, comment: w.calls.comment.length };
    // The same press again (the stored rows not caught up): every name is taken — nothing is written.
    const again = await m.createRelease(1, workspaceId, { repoIds: [API, WEB], snapshot: snap }, deps({ check: stale }));
    // Every name is owned by the first press: nothing is recorded either (no empty "latest release").
    expect(again.outcome).toBe('stopped');
    expect(again.changes).toContain('api v1.0.0-rc was already made by an earlier release. Nothing was written for it.');
    expect({ tag: w.calls.tag.length, pre: w.calls.prerelease.length, comment: w.calls.comment.length }).toEqual(counts);
  });

  it('a FAILED tag holds no name: a later press is a new claim on a new row, and the failed row stays as history', async () => {
    w.failTag.add('web');
    const snap = await snapshot([API, WEB]);
    await create([API, WEB], snap);
    const webCalls = () => w.calls.tag.filter((t) => t.startsWith('web')).length;
    expect(webCalls()).toBe(1);
    w.failTag.clear();
    const again = await m.createRelease(1, workspaceId, { repoIds: [API, WEB], snapshot: snap }, deps({ check: stale }));
    expect(again.outcome).toBe('written');
    expect(webCalls()).toBe(2);
    const { releaseItems } = client.schema;
    const rows = await client.db.select().from(releaseItems).execute();
    expect(rows.filter((r: any) => r.releaseTagName === 'v1.0.0-rc' && r.repoId === WEB).map((r: any) => r.tagState).sort()).toEqual(['done', 'failed']);
    // A third press: the DONE row owns the name — nothing is written, and no empty release is recorded.
    const before = (await client.db.select().from(client.schema.releases).execute()).length;
    const third = await m.createRelease(1, workspaceId, { repoIds: [API, WEB], snapshot: snap }, deps({ check: stale }));
    expect(webCalls()).toBe(2);
    expect(third.outcome).toBe('stopped');
    expect(third.changes).toContain('web v1.0.0-rc was already made by an earlier release. Nothing was written for it.');
    expect((await client.db.select().from(client.schema.releases).execute()).length).toBe(before);
  });

  it('a tag CLAIMED by an earlier press (it stopped part way) is never written again, and says so', async () => {
    const snap = await snapshot([API, WEB]);
    const { releaseItems, releases } = client.schema;
    const [rel] = await client.db
      .insert(releases)
      .values({ accountId: 1, workspaceId, createdAt: new Date(), releaseSuffix: '-rc', notesMarkdown: '', state: 'writing' })
      .returning()
      .execute();
    await client.db
      .insert(releaseItems)
      .values({ accountId: 1, releaseId: rel.id, repoId: WEB, versionTag: 'v1.0.0', sha: 'x', releaseTagName: 'v1.0.0-rc', tagState: 'claimed', updatedAt: new Date() })
      .execute();
    const res = await create([API, WEB], snap);
    expect(w.calls.tag.filter((t) => t.startsWith('web'))).toHaveLength(0);
    expect(res.release!.steps).toContainEqual({
      ok: false,
      text: 'web v1.0.0-rc is being made by an earlier release, or that release stopped part way (check GitHub). Nothing was written for it.',
    });
  });

  it('another tracker: the comment is skipped with "not supported yet", per ticket', async () => {
    w.linear.add('PLAT-3');
    const res = await create([API, WEB]);
    expect(res.release!.comments.find((c) => c.ticketKey === 'PLAT-3')).toEqual({
      ticketKey: 'PLAT-3',
      state: 'skipped',
      error: 'comments on Linear are not supported yet',
    });
    expect(res.release!.state).toBe('done');
  });

  it('the edited notes are what the pre-release carries', async () => {
    const snap = await snapshot([API, WEB]);
    const res = await m.createRelease(1, workspaceId, { repoIds: [API, WEB], snapshot: snap, sections: [{ repoId: API, markdown: 'Edited by hand.' }] }, deps());
    expect(res.outcome).toBe('written');
    expect(w.calls.prerelease.find((p) => p.repo === 'api')!.body).toBe('Edited by hand.');
    expect(w.calls.prerelease.find((p) => p.repo === 'web')!.body).toContain('## web v1.0.0-rc');
  });

  it('refuses before anything with no repos of this workspace', async () => {
    await expect(m.createRelease(1, workspaceId, { repoIds: [999_999], snapshot: { repos: [], tickets: [] } }, deps())).rejects.toMatchObject({ status: 400, code: 'NotReleasable' });
    await expect(m.createRelease(1, workspaceId, { repoIds: [], snapshot: { repos: [], tickets: [] } }, deps())).rejects.toMatchObject({ status: 400, code: 'NothingToRelease' });
  });
});

/** The check as it read BEFORE the release tags were stored (the repeat-press race). */
async function stale(
  _accountId?: number,
  _workspaceId?: number,
  repoIds: readonly number[] = [API, WEB],
): Promise<ReturnType<ReleaseWriteDeps['check']> extends Promise<infer R> ? R : never> {
  const inp = only(input(), repoIds);
  for (const r of inp.repos) {
    r.tags = r.tags.filter((t) => !t.name.endsWith('-rc'));
    r.ranges = r.ranges.filter((x) => !x.tagName.endsWith('-rc'));
  }
  return { result: foldReleaseCheck(inp), repoNames: new Map(inp.repos.map((r) => [r.repoId, { owner: 'acme', name: r.name }])) };
}

describe('previewRelease — the dialog', () => {
  it('acceptance 32 (AI off): the notes are complete minus summaries; the comment preview reads like the comment', async () => {
    const p = await m.previewRelease(1, workspaceId, { repoIds: [API, WEB] }, deps());
    expect(p.summaries).toEqual({ written: 0, missing: 3, ai: false });
    expect(p.sections.map((s) => s.releaseTagName)).toEqual(['v1.0.0-rc', 'v1.0.0-rc']);
    expect(p.notesMarkdown).toContain('#### [PLAT-1](https://acme.atlassian.net/browse/PLAT-1) Story PLAT-1');
    expect(p.commentPreview?.split('\n')[0]).toBe('Approved for release by Ada Lovelace on 14 Nov 2026.');
  });

  it('acceptance 32 (AI on): a summary per story; one with a model-written number is dropped', async () => {
    const { _resetSummaryMemoForTest } = await import('./notes.js');
    _resetSummaryMemoForTest();
    const p = await m.previewRelease(
      1,
      workspaceId,
      { repoIds: [API, WEB] },
      deps({
        summariesAvailable: async () => true,
        summarise: async (_a, s) => (s.key === 'PLAT-2' ? 'Exports now handle 3 times the load.' : `People can use ${s.title?.toLowerCase().replace(/[^a-z ]/g, '')}.`),
      }),
    );
    expect(p.summaries).toEqual({ written: 2, missing: 1, ai: true });
    expect(p.notesMarkdown).toContain('People can use story plat.');
    expect(p.notesMarkdown).not.toContain('3 times');
  });
});
