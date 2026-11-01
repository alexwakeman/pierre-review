// A Limn finding comment is a BOT, one per poster: users row `limn:<login>`, display name
// "Limn · <login>" (docs/CLAUDE-REVIEW.md § Limn findings are bots). The login is NOT a GitHub
// account, so no surface may turn it into a profile link, and its severity badge is the review's
// own label, never a model score.
//
// Run from the workspace that HAS vitest:
//   ./apps/backend/node_modules/.bin/vitest run --root apps/frontend
import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { LIMN_LABEL_BACKEND, LIMN_LABEL_MODEL_VERSION } from '@pierre-review/shared';
import type { MlLabel, User } from '@pierre-review/shared';
import { buildQuotedReply, profileUrl } from '../src/lib/ui.js';
import { renderUserLabel } from '../src/components/Timeline/userRow.js';
import { MlSeverityBadge } from '../src/components/MlSeverityBadge.js';

const limnUser: User = {
  id: 77,
  githubLogin: 'limn:alice',
  displayName: 'Limn · alice',
  avatarUrl: null,
  isBot: true,
} as User;

describe('a Limn bot has no GitHub profile', () => {
  it('profileUrl is null for a limn: login and a URL for anyone else', () => {
    expect(profileUrl('limn:alice')).toBeNull();
    expect(profileUrl('alice')).toBe('https://github.com/alice');
  });

  it('the timeline row label shows "Limn · alice" and never links to GitHub', () => {
    const withGid = renderUserLabel(limnUser, 77, false, 'g77');
    const plain = renderUserLabel(limnUser, 77);
    for (const html of [withGid, plain]) {
      expect(html).toContain('Limn · alice');
      expect(html).not.toContain('github.com');
    }
    // The popover still opens from the name when the row has a gid.
    expect(withGid).toContain('data-user-gid="g77"');
  });
});

describe('MlSeverityBadge on a Limn finding', () => {
  const label = (over: Partial<MlLabel> = {}): MlLabel => ({
    targetKind: 'review_comment',
    targetId: 1,
    severity: 'major',
    severityOrd: 2,
    severityProb: 1,
    vendorSeverity: null,
    vendorSeverityConfidence: null,
    categories: ['correctness_bug'],
    isSummary: false,
    backend: LIMN_LABEL_BACKEND,
    modelVersion: LIMN_LABEL_MODEL_VERSION,
    createdAt: '2026-10-30T00:00:00.000Z',
    ...over,
  });
  const render = (l: MlLabel, vendorClaim?: boolean): string =>
    renderToStaticMarkup(createElement(MlSeverityBadge, { label: l, vendorClaim }));
  const tooltip = (html: string): string =>
    (/title="([^"]*)"/.exec(html)?.[1] ?? '').replace(/&#x27;|&#39;/g, "'").replace(/&amp;/g, '&');

  it("says it is from Limn's review, with no confidence and no fallback note", () => {
    const t = tooltip(render(label()));
    expect(t).toContain("From Limn's review.");
    expect(t).not.toContain('Confidence');
    expect(t).not.toContain('Heuristic fallback');
  });

  it('is never dimmed and never claims the bot declared nothing', () => {
    const html = render(label({ severityProb: 0.1 }), true);
    expect(html).not.toContain('opacity-70');
    expect(html).not.toContain('bot declared nothing');
  });
});

describe('a reply to a Limn finding never mentions the limn: login', () => {
  it('mentions the person who posted the finding', () => {
    expect(buildQuotedReply('**Nit** · x', 'limn:alice')).toBe('> **Nit** · x\n\n@alice ');
    expect(buildQuotedReply('', 'limn:alice')).toBe('@alice ');
    expect(buildQuotedReply('hi', 'bob')).toBe('> hi\n\n@bob ');
  });
});
