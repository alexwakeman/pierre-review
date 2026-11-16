// THE HOTFIX PORT REPORT — the pure halves (docs/STORY-BUILD.md § Hotfix builds → The port report;
// docs/RELEASES.md § Port report, acceptance 34–37). Pinned:
//   • the shared fold `hotfixPortOf`: the claim checked against the two patches (the two contradictions
//     flagged, no claim ⇒ no flag), the files compared, the tab's line and the PR body's line;
//   • THE validator (`validatePortReport`, the same text the sandbox checker embeds): unknown repositories
//     refused, a reason required for adapted / not_needed, bad entries dropped and named; the host's clip;
//   • the checker runs in Node as the agent runs it;
//   • the seed: the port report's files and wording only in a hotfix build (an ordinary seed unchanged);
//   • the release check: a hotfix ticket's hotfix-branch PR is in no range — no warning, no block.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  foldReleaseCheck,
  HOTFIX_PORT_REASON_MAX,
  hotfixPortBodyLine,
  hotfixPortClaimOf,
  hotfixPortFilesOf,
  hotfixPortLine,
  hotfixPortOf,
} from '@pierre-review/shared';
import { buildInstruction } from '../../sandbox/session/manager.js';
import { planBuildInstruction } from '../../sandbox/session/plan.js';
import { portClaimsOf, portReportCheckerSource, PORT_REPORT_CHECKER, PORT_REPORT_FILE, validatePortReport } from '../../sandbox/workspace/port-report.js';
import { buildSeed, type SeedInput } from '../../sandbox/workspace/seed.js';

const CTX = { repos: ['acme/api', 'acme/web'] };

describe('the fold (shared hotfixPortOf)', () => {
  const claim = (outcome: 'same' | 'adapted' | 'not_needed', reason: string | null = null) => hotfixPortClaimOf({ outcome, reason });

  it('34: same with a main change — no flag; the line and the body line', () => {
    const p = hotfixPortOf({ claim: claim('same'), releaseFiles: ['a.ts'], mainFiles: ['a.ts'], mainChanged: true });
    expect(p).toEqual({ claim: { outcome: 'same', reason: null, evidence: [] }, flag: null, files: 'same' });
    expect(hotfixPortLine(p.claim)).toBe('Applied to both');
    expect(hotfixPortBodyLine(p)).toBe('**Port:** Applied to both.');
  });

  it('35: adapted carries its reason', () => {
    const p = hotfixPortOf({ claim: claim('adapted', 'Main moved it to b.ts.'), releaseFiles: ['a.ts', 'c.ts'], mainFiles: ['b.ts', 'c.ts'], mainChanged: true });
    expect(p.flag).toBeNull();
    expect(p.files).toBe('some_differ');
    expect(hotfixPortLine(p.claim)).toBe('Applied to both, adapted for main — Main moved it to b.ts.');
    expect(hotfixPortBodyLine(p)).toBe('**Port:** Applied to both, adapted for main: Main moved it to b.ts.');
  });

  it('36: not_needed with main unchanged — no flag', () => {
    const p = hotfixPortOf({ claim: claim('not_needed', 'The code was removed in src/old/.'), releaseFiles: ['a.ts'], mainFiles: [], mainChanged: false });
    expect(p).toMatchObject({ flag: null, files: null });
    expect(hotfixPortLine(p.claim)).toBe('Not applied to main — The code was removed in src/old/.');
    expect(hotfixPortBodyLine(p)).toBe('**Port:** Not applied to main: The code was removed in src/old/.');
  });

  it('37: the two contradictions are flagged, and a flagged claim is not sent to GitHub', () => {
    const a = hotfixPortOf({ claim: claim('not_needed', 'gone'), releaseFiles: ['a.ts'], mainFiles: ['a.ts'], mainChanged: true });
    expect(a.flag).toBe('not_needed_but_changed');
    expect(hotfixPortBodyLine(a)).toBeNull();
    for (const o of ['same', 'adapted'] as const) {
      const b = hotfixPortOf({ claim: claim(o, 'x'), releaseFiles: ['a.ts'], mainFiles: [], mainChanged: false });
      expect(b.flag).toBe('ported_but_unchanged');
      expect(hotfixPortBodyLine(b)).toBeNull();
    }
  });

  it('no claim: "No report from the agent", no flag, nothing inferred from the patches', () => {
    for (const mainChanged of [true, false]) {
      const p = hotfixPortOf({ claim: null, releaseFiles: ['a.ts'], mainFiles: mainChanged ? ['a.ts'] : [], mainChanged });
      expect(p.claim).toBeNull();
      expect(p.flag).toBeNull();
      expect(hotfixPortLine(p.claim)).toBe('No report from the agent');
      expect(hotfixPortBodyLine(p)).toBeNull();
    }
  });

  it('the files compared: same, some differ, none in common, nothing to compare', () => {
    expect(hotfixPortFilesOf(['a', 'b'], ['b', 'a'])).toBe('same');
    expect(hotfixPortFilesOf(['a', 'b'], ['a'])).toBe('some_differ');
    expect(hotfixPortFilesOf(['a'], ['b'])).toBe('none_in_common');
    expect(hotfixPortFilesOf([], ['b'])).toBeNull();
    expect(hotfixPortFilesOf(['a'], [])).toBeNull();
  });

  it('the host clips: one line, at most the cap, evidence trimmed and capped', () => {
    const c = hotfixPortClaimOf({ outcome: 'adapted', reason: `line one\n\tline two\u0007 ${'x'.repeat(2000)}`, evidence: ['  a.ts ', '', ...Array.from({ length: 20 }, (_, i) => `f${i}`)] });
    expect(c.reason!.length).toBeLessThanOrEqual(HOTFIX_PORT_REASON_MAX);
    expect(c.reason!.startsWith('line one line two x')).toBe(true);
    expect(c.reason).not.toMatch(/[\n\t\u0007]/);
    expect(c.evidence[0]).toBe('a.ts');
    expect(c.evidence).toHaveLength(10);
    expect(hotfixPortClaimOf({ outcome: 'same', reason: '   ' }).reason).toBeNull();
  });
});

describe('THE validator (host and checker)', () => {
  it('keeps valid entries and names the rest: unknown repository, duplicate, missing reason, bad outcome', () => {
    const r = validatePortReport(
      {
        repos: [
          { repo: 'acme/api', outcome: 'same' },
          { repo: 'acme/web', outcome: 'not_needed' },
          { repo: 'evil/other', outcome: 'same' },
          { repo: 'acme/api', outcome: 'adapted', reason: 'twice' },
          { repo: 'acme/web', outcome: 'maybe', reason: 'x' },
        ],
      },
      CTX,
    );
    expect(r.entries).toEqual([{ repo: 'acme/api', outcome: 'same', reason: null, evidence: [] }]);
    expect(r.problems.join('\n')).toMatch(/"repos"\[1\]\.reason is required for not_needed/);
    expect(r.problems.join('\n')).toMatch(/"repos"\[2\]\.repo must be one of acme\/api, acme\/web/);
    expect(r.problems.join('\n')).toMatch(/listed twice/);
    expect(r.problems.join('\n')).toMatch(/outcome must be same, adapted or not_needed/);
  });

  it('a wrong shape is no report; over-long text is refused, not cut', () => {
    expect(validatePortReport([], CTX).entries).toBeNull();
    expect(validatePortReport({ repos: 'x' }, CTX).entries).toBeNull();
    const long = validatePortReport({ repos: [{ repo: 'acme/api', outcome: 'adapted', reason: 'x'.repeat(HOTFIX_PORT_REASON_MAX + 1) }] }, CTX);
    expect(long.entries).toEqual([]);
    expect(long.problems[0]).toMatch(/at most 600 characters/);
  });

  it('portClaimsOf: by owner/name, the host form', () => {
    const m = portClaimsOf(validatePortReport({ repos: [{ repo: 'acme/web', outcome: 'adapted', reason: ' Main  differs. ', evidence: ['src/x.ts'] }] }, CTX));
    expect(m.get('acme/web')).toEqual({ outcome: 'adapted', reason: 'Main differs.', evidence: ['src/x.ts'] });
    expect(m.has('acme/api')).toBe(false);
  });

  it('the checker the agent runs prints OK or the problems (the same validator text)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'port-report-'));
    try {
      const report = join(dir, 'port-report.json');
      const context = join(dir, 'port-context.json');
      const checker = join(dir, 'check.cjs');
      writeFileSync(context, JSON.stringify(CTX));
      writeFileSync(checker, portReportCheckerSource({ reportFile: report, contextFile: context }));
      writeFileSync(report, JSON.stringify({ repos: [{ repo: 'acme/api', outcome: 'not_needed', reason: 'Removed in src/old/.' }] }));
      expect(execFileSync(process.execPath, [checker], { encoding: 'utf8' }).trim()).toBe('OK');
      writeFileSync(report, JSON.stringify({ repos: [{ repo: 'acme/nope', outcome: 'same' }] }));
      let out = '';
      try {
        execFileSync(process.execPath, [checker], { encoding: 'utf8' });
      } catch (err) {
        out = String((err as { stdout?: string }).stdout ?? '');
      }
      expect(out).toMatch(/must be one of acme\/api, acme\/web/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('what the agent is told (hotfix only)', () => {
  const BASE: SeedInput = {
    layout: {
      root: '/workspace',
      folder: null,
      repos: [
        { repoId: 1, owner: 'acme', name: 'api', fullName: 'acme/api', path: '/workspace/api', placed: 'default' },
        { repoId: 2, owner: 'acme', name: 'worker', fullName: 'acme/worker', path: '/workspace/worker', placed: 'default' },
      ],
      startDir: '/workspace',
      startDirReason: 'default',
      memoryProjects: [],
      outside: [],
      notes: [],
    },
    bases: new Map(),
    branch: 'PLAT-290',
    ticket: {
      ident: 'jira:https://acme.atlassian.net#PLAT-290',
      key: 'PLAT-290',
      title: 'Refund rounding',
      url: null,
      description: 'Fix the rounding.',
      acceptanceCriteriaText: 'Refunds round half up.',
      criteria: [{ n: 1, text: 'Refunds round half up.' }],
      criteriaSource: 'ticket_review',
      openPoints: [],
      comments: null,
      prs: [],
      gaps: null,
      fresh: true,
      readAt: '2026-11-14T09:00:00.000Z',
      acLocation: { kind: 'none' },
    },
    mode: 'implement',
    memories: [],
    userClaudeMd: null,
    folderClaudeMd: null,
    skills: [],
    services: null,
  };
  const base = (over: Partial<SeedInput> = {}): SeedInput => ({ ...BASE, ...over });
  const hotfix = {
    repos: [
      { repoId: 1, fullName: 'acme/api', release: { tagName: 'v2.4.0-rc', path: '/workspace/api', hotfixBranch: 'hotfix/v2.4.0-rc' }, main: { path: '/workspace/api.main', label: 'main', sha: 'c'.repeat(40) } },
      { repoId: 2, fullName: 'acme/worker', release: null, main: null },
    ],
  };

  it('a hotfix seed has the port report: the file, the checker, its context (the release repositories only)', () => {
    const s = buildSeed(base({ hotfix }));
    for (const md of [s.claudeMd, s.agentsMd]) {
      expect(md).toContain(`/workspace/${PORT_REPORT_FILE}`);
      expect(md).toContain(`node ${PORT_REPORT_CHECKER}`);
      expect(md).toContain('Before you port, read the main checkout');
    }
    expect(s.systemPrompts.claude).toContain('End with the port report.');
    const ctxFile = s.files.find((f) => f.path === '/workspace/.limn/port-context.json');
    expect(JSON.parse(String(ctxFile!.content))).toEqual({ repos: ['acme/api'] });
    expect(s.files.some((f) => f.path === PORT_REPORT_CHECKER)).toBe(true);
  });

  it('an ordinary seed and build instructions say nothing of it (byte-identical to before)', () => {
    const s = buildSeed(base());
    expect(s.claudeMd).not.toContain('port report');
    expect(s.files.some((f) => f.path.includes('port-'))).toBe(false);
    expect(buildInstruction({ ticketChanged: false, extra: null })).toBe(
      [
        'Start the build now. Implement the ticket in TICKET.md in the repositories of this workspace.',
        "Run each changed repository's own tests, and use limn-svc for the services they need.",
        'Commit your work on the session branch in each repository you change.',
        'End with one line per acceptance criterion: done, partly done or not done, and why.',
      ].join('\n'),
    );
    expect(planBuildInstruction({ revision: 1, root: '/workspace', ticketChanged: false, extra: null })).not.toContain('port report');
  });

  it('the hotfix build turn asks for the port report (plan first or not)', () => {
    expect(buildInstruction({ ticketChanged: false, extra: null, hotfix: { root: '/workspace' } })).toContain(`/workspace/${PORT_REPORT_FILE}`);
    expect(planBuildInstruction({ revision: 1, root: '/workspace', ticketChanged: false, extra: null, hotfix: { branch: 'PLAT-290' } })).toContain(`node ${PORT_REPORT_CHECKER}`);
  });
});

describe('the release check: a hotfix not needed on main', () => {
  it('a repository with only a hotfix-branch PR for the ticket: no block, no warning (an open PR into hotfix/… is not work on its way to main)', () => {
    const at = (d: number): Date => new Date(Date.UTC(2026, 10, d, 12));
    const sha = (c: string): string => c.repeat(40);
    const tag = (name: string, c: string, d: number) => ({ name, sha: sha(c), committedAt: at(d), taggedAt: null, onDefaultBranch: true, moved: false });
    const range = (tagName: string, c: string, base: { name: string; c: string } | null, prIds: number[]) => ({
      tagName,
      sha: sha(c),
      baseTagName: base?.name ?? null,
      baseSha: base ? sha(base.c) : null,
      prIds,
      unresolvedPrNumbers: [],
      unmatchedCommits: 0,
    });
    const r = foldReleaseCheck({
      settings: { releaseSuffix: '-rc', hotfixSuffix: '-hotfix' },
      repos: [
        {
          repoId: 1,
          fullName: 'acme/api',
          name: 'api',
          writable: true,
          tags: [tag('v1.0.0', 'a', 1), tag('v1.1.0', 'b', 3)],
          ranges: [range('v1.0.0', 'a', null, []), range('v1.1.0', 'b', { name: 'v1.0.0', c: 'a' }, [10])],
        },
        { repoId: 2, fullName: 'acme/worker', name: 'worker', writable: true, tags: [], ranges: [] },
      ],
      // api: the main PR, merged and in v1.1.0. worker: the release fix only (into hotfix/…, open), main
      // not needed — the DB half never hands in an open PR into another branch (db/release-check.ts).
      prs: [{ id: 10, repoId: 1, number: 10, title: 'PLAT-1 change', url: 'https://github.com/acme/api/pull/10', isBot: false, mergedAt: at(2), ticketIdents: ['PLAT-1'] }],
      openPrs: [],
      tickets: [{ ident: 'PLAT-1', key: 'PLAT-1', title: 't', url: null, statusName: 'Done', done: true, readState: 'ok' }],
    });
    const t = r.tickets.find((x) => x.key === 'PLAT-1')!;
    expect(t.blocker).toBeNull();
    expect(t.repos.find((x) => x.repoId === 1)?.state).toBe('in_candidate');
    expect(t.repos.find((x) => x.repoId === 2)).toBeUndefined();
    expect(r.repos.find((x) => x.repoId === 1)?.candidate?.name).toBe('v1.1.0');
  });
});
