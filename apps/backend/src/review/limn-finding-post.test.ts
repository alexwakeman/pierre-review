// The ONE predicate that makes a posted comment a Limn FINDING (shared limn-severity.ts
// `limnFindingPost`), over the exact bodies the post builders write.
import { describe, expect, it } from 'vitest';
import {
  isLimnBotLogin,
  LIMN_ML_SEVERITY,
  limnBotLabel,
  limnBotLogin,
  limnFindingPost,
  limnPosterOf,
} from '@pierre-review/shared';
import { findingCommentBody, prLevelFindingBody } from './post-review.js';
import { reminderLead } from './claude-review/posted-state.js';

const MARK = '<!-- pierre:claude-review-finding v=1 -->';
const base = { body: 'This can throw.', editedBody: null, suggestion: null };

describe('limnFindingPost', () => {
  it('reads every lead form the builders write', () => {
    expect(limnFindingPost(findingCommentBody({ ...base, severity: 'warning' }))).toEqual({ severity: 'warning', reminder: false });
    expect(limnFindingPost(findingCommentBody({ ...base, severity: 'nit' }, { tag: 'Codex' }))).toEqual({ severity: 'nit', reminder: false });
    expect(
      limnFindingPost(prLevelFindingBody({ ...base, path: 'src/x.ts', line: 4, severity: 'blocker' })),
    ).toEqual({ severity: 'blocker', reminder: false });
    expect(limnFindingPost(`**Question** · Codex · \`src/x.ts:4\`\n\nWhy?\n\n${MARK}`)).toEqual({ severity: 'question', reminder: false });
  });

  it('reads a reminder, with and without a severity', () => {
    const lead = reminderLead({ url: 'https://github.com/a/b/pull/1#discussion_r1', postedAt: '2026-10-02T00:00:00Z' });
    expect(limnFindingPost(findingCommentBody({ ...base, severity: 'warning', storyLead: lead }))).toEqual({ severity: 'warning', reminder: true });
    expect(limnFindingPost(findingCommentBody({ ...base, storyLead: lead }))).toEqual({ severity: null, reminder: true });
    expect(
      limnFindingPost(prLevelFindingBody({ ...base, path: 'src/x.ts', line: 4, storyLead: lead })),
    ).toEqual({ severity: null, reminder: true });
  });

  it('is null for replies, pushback, ticket posts, legacy findings and unmarked text', () => {
    expect(limnFindingPost(`Fixed, thanks.\n\n${MARK}`)).toBeNull();
    expect(limnFindingPost(`**Warning**\n\nNo.\n\n<!-- pierre:claude-review-pushback v=1 -->\n${MARK}`)).toBeNull();
    expect(limnFindingPost(`**BMD-1 story check**\n\nAC2 is not met.\n\n${MARK}`)).toBeNull();
    expect(limnFindingPost(findingCommentBody(base))).toBeNull();
    expect(limnFindingPost('**Warning**\n\nA person typed this.')).toBeNull();
    expect(limnFindingPost(null)).toBeNull();
    expect(limnFindingPost('')).toBeNull();
  });

  it('reads a thread-opening finding posted before leads existed as a finding with no severity', () => {
    expect(limnFindingPost(findingCommentBody(base), { threadRoot: true })).toEqual({ severity: null, reminder: false });
    // Still never a ticket post or a pushback, even when it opens a thread.
    expect(limnFindingPost(`**BMD-1 story check** on abc1234: 1 gap.\n\n${MARK}`, { threadRoot: true })).toBeNull();
    expect(limnFindingPost(`No.\n\n<!-- pierre:claude-review-pushback v=1 -->\n${MARK}`, { threadRoot: true })).toBeNull();
    expect(limnFindingPost('A person opened this thread.', { threadRoot: true })).toBeNull();
  });

  it('reads CRLF bodies and leading whitespace', () => {
    expect(limnFindingPost(`\r\n**Warning**\r\n\r\nThis can throw.\r\n\r\n${MARK}`)).toEqual({ severity: 'warning', reminder: false });
  });
});

describe('the limn: bot identity', () => {
  it('round-trips a poster login and names the bot', () => {
    expect(limnBotLogin('alice')).toBe('limn:alice');
    expect(isLimnBotLogin('limn:alice')).toBe(true);
    expect(isLimnBotLogin('alice')).toBe(false);
    expect(limnPosterOf('limn:alice')).toBe('alice');
    expect(limnPosterOf('alice')).toBeNull();
    expect(limnBotLabel('alice')).toBe('Limn · alice');
  });

  it('maps every severity onto the ML scale', () => {
    expect(LIMN_ML_SEVERITY).toEqual({ blocker: 'critical', warning: 'major', nit: 'nit', question: 'minor' });
  });
});
