// This Sprint → Releases and Settings → Releases: the pure UI half (components/Sprint/releasesModel.ts,
// components/Sprint/releaseTicketsModel.ts,
// components/settings/releasesSectionModel.ts) over REAL results of the shared fold
// (`foldReleaseCheck`). docs/RELEASES.md § Acceptance checks — numbers in the test names.
//
//   ./apps/backend/node_modules/.bin/vitest run --root apps/frontend test/releasesModel.test.ts
import { describe, expect, it } from 'vitest';
import {
  foldReleaseCheck,
  type ReleaseCheckInput,
  type ReleaseCheckPrInput,
  type ReleaseCheckRepoInput,
  type ReleaseCheckResult,
  type ReleaseCheckTicketInput,
} from '@pierre-review/shared';
import {
  RELEASES_POLL_MS,
  confirmStops,
  defaultTickedRepoIds,
  editedSections,
  latestReleaseLine,
  readAgoWords,
  refreshingLine,
  releasableRepos,
  releaseTagsLine,
  releasesPollInterval,
  showCreateRelease,
  repoLatestNote,
  repoProgress,
  ticketStatusWords,
} from '../src/components/Sprint/releasesModel.js';
import {
  TICKET_WINDOW_START,
  TICKET_WINDOW_STEP,
  noTicketGroupWords,
  noTicketPrLineOf,
  noTicketShownPrs,
  listedItems,
  releaseHolders,
  reposWithoutCandidate,
  repoStripText,
  repoTagWords,
  showTicketsWords,
  ticketMergedWords,
  ticketCardLine,
  ticketCardPrLines,
  ticketCardStatus,
  ticketList,
  ticketWindow,
} from '../src/components/Sprint/releaseTicketsModel.js';
import { releaseBasesDirty, releaseBasisOptions, releaseReposDirty, releaseSuffixChangeWarning } from '../src/components/settings/releasesSectionModel.js';

const SETTINGS = { releaseSuffix: '-rc', hotfixSuffix: '-hotfix' };
const day = (d: number, h = 12) => new Date(Date.UTC(2026, 10, d, h));
const sha = (c: string) => c.padEnd(40, '0');

interface TagSpec {
  name: string;
  d: number;
  prs?: number[];
  commit?: string;
  noRange?: boolean;
  taggedAt?: number;
}

function repo(repoId: number, name: string, specs: TagSpec[], writable = true): ReleaseCheckRepoInput {
  const tags = specs.map((s) => ({
    name: s.name,
    sha: sha(s.commit ?? s.name),
    committedAt: day(s.d),
    taggedAt: s.taggedAt != null ? day(s.taggedAt, 18) : null,
    onDefaultBranch: true,
    moved: false,
  }));
  const sorted = tags
    .map((t, i) => ({ t, s: specs[i]! }))
    .sort((a, b) => a.t.committedAt.getTime() - b.t.committedAt.getTime() || (a.t.taggedAt?.getTime() ?? 0) - (b.t.taggedAt?.getTime() ?? 0));
  const ranges = sorted.flatMap(({ t, s }, i) => {
    const base = i > 0 ? sorted[i - 1]!.t : null;
    if (s.noRange) return [];
    return [{
      tagName: t.name,
      sha: t.sha,
      baseTagName: base?.name ?? null,
      baseSha: base?.sha ?? null,
      prIds: s.prs ?? [],
      unresolvedPrNumbers: [],
      unmatchedCommits: 0,
    }];
  });
  return { repoId, fullName: `acme/${name}`, name, writable, tags, ranges };
}

function pr(id: number, repoId: number, tickets: string[], extra: Partial<ReleaseCheckPrInput> = {}): ReleaseCheckPrInput {
  return {
    id,
    repoId,
    number: id,
    title: `change ${id}`,
    url: `https://github.com/acme/r/pull/${id}`,
    isBot: false,
    mergedAt: day(1),
    ticketIdents: tickets,
    ...extra,
  };
}

function ticket(key: string, extra: Partial<ReleaseCheckTicketInput> = {}): ReleaseCheckTicketInput {
  return { ident: key, key, title: `${key} title`, url: null, statusName: 'Done', done: true, readState: 'ok', ...extra };
}

function run(parts: Partial<ReleaseCheckInput>): ReleaseCheckResult {
  return foldReleaseCheck({ settings: SETTINGS, repos: [], prs: [], tickets: [], ...parts });
}

const threeTags = (writable = true) =>
  repo(
    1,
    'api',
    [
      { name: 'v1.0.0', d: 1, prs: [1] },
      { name: 'v1.1.0', d: 3, prs: [2] },
      { name: 'v1.2.0', d: 5, prs: [3] },
    ],
    writable,
  );

describe('the header line', () => {
  it('says "none" with no release, else the day and month', () => {
    expect(latestReleaseLine({ latestReleaseTagAt: null, latestRelease: null })).toBe('Latest release: none');
    expect(latestReleaseLine({ latestReleaseTagAt: day(12).toISOString(), latestRelease: null })).toBe('Latest release: 12 Nov');
    // A release made here whose tag is not synced yet still counts.
    expect(
      latestReleaseLine({ latestReleaseTagAt: null, latestRelease: { id: 1, createdAt: day(14).toISOString(), state: 'done' } }),
    ).toBe('Latest release: 14 Nov');
  });
});

describe('the repository strip — the cumulative rule', () => {
  const all = () => ({ prs: [pr(1, 1, ['T1']), pr(2, 1, ['T2']), pr(3, 1, ['T3'])], tickets: [ticket('T1'), ticket('T2'), ticket('T3')] });

  it('acceptance 4: all Complete, no release → "v1.2.0 → v1.2.0-rc", no "Latest" beside it; the candidate commit is the tag’s', () => {
    const res = run({ repos: [threeTags()], ...all() });
    const api = res.repos[0]!;
    expect(repoStripText(api)).toBe('v1.2.0 → v1.2.0-rc');
    expect(api.candidate?.sha).toBe(sha('v1.2.0'));
    expect(repoLatestNote(api)).toBeNull();
    expect(repoProgress(api)).toBeNull();
    expect(defaultTickedRepoIds(res)).toEqual([1]);
  });

  it('acceptance 5: an In PO Review ticket in v1.2.0 → "v1.1.0 → v1.1.0-rc" with "Latest v1.2.0" beside it', () => {
    const res = run({ repos: [threeTags()], prs: all().prs, tickets: [ticket('T1'), ticket('T2'), ticket('T3', { done: false, statusName: 'In PO Review' })] });
    expect(repoStripText(res.repos[0]!)).toBe('v1.1.0 → v1.1.0-rc');
    expect(repoLatestNote(res.repos[0]!)).toBe('Latest v1.2.0');
  });

  it('acceptance 16: every tag ruled out → "No tag can be released"; after a release, "No tag since … can be released"', () => {
    const none = run({ repos: [threeTags()], prs: all().prs, tickets: [ticket('T1', { done: false }), ticket('T2', { done: false }), ticket('T3', { done: false })] });
    expect(repoStripText(none.repos[0]!)).toBe('No tag can be released');
    expect(releasableRepos(none)).toEqual([]);
    const released = repo(1, 'api', [
      { name: 'v1.0.0', d: 1, prs: [1] },
      { name: 'v1.0.0-rc', d: 1, commit: 'v1.0.0', taggedAt: 2 },
      { name: 'v1.1.0', d: 3, prs: [2] },
      { name: 'v1.2.0', d: 5, prs: [3] },
    ]);
    const res = run({ repos: [released], prs: all().prs, tickets: [ticket('T2', { done: false, statusName: 'In Progress' }), ticket('T3')] });
    expect(repoStripText(res.repos[0]!)).toBe('No tag since v1.0.0-rc can be released');
  });

  it('acceptance 17: not decided yet → "Checking…" with a bar and ONE line', () => {
    const r = threeTags();
    r.defaultBranch = 'main';
    r.ranges = r.ranges.filter((x) => x.tagName !== 'v1.2.0');
    r.history = { done: 1200, total: 5400, complete: false };
    const api = run({ repos: [r], ...all() }).repos[0]!;
    expect(repoStripText(api)).toBe('Checking…');
    expect(repoProgress(api)).toEqual({ share: 1200 / 5400, line: "Reading main's history: 1,200 of 5,400 commits" });
    const t = run({ repos: [threeTags()], prs: all().prs, tickets: [ticket('T1'), ticket('T2')], trackerName: 'Jira' });
    expect(repoProgress(t.repos[0]!)).toEqual({ share: 2 / 3, line: 'Reading tickets from Jira: 2 of 3' });
  });

  it('acceptance 41: the tab polls every ~3 s while a repo is checking, and stops when none is', () => {
    const r = threeTags();
    r.ranges = r.ranges.filter((x) => x.tagName !== 'v1.2.0');
    expect(releasesPollInterval({ check: run({ repos: [r], ...all() }) })).toBe(RELEASES_POLL_MS);
    expect(releasesPollInterval({ check: run({ repos: [threeTags()], ...all() }) })).toBe(false);
    expect(releasesPollInterval(null)).toBe(false);
  });

  it('acceptance 12 / 24: "Nothing new since v1.2.0-rc"; none at all → "No version tags on main yet"; Release… only with push access', () => {
    const r = repo(1, 'api', [
      { name: 'v1.2.0', d: 5, prs: [3] },
      { name: 'v1.2.0-rc', d: 5, commit: 'v1.2.0', taggedAt: 6 },
    ]);
    expect(repoStripText(run({ repos: [r], ...all() }).repos[0]!)).toBe('Nothing new since v1.2.0-rc');
    expect(repoStripText(run({ repos: [repo(2, 'web', [])] }).repos[0]!)).toBe('No version tags on main yet');
    expect(releasableRepos(run({ repos: [threeTags(false)], ...all() }))).toEqual([]);
  });

  it('above the list: only the repositories with NO candidate; the ONE Release… shows only with a candidate the reader can push', () => {
    const lib = repo(2, 'lib', []);
    const res = run({ repos: [threeTags(), lib], ...all() });
    expect(reposWithoutCandidate(res).map((r) => r.name)).toEqual(['lib']);
    expect(showCreateRelease(res)).toBe(true);
    expect(showCreateRelease(run({ repos: [threeTags(false), lib], ...all() }))).toBe(false);
  });
});

describe('THE TICKET LIST: one list of ticket cards in tag order (owner, 2026-11-16)', () => {
  /** `n` tags v1.<i>.0 on day i, each adding PR i naming T<i>. */
  const many = (n: number) => repo(1, 'api', Array.from({ length: n }, (_, k) => ({ name: `v1.${k + 1}.0`, d: k + 1, prs: [k + 1] })));
  const manyPrs = (n: number) => Array.from({ length: n }, (_, k) => pr(k + 1, 1, [`T${k + 1}`], { authorLogin: 'alex', mergedAt: day(k + 1, 9) }));
  const manyTickets = (n: number) => Array.from({ length: n }, (_, k) => ticket(`T${k + 1}`, { statusName: 'Complete', stage: 'done' }));
  const keys = (items: ReturnType<typeof ticketList>['items']) =>
    items.map((i) => (i.kind === 'ticket' ? i.ticket.key : `-${i.prs.map((p) => p.number).join(',')}`));

  it('a ticket in both repositories is ONE card, placed by its LATEST tag in either; tags of both repositories in commit-date order', () => {
    const api = repo(1, 'api', [
      { name: 'a1', d: 1, prs: [1] },
      { name: 'a2', d: 4, prs: [2] },
    ]);
    const web = repo(2, 'web', [
      { name: 'w1', d: 2, prs: [21] },
      { name: 'w2', d: 3, prs: [22] },
    ]);
    const res = run({
      repos: [api, web],
      prs: [pr(1, 1, ['T1']), pr(2, 1, ['T2']), pr(21, 2, ['T1']), pr(22, 2, ['T3'])],
      tickets: [ticket('T1'), ticket('T2'), ticket('T3')],
    });
    const l = ticketList(res);
    // T2 (a2, day 4) · T3 (w2, day 3) · T1 (a1 day 1 and w1 day 2 → day 2): one card each.
    expect(keys(l.items)).toEqual(['T2', 'T3', 'T1']);
    const t1 = l.tickets.find((c) => c.ticket.key === 'T1')!;
    expect(t1.latest.map(repoTagWords)).toEqual(['api a1', 'web w1']);
  });

  it('THE CANDIDATE TICKET (★) is the newest ticket all of whose work is in the candidates; the list opens on it with one either side; each way grows by 3', () => {
    // T9 is In Progress: the candidate is v1.8.0, so T8 is the candidate ticket.
    const tickets = manyTickets(15);
    tickets[8] = ticket('T9', { done: false, statusName: 'In Progress', stage: 'in_progress' });
    const res = run({ repos: [many(15)], prs: manyPrs(15), tickets });
    expect(res.repos[0]!.candidate?.name).toBe('v1.8.0');
    const l = ticketList(res);
    expect(l.tickets[l.anchor!]!.ticket.key).toBe('T8');
    expect(l.tickets[l.anchor!]!.isAnchor).toBe(true);
    const w = ticketWindow(l, TICKET_WINDOW_START, TICKET_WINDOW_START);
    expect(keys(w.items)).toEqual(['T9', 'T8', 'T7']);
    expect(w).toMatchObject({ moreUp: 6, moreDown: 6 });
    expect(showTicketsWords('later', w.moreUp)).toBe('Show next 3 of 6');
    const w2 = ticketWindow(l, TICKET_WINDOW_START + TICKET_WINDOW_STEP, TICKET_WINDOW_START);
    expect(keys(w2.items)).toEqual(['T12', 'T11', 'T10', 'T9', 'T8', 'T7']);
    expect(showTicketsWords('earlier', w2.moreDown)).toBe('Show previous 3 of 6');
    expect(showTicketsWords('earlier', 2)).toBe('Show previous 2 of 2');
    expect(showTicketsWords('later', 1)).toBe('Show next 1 of 1');
    // Older tags not read yet: the total is not known, so it is not given.
    expect(showTicketsWords('earlier', 6, false)).toBe('Show previous 3');
    // Marks: ✗ not Complete; ⊘ Complete but above the candidate; ✓ in it.
    expect(l.tickets.find((c) => c.ticket.key === 'T9')!.mark).toBe('blocked');
    expect(l.tickets.find((c) => c.ticket.key === 'T10')!.mark).toBe('held');
    expect(l.tickets.find((c) => c.ticket.key === 'T7')!.mark).toBe('ok');
  });

  it('the holding ticket is named, always visible, and every held card says what it waits on — never another held ticket', () => {
    const tickets = manyTickets(5);
    tickets[2] = ticket('T3', { done: false, statusName: 'In Code Review', stage: 'review' });
    const res = run({ repos: [many(5)], prs: manyPrs(5), tickets, trackerName: 'Jira' });
    const holders = releaseHolders(res);
    expect(holders).toEqual([{ ident: 'T3', key: 'T3', title: 'T3 title', text: 'In Code Review', repoNames: ['api'] }]);
    const l = ticketList(res);
    const ctx = { holders, repoNames: new Map([[1, 'api']]), trackerName: 'Jira' };
    const line = (k: string) => ticketCardLine(l.tickets.find((c) => c.ticket.key === k)!, ctx);
    expect(line('T5')).toMatchObject({ tone: 'warn', text: 'Waits on T3: In Code Review', holder: { ident: 'T3' } });
    expect(line('T3')).toMatchObject({ tone: 'bad', text: 'Holds back api', holder: null });
    // Done: what was done.
    expect(line('T2')).toMatchObject({ tone: 'mute', text: '1 PR by alex' });
    // Every card with merged work carries its newest merge date; the ✓ line does not repeat it.
    const t2 = l.tickets.find((c) => c.ticket.key === 'T2')!;
    expect(ticketMergedWords(t2)).toBe('merged 2 Nov');
    expect(ticketMergedWords(l.tickets.find((c) => c.ticket.key === 'T3')!)).toMatch(/^merged \d{1,2} [A-Z][a-z]{2}$/);
    expect(ticketMergedWords({ mergedAt: null })).toBeNull();
  });

  it('picked together: a Complete ticket split across repositories waits on the ROOT ticket, not its other half', () => {
    const api = many(2);
    const web = repo(2, 'frontend', [
      { name: 'w1.0.0', d: 2, prs: [22] },
      { name: 'w1.1.0', d: 4, prs: [21] },
    ]);
    const res = run({
      repos: [api, web],
      prs: [...manyPrs(2), pr(21, 2, ['T2']), pr(22, 2, ['W9'])],
      tickets: [...manyTickets(2), ticket('W9', { done: false, statusName: 'In Progress' })],
      trackerName: 'Jira',
    });
    const holders = releaseHolders(res);
    expect(holders.map((h) => [h.key, h.text, h.repoNames])).toEqual([['W9', 'In Progress', ['api', 'frontend']]]);
    const l = ticketList(res);
    const t2 = l.tickets.find((c) => c.ticket.key === 'T2')!;
    expect(t2.mark).toBe('held');
    expect(t2.latest.map(repoTagWords)).toEqual(['api v1.2.0', 'frontend w1.1.0']);
    expect(ticketCardLine(t2, { holders, repoNames: new Map([[1, 'api'], [2, 'frontend']]), trackerName: 'Jira' }).text).toBe('Waits on W9: In Progress');
  });

  it('pull requests with no ticket are narrow rows BETWEEN the cards, grouped while consecutive', () => {
    const r = many(4);
    r.ranges[1]!.prIds = [2, 30, 31];
    const res = run({
      repos: [r],
      prs: [...manyPrs(4), pr(30, 1, [], { isBot: true, mergedAt: day(2, 10) }), pr(31, 1, [], { mergedAt: day(2, 11) })],
      tickets: manyTickets(4),
    });
    const l = ticketList(res);
    expect(keys(l.items)).toEqual(['T4', 'T3', '-31,30', 'T2', 'T1']);
    const g = l.items[2]!;
    expect(g.kind === 'no_ticket' && noTicketGroupWords(g.prs)).toBe('2 PRs with no ticket · 1 by bots');
    expect(noTicketGroupWords([{ isBot: true }])).toBe('1 PR with no ticket · by a bot');
    // Bot PRs are left out of the list unless "Show bot PRs" is ticked; the header still counts them.
    expect(g.kind === 'no_ticket' && noTicketShownPrs(g.prs, false).map((p) => p.number)).toEqual([31]);
    expect(g.kind === 'no_ticket' && noTicketShownPrs(g.prs, true).map((p) => p.number)).toEqual([31, 30]);
    // "Show PRs with no ticket" unticked: only the ticket cards are left.
    expect(keys(listedItems(l.items, false))).toEqual(['T4', 'T3', 'T2', 'T1']);
    expect(keys(listedItems(l.items, true))).toEqual(['T4', 'T3', '-31,30', 'T2', 'T1']);
    expect(noTicketPrLineOf(res, res.prs.find((p) => p.id === 31)!)).toMatchObject({ label: 'api #31', tail: 'merged 2 Nov · in v1.2.0' });
  });

  it('a ticket the tracker could not give is still a card, marked missing — it never stops a release', () => {
    const tickets = manyTickets(3);
    tickets[1] = ticket('T2', { readState: 'not_found', done: false, statusName: null, title: null });
    const res = run({ repos: [many(3)], prs: manyPrs(3), tickets, trackerName: 'Jira' });
    expect(res.repos[0]!.candidate?.name).toBe('v1.3.0');
    const l = ticketList(res);
    const t2 = l.tickets.find((c) => c.ticket.key === 'T2')!;
    expect(t2.mark).toBe('missing');
    expect(ticketCardLine(t2, { holders: [], repoNames: new Map(), trackerName: 'Jira' })).toMatchObject({ tone: 'unknown', text: 'Not found in Jira — check it by hand' });
    expect(ticketCardStatus(t2.ticket)).toBeNull();
    // The candidate ticket is the newest ✓, never a missing one.
    expect(l.tickets[l.anchor!]!.ticket.key).toBe('T3');
  });

  it('a Cancelled ticket never stops a tag: a tick and its status', () => {
    const tickets = manyTickets(3);
    tickets[2] = ticket('T3', { done: false, statusName: "Won't Do", stage: 'cancelled' });
    const res = run({ repos: [many(3)], prs: manyPrs(3), tickets });
    const l = ticketList(res);
    expect(res.repos[0]!.candidate?.name).toBe('v1.3.0');
    expect(l.tickets.find((c) => c.ticket.key === 'T3')!.mark).toBe('ok');
    expect(ticketCardStatus(l.tickets.find((c) => c.ticket.key === 'T3')!.ticket)).toBe("Won't Do");
  });

  it('NOT IN A TAG YET: a ticket whose only work is an open pull request sits apart at the top; an open PR on a tagged ticket stays on its card', () => {
    const res = run({
      repos: [many(2)],
      prs: manyPrs(2),
      openPrs: [
        { repoId: 2, repoName: 'frontend', number: 812, url: 'https://github.com/acme/frontend/pull/812', prId: 9, ticketIdents: ['T7'], title: 'T7: start' },
        { repoId: 2, repoName: 'frontend', number: 813, url: 'https://github.com/acme/frontend/pull/813', prId: 10, ticketIdents: ['T2'], title: 'T2: more' },
      ],
      tickets: [...manyTickets(2), ticket('T7', { done: false, statusName: 'In Development' })],
      trackerName: 'Jira',
    });
    const l = ticketList(res);
    expect(l.notTagged.map((c) => c.ticket.key)).toEqual(['T7']);
    expect(l.notTagged[0]!.latest.map(repoTagWords)).toEqual(['frontend: open PR']);
    expect(keys(l.items)).toEqual(['T2', 'T1']);
    const t2 = l.tickets.find((c) => c.ticket.key === 'T2')!;
    expect(t2.mark).toBe('blocked');
    const holders = releaseHolders(res);
    expect(ticketCardLine(t2, { holders, repoNames: new Map(), trackerName: 'Jira' }).text).toBe('Holds back api · open PR: frontend #813');
    // Opened: its PRs, open first, then merged newest first, each with its tag.
    expect(ticketCardPrLines(t2.ticket).map((x) => [x.label, x.tail])).toEqual([
      ['frontend #813', 'OPEN'],
      ['api #2', 'merged 2 Nov · alex · in v1.2.0'],
    ]);
  });

  it('Refresh shows a bar with what it reads', () => {
    expect(refreshingLine({ trackerName: 'Jira' })).toBe('Reading tickets from Jira again');
    expect(refreshingLine(null)).toBe('Reading tickets from the tracker again');
  });

  it('the status words: the bucket in brackets only when it differs; the read age', () => {
    expect(ticketStatusWords({ statusName: "Won't Do", stage: 'cancelled', done: false })).toBe("Won't Do (Cancelled)");
    expect(ticketStatusWords({ statusName: 'Complete', stage: 'done', done: true })).toBe('Complete');
    expect(ticketStatusWords({ statusName: 'In progress', stage: 'in_progress', done: false })).toBe('In progress');
    expect(ticketStatusWords({ statusName: 'Done', stage: null, done: true })).toBe('Done');
    const t0 = day(10).getTime();
    expect(readAgoWords(day(10).toISOString(), t0 + 10_000)).toBe('just now');
    expect(readAgoWords(day(10).toISOString(), t0 + 3 * 3_600_000)).toBe('3 hours ago');
    expect(readAgoWords(day(10).toISOString(), t0 + 86_400_000)).toBe('1 day ago');
  });
});

describe('the dialog: each repo on its own', () => {
  it('unticking a repo stops nothing; none ticked hides Confirm', () => {
    const api = repo(1, 'api', [{ name: 'v2.4.0', d: 5, prs: [11] }]);
    const web = repo(2, 'web', [{ name: 'v1.9.0', d: 8, prs: [21] }]);
    const res = run({ repos: [api, web], prs: [pr(11, 1, ['PLAT-290']), pr(21, 2, ['PLAT-290'])], tickets: [ticket('PLAT-290')] });
    expect(confirmStops([1])).toEqual([]);
    expect(confirmStops([])).toEqual(['Tick at least one repository.']);
    expect(releaseTagsLine(res, [1, 2])).toBe('api v2.4.0-rc · web v1.9.0-rc');
  });
});

describe('the dialog sends only edited, ticked sections', () => {
  const preview = {
    sections: [
      { repoId: 1, repoName: 'api', releaseTagName: 'v1-rc', markdown: '## api' },
      { repoId: 2, repoName: 'web', releaseTagName: 'v2-rc', markdown: '## web' },
    ],
  };
  it('an unchanged edit and an unticked repo are left out', () => {
    const edits = new Map([
      [1, '## api\n\nEdited.'],
      [2, '## web edited'],
    ]);
    expect(editedSections(preview, [1], edits)).toEqual([{ repoId: 1, markdown: '## api\n\nEdited.' }]);
    expect(editedSections(preview, [1, 2], new Map([[1, '## api']]))).toEqual([]);
  });
});

describe('Settings → Releases: the ticked repositories', () => {
  it('dirty only when the set changes (order does not count)', () => {
    expect(releaseReposDirty([1, 2], [2, 1])).toBe(false);
    expect(releaseReposDirty([1], [1, 2])).toBe(true);
    expect(releaseReposDirty([1, 2], [1])).toBe(true);
    expect(releaseReposDirty([], [])).toBe(false);
  });
  it('"Release from": dirty only for a ticked repository whose choice changed; Auto names what it means now', () => {
    expect(releaseBasesDirty({ 1: 'auto' }, { 1: 'auto' }, [1])).toBe(false);
    expect(releaseBasesDirty({ 1: 'auto' }, { 1: 'prs' }, [1])).toBe(true);
    expect(releaseBasesDirty({ 1: 'auto' }, { 1: 'prs' }, [])).toBe(false);
    expect(releaseBasesDirty({}, { 2: 'auto' }, [2])).toBe(false);
    expect(releaseBasisOptions('prs').map((o) => o.label)).toEqual(['Auto (merged pull requests)', 'Version tags', 'Merged pull requests']);
    expect(releaseBasisOptions('tags')[0]!.label).toBe('Auto (version tags)');
  });
});

describe('the repository strip — released from merged pull requests', () => {
  // threeTags() with each tag standing for the merged PR on its commit: #1, #2, #3.
  const NAMES: Record<string, string> = { 'v1.0.0': '#1', 'v1.1.0': '#2', 'v1.2.0': '#3', 'v1.0.0-rc': '2026.11.10-rc' };
  const points = (base = threeTags()) => ({
    ...base,
    basis: 'prs' as const,
    pointReleaseTagName: '2026.11.19-rc',
    tags: base.tags.map((t) => ({ ...t, name: NAMES[t.name] ?? t.name })),
    ranges: base.ranges.map((x) => ({ ...x, tagName: NAMES[x.tagName] ?? x.tagName, baseTagName: x.baseTagName == null ? null : (NAMES[x.baseTagName] ?? x.baseTagName) })),
  });
  const prs = () => [pr(1, 1, ['T1']), pr(2, 1, ['T2']), pr(3, 1, ['T3'])];

  it('candidate: "Up to #3 “title” → 2026.11.19-rc"; held: the PR below; none and nothing new in plain words', () => {
    const ok = run({ repos: [points()], prs: prs(), tickets: [ticket('T1'), ticket('T2'), ticket('T3')] });
    expect(repoStripText(ok.repos[0]!)).toBe(`Up to #3 “${prs()[2]!.title}” → 2026.11.19-rc`);
    const held = run({ repos: [points()], prs: prs(), tickets: [ticket('T1'), ticket('T2'), ticket('T3', { done: false })] });
    expect(repoStripText(held.repos[0]!)).toBe(`Up to #2 “${prs()[1]!.title}” → 2026.11.19-rc`);
    const none = run({ repos: [points()], prs: prs(), tickets: [ticket('T1', { done: false }), ticket('T2'), ticket('T3')] });
    expect(repoStripText(none.repos[0]!)).toBe('Nothing merged can be released');
    const empty = run({ repos: [{ ...points(), tags: [], ranges: [] }] });
    expect(repoStripText(empty.repos[0]!)).toBe('Nothing merged yet');
  });
});

describe('Settings → Releases: the suffix-change warning', () => {
  const saved = { releaseSuffix: '-rc', hotfixSuffix: '-hotfix', hasReleases: true };
  it('acceptance 3: changing the release suffix after a release exists warns', () => {
    expect(releaseSuffixChangeWarning(saved, { releaseSuffix: '-release', hotfixSuffix: '-hotfix' })).toBe(
      'Tags ending in -rc will stop counting as releases.',
    );
    expect(releaseSuffixChangeWarning(saved, { releaseSuffix: '-rc', hotfixSuffix: '-fix' })).toBe(
      'Tags ending in -hotfix will stop counting as hotfixes.',
    );
  });
  it('no warning before any release, for an unchanged suffix, or for a first set', () => {
    expect(releaseSuffixChangeWarning({ ...saved, hasReleases: false }, { releaseSuffix: '-x', hotfixSuffix: '-y' })).toBeNull();
    expect(releaseSuffixChangeWarning(saved, { releaseSuffix: '-rc', hotfixSuffix: '-hotfix' })).toBeNull();
    expect(
      releaseSuffixChangeWarning({ releaseSuffix: null, hotfixSuffix: null, hasReleases: true }, { releaseSuffix: '-rc', hotfixSuffix: '-hotfix' }),
    ).toBeNull();
  });
});
