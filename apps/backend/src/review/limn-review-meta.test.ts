// THE HIDDEN METADATA ON A POSTED REVIEW (shared limn-review-meta.ts; docs/CLAUDE-REVIEW.md
// § Teammates' reviews). Pure: the marker's round trip, a legacy post, hostile values, the finding
// comment parser, and the post seam's marker keeping the prefix every reader matches.
import { describe, expect, it } from 'vitest';
import {
  hasLimnReviewMarker,
  limnReviewMarker,
  parseLimnReviewMarker,
  parsePostedLimnFinding,
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
