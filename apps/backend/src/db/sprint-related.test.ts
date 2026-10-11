import { describe, expect, it } from 'vitest';
import { SPRINT_RELATED_MAX, siteTicketKeyOfUrl, ticketBrowseUrl, ticketMentionsInText, type KnownTicket } from '@pierre-review/shared';
import { sprintRelatedCandidateKeys, sprintRelatedFor } from './sprint-related.js';

// The tickets a sprint ticket points at (db/sprint-related.ts) and the shared URL → key parsing it
// rests on (packages/shared/src/ticket-refs.ts). Pure.

const JIRA = { provider: 'jira' as const, root: 'https://eaflood.atlassian.net' };
const LINEAR = { provider: 'linear' as const, root: 'https://linear.app/acme' };
const GITHUB = { provider: 'github' as const, root: 'https://github.com' };

describe('URL → ticket key on this site', () => {
  it('Jira: a browse link on the site, any case; another site, a PR link or junk is null', () => {
    expect(siteTicketKeyOfUrl('https://eaflood.atlassian.net/browse/BMD-855', JIRA)).toBe('BMD-855');
    expect(siteTicketKeyOfUrl('https://eaflood.atlassian.net/browse/bmd-855).', JIRA)).toBe('BMD-855');
    expect(siteTicketKeyOfUrl('https://other.atlassian.net/browse/BMD-855', JIRA)).toBeNull();
    // A board link's root is only the host: it matches a site that starts there.
    expect(siteTicketKeyOfUrl('https://eaflood.atlassian.net/jira/software/projects/BMD/boards/1?selectedIssue=BMD-9', JIRA)).toBe('BMD-9');
    expect(siteTicketKeyOfUrl('https://github.com/o/r/issues/3', JIRA)).toBeNull();
    expect(siteTicketKeyOfUrl('not a url', JIRA)).toBeNull();
  });

  it('Linear and GitHub', () => {
    expect(siteTicketKeyOfUrl('https://linear.app/acme/issue/ENG-4/some-slug', LINEAR)).toBe('ENG-4');
    expect(siteTicketKeyOfUrl('https://linear.app/other/issue/ENG-4', LINEAR)).toBeNull();
    expect(siteTicketKeyOfUrl('https://github.com/Acme/Web/issues/12', GITHUB)).toBe('acme/web#12');
    expect(siteTicketKeyOfUrl('https://github.com/acme/web/pull/12', GITHUB)).toBeNull();
  });

  it('browse links back', () => {
    expect(ticketBrowseUrl(JIRA, 'BMD-1')).toBe('https://eaflood.atlassian.net/browse/BMD-1');
    expect(ticketBrowseUrl(LINEAR, 'ENG-4')).toBe('https://linear.app/acme/issue/ENG-4');
    expect(ticketBrowseUrl(GITHUB, 'acme/web#12')).toBe('https://github.com/acme/web/issues/12');
  });
});

describe('mentions in text', () => {
  it('links and bare keys, in order, one per key; a key inside a URL is not also bare', () => {
    const text = 'Builds on https://eaflood.atlassian.net/browse/BMD-855 and BMD-900.\nSee BMD-855 again; UTF-8 output; ABC-1x.';
    expect(ticketMentionsInText(text, JIRA)).toEqual([
      { key: 'BMD-855', via: 'url' },
      { key: 'BMD-900', via: 'bare' },
      { key: 'UTF-8', via: 'bare' },
    ]);
  });

  it('GitHub keys only on a GitHub site', () => {
    expect(ticketMentionsInText('Fixes acme/web#12 and ENG-4', GITHUB)).toEqual([{ key: 'acme/web#12', via: 'bare' }]);
    expect(ticketMentionsInText('Fixes acme/web#12 and ENG-4', LINEAR)).toEqual([{ key: 'ENG-4', via: 'bare' }]);
  });
});

describe('sprintRelatedFor', () => {
  const known = new Map<string, KnownTicket>([
    ['OPS-3', { title: 'Cookie banner', status: 'Done', category: 'done', url: 'https://eaflood.atlassian.net/browse/OPS-3' }],
    ['BMD-900', { title: 'Hedgerow summary', status: 'In Progress', category: 'indeterminate', url: null }],
  ]);
  const input = {
    key: 'BMD-919',
    description: 'First iteration via https://eaflood.atlassian.net/browse/BMD-855. Uses UTF-8. Needs OPS-3 and XYZ-1. Self: BMD-919.',
    acceptanceCriteria: 'Same as BMD-900; also BMD-568.',
    links: [
      { key: 'BMD-568', title: 'Cookie consent', status: 'To Do', category: 'new' as const, relation: 'is blocked by', url: null },
      { key: 'BMD-12', title: 'Spike', status: 'Done', category: 'done' as const, relation: 'relates to', url: null },
    ],
  };

  it('links first (blockers, then others), then mentions; bare keys only in the same project or stored; self and duplicates out', () => {
    const r = sprintRelatedFor(input, JIRA, known);
    expect(r.map((x) => [x.key, x.relation, x.title, x.status, x.done])).toEqual([
      ['BMD-568', 'blocked_by', 'Cookie consent', 'To Do', false],
      ['BMD-12', 'linked', 'Spike', 'Done', true],
      ['BMD-855', 'mentioned', null, null, null],
      ['OPS-3', 'mentioned', 'Cookie banner', 'Done', true],
      ['BMD-900', 'mentioned', 'Hedgerow summary', 'In Progress', false],
    ]);
    expect(r[0]!.ident).toBe('jira:https://eaflood.atlassian.net#BMD-568');
    expect(r[0]!.url).toBe('https://eaflood.atlassian.net/browse/BMD-568');
    expect(r[3]!.url).toBe('https://eaflood.atlassian.net/browse/OPS-3');
  });

  it('the candidate keys are every key a link or the text names (looked up once)', () => {
    expect(sprintRelatedCandidateKeys(input, JIRA)).toEqual(
      expect.arrayContaining(['BMD-568', 'BMD-12', 'BMD-855', 'OPS-3', 'XYZ-1', 'BMD-900', 'UTF-8']),
    );
  });

  it('a blocker code holds (a key the label named in the text) lists as blocked_by, not mentioned', () => {
    const r = sprintRelatedFor(
      { ...input, links: null, blockers: [{ ticketKey: 'BMD-900', what: 'Hedgerow summary', status: 'In Progress', category: 'indeterminate', url: null }, { ticketKey: null, what: 'A design', status: null, category: null, url: null }] },
      JIRA,
      known,
    );
    expect(r[0]).toMatchObject({ key: 'BMD-900', relation: 'blocked_by', title: 'Hedgerow summary', done: false });
    expect(r.filter((x) => x.key === 'BMD-900')).toHaveLength(1);
  });

  it('rubric 4: each named ticket carries the relation the label read; a text blocker is depends_on; order blockers → alongside → links → rest', () => {
    const r = sprintRelatedFor(
      {
        ...input,
        links: [{ key: 'BMD-12', title: 'Spike', status: 'Done', category: 'done' as const, relation: 'relates to', url: null }],
        blockers: [{ source: 'text', ticketKey: 'BMD-568', what: 'BMD-568', status: null, category: null, url: null }],
        references: [
          { ticketKey: 'BMD-855', relation: 'supersedes', quote: null, owner: null },
          { ticketKey: 'BMD-900', relation: 'out_of_scope', quote: null, owner: null },
          { ticketKey: 'BMD-900', relation: 'concurrent', quote: null, owner: null },
          { ticketKey: 'OPS-3', relation: 'builds_on', quote: null, owner: null },
          { ticketKey: 'BMD-568', relation: 'depends_on', quote: null, owner: null },
        ],
      },
      JIRA,
      known,
    );
    expect(r.map((x) => [x.key, x.relation, x.title, x.status])).toEqual([
      // The blocker's `what` was only its key: no title invented.
      ['BMD-568', 'depends_on', null, null],
      // Named out of scope AND to build alongside: alongside wins (`storyReferencesByKey`).
      ['BMD-900', 'concurrent', 'Hedgerow summary', 'In Progress'],
      ['BMD-12', 'linked', 'Spike', 'Done'],
      ['BMD-855', 'supersedes', null, null],
      ['OPS-3', 'builds_on', 'Cookie banner', 'Done'],
    ]);
  });

  it('caps the list and handles a ticket with nothing', () => {
    const many = { key: 'BMD-1', description: Array.from({ length: 20 }, (_, i) => `BMD-${i + 100}`).join(' '), acceptanceCriteria: '', links: null };
    expect(sprintRelatedFor(many, JIRA, new Map())).toHaveLength(SPRINT_RELATED_MAX);
    expect(sprintRelatedFor({ key: 'BMD-1', description: '', acceptanceCriteria: '', links: null }, JIRA, new Map())).toEqual([]);
  });

  it('GitHub: same-repo bare keys count, the ident is the repo-rooted one', () => {
    const r = sprintRelatedFor({ key: 'acme/web#1', description: 'After acme/web#2 and other/x#3', acceptanceCriteria: '', links: null }, GITHUB, new Map());
    expect(r.map((x) => [x.key, x.ident])).toEqual([['acme/web#2', 'github:https://github.com/acme/web#2']]);
  });
});
