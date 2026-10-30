// ── COLOUR AND ICONS IN SLACK MESSAGES (slack/tones.ts) ─────────────────────────────────────
//
// What it pins:
//   • the tone → bar colour map (merged purple, good green, bad red, waiting amber, info grey);
//   • a review's colour follows its verdict, a merge is purple — and the WORDS are still there
//     (colour is never the only signal);
//   • every Pending card kind opens its line with one standard emoji;
//   • an event signal posts no empty top-level `blocks` key.
//
//   pnpm --filter @pierre-review/backend exec vitest run src/platform/test/slack-tones.test.ts
import { describe, expect, it } from 'vitest';
import { PENDING_TABS, type InsightCard } from '@pierre-review/shared';
import type { ProContext } from '../contract.js';
import { mergeMessage, reviewMessage } from '../slack/signals.js';
import { slackBody } from '../slack/send.js';
import {
  PENDING_TAB_EMOJI,
  PENDING_TAB_TONE,
  SLACK_TONE_COLOUR,
  pendingCardEmoji,
  verdictTone,
} from '../slack/tones.js';

const ctx = { host: { version: '0', appWebUrl: 'https://limn.example' } } as unknown as ProContext;
const facts = {
  prId: 100,
  repoId: 10,
  number: 12,
  title: 'Fix login',
  owner: 'acme',
  name: 'api',
  authorLogin: 'alice',
  mergedByLogin: 'bob',
};
type Att = { color: string; fallback: string; blocks: Array<{ text: { text: string } }> };
const att = (m: { attachments?: unknown[] }): Att => (m.attachments ?? [])[0] as Att;

describe('Slack tones', () => {
  it('maps each tone to its bar colour', () => {
    expect(SLACK_TONE_COLOUR).toEqual({
      merged: '#8250df',
      good: '#1f883d',
      bad: '#cf222e',
      waiting: '#d4a72c',
      info: '#8c959f',
    });
  });

  it('a review is coloured by its verdict, and still says the verdict in words', () => {
    expect(verdictTone('APPROVE')).toBe('good');
    expect(verdictTone('REQUEST_CHANGES')).toBe('bad');
    expect(verdictTone('COMMENT')).toBe('info');
    expect(verdictTone(null)).toBe('info');

    const changes = reviewMessage(ctx, 1, facts, 'REQUEST_CHANGES', 'Two bugs.');
    expect(changes.blocks).toEqual([]);
    expect(att(changes).color).toBe(SLACK_TONE_COLOUR.bad);
    expect(att(changes).fallback).toBe('Claude Review ran on acme/api#12: Request changes');
    const text = att(changes).blocks[0]!.text.text;
    expect(text).toContain('Verdict: *Request changes*');
    expect(text.startsWith(':warning: *Claude Review ran*')).toBe(true);

    const ok = reviewMessage(ctx, 1, facts, 'APPROVE', null);
    expect(att(ok).color).toBe(SLACK_TONE_COLOUR.good);
    expect(att(ok).blocks[0]!.text.text).toContain('Verdict: *Approve*');
  });

  it('a merge is purple and says "Merged"', () => {
    const m = mergeMessage(ctx, 1, facts);
    expect(att(m).color).toBe(SLACK_TONE_COLOUR.merged);
    expect(att(m).blocks[0]!.text.text).toContain(':tada: *Merged* · @bob merged');
    expect(m.text).toBe('@bob merged acme/api#12');
  });

  it('every team tab has a tone and one heading emoji', () => {
    for (const def of PENDING_TABS) {
      if (def.key === 'my_turn' || def.key === 'claude') continue;
      expect(PENDING_TAB_TONE[def.key], def.key).toBeDefined();
      expect(PENDING_TAB_EMOJI[def.key], def.key).toMatch(/^:[a-z_]+:$/);
    }
  });

  it('every Pending card kind on a team tab opens with one standard emoji', () => {
    const kinds = PENDING_TABS.flatMap((t) => t.kinds).filter((k) => k !== 'reviewer_load');
    for (const kind of kinds) {
      const card = { id: 'x', kind, arm: 'trunk', reason: 'trunk_red' } as unknown as InsightCard;
      expect(pendingCardEmoji(card), kind).toMatch(/^:[a-z_]+:$/);
    }
    const trunk = { kind: 'ci_failing', arm: 'trunk' } as unknown as InsightCard;
    const pr = { kind: 'ci_failing', arm: 'your_pr' } as unknown as InsightCard;
    expect(pendingCardEmoji(trunk)).toBe(':red_circle:');
    expect(pendingCardEmoji(pr)).toBe(':x:');
  });

  it('an event signal sends no empty top-level blocks; the digest keeps its header', () => {
    const body = JSON.parse(slackBody(mergeMessage(ctx, 1, facts))) as Record<string, unknown>;
    expect('blocks' in body).toBe(false);
    expect(body.text).toBe('@bob merged acme/api#12');
    expect(Array.isArray(body.attachments)).toBe(true);
    const digest = JSON.parse(slackBody({ blocks: [{ type: 'header' }], text: 't' })) as Record<string, unknown>;
    expect(digest.blocks).toEqual([{ type: 'header' }]);
  });
});
