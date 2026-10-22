// ── EVERY LINK IN THE SLACK SPRINT REPORT POINTS INTO LIMN ───────────────────────────────────
//
// The Slack message used to link every PR reference to github.com, and resolved a bare "#12" to
// the FIRST ref with that number across every repo. It now links each reference to the PR's own
// tab in Limn, prints its title and author, and resolves a number only within one repository. This
// suite pins the pure half: the link builder, the formatter and the section splitter.
//
//   pnpm --filter @pierre-review/backend exec vitest run src/platform/test/slack-pr-links.test.ts
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { DigestPrRef } from '@pierre-review/shared';
import type { ProContext } from '../contract.js';
import { prLink, slackLink } from '../slack/links.js';
import { fitSections, toSlackMrkdwn } from '../slack/format.js';

const ref = (over: Partial<DigestPrRef> & Pick<DigestPrRef, 'prNumber' | 'repoFullName'>): DigestPrRef => ({
  prId: null,
  repoId: 0,
  title: null,
  authorLogin: null,
  authorId: null,
  state: 'open',
  ciStatus: null,
  additions: 0,
  deletions: 0,
  changedFiles: 0,
  openedAt: null,
  ...over,
});

const API12 = ref({
  prNumber: 12,
  prId: 501,
  repoId: 10,
  repoFullName: 'acme/api',
  title: 'Fix the login redirect',
  authorLogin: 'alice',
  authorId: 1,
});
const WEB12 = ref({
  prNumber: 12,
  prId: 502,
  repoId: 11,
  repoFullName: 'acme/web',
  title: 'Tidy the footer',
  authorLogin: 'bob',
  authorId: 2,
});
const API7 = ref({
  prNumber: 7,
  prId: 507,
  repoId: 10,
  repoFullName: 'acme/api',
  title: 'Add retry to the webhook sender',
  authorLogin: 'carol',
  authorId: 3,
});

const LIMN = 'https://limn.example/app/?workspace=3&view=pr-detail%3A';
const prUrl = (r: DigestPrRef): string | null => `${LIMN}${r.prId}`;
const repoUrl = (id: number): string | null =>
  `https://limn.example/app/?view=activity&workspace=3&activityRepo=${id}`;

const ctxWith = (appWebUrl?: string): ProContext =>
  ({
    host: {
      version: '0.0.0',
      deploymentMode: 'local' as const,
      isCloud: false,
      ...(appWebUrl === undefined ? {} : { appWebUrl }),
    },
  }) as unknown as ProContext;

const count = (s: string, sub: string): number => s.split(sub).length - 1;

describe('prLink — a PR tab in Limn', () => {
  it('(a) builds the SPA tab-key address on a local host', () => {
    const url = prLink(ctxWith('http://localhost:4000'), 3, 501);
    expect(url).toBe('http://localhost:4000/app/?workspace=3&view=pr-detail%3A501');
    expect(new URL(url!).searchParams.get('view')).toBe('pr-detail:501');
    expect(new URL(url!).searchParams.get('workspace')).toBe('3');
  });

  it('(b) strips a trailing slash off the base', () => {
    expect(prLink(ctxWith('https://app.example.com/'), 7, 9)).toBe(
      'https://app.example.com/app/?workspace=7&view=pr-detail%3A9',
    );
  });

  it('(c) is null with no usable base — never a GitHub fallback', () => {
    expect(prLink(ctxWith(), 1, 2)).toBeNull();
    expect(prLink(ctxWith(''), 1, 2)).toBeNull();
    expect(prLink(ctxWith('not-a-url'), 1, 2)).toBeNull();
  });

  it('(d) speaks the SPA’s own URL vocabulary (source scan across the open-core boundary)', () => {
    const read = (rel: string): string =>
      readFileSync(fileURLToPath(new URL(`../../../../frontend/src/${rel}`, import.meta.url)), 'utf8');
    const tabs = read('store/pinnedTabs.ts');
    expect(tabs).toMatch(/prDetailKey\s*=\s*\(id: number\): string =>\s*`pr-detail:\$\{id\}`/);
    expect(tabs).toContain('(pr-detail|pr-focus):(\\d+)');
    const url = read('hooks/useUrlState.ts');
    expect(url).toContain("p.get('view')");
    expect(url).toContain('parseTabKey(view)');
  });

  it('(e) slackLink escapes its text and a `|` cannot end the label early', () => {
    expect(slackLink('https://x.example/', 'Team <A>|B <!here>')).toBe(
      '<https://x.example/|Team &lt;A&gt;¦B &lt;!here&gt;>',
    );
    expect(slackLink(null, 'Team <A> & B')).toBe('Team &lt;A&gt; &amp; B');
  });
});

describe('toSlackMrkdwn — PR references', () => {
  it('1. a qualified token on a metrics line links into Limn with title and author', () => {
    const out = toSlackMrkdwn('- **CI:** 1 PR red: acme/web#12 (2 days red)', [API12, WEB12], {
      prUrl,
      repoUrl,
    });
    expect(out).toContain(`<${LIMN}502|acme/web#12 Tidy the footer> by @bob (2 days red)`);
    expect(out.startsWith('• *CI:*')).toBe(true);
  });

  it('2. a repo heading links into Limn and its action items drop the repo prefix', () => {
    const out = toSlackMrkdwn(
      '**Action items**\n\n**acme/api**\n- acme/api#12 — Stalled 5 days; needs review from @bob.',
      [API12, WEB12],
      { prUrl, repoUrl },
    );
    expect(out).toContain('*<https://limn.example/app/?view=activity&workspace=3&activityRepo=10|acme/api>*');
    expect(out).toContain(
      `• <${LIMN}501|#12 Fix the login redirect> by @alice — Stalled 5 days; needs review from @bob.`,
    );
    const colon = toSlackMrkdwn('**acme/api:**\n- #12 needs a look', [API12], { prUrl, repoUrl });
    expect(colon).toContain('activityRepo=10|acme/api>*');
    expect(colon).toContain(`<${LIMN}501|#12 Fix the login redirect>`);
  });

  it('3. never guesses between two repositories’ #12', () => {
    const out = toSlackMrkdwn(
      '- #12 needs a look\n**acme/web**\n- #12 needs a look\n- acme/api#12 also stalled',
      [API12, WEB12],
      { prUrl, repoUrl },
    );
    const lines = out.split('\n');
    expect(lines[0]).toBe('• #12 needs a look');
    expect(lines[2]).toContain(`<${LIMN}502|#12 Tidy the footer> by @bob`);
    expect(lines[3]).toContain(`<${LIMN}501|acme/api#12 Fix the login redirect> by @alice`);
    expect(out).not.toContain(`${LIMN}501|#12 `);

    // A per-repo section whose own repo has no #12 leaves it plain, whatever another repo holds.
    const own = toSlackMrkdwn('- #12 needs a look', [WEB12], { prUrl, repoFullName: 'acme/api' });
    expect(own).toBe('• #12 needs a look');
  });

  it('3b. a line opening with another repo’s bold name ends the previous heading’s scope', () => {
    const out = toSlackMrkdwn('**acme/api**\n- #7 ok\n**acme/web** — 1 item\n- #12 stalled', [API12, API7, WEB12], {
      prUrl,
      repoUrl,
    });
    expect(out).toContain(`<${LIMN}507|#7 `);
    expect(out).toContain(`<${LIMN}502|#12 Tidy the footer>`);
    expect(out).not.toContain(`${LIMN}501`);
  });

  it('4. a per-repo section resolves a bare #N within its own repo only', () => {
    const out = toSlackMrkdwn('- #12 still waiting on review.', [API12, WEB12], {
      prUrl,
      repoFullName: 'acme/api',
    });
    expect(out).toBe(`• <${LIMN}501|#12 Fix the login redirect> by @alice still waiting on review.`);
  });

  it('5. escapes titles and model text so nothing forges a link or a mention', () => {
    const evil = { ...API12, title: 'Use <T> & friends | more <!channel>' };
    const out = toSlackMrkdwn('- #12 lead time < 2h & falling', [evil], {
      prUrl,
      repoFullName: 'acme/api',
    });
    expect(out).toContain(`<${LIMN}501|#12 Use &lt;T&gt; &amp; friends ¦ more &lt;!channel&gt;>`);
    expect(out).toContain('lead time &lt; 2h &amp; falling');
    expect(out).not.toContain('<!channel>');
    const forged = toSlackMrkdwn('ping <!here> and <https://evil.example|click>', [], { prUrl });
    expect(forged).not.toMatch(/<[!h]/);
  });

  it('6. with no base URL the reference is plain text — never GitHub', () => {
    const out = toSlackMrkdwn('- #12 stalled', [API12], { prUrl: () => null, repoFullName: 'acme/api' });
    expect(out).toBe('• #12 Fix the login redirect by @alice stalled');
    expect(out).not.toMatch(/<https?:/);
    expect(out).not.toMatch(/github\.com/i);
  });

  it('7. a ref with no local id renders as plain text', () => {
    const out = toSlackMrkdwn('- #12 stalled', [{ ...API12, prId: null }], {
      prUrl,
      repoFullName: 'acme/api',
    });
    expect(out).toBe('• #12 Fix the login redirect by @alice stalled');
  });

  it('8. an unknown title or author is omitted, never printed as "null"', () => {
    const bare = { ...API12, title: null, authorLogin: null };
    const out = toSlackMrkdwn('- #12 stalled', [bare], { prUrl, repoFullName: 'acme/api' });
    expect(out).toBe(`• <${LIMN}501|#12> stalled`);
    expect(out).not.toContain('null');
    expect(out).not.toContain(' by ');
  });

  it('9. no github.com URL survives, as a link or as text', () => {
    const cases: Array<[string, string]> = [
      ['[#12](https://github.com/acme/api/pull/12)', `<${LIMN}501|acme/api#12 Fix the login redirect> by @alice`],
      ['[the README](https://github.com/acme/api/blob/main/README.md)', 'the README'],
      ['see https://github.com/acme/api/pull/99 now', 'see acme/api#99 now'],
      ['https://github.com/acme/api/issues/5', 'acme/api#5'],
      ['see https://github.com/acme/api.', 'see acme/api.'],
      ['[x](https://example.com/y)', 'x'],
      ['https://api.github.com/repos/acme/api', 'GitHub'],
      ['(https://github.com/acme/api/pull/12#discussion_r1)', `(<${LIMN}501|acme/api#12 Fix the login redirect> by @alice)`],
      ['<https://github.com/acme>', 'acme'],
      ['notgithub.com stays', 'notgithub.com stays'],
    ];
    for (const [input, expected] of cases) {
      const out = toSlackMrkdwn(input, [API12], { prUrl, repoUrl });
      expect(out, input).toBe(expected);
      if (!input.startsWith('notgithub')) expect(out, input).not.toMatch(/github\.com/i);
    }
    const titled = { ...API12, title: 'Port https://github.com/acme/web/pull/3 here' };
    const out = toSlackMrkdwn('- #12', [titled], { prUrl: () => null, repoFullName: 'acme/api' });
    expect(out).toBe('• #12 Port acme/web#3 here by @alice');
    expect(out).not.toMatch(/github\.com/i);
  });

  it('10. a title or author the line already carries is not printed twice', () => {
    const out = toSlackMrkdwn('- acme/api#12 Fix the login redirect — stalled', [API12], { prUrl, repoUrl });
    expect(count(out, 'Fix the login redirect')).toBe(1);
    const by = toSlackMrkdwn('- #12 by @alice merged', [API12], { prUrl, repoFullName: 'acme/api' });
    expect(count(by, 'by @alice')).toBe(1);
    expect(by).toContain(`<${LIMN}501|#12 Fix the login redirect> by @alice merged`);
  });

  it('11. an inserted title is never scanned for tokens (single pass)', () => {
    const revert = { ...API7, title: 'Revert #12 and retry' };
    const input = '- #7 and #12 are open';
    const out = toSlackMrkdwn(input, [revert, API12], { prUrl, repoFullName: 'acme/api' });
    expect(count(out, '<https://')).toBe(2);
    expect(out).toContain(`<${LIMN}507|#7 Revert #12 and retry> by @carol`);
  });

  it('12. a long title is capped at 80 characters ending in …', () => {
    const long = { ...API12, title: 'x'.repeat(120) };
    const out = toSlackMrkdwn('- #12', [long], { prUrl, repoFullName: 'acme/api' });
    const label = /\|#12 ([^>]*)>/.exec(out)?.[1] ?? '';
    expect(label.length).toBeLessThanOrEqual(80);
    expect(label.endsWith('…')).toBe(true);
  });

  it('13. the first mention in a line carries the title; a repeat is a bare link', () => {
    const out = toSlackMrkdwn(
      '- Deadlocked #12 #7; #12 still holds 11 threads\n- #12 again',
      [API12, API7],
      { prUrl, repoFullName: 'acme/api' },
    );
    const [first, second] = out.split('\n');
    expect(count(first!, 'Fix the login redirect')).toBe(1);
    expect(first).toContain(`; <${LIMN}501|#12> still holds 11 threads`);
    expect(second).toContain(`<${LIMN}501|#12 Fix the login redirect> by @alice again`);
  });

  it('14. adjacent PR tokens are separated by a comma', () => {
    const run = toSlackMrkdwn('- awaiting review #12 #7.', [API12, API7], { prUrl, repoFullName: 'acme/api' });
    expect(run).toContain(`> by @alice, <${LIMN}507|#7 Add retry to the webhook sender> by @carol.`);
    const and = toSlackMrkdwn('- #12 and #7', [API12, API7], { prUrl, repoFullName: 'acme/api' });
    expect(and).not.toContain(',');
    const listed = toSlackMrkdwn('- #12, #7', [API12, API7], { prUrl, repoFullName: 'acme/api' });
    expect(listed).not.toContain(',,');
    expect(count(listed, ',')).toBe(1);
  });
});

describe('toSlackMrkdwn — a line naming many PRs lists them', () => {
  // HEADLINES_SYSTEM puts every PR of a shared theme on ONE bullet ("awaiting review #1 #2 #3"),
  // with no upper bound. Inline, twenty titled references made one line longer than a Slack
  // section; `fitSections` cut it mid-list and dropped the next bullet.
  const many = (n: number, titleLen = 50): DigestPrRef[] =>
    Array.from({ length: n }, (_, i) =>
      ref({
        prNumber: 13 + i,
        prId: 900 + i,
        repoId: 20,
        repoFullName: 'acme/fixtures',
        title: `Fixture change ${13 + i} `.padEnd(titleLen, 'x'),
        authorLogin: 'alice-dev',
        authorId: 1,
      }),
    );

  it('19. four titled PRs on one line: plain numbers in the sentence, one sub-line each', () => {
    const refs = many(4);
    const out = toSlackMrkdwn('- Four PRs awaiting review #13 #14 #15 #16; #13 is oldest.', refs, {
      prUrl,
      repoFullName: 'acme/fixtures',
    });
    const lines = out.split('\n');
    expect(lines[0]).toBe('• Four PRs awaiting review #13 #14 #15 #16; #13 is oldest.');
    expect(lines).toHaveLength(5); // the repeat #13 is not listed twice
    for (const [i, r] of refs.entries()) {
      expect(lines[i + 1]).toBe(`    ◦ <${LIMN}${r.prId}|#${r.prNumber} ${r.title}> by @alice-dev`);
    }
  });

  it('20. three titled PRs stay inline (the list starts at four)', () => {
    const out = toSlackMrkdwn('- awaiting review #13 #14 #15.', many(3), {
      prUrl,
      repoFullName: 'acme/fixtures',
    });
    expect(out.split('\n')).toHaveLength(1);
    expect(count(out, `|#1`)).toBe(3);
    expect(out).toContain('> by @alice-dev, <');
  });

  it('21. a nested bullet indents its list deeper; a ref with nothing to add stays an inline link', () => {
    const refs = [...many(4), ref({ prNumber: 40, prId: 940, repoId: 20, repoFullName: 'acme/fixtures' })];
    const out = toSlackMrkdwn('  - stalled #13 #14 #15 #16 #40', refs, { prUrl, repoFullName: 'acme/fixtures' });
    const lines = out.split('\n');
    expect(lines[0]).toBe(`• stalled #13 #14 #15 #16 <${LIMN}940|#40>`);
    expect(lines).toHaveLength(5);
    // `.trim()` on the joined text strips the first line's indent only, never a sub-line's.
    for (const l of lines.slice(1)) expect(l.startsWith('      ◦ <')).toBe(true);
  });

  it('22. with no base URL the list is plain text — never GitHub', () => {
    const out = toSlackMrkdwn('- #13 #14 #15 #16 waiting', many(4), {
      prUrl: () => null,
      repoFullName: 'acme/fixtures',
    });
    const lines = out.split('\n');
    expect(lines[0]).toBe('• #13 #14 #15 #16 waiting');
    expect(lines[1]).toBe(`    ◦ #13 ${many(1)[0]!.title} by @alice-dev`);
    expect(out).not.toMatch(/<https?:|github\.com/i);
  });

  it('23. a twenty-PR bullet keeps all twenty links AND the next bullet inside a repo’s two sections', () => {
    const refs = many(20, 52);
    const tokens = refs.map((r) => `#${r.prNumber}`).join(' ');
    const digest = [
      '- All 20 open PRs are new this week; no merges yet.',
      `- Twenty fixture PRs ${tokens} are all in progress and awaiting review.`,
      '- #13 is the oldest unreviewed PR at 15 hours.',
    ].join('\n');
    const base = 'https://limn-production.up.railway.app/app/?workspace=3&view=pr-detail%3A';
    const md = toSlackMrkdwn(digest, refs, {
      prUrl: (r) => `${base}${r.prId}`,
      repoFullName: 'acme/fixtures',
    });
    // report.ts: SECTION_MAX = 2900, REPO_MAX_SECTIONS = 2.
    const chunks = fitSections(`*acme/fixtures*\n${md}`, 2900, 2);
    const all = chunks.join('\n');
    expect(all).not.toContain('…');
    for (const r of refs) expect(all, `#${r.prNumber}`).toContain(`${base}${r.prId}|#${r.prNumber} ${r.title}>`);
    expect(all).toContain('are all in progress and awaiting review.');
    expect(all).toContain('is the oldest unreviewed PR at 15 hours.');
    for (const c of chunks) {
      expect(c.length).toBeLessThanOrEqual(2900);
      expect(count(c, '<')).toBe(count(c, '>'));
    }
  });
});

describe('fitSections — splitting at line boundaries', () => {
  const linkLine = (i: number): string =>
    `• <${LIMN}${i}|#${i} A fairly long pull request title number ${i}> by @someone — stalled`;

  it('15. never exceeds max and never splits a link', () => {
    const text = Array.from({ length: 40 }, (_, i) => linkLine(i)).join('\n');
    const chunks = fitSections(text, 500, 100);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) {
      expect(c.length).toBeLessThanOrEqual(500);
      expect(count(c, '<')).toBe(count(c, '>'));
    }
    expect(chunks.join('\n')).toBe(text);
  });

  it('16. more chunks than the limit: exactly `limit`, the last ending in …', () => {
    const text = Array.from({ length: 40 }, (_, i) => linkLine(i)).join('\n');
    const chunks = fitSections(text, 500, 2);
    expect(chunks).toHaveLength(2);
    expect(chunks[1]!.endsWith('…')).toBe(true);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(500);
  });

  it('17. an over-long line is cut before an unclosed link and never inside an entity', () => {
    const line = `${'a'.repeat(90)}<${LIMN}1|#1 title>`;
    const [cut] = fitSections(line, 100, 1);
    expect(cut).toBe(`${'a'.repeat(90)}…`);
    const amp = `${'b'.repeat(96)}&amp;tail`;
    const [cutAmp] = fitSections(amp, 100, 1);
    expect(cutAmp).toBe(`${'b'.repeat(96)}…`);
    expect(cutAmp!.length).toBeLessThanOrEqual(100);
  });

  it('17b. a chunk that opens on a list sub-line keeps its indent', () => {
    const text = ['• head', ...Array.from({ length: 6 }, (_, i) => `    ◦ item ${i} ${'z'.repeat(20)}`)].join('\n');
    const chunks = fitSections(text, 80, 10);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks.slice(1)) expect(c.startsWith('    ◦ item')).toBe(true);
    expect(chunks.join('\n')).toBe(text);
  });

  it('18. never yields an empty or whitespace-only chunk', () => {
    const text = `\n\n${'x'.repeat(40)}\n\n\n\n   \n\n${'y'.repeat(40)}\n\n`;
    const chunks = fitSections(text, 45, 10);
    expect(chunks.length).toBeGreaterThan(0);
    for (const c of chunks) expect(c.trim()).toBe(c);
    for (const c of chunks) expect(c).not.toBe('');
    expect(fitSections('\n  \n', 100, 3)).toEqual([]);
  });
});
