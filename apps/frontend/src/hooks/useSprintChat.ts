import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  CreatePinnedPromptBody,
  PinnedPromptsResponse,
  SprintChatBody,
  SprintChatResponse,
  User,
} from '@pierre-review/shared';
import { api } from '../api/client.js';

// The ad-hoc "Ask about the sprint" chat (Pro Haiku). A free-text question is answered from the
// current sprint snapshot; the mutation returns the grounded Markdown answer + resolved PR refs +
// an optional chart spec. Ephemeral — no cache; the panel holds the last answer in component
// state. A generation may spend credits → invalidate the AI-usage meter.
export function useSprintChat() {
  const qc = useQueryClient();
  return useMutation<SprintChatResponse, Error, SprintChatBody>({
    mutationFn: (body: SprintChatBody) => api.sprintChat(body),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['ai-usage'] });
    },
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
