import {
  keepPreviousData,
  skipToken,
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
import { workspaceKey } from './useActivity.js';

// Chat history page size (matches the server default). One shared const so the hook, the
// pagination math, and the panel's "N per page" copy can't drift.
export const CHAT_HISTORY_PAGE_SIZE = 10;

// The ad-hoc "Ask about the workspace" chat (Pro Haiku). A free-text question is answered from the
// current snapshot; the mutation returns the grounded Markdown answer + resolved PR refs + an
// optional chart spec. A generation may spend credits → invalidate the AI-usage meter; every
// answer is persisted server-side, so also refresh the chat history so the new Q&A appears.
//
// ⚠ THE HOOK STAMPS THE SCOPE, THE CALLER CANNOT. `SprintChatBody.scope` is an OPTIONAL string and
// an absent one silently grounds the answer in the account's DEFAULT workspace — a wrong answer
// that looks entirely plausible. Taking the workspace as a parameter and omitting `scope` from the
// mutation variable makes forgetting it impossible. The wire value is the workspace id as a
// string; the plugin parses it and persists `ws:<id>` as the cache `scope_key`.
export function useSprintChat(workspaceId: number | null) {
  const qc = useQueryClient();
  return useMutation<SprintChatResponse, Error, Omit<SprintChatBody, 'scope'>>({
    mutationFn: (body) =>
      api.sprintChat({
        ...body,
        ...(workspaceId != null ? { scope: String(workspaceId) } : {}),
      }),
    onSuccess: () => {
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
  return useQuery<User[]>({
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
