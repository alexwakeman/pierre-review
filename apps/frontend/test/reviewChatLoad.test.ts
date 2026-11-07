import { describe, expect, it } from 'vitest';
import { QueryClient, QueryObserver } from '@tanstack/query-core';
import type { ClaudeReviewChatAnswer, ClaudeReviewChatMessage, ClaudeReviewChatResponse } from '@pierre-review/shared';
import {
  chatThreadLoadFailed,
  claudeReviewChatKey,
  claudeReviewChatQueryOptions,
  mergeChatAnswer,
} from '../src/hooks/useClaudeReviewChat.js';

// THE REVIEW CHAT'S "Could not load this conversation." (reported 2026-11-06: the line showed under a
// chat whose answer had come back fine). The root cause is pinned at the bottom (a passive `skipToken`
// observer); the guard here is the second line of defence: the panel read `isError` alone. After an answer
// the hook writes the turn into the cache and re-reads the thread; when that BACKGROUND re-read fails
// (a server restart, a dropped connection), React Query keeps the data AND sets `status: 'error'`, so
// the line printed under a conversation that was on screen. The line is for "nothing to show" only.

const msg = (id: number, role: 'user' | 'assistant', content: string): ClaudeReviewChatMessage =>
  ({ id, findingId: null, role, content, createdAt: '2026-11-06T12:36:06.000Z' }) as ClaudeReviewChatMessage;

const thread = (messages: ClaudeReviewChatMessage[]): ClaudeReviewChatResponse => ({
  reviewId: 7,
  findingId: null,
  messages,
  headMoved: false,
  answering: false,
});

describe('chatThreadLoadFailed', () => {
  it('a failed re-read of a thread already on screen is not a failed load', async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const key = claudeReviewChatKey(7, null);
    let fail = false;
    const observer = new QueryObserver<ClaudeReviewChatResponse>(qc, {
      queryKey: key,
      queryFn: async () => {
        if (fail) throw new Error('502 Bad Gateway');
        return thread([msg(1, 'user', 'Why?'), msg(2, 'assistant', 'Because.')]);
      },
    });
    const unsubscribe = observer.subscribe(() => {});
    await observer.refetch();
    expect(chatThreadLoadFailed(observer.getCurrentResult())).toBe(false);

    // The answer lands, then the re-read fails.
    qc.setQueryData<ClaudeReviewChatResponse>(key, (prev) =>
      mergeChatAnswer(prev, { messages: [msg(3, 'user', 'And?'), msg(4, 'assistant', 'Fixed.')], trimmedTurns: 0, headMoved: false }, 7, null),
    );
    fail = true;
    await observer.refetch();
    const r = observer.getCurrentResult();
    expect(r.isError).toBe(true); // React Query's own flag: what the panel used to read
    expect(r.data?.messages.map((m) => m.id)).toEqual([1, 2, 3, 4]);
    expect(chatThreadLoadFailed(r)).toBe(false);
    unsubscribe();
  });

  it('a first read that fails, with nothing cached, is a failed load', async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const observer = new QueryObserver<ClaudeReviewChatResponse>(qc, {
      queryKey: claudeReviewChatKey(8, null),
      queryFn: async () => {
        throw new Error('500');
      },
    });
    const unsubscribe = observer.subscribe(() => {});
    await observer.refetch();
    expect(chatThreadLoadFailed(observer.getCurrentResult())).toBe(true);
    unsubscribe();
  });
});

describe('mergeChatAnswer', () => {
  const answer: ClaudeReviewChatAnswer = {
    messages: [msg(3, 'user', 'And?'), msg(4, 'assistant', 'Fixed.')],
    trimmedTurns: 0,
    headMoved: true,
  };

  it('appends the new turn once and clears the answering flag', () => {
    const prev = { ...thread([msg(1, 'user', 'Why?'), msg(2, 'assistant', 'Because.'), msg(3, 'user', 'And?')]), answering: true };
    const out = mergeChatAnswer(prev, answer, 7, null);
    expect(out.messages.map((m) => m.id)).toEqual([1, 2, 3, 4]);
    expect(out.answering).toBe(false);
    expect(out.headMoved).toBe(true);
  });

  it('with nothing cached, the answer seeds the thread instead of being dropped', () => {
    const out = mergeChatAnswer(undefined, answer, 7, null);
    expect(out).toEqual({ reviewId: 7, findingId: null, messages: answer.messages, headMoved: true, answering: false });
  });
});

// THE ROOT CAUSE (confirmed 2026-11-06): the AI Review tab observes the SAME thread key passively.
// When that observer used `skipToken`, each of its renders wrote skipToken onto the shared query,
// and the re-read after an answer (`invalidateQueries`) rejected with "Missing queryFn" — the open
// thread then read as an error. Every observer now carries the real queryFn and gates on `enabled`.
describe('a passive observer of the thread', () => {
  it('never breaks the open thread\'s re-read after an answer', async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    let reads = 0;
    const fetchThread = async (): Promise<ClaudeReviewChatResponse> => {
      reads += 1;
      return thread([msg(1, 'user', 'Why?'), msg(2, 'assistant', 'Because.')]);
    };
    const open = new QueryObserver<ClaudeReviewChatResponse>(qc, claudeReviewChatQueryOptions(7, null, true, fetchThread) as never);
    const stopOpen = open.subscribe(() => {});
    await open.refetch();
    // The tab's passive observer mounts (and re-renders) AFTER the panel's.
    const passive = new QueryObserver<ClaudeReviewChatResponse>(qc, claudeReviewChatQueryOptions(7, null, false, fetchThread) as never);
    const stopPassive = passive.subscribe(() => {});
    passive.setOptions(claudeReviewChatQueryOptions(7, null, false, fetchThread) as never);
    const before = reads;
    await qc.invalidateQueries({ queryKey: claudeReviewChatKey(7, null) });
    const r = open.getCurrentResult();
    expect(r.isError).toBe(false);
    expect(reads).toBe(before + 1);
    stopPassive();
    stopOpen();
  });

  it('a passive observer alone fetches nothing', async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    let reads = 0;
    const passive = new QueryObserver<ClaudeReviewChatResponse>(
      qc,
      claudeReviewChatQueryOptions(9, null, false, async () => {
        reads += 1;
        return thread([]);
      }) as never,
    );
    const stop = passive.subscribe(() => {});
    await qc.invalidateQueries({ queryKey: claudeReviewChatKey(9, null) });
    expect(reads).toBe(0);
    stop();
  });
});
