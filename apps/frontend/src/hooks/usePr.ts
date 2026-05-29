import { useQuery } from '@tanstack/react-query';
import type { PrDetail, ThreadDetail } from '@gh-team-monitor/shared';
import { api } from '../api/client.js';

export function usePr(id: number | null) {
  return useQuery<PrDetail>({
    queryKey: ['pr', id],
    queryFn: () => api.pr(id as number),
    enabled: id != null,
  });
}

export function useThread(id: number | null) {
  return useQuery<ThreadDetail>({
    queryKey: ['thread', id],
    queryFn: () => api.thread(id as number),
    enabled: id != null,
  });
}
