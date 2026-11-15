import { skipToken, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';
import type { StoryChatDetailResponse, StoryChatListResponse } from '@pierre-review/shared';
import { api } from '../api/client.js';
import { workspaceKey } from './useActivity.js';

// STORY CHAT (docs/STORY-CHAT.md). The story's saved chats + its live agent, and one chat's turns.
// Both poll quickly only while something moves (preparing, answering), else slowly.

const FAST_MS = 1_500;
/** The keep-alive while the panel is open and the tab visible: well inside the 10-minute idle close. */
export const STORY_CHAT_KEEPALIVE_MS = 3 * 60_000;

export function useStoryChats(workspaceId: number | null, ident: string | null, enabled: boolean) {
  return useQuery<StoryChatListResponse>({
    queryKey: ['story-chats', workspaceKey(workspaceId), ident],
    queryFn: workspaceId == null || ident == null || !enabled ? skipToken : () => api.storyChats(workspaceId, ident),
    refetchInterval: (q) => {
      const s = q.state.data?.live.state;
      return s === 'preparing' || s === 'answering' ? FAST_MS : 30_000;
    },
    refetchIntervalInBackground: false,
  });
}

export function useStoryChat(chatId: number | null) {
  return useQuery<StoryChatDetailResponse>({
    queryKey: ['story-chat', chatId],
    queryFn: chatId == null ? skipToken : () => api.storyChat(chatId),
    refetchInterval: (q) => {
      const d = q.state.data;
      const moving = d != null && (d.live.state === 'answering' || d.turns.some((t) => t.status === 'running'));
      return moving ? FAST_MS : false;
    },
    refetchIntervalInBackground: false,
  });
}

/**
 * Keep the story's agent ready while `enabled`: prepare at once, then every few minutes while the tab
 * is visible. Closing the panel stops the keep-alive; the server closes the agent after the idle time.
 */
export function useStoryChatKeepAlive(workspaceId: number | null, ident: string | null, chatId: number | null, enabled: boolean): void {
  const qc = useQueryClient();
  useEffect(() => {
    if (!enabled || workspaceId == null || ident == null) return;
    let stopped = false;
    const ping = (): void => {
      if (stopped || document.visibilityState !== 'visible') return;
      void api
        .storyChatPrepare({ workspaceId, ident, chatId })
        .then(() => qc.invalidateQueries({ queryKey: ['story-chats', workspaceKey(workspaceId), ident] }))
        .catch(() => {});
    };
    ping();
    const t = window.setInterval(ping, STORY_CHAT_KEEPALIVE_MS);
    const onVisible = (): void => {
      if (document.visibilityState === 'visible') ping();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      stopped = true;
      window.clearInterval(t);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [enabled, workspaceId, ident, chatId, qc]);
}

export function useStoryChatAsk(workspaceId: number | null, ident: string | null) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (a: { chatId: number | null; question: string }) =>
      api.storyChatAsk({ workspaceId: workspaceId!, ident: ident!, chatId: a.chatId, question: a.question }),
    onSuccess: (res) => {
      void qc.invalidateQueries({ queryKey: ['story-chats', workspaceKey(workspaceId), ident] });
      void qc.invalidateQueries({ queryKey: ['story-chat', res.chatId] });
    },
  });
}

export function useStoryChatStop() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (chatId: number) => api.storyChatStop(chatId),
    onSuccess: (_r, chatId) => void qc.invalidateQueries({ queryKey: ['story-chat', chatId] }),
  });
}

export function useStoryChatDelete(workspaceId: number | null, ident: string | null) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (chatId: number) => api.storyChatDelete(chatId),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['story-chats', workspaceKey(workspaceId), ident] }),
  });
}
