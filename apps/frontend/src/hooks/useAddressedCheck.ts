import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { AddressedCheckResponse, AddressedTargetKind } from '@pierre-review/shared';
import { api } from '../api/client.js';

// "Was this TRULY addressed?" check (Pro; reuses the prSummary capability). A retained Haiku verdict
// + 0-100 confidence for one review thread or PR-level comment. The GET is a cache read (retained
// after generation); the run mutation is the billing path. `enabled` gates on the prSummary
// capability + a real id. staleTime Infinity: the stored check only changes on a re-run.
export function addressedCheckKey(kind: AddressedTargetKind, id: number | null): unknown[] {
  return ['addressed-check', kind, id];
}

export function useAddressedCheck(
  kind: AddressedTargetKind,
  id: number | null,
  enabled: boolean,
) {
  return useQuery<AddressedCheckResponse>({
    queryKey: addressedCheckKey(kind, id),
    queryFn: () =>
      kind === 'thread'
        ? api.threadAddressed(id as number)
        : api.prCommentAddressed(id as number),
    enabled: id != null && enabled,
    staleTime: Infinity,
  });
}

export function useRunAddressedCheck(kind: AddressedTargetKind, id: number) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () =>
      kind === 'thread' ? api.checkThreadAddressed(id) : api.checkPrCommentAddressed(id),
    onSuccess: (data) => {
      qc.setQueryData(addressedCheckKey(kind, id), data);
      // This route now writes the SAME row the annotations platform serves (kind='addressed'),
      // so the PR-wide annotations cache must not keep the old copy.
      void qc.invalidateQueries({ queryKey: ['pr-annotations'] });
    },
  });
}
