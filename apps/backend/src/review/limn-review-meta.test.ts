// THE HIDDEN METADATA ON A POSTED REVIEW (shared limn-review-meta.ts; docs/CLAUDE-REVIEW.md
// § Teammates' reviews). Pure: the marker's round trip, a legacy post, hostile values, the finding
// comment parser, and the post seam's marker keeping the prefix every reader matches.
import { describe, expect, it } from 'vitest';
import {
  compareLimnVersions,
  hasLimnReviewMarker,
  isLimnBelowTeamMinimum,
  MIN_TEAM_LIMN_VERSION,
  limnReviewMarker,
  parseLimnReviewMarker,
  parsePostedLimnFinding,
  postedFindingDisplay,
  stripLimnReviewMarker,
} from '@pierre-review/shared';

const SHA = 'a'.repeat(40);

describe('limnReviewMarker / parseLimnReviewMarker', () => {
  it('round-trips a single run', () => {
    const m = limnReviewMarker('abc123', {
      headSha: SHA,
      run: 'auto',
      pair: false,
      runs: [{ provider: 'claude', model: 'claude-opus-5-5', effort: 'medium' }],
      verdict: 'REQUEST_CHANGES',
      limnVersion: '0.1.174',
    });
    expect(m.startsWith('<!-- pierre:claude-review v=1 a=abc123 ')).toBe(true);
    expect(m.endsWith(' -->')).toBe(true);
    expect(parseLimnReviewMarker(`Looks good.\n\n${m}`)).toEqual({
      legacy: false,
      headSha: SHA,
      run: 'auto',
      pair: false,
      runs: [{ provider: 'claude', model: 'claude-opus-5-5', effort: 'medium' }],
      verdict: 'REQUEST_CHANGES',
      limnVersion: '0.1.174',
    });
  });

  it('round-trips a Claude + Codex pair, a half with no effort included', () => {
    const m = limnReviewMarker('n1', {
      headSha: SHA,
      run: 'manual',
      pair: true,
      runs: [
        { provider: 'claude', model: 'claude-opus-5-5', effort: null },
        { provider: 'codex', model: 'gpt-5.5', effort: 'high' },
      ],
      verdict: 'COMMENT',
      limnVersion: null,
    });
    expect(m).toContain('s=pair p=claude,codex m=claude-opus-5-5,gpt-5.5 e=-,high');
    const p = parseLimnReviewMarker(m)!;
    expect(p.pair).toBe(true);
    expect(p.runs).toEqual([
      { provider: 'claude', model: 'claude-opus-5-5', effort: null },
      { provider: 'codex', model: 'gpt-5.5', effort: 'high' },
    ]);
    expect(p.limnVersion).toBeNull();
  });

  it('reads a legacy post (no metadata) with every field null', () => {
    for (const body of ['Summary.\n\n<!-- pierre:claude-review v=1 -->', 'x <!-- pierre:claude-review v=1 a=0f0f0f -->']) {
      expect(parseLimnReviewMarker(body)).toEqual({
        legacy: true,
        headSha: null,
        run: null,
        pair: false,
        runs: [],
        verdict: null,
        limnVersion: null,
      });
    }
  });

  it('never matches the finding, pushback, CI or sonar markers', () => {
    for (const body of [
      '<!-- pierre:claude-review-finding v=1 -->',
      '<!-- pierre:claude-review-pushback v=1 -->',
      '<!-- pierre:claude-review-ci v=1 -->',
      '<!-- pierre:claude-review-sonar v=1 -->',
      'no marker at all',
    ]) {
      expect(parseLimnReviewMarker(body)).toBeNull();
      expect(hasLimnReviewMarker(body)).toBe(false);
    }
  });

  it('keeps hostile values inside the comment and drops malformed ones', () => {
    const m = limnReviewMarker('x', {
      headSha: 'not-a-sha',
      run: 'auto',
      pair: false,
      runs: [{ provider: 'claude', model: 'evil --> <script>', effort: 'low' }],
      verdict: 'COMMENT',
      limnVersion: '1.0 --> x',
    });
    expect(m.indexOf('-->')).toBe(m.length - 3);
    expect(m).not.toContain('<script');
    const p = parseLimnReviewMarker(m)!;
    expect(p.headSha).toBeNull(); // not hex
    expect(p.runs[0]!.model).toBe('evil-script');
    // Unknown keys and a junk verdict are ignored.
    expect(parseLimnReviewMarker('<!-- pierre:claude-review v=1 zz=1 d=MERGE k=weird -->')).toMatchObject({
      verdict: null,
      run: null,
    });
  });

  it('carries each judgement\'s one-line how in `jr=`, which an older reader ignores', () => {
    const m = limnReviewMarker('n1', {
      headSha: SHA,
      judged: [
        { commentId: '12', outcome: 'addressed', reason: 'rowSelect now reads rowid — café' },
        { commentId: '13', outcome: 'still_open', reason: 'Add the guard' },
        { commentId: '14', outcome: 'no_longer_applies' },
      ],
    });
    // Nothing in the value can close the comment or carry markup.
    expect(m).toMatch(/ jr=12:[A-Za-z0-9+/]+,13:[A-Za-z0-9+/]+ -->$/);
    expect(parseLimnReviewMarker(m)?.judged).toEqual([
      { commentId: '12', outcome: 'addressed', reason: 'rowSelect now reads rowid — café' },
      { commentId: '13', outcome: 'still_open', reason: 'Add the guard' },
      { commentId: '14', outcome: 'no_longer_applies' },
    ]);
    // A malformed reason is dropped; the outcome never is.
    const bad = m.replace(/jr=12:[A-Za-z0-9+/]+/, 'jr=12:!!');
    expect(parseLimnReviewMarker(bad)?.judged?.[0]).toEqual({ commentId: '12', outcome: 'addressed' });
    // A reason for an id `j=` does not name is ignored.
    const stray = limnReviewMarker('n1', { headSha: SHA, judged: [{ commentId: '12', outcome: 'addressed' }] }).replace(' -->', ' jr=99:eA -->');
    expect(parseLimnReviewMarker(stray)?.judged).toEqual([{ commentId: '12', outcome: 'addressed' }]);
  });

  it('strips the marker from the summary text', () => {
    expect(stripLimnReviewMarker(`Two issues.\n\n${limnReviewMarker('q', { run: 'auto' })}`)).toBe('Two issues.');
  });
});

describe('parsePostedLimnFinding', () => {
  const MARK = '<!-- pierre:claude-review-finding v=1 -->';

  it('reads an inline finding: severity from the lead, notes and footer gone', () => {
    const body = `**Warning**\n\nThis can throw on an empty list.\nGuard it.\n\n_The line this refers to isn’t part of the PR’s diff, so it’s anchored to the file’s first change._\n\n_Posted automatically by Limn’s Claude review._\n\n${MARK}`;
    expect(parsePostedLimnFinding(body)).toEqual({
      severity: 'warning',
      tag: null,
      refPath: null,
      refLine: null,
      title: 'This can throw on an empty list.',
      body: 'This can throw on an empty list.\nGuard it.',
    });
  });

  it('reads a pair tag and a PR-level reference from the lead', () => {
    const p = parsePostedLimnFinding(`**Blocker** · Codex · \`src/y.ts:4\`\n\nThe lock is never released.\n\n${MARK}`);
    expect(p).toMatchObject({ severity: 'blocker', tag: 'Codex', refPath: 'src/y.ts', refLine: 4, body: 'The lock is never released.' });
  });

  it('reads an unlabelled finding (posted before leads) and a bare PR-level reference', () => {
    expect(parsePostedLimnFinding(`Rename this.\n\n${MARK}`)).toMatchObject({ severity: null, title: 'Rename this.' });
    expect(parsePostedLimnFinding(`**\`src/z.ts\`**\n\nOld style.\n\n${MARK}`)).toMatchObject({
      severity: null,
      refPath: 'src/z.ts',
      refLine: null,
      body: 'Old style.',
    });
  });
});

describe('postedFindingDisplay (a posted finding shown like the reader’s own)', () => {
  it('splits the first sentence off as the title, outside `code`', () => {
    const text =
      "`schemaErrorListener` runs only on hapi's `request` event, `error` channel. Hapi emits that event only for a 500.\n\nTo fix this, move the count.";
    expect(postedFindingDisplay(text, 'fallback')).toEqual({
      title: "`schemaErrorListener` runs only on hapi's `request` event, `error` channel.",
      body: 'Hapi emits that event only for a 500.\n\nTo fix this, move the count.',
      suggestion: null,
    });
    // A full stop inside code (`error.message`) or "e.g." is not the end.
    expect(postedFindingDisplay('Log `error.message` once, e.g. here. Then stop.', 'x').title).toBe(
      'Log `error.message` once, e.g. here.',
    );
  });

  it('a one-line text is all title; a short first line without a stop is the title', () => {
    expect(postedFindingDisplay('Rename this', 'x')).toEqual({ title: 'Rename this', body: '', suggestion: null });
    expect(postedFindingDisplay('Missing guard\nThe list can be empty.', 'x')).toEqual({
      title: 'Missing guard',
      body: 'The list can be empty.',
      suggestion: null,
    });
  });

  it('a long first sentence keeps the stored title and the whole text', () => {
    const long = `${'word '.repeat(50)}end. More.`;
    expect(postedFindingDisplay(long, 'Stored title…')).toEqual({ title: 'Stored title…', body: long, suggestion: null });
  });

  it('takes a trailing suggestion block out of the text', () => {
    expect(postedFindingDisplay('Use a guard. It is safer.\n\n```suggestion\nif (!xs.length) return;\n```', 'x')).toEqual({
      title: 'Use a guard.',
      body: 'It is safer.',
      suggestion: 'if (!xs.length) return;',
    });
  });
});

describe('compareLimnVersions / isLimnBelowTeamMinimum (docs/TEAM-REVIEW.md § 12)', () => {
  it('orders by semver, numerically', () => {
    expect(compareLimnVersions('0.1.188', '1.0.3')).toBeLessThan(0);
    expect(compareLimnVersions('1.0.10', '1.0.3')).toBeGreaterThan(0);
    expect(compareLimnVersions('1.0.3', '1.0.3')).toBe(0);
    expect(compareLimnVersions('v1.0.3', '1.0.3')).toBe(0);
    expect(compareLimnVersions('1.10.0', '1.9.9')).toBeGreaterThan(0);
    expect(compareLimnVersions('1.0.3-beta.1', '1.0.3')).toBeLessThan(0);
    expect(compareLimnVersions('1.0.3-beta.2', '1.0.3-beta.10')).toBeLessThan(0);
    expect(compareLimnVersions('1.0', '1.0.3')).toBeNull();
  });

  it('counts an unknown or unreadable version as older', () => {
    expect(MIN_TEAM_LIMN_VERSION).toBe('1.0.5');
    expect(isLimnBelowTeamMinimum('0.1.188')).toBe(true);
    expect(isLimnBelowTeamMinimum('1.0.3')).toBe(true);
    expect(isLimnBelowTeamMinimum('1.0.4')).toBe(true);
    expect(isLimnBelowTeamMinimum('1.0.5')).toBe(false);
    expect(isLimnBelowTeamMinimum('1.1.0')).toBe(false);
    expect(isLimnBelowTeamMinimum(null)).toBe(true);
    expect(isLimnBelowTeamMinimum('')).toBe(true);
    expect(isLimnBelowTeamMinimum('dev')).toBe(true);
  });
});
