import {
  skipToken,
  useIsMutating,
  useMutation,
  useMutationState,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
import type {
  ClaudeReviewChatAnswer,
  ClaudeReviewChatBody,
  ClaudeReviewChatHistoryResponse,
  ClaudeReviewChatResponse,
} from '@pierre-review/shared';
import { api } from '../api/client.js';
import { useReviewChatPins, type ChatPinEntry } from '../store/reviewChatPins.js';

/**
 * What one Ask carries. `prId` + `pinEntries` are CLIENT-ONLY — the pins as the panel showed them,
 * so the pending turn can draw them and a failed send can put them back. Never sent: the POST body
 * is the question, the thread and the pins' REFERENCES.
 */
export type AskChatVars = ClaudeReviewChatBody & { prId?: number; pinEntries?: ChatPinEntry[] };

// Claude Review chat: one thread per review (findingId null) and one per finding.

/** The query key of ONE thread. */
export const claudeReviewChatKey = (reviewId: number, findingId: number | null) =>
  ['claude-review-chat', reviewId, findingId ?? 'review'] as const;

// ⚠ ONE MUTATION KEY PER REVIEW, shared by every mount. The server answers one question per
// account at a time, and a per-mount `isPending` resets when the tab is switched mid-answer —
// inviting a second BILLED POST. Every thread of the review reads `useIsMutating` on this key.
export const claudeReviewChatAskKey = (reviewId: number) =>
  ['claude-review-chat-ask', reviewId] as const;

/**
 * One thread's stored turns. Fetched only while the thread is OPEN (`enabled`) — nothing fetches
 * on mount. While the server reports an answer being written (`answering`, e.g. the pane was
 * reopened mid-answer), it re-reads every few seconds until the answer lands.
 */
export function useClaudeReviewChat(reviewId: number, findingId: number | null, enabled: boolean) {
  return useQuery<ClaudeReviewChatResponse>(claudeReviewChatQueryOptions(reviewId, findingId, enabled));
}

/** The thread query's options (exported so test/reviewChatLoad.test.ts pins them without React). */
export function claudeReviewChatQueryOptions(
  reviewId: number,
  findingId: number | null,
  enabled: boolean,
  fetchThread: (reviewId: number, findingId: number | null) => Promise<ClaudeReviewChatResponse> = api.claudeReviewChat,
) {
  return {
    queryKey: claudeReviewChatKey(reviewId, findingId),
    // ⚠ `enabled`, NEVER `skipToken`, for the closed case. The AI Review tab OBSERVES this same key
    // passively (enabled: false), and every observer's options are written onto the shared query on
    // each render. A `skipToken` observer left the QUERY's queryFn as skipToken, so the re-read after
    // an answer (`invalidateQueries`, which fetches with the query's own options) rejected with
    // "Missing queryFn" and the open thread showed "Could not load this conversation." under a
    // conversation that had loaded. With the real queryFn on every observer that cannot happen.
    queryFn: () => fetchThread(reviewId, findingId),
    enabled,
    staleTime: 30_000,
    refetchInterval: (q: { state: { data?: ClaudeReviewChatResponse } }) => (q.state.data?.answering ? 4_000 : false),
  };
}

/**
 * THE THREAD FAILED TO LOAD only when there is nothing to show. A failed BACKGROUND re-read (the
 * re-read after an answer, the poll while one is written, a remount) keeps the thread already on
 * screen: React Query then holds `status: 'error'` AND the data, and reading `isError` alone printed
 * "Could not load this conversation." under a conversation that had loaded, answer included.
 */
export function chatThreadLoadFailed(q: { isError: boolean; data: ClaudeReviewChatResponse | undefined }): boolean {
  return q.isError && q.data === undefined;
}

/**
 * The stored turn an Ask returned, written into the thread's cache. With no cached thread (the first
 * read failed) the answer SEEDS it, so the answer shows; the re-read that follows fills in any earlier
 * turns. Before this, a missing cache entry dropped the answer on the floor.
 */
export function mergeChatAnswer(
  prev: ClaudeReviewChatResponse | undefined,
  data: ClaudeReviewChatAnswer,
  reviewId: number,
  findingId: number | null,
): ClaudeReviewChatResponse {
  const earlier = (prev?.messages ?? []).filter((m) => !data.messages.some((n) => n.id === m.id));
  return {
    reviewId: prev?.reviewId ?? reviewId,
    findingId: prev?.findingId ?? findingId,
    messages: [...earlier, ...data.messages],
    headMoved: data.headMoved,
    answering: false,
  };
}

/** True while ANY mount is waiting on an answer for this review. */
export function useClaudeReviewChatBusy(reviewId: number): boolean {
  return useIsMutating({ mutationKey: claudeReviewChatAskKey(reviewId) }) > 0;
}

/** The question being answered in THIS thread right now, if any (read off the shared mutation). */
export function useClaudeReviewChatPendingQuestion(
  reviewId: number,
  findingId: number | null,
): { question: string; pins: ChatPinEntry[] } | null {
  const pending = useMutationState({
    filters: { mutationKey: claudeReviewChatAskKey(reviewId), status: 'pending' },
    select: (m) => m.state.variables as AskChatVars | undefined,
  });
  const mine = pending.find((v) => (v?.findingId ?? null) === findingId);
  return mine ? { question: mine.question, pins: mine.pinEntries ?? [] } : null;
}

/**
 * Every review run of this PR that has a chat — the panel's "Earlier reviews' chats". Fetched only
 * once that section is OPENED (`enabled`), never on mount.
 */
export function useClaudeReviewChatHistory(prId: number, enabled: boolean) {
  return useQuery<ClaudeReviewChatHistoryResponse>({
    queryKey: ['claude-review-chat-history', prId],
    queryFn: enabled ? () => api.claudeReviewChatHistory(prId) : skipToken,
    staleTime: 60_000,
  });
}

/**
 * Ask one question. ⚠ THE COMPLETED TURN IS WRITTEN INTO THE CACHE HERE, AT THE HOOK LEVEL —
 * never in a mutate() callback, which dies with its observer when the pane closes mid-answer and
 * would lose an answer that was already billed and stored.
 */
export function useAskClaudeReviewChat(reviewId: number) {
  const qc = useQueryClient();
  return useMutation<ClaudeReviewChatAnswer, Error, AskChatVars>({
    mutationKey: claudeReviewChatAskKey(reviewId),
    mutationFn: ({ question, findingId, pins }) =>
      api.askClaudeReviewChat(reviewId, {
        question,
        findingId,
        ...(pins != null && pins.length > 0 ? { pins } : {}),
      }),
    // A failed send puts its pins back (hook level, so it survives the panel closing).
    onError: (_e, variables) => {
      if (variables.prId != null && variables.pinEntries?.length) {
        useReviewChatPins.getState().restore(variables.prId, variables.pinEntries);
      }
    },
    onSuccess: (data, variables) => {
      const findingId = variables.findingId ?? null;
      const key = claudeReviewChatKey(reviewId, findingId);
      qc.setQueryData<ClaudeReviewChatResponse>(key, (prev) => mergeChatAnswer(prev, data, reviewId, findingId));
      void qc.invalidateQueries({ queryKey: key });
      if (variables.prId != null) {
        void qc.invalidateQueries({ queryKey: ['claude-review-chat-history', variables.prId] });
      }
    },
  });
}
