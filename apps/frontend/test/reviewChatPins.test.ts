// "Send to chat" pins (store/reviewChatPins.ts): per PR, a second pin is a no-op, the cap counts what
// THIS chat would send, and a finding pin shows only on its own review run's chat.
import { beforeEach, describe, expect, it } from 'vitest';
import { CLAUDE_REVIEW_CHAT_MAX_PINS } from '@pierre-review/shared';
import { pinsForChat, useReviewChatPins } from '../src/store/reviewChatPins.js';

const s = () => useReviewChatPins.getState();
const finding = (findingId: number, reviewId = 7) => ({ ref: { kind: 'finding' as const, findingId }, label: `F${findingId}`, reviewId });

beforeEach(() => useReviewChatPins.setState({ byPr: {}, chats: {}, focus: null }));

describe('reviewChatPins', () => {
  it('pins once, asks the chat to focus each time, and unpins', () => {
    s().registerChat(1, 7);
    expect(s().pin(1, finding(10))).toBe('added');
    const tick = s().focus?.tick;
    expect(s().pin(1, finding(10))).toBe('already');
    expect(s().focus?.tick).toBe((tick ?? 0) + 1);
    expect(s().byPr[1]).toHaveLength(1);
    s().unpin(1, 'f:10');
    expect(s().byPr[1]).toHaveLength(0);
  });

  it('refuses past the cap, counting only what this chat would send', () => {
    s().registerChat(1, 7);
    useReviewChatPins.setState({ byPr: { 1: [{ ...finding(99, 6), key: 'f:99' }] } });
    for (let i = 0; i < CLAUDE_REVIEW_CHAT_MAX_PINS; i++) expect(s().pin(1, finding(i + 1))).toBe('added');
    expect(s().pin(1, { ref: { kind: 'story_item', ticketReviewId: 3, itemId: 4 }, label: 'AC1', reviewId: null })).toBe('full');
  });

  it("shows story items on any run's chat and findings only on their own run's", () => {
    const entries = [
      { ...finding(1, 7), key: 'f:1' },
      { ...finding(2, 8), key: 'f:2' },
      { ref: { kind: 'story_item' as const, ticketReviewId: 3, itemId: 4 }, label: 'AC1', reviewId: null, key: 's:3:4' },
    ];
    expect(pinsForChat(entries, 7).map((e) => e.key)).toEqual(['f:1', 's:3:4']);
  });

  it('restores a failed send in front, without duplicates', () => {
    s().pin(1, finding(1));
    const sent = [{ ...finding(2), key: 'f:2' }, { ...finding(1), key: 'f:1' }];
    s().restore(1, sent);
    expect(s().byPr[1]!.map((e) => e.key)).toEqual(['f:2', 'f:1']);
  });

  it('a restore never leaves the chat over the cap (the newest pins go)', () => {
    s().registerChat(1, 7);
    const sent = Array.from({ length: CLAUDE_REVIEW_CHAT_MAX_PINS }, (_, i) => ({ ...finding(i + 1), key: `f:${i + 1}` }));
    s().remove(1, sent.map((e) => e.key));
    // Pinned while the send was in flight, plus an older run's hidden pin that does not count.
    s().pin(1, finding(100));
    s().pin(1, finding(101));
    useReviewChatPins.setState({ byPr: { 1: [...s().byPr[1]!, { ...finding(200, 6), key: 'f:200' }] } });
    s().restore(1, sent);
    const keys = s().byPr[1]!.map((e) => e.key);
    expect(pinsForChat(s().byPr[1]!, 7)).toHaveLength(CLAUDE_REVIEW_CHAT_MAX_PINS);
    expect(keys).not.toContain('f:100');
    expect(keys).toContain('f:200');
  });

  it('unregisters only the chat it registered', () => {
    s().registerChat(1, 7);
    s().unregisterChat(1, 8);
    expect(s().chats[1]).toBe(7);
    s().unregisterChat(1, 7);
    expect(s().chats[1]).toBeUndefined();
  });
});
