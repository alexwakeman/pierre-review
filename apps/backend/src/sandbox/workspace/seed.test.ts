// THE SEED (seed.ts). Pinned:
//   1. ⚠ GOLDENS: CLAUDE.md, AGENTS.md and TICKET.md equal __fixtures__/seed-*.md byte for byte (a wording
//      change is a deliberate fixture update: SANDBOX_SEED_GOLDEN_WRITE=1 rewrites them);
//   2. ONE fold: the files are written at the layout's ROOT (outside every repository) and are the same
//      strings the seed returns; both providers get the same repositories, rules and ticket;
//   3. the ticket renders the story view's AC order, the open points with "do not invent", Fill gaps' gaps,
//      the stale-copy line, and the fallback when there is no numbered list.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { WRITING_RULES } from '../../ai/writing-rules.js';
import type { WorkspaceLayout } from './layout.js';
import { buildSeed, sessionBranch, ticketMarkdown, type SeedInput } from './seed.js';
import type { SessionTicket } from './ticket.js';

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), '__fixtures__');
const ROOT = '/Users/alex/Projects/DEFRA/bng-fe-be';
const HARNESS_KEY = '-Users-alex-Projects-DEFRA-bng-fe-be-bng-metric-harness';

const layout: WorkspaceLayout = {
  root: ROOT,
  folder: ROOT,
  repos: [
    { repoId: 1, owner: 'DEFRA', name: 'bng-metric-backend', fullName: 'DEFRA/bng-metric-backend', path: `${ROOT}/bng-metric-backend`, placed: 'local' },
    { repoId: 2, owner: 'DEFRA', name: 'bng-metric-harness', fullName: 'DEFRA/bng-metric-harness', path: `${ROOT}/bng-metric-harness`, placed: 'local' },
    { repoId: 3, owner: 'DEFRA', name: 'bng-perf-tests', fullName: 'DEFRA/bng-perf-tests', path: `${ROOT}/bng-perf-tests`, placed: 'folder' },
  ],
  startDir: `${ROOT}/bng-metric-harness`,
  startDirReason: 'memories',
  memoryProjects: [{ dir: `${ROOT}/bng-metric-harness`, key: HARNESS_KEY, memoryCount: 2 }],
  outside: [{ fullName: 'DEFRA/cdp-app-config', localPath: `${ROOT}/cdp-app-config` }],
  notes: [],
};

const ticket: SessionTicket = {
  ident: 'jira:https://eaflood.atlassian.net#BMD-412',
  key: 'BMD-412',
  title: 'Show the habitat baseline summary',
  url: 'https://eaflood.atlassian.net/browse/BMD-412',
  description: 'As a developer, I want to see the baseline summary, so that I can check the units.',
  acceptanceCriteriaText: 'Shown on the summary page.\nTotals in hectares.',
  criteria: [
    { n: 1, text: 'GIVEN a baseline WHEN I open the summary THEN I see the habitat table' },
    { n: 2, text: 'Totals are in hectares to two decimal places' },
  ],
  criteriaSource: 'ticket_review',
  openPoints: [
    { text: 'Content depends on UCD confirming the heading', source: 'field', fieldName: 'Open points' },
    { text: 'Rounding rule for hedgerows', source: 'description', fieldName: null },
  ],
  comments: 'Jo (2026-11-05): the table must match the metric spreadsheet.',
  prs: [{ fullName: 'DEFRA/bng-metric-frontend', number: 88, title: 'Baseline summary page', state: 'open', byReader: false }],
  gaps: null,
  fresh: true,
  readAt: '2026-11-07T09:00:00.000Z',
};

const input = (over: Partial<SeedInput> = {}): SeedInput => ({
  layout,
  bases: new Map([
    [1, { sha: 'a'.repeat(40), label: 'main', note: null }],
    [2, { sha: 'b'.repeat(40), label: 'main', note: null }],
    [3, { sha: 'c'.repeat(40), label: 'main', note: '#7 on this ticket is someone else\'s, so this builds from main.' }],
  ]),
  branch: sessionBranch('BMD-412'),
  ticket,
  mode: 'implement',
  memories: [{ dir: `${ROOT}/bng-metric-harness`, key: HARNESS_KEY, files: [`/home/agent/.claude/projects/${HARNESS_KEY}/memory/MEMORY.md`, `/home/agent/.claude/projects/${HARNESS_KEY}/memory/cdp-uploader.md`], skipped: 0 }],
  userClaudeMd: '/home/agent/.claude/CLAUDE.md',
  folderClaudeMd: '# BNG\nRun scripts from the harness.\n',
  skills: ['bng-story'],
  services: [{ name: 'postgis', from: 'bng-metric-backend/compose.yml' }],
  ...over,
});

function golden(name: string, now: string): void {
  const file = join(FIXTURES, name);
  if (process.env.SANDBOX_SEED_GOLDEN_WRITE === '1') {
    mkdirSync(FIXTURES, { recursive: true });
    writeFileSync(file, now);
  }
  expect(now).toBe(readFileSync(file, 'utf8'));
}

describe('the seed', () => {
  it('⚠ Claude: CLAUDE.md byte-for-byte the golden', () => golden('seed-claude.md', buildSeed(input()).claudeMd));
  it('⚠ Codex: AGENTS.md byte-for-byte the golden', () => golden('seed-codex.md', buildSeed(input()).agentsMd));
  it('⚠ the ticket: TICKET.md byte-for-byte the golden', () => golden('seed-ticket.md', buildSeed(input()).ticketMd));
  it('⚠ Fill gaps: TICKET.md byte-for-byte the golden', () =>
    golden(
      'seed-ticket-fill-gaps.md',
      ticketMarkdown(
        {
          ...ticket,
          fresh: false,
          gaps: {
            criteria: [
              { ref: 'AC1', text: ticket.criteria[0]!.text, verdict: 'met' },
              { ref: 'AC2', text: ticket.criteria[1]!.text, verdict: 'partly_met' },
            ],
            missing: [{ ref: 'M1', text: 'An empty-state message' }],
            note: null,
          },
        },
        'fill_gaps',
      ),
    ));

  it('writes the three files at the ROOT, outside every repository, as the strings it returns', () => {
    const s = buildSeed(input());
    expect(s.files.map((f) => f.path)).toEqual([`${ROOT}/CLAUDE.md`, `${ROOT}/AGENTS.md`, `${ROOT}/TICKET.md`]);
    expect(s.files.map((f) => f.content)).toEqual([s.claudeMd, s.agentsMd, s.ticketMd]);
    for (const f of s.files) for (const r of layout.repos) expect(f.path.startsWith(`${r.path}/`)).toBe(false);
  });

  it('gives both providers the same repositories, rules and writing rules; Codex gets its memory files listed', () => {
    const s = buildSeed(input());
    for (const text of [s.claudeMd, s.agentsMd]) {
      expect(text).toContain('`/Users/alex/Projects/DEFRA/bng-fe-be/bng-metric-harness` (from main at bbbbbbb; branch `limn/bmd-412`)');
      expect(text).toContain('DEFRA/cdp-app-config');
      expect(text).toContain('Do not push and do not add a remote.');
      expect(text).toContain('`limn-svc up');
      expect(text).toContain(WRITING_RULES);
    }
    expect(s.agentsMd).toContain(`/home/agent/.claude/projects/${HARNESS_KEY}/memory/cdp-uploader.md`);
    expect(s.claudeMd).not.toContain('cdp-uploader.md');
    expect(s.systemPrompts.claude).toContain(`${ROOT}/CLAUDE.md`);
    expect(s.systemPrompts.codex).toContain(`${ROOT}/AGENTS.md`);
  });

  it('says there are no services, and no notes, when there are none', () => {
    const s = buildSeed(input({ services: null, memories: [], userClaudeMd: null, folderClaudeMd: null, skills: [] }));
    expect(s.claudeMd).toContain('There is no Docker in the sandbox');
    expect(s.claudeMd).toContain('The reader brought no notes for this session.');
  });

  it('renders a ticket with no numbered list, no criteria, and a stale copy', () => {
    const t = ticketMarkdown({ ...ticket, criteria: [], fresh: false, readAt: '2026-11-01T00:00:00.000Z', openPoints: [] }, 'implement');
    expect(t).toContain("This is Limn's stored copy from 2026-11-01T00:00:00.000Z.");
    expect(t).toContain('Number the criteria in the text below AC1, AC2');
    expect(t).toContain('Totals in hectares.');
    expect(t).toMatch(/## Open points \(not decided yet\)\n\n_None._/);
    const none = ticketMarkdown({ ...ticket, criteria: [], acceptanceCriteriaText: '' }, 'implement');
    expect(none).toContain('The ticket has no acceptance criteria.');
  });

  it('names the session branch from the ticket key', () => {
    expect(sessionBranch('BMD-412')).toBe('limn/bmd-412');
    expect(sessionBranch('DEFRA/bng-library#12')).toBe('limn/defra-bng-library-12');
    expect(sessionBranch('…')).toBe('limn/ticket');
  });
});
