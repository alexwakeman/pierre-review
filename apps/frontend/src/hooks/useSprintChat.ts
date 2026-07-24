import {
  keepPreviousData,
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
import type {
  CreatePinnedPromptBody,
  PinnedPromptsResponse,
  SprintChatBody,
  SprintChatHistoryResponse,
  SprintChatResponse,
  User,
} from '@pierre-review/shared';
import { api } from '../api/client.js';

// Chat history page size (matches the server default). One shared const so the hook, the
// pagination math, and the panel's "N per page" copy can't drift.
export const CHAT_HISTORY_PAGE_SIZE = 10;

// The ad-hoc "Ask about the sprint" chat (Pro Haiku). A free-text question is answered from the
// current sprint snapshot; the mutation returns the grounded Markdown answer + resolved PR refs +
// an optional chart spec. A generation may spend credits → invalidate the AI-usage meter; every
// answer is now persisted server-side, so also refresh the chat history so the new Q&A appears.
export function useSprintChat() {
  const qc = useQueryClient();
  return useMutation<SprintChatResponse, Error, SprintChatBody>({
    mutationFn: (body: SprintChatBody) => api.sprintChat(body),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['ai-usage'] });
      void qc.invalidateQueries({ queryKey: ['sprint-chat-history'] });
    },
  });
}

// The account's paginated chat history for the CURRENT scope (newest-first; stored answers are
// free to re-open — no AI). `page` is 0-based; `scope` keys it to the active team context so the
// panel shows only that context's questions. keepPreviousData holds the current page visible while
// the next one loads so paging doesn't flash empty. Gated on the AI capability (`enabled`).
export function useSprintChatHistory(page: number, scope: string | undefined, enabled: boolean) {
  return useQuery<SprintChatHistoryResponse>({
    queryKey: ['sprint-chat-history', scope ?? 'all', page],
    queryFn: () =>
      api.sprintChatHistory(CHAT_HISTORY_PAGE_SIZE, page * CHAT_HISTORY_PAGE_SIZE, scope),
    enabled,
    staleTime: 30_000,
    placeholderData: keepPreviousData,
  });
}

// @mention candidates for the whole scope (team / listed repos) — the ad-hoc box's roster. Only
// fetched when the AI capability is on (`enabled`); scoped per team scope.
export function useScopeMentionCandidates(scope: string | undefined, enabled: boolean) {
  return useQuery<User[]>({
    queryKey: ['scope-mention-candidates', scope ?? 'all'],
    queryFn: () => api.scopeMentionCandidates(scope),
    enabled,
    staleTime: 300_000,
  });
}

// The account's saved (pinned) prompts for a scope. Server-stored (cross-device); free retrieval.
export function usePinnedPrompts(scope: string | undefined, enabled: boolean) {
  return useQuery<PinnedPromptsResponse>({
    queryKey: ['pinned-prompts', scope ?? 'all'],
    queryFn: () => api.pinnedPrompts(scope),
    enabled,
    staleTime: 60_000,
  });
}

export function useCreatePinnedPrompt(scope?: string) {
  const qc = useQueryClient();
  return useMutation<unknown, Error, CreatePinnedPromptBody>({
    mutationFn: (body: CreatePinnedPromptBody) => api.createPinnedPrompt({ ...body, scope }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['pinned-prompts', scope ?? 'all'] });
    },
  });
}

export function useDeletePinnedPrompt(scope?: string) {
  const qc = useQueryClient();
  return useMutation<void, Error, number>({
    mutationFn: (id: number) => api.deletePinnedPrompt(id),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['pinned-prompts', scope ?? 'all'] });
    },
  });
}
