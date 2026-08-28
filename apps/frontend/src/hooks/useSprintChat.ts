import {
  keepPreviousData,
  skipToken,
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
import {
  SPRINT_CHAT_MAX_TURNS,
  type CreatePinnedPromptBody,
  type MentionCandidate,
  type PinnedPromptsResponse,
  type SprintChatBody,
  type SprintChatHistoryResponse,
  type SprintChatHistoryTurn,
  type SprintChatResponse,
} from '@pierre-review/shared';
import { api } from '../api/client.js';
import { useFilters, type SprintChatTurn } from '../store/filters.js';
import { workspaceKey } from './useActivity.js';

// Chat history page size (matches the server default). One shared const so the hook, the
// pagination math, and the panel's "N per page" copy can't drift.
export const CHAT_HISTORY_PAGE_SIZE = 10;

// Wire mapping for a continued conversation: the newest ≤ SPRINT_CHAT_MAX_TURNS − 1 completed
// pairs, oldest→newest, strings only (grounding is rebuilt fresh every turn — the transcript is
// what carries forward, never stale data). A turn whose response holds no answer is dropped
// rather than sent as "" — the panel never appends one, but the mapping stays total. The client
// cap here matches the server's own re-cap (`CHAT_MAX_PRIOR_TURNS`), so nothing sent is silently
// discarded on depth alone; the token BUDGET can still trim, which the response discloses via
// `trimmedTurns`.
export function threadToWireHistory(turns: SprintChatTurn[]): SprintChatHistoryTurn[] {
  return turns
    .flatMap((t) =>
      t.response.answer != null ? [{ question: t.question, answer: t.response.answer }] : [],
    )
    .slice(-(SPRINT_CHAT_MAX_TURNS - 1));
}

// The ad-hoc "Ask about the workspace" chat (Pro — answered by the account's configured report
// model). A free-text question is answered from the current snapshot; the mutation returns the
// grounded Markdown answer + resolved PR refs + an optional chart spec. A generation may spend
// credits → invalidate the AI-usage meter; every answer is persisted server-side, so also refresh
// the chat history so the new Q&A appears.
//
// ⚠ THE HOOK STAMPS THE SCOPE, THE WINDOW **AND THE HISTORY**, THE CALLER CANNOT. All are OPTIONAL
// fields whose absence produces a confident, plausible, WRONG answer: no `scope` silently grounds
// it in the account's DEFAULT workspace, no window silently answers over the account's configured
// window while the surface says otherwise, and no `history` silently answers a follow-up ("what
// about the second one?") with no idea what came before. Omitting them from the mutation variable
// makes forgetting any of them impossible. The scope wire value is the workspace id as a string
// (the plugin persists `ws:<id>` as the cache `scope_key`).
//
// The window has ONE form: `periodWindow`, the explicit `[fromMs, toMs)` bounds of the report
// being viewed, sent as `window`. There used to be a second — a FilterBar "Range" chip strip —
// but the ONE mount of this chat lives inside the period report and always passes a window, so
// the chips could never reach the wire. They are gone; `SprintChatBody.range` remains on the wire
// and the plugin route still accepts it.
//
// The history is read from the store AT CALL TIME (`getState()`, not a subscription) — the live
// thread for the SAME workspace key the panel renders, so a turn appended between render and
// click is still sent, and an empty thread omits the field entirely.
//
// ⚠ THE COMPLETED TURN IS APPENDED HERE, AT THE HOOK LEVEL — NEVER IN A mutate() CALLBACK.
// Mutate-scoped callbacks die with the observer: `MutationObserver.reset()` (the panel fires it
// on a workspace switch / history pick / New conversation) and the panel unmounting mid-flight
// (clicking a PR ref) both `removeObserver` the pending mutation, after which the mutate-level
// onSuccess never runs — the billed, server-persisted answer would silently miss the live
// transcript, and the NEXT ask would send a history missing that turn, so a follow-up like "why
// is that?" resolves against the wrong previous answer. Hook-level callbacks run from
// Mutation.execute regardless of observers. The scope is captured as onMutate CONTEXT because
// the options closure is NOT ask-stable: while the mutation is pending, every re-render
// setOptions-swaps it, so by completion `workspaceId` here can already be another workspace's.
export function useSprintChat(
  workspaceId: number | null,
  periodWindow?: { fromMs: number; toMs: number } | null,
) {
  const qc = useQueryClient();
  return useMutation<
    SprintChatResponse,
    Error,
    Omit<SprintChatBody, 'scope' | 'range' | 'window' | 'history'>,
    { scopeKey: string }
  >({
    mutationFn: (body) => {
      const thread =
        useFilters.getState().sprintChatThreads[workspaceKey(workspaceId)] ?? [];
      const history = threadToWireHistory(thread);
      return api.sprintChat({
        ...body,
        ...(history.length > 0 ? { history } : {}),
        ...(workspaceId != null ? { scope: String(workspaceId) } : {}),
        // ⚠ THE ONLY MOUNT ALWAYS PASSES A WINDOW. The chat lives inside the period report and
        // is grounded in the VIEWED period's exact `[fromMs, toMs)`. The `range` fallback that
        // used to sit here fed off a FilterBar "Range" chip strip that this precedence made
        // unreachable — four no-op chips shipped to every user — so both are gone.
        // `SprintChatBody.range` stays on the wire and the plugin route still accepts it.
        ...(periodWindow != null
          ? { window: { fromMs: periodWindow.fromMs, toMs: periodWindow.toMs } }
          : {}),
      });
    },
    // Runs at ask time, before the options closure can be swapped — the context pins the
    // workspace the question was grounded in.
    onMutate: () => ({ scopeKey: workspaceKey(workspaceId) }),
    onSuccess: (data, variables, context) => {
      // Only a response carrying a real answer becomes a transcript turn — a throttled /
      // out-of-credits shape renders its notice outside the transcript (off the mutation's own
      // data) and must not occupy one of the SPRINT_CHAT_MAX_TURNS slots. Appended under the
      // ask-time workspace key, so a workspace switch mid-flight lands the turn in the
      // workspace it was asked in. The store outlives the panel, so an unmount mid-flight
      // loses nothing.
      if (data.answer != null && context != null) {
        useFilters.getState().appendSprintChatTurn(context.scopeKey, {
          question: variables.question,
          response: data,
        });
        // Chat composers clear on send-success: the question is already rendered as the turn's
        // own row, and a retained box reads as "not yet sent" — one stray Cmd+Enter away from
        // re-billing the identical ask. Guarded so text typed toward the NEXT question during
        // the wait survives; retained on error/throttle on purpose (it aids retry).
        const draft = useFilters.getState().sprintChatDraft;
        if (draft.question.trim() === variables.question) {
          useFilters.getState().setSprintChatDraft({ question: '' });
        }
      }
      void qc.invalidateQueries({ queryKey: ['ai-usage'] });
      // A PREFIX: the history is keyed by workspace AND page, and a new answer shifts every page.
      void qc.invalidateQueries({ queryKey: ['sprint-chat-history'] });
    },
  });
}

// The account's paginated chat history for the CURRENT workspace (newest-first; stored answers are
// free to re-open — no AI). `page` is 0-based; the workspace keys it so the panel shows only that
// workspace's questions — the server stores each answer under the `ws:<id>` scope key, so a
// mismatched client key would render another workspace's transcript. keepPreviousData holds the
// current page visible while the next one loads so paging doesn't flash empty. Gated on the AI
// capability (`enabled`).
export function useSprintChatHistory(
  page: number,
  workspaceId: number | null,
  enabled: boolean,
) {
  return useQuery<SprintChatHistoryResponse>({
    queryKey: ['sprint-chat-history', workspaceKey(workspaceId), page],
    queryFn:
      workspaceId == null
        ? skipToken
        : () =>
            api.sprintChatHistory(
              CHAT_HISTORY_PAGE_SIZE,
              page * CHAT_HISTORY_PAGE_SIZE,
              workspaceId,
            ),
    enabled,
    staleTime: 30_000,
    placeholderData: keepPreviousData,
  });
}

// @mention candidates for the whole WORKSPACE — the ad-hoc box's roster. Only fetched when the AI
// capability is on (`enabled`). The server resolves the workspace to its repos, so a caller cannot
// widen it and an empty workspace yields no candidates.
export function useScopeMentionCandidates(workspaceId: number | null, enabled: boolean) {
  return useQuery<MentionCandidate[]>({
    queryKey: ['scope-mention-candidates', workspaceKey(workspaceId)],
    queryFn: workspaceId == null ? skipToken : () => api.scopeMentionCandidates(workspaceId),
    enabled,
    staleTime: 300_000,
  });
}

// The account's saved (pinned) prompts for a workspace. Server-stored (cross-device); free
// retrieval. Stored under the same `ws:<id>` scope key the chat history uses.
export function usePinnedPrompts(workspaceId: number | null, enabled: boolean) {
  return useQuery<PinnedPromptsResponse>({
    queryKey: ['pinned-prompts', workspaceKey(workspaceId)],
    queryFn: workspaceId == null ? skipToken : () => api.pinnedPrompts(workspaceId),
    enabled,
    staleTime: 60_000,
  });
}

// Pin a prompt to the ACTIVE workspace. Same rule as useSprintChat: the hook stamps `scope`, so a
// caller cannot pin a prompt into the Default workspace by omission.
export function useCreatePinnedPrompt(workspaceId: number | null) {
  const qc = useQueryClient();
  return useMutation<unknown, Error, Omit<CreatePinnedPromptBody, 'scope'>>({
    mutationFn: (body) =>
      api.createPinnedPrompt({
        ...body,
        ...(workspaceId != null ? { scope: String(workspaceId) } : {}),
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['pinned-prompts', workspaceKey(workspaceId)] });
    },
  });
}

export function useDeletePinnedPrompt(workspaceId: number | null) {
  const qc = useQueryClient();
  return useMutation<void, Error, number>({
    mutationFn: (id: number) => api.deletePinnedPrompt(id),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['pinned-prompts', workspaceKey(workspaceId)] });
    },
  });
}
