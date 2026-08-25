import { useEffect, useRef } from 'react';
import { skipToken, useIsMutating, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  BotWindowKind,
  MlCategory,
  MlSeverity,
  StoredSynthesis,
  SynthesisFlaggingSelect,
  SynthesisResponse,
  SynthesisScopeKind,
  VendorDisagreeDirection,
} from '@pierre-review/shared';
import { api, type SynthesisRequestParams } from '../api/client.js';
import { workspaceKey } from './useActivity.js';
import { repoKeySlot } from './useBotTriage.js';
import { useProCapabilities } from './useTriage.js';

// The synthesis verdict (plan P2.1) — the GET-backed cached read + the generate mutation, for
// every surface that mounts a SynthesisCard (P2.2's drill-downs, P2.3's Measure card).
//
// ⚠ THE QUERY KEY CARRIES THE WHOLE DESCRIPTOR, one slot per field (`ws:<id>` + `bot:<id>` per
// §8.12 — the refineQueryKey precedent): two bots' cards, or a tile card and the workspace card,
// must never share a cache entry.
//
// ⚠ THE MUTATION KEY IS SHARED PER SCOPE (the CiAnalysisCard two-mounts lesson): a paid
// generation's in-flight state must be readable from EVERY mount of the same scope via
// `useIsMutating`, or a tab switch mid-run resets the button to "Summarise" and invites a second
// BILLED POST. `synthesisKeySlots` is the one spelling of those segments — the query key, the
// mutation key and the setQueryData write all build from it, so they cannot drift.
//
// ⚠ NOTHING FETCHES WITHOUT `activityDigest` (§8.20): in OSS the route does not exist, on free
// cloud it would 402 — either way the hook goes quiet and the card renders the nudge/nothing.

export interface SynthesisDescriptor {
  kind: SynthesisScopeKind;
  window: BotWindowKind;
  /** Repo NARROWING within the workspace — send whenever the array exists, INCLUDING empty. */
  repoIds?: number[] | null;
  botUserId?: number | null;
  direction?: VendorDisagreeDirection | null;
  select?: SynthesisFlaggingSelect | null;
  severities?: MlSeverity[] | null;
  category?: MlCategory | null;
  /** The person grains only — 'person' (the 1:1 narration, plan P4.2) and 'person_report' (the
   *  People report's sections): the subject + the period's REAL epoch-ms bounds — never
   *  `botUserId` (a bot-population narrowing) and never the enum `window` (canonicalised out
   *  for the ordering/sections grains). */
  userId?: number | null;
  fromMs?: number | null;
  toMs?: number | null;
}

/** The canonical client-side key segments for one synthesis scope. Mirrors the server's
 *  canonicalisation (the 'findings' default; severities sorted) so omitted-vs-explicit spellings
 *  of one drill-down share one cache entry and ONE in-flight mutation. */
export function synthesisKeySlots(
  workspaceId: number | null,
  d: SynthesisDescriptor,
): (string | number)[] {
  const flagging = d.kind === 'bot-flagging';
  // BOTH person grains — 'person' (the 1:1 ordering narration) and 'person_report' (the People
  // report's SECTIONS narrative) — share the subject + period tail below; the `d.kind` slot at
  // the head is what keeps their cache rows (and shared mutation keys) apart, mirroring the
  // server key's `k:` slot.
  const person = d.kind === 'person' || d.kind === 'person_report';
  const select = flagging ? (d.select ?? 'findings') : null;
  // The windowless kinds mirror the server's canonicalisation: 'bot-threads' (current-state
  // backlog) and the ordering/sections grains 'brief'/'rollup'/'person'/'person_report' — the
  // first two are "now" folds (plan P3.1/P3.3) and the person grains carry REAL bounds in their
  // own slot below (P4.2); all of them take the whole workspace (no repo narrowing slot
  // variation).
  const windowless =
    d.kind === 'bot-threads' || d.kind === 'brief' || d.kind === 'rollup' || person;
  const ordering = d.kind === 'brief' || d.kind === 'rollup' || person;
  return [
    d.kind,
    windowless ? 'w:-' : `w:${d.window}`,
    workspaceKey(workspaceId),
    ordering ? 'r:-' : repoKeySlot(d.repoIds ?? null),
    d.botUserId != null && (flagging || d.kind === 'bot-volume') ? `bot:${d.botUserId}` : 'bot:-',
    `dir:${(flagging ? d.direction : null) ?? '-'}`,
    `sel:${select ?? '-'}`,
    `sev:${select === 'severity' && d.severities ? [...d.severities].sort().join(',') : '-'}`,
    `cat:${(select === 'category' ? d.category : null) ?? '-'}`,
    // The person grain's subject + period (mirrors the server key's conditional tail; constant
    // '-' slots for every other kind so existing keys keep their identity).
    `u:${(person ? d.userId : null) ?? '-'}`,
    `pw:${person && d.fromMs != null && d.toMs != null ? `${d.fromMs}-${d.toMs}` : '-'}`,
  ];
}

function requestParams(workspaceId: number, d: SynthesisDescriptor): SynthesisRequestParams {
  return {
    kind: d.kind,
    window: d.window,
    workspaceId,
    repoIds: d.repoIds ?? null,
    botUserId: d.botUserId ?? null,
    direction: d.direction ?? null,
    select: d.select ?? null,
    severities: d.severities ?? null,
    category: d.category ?? null,
    userId: d.userId ?? null,
    fromMs: d.fromMs ?? null,
    toMs: d.toMs ?? null,
  };
}

/** The cached synthesis + stale flag. Free — the server never generates on this path. */
export function useSynthesis(
  workspaceId: number | null,
  d: SynthesisDescriptor,
  enabled = true,
) {
  const { activityDigest } = useProCapabilities();
  return useQuery<SynthesisResponse>({
    queryKey: ['synthesis', ...synthesisKeySlots(workspaceId, d)],
    // `skipToken`, not a bare `enabled`: it narrows workspaceId to a number, so a request the
    // server would answer from the account's DEFAULT workspace cannot be written (§ the
    // workspaceId-null rule — nothing renders workspace-scoped data while unresolved).
    queryFn: workspaceId == null ? skipToken : () => api.synthesis(requestParams(workspaceId, d)),
    enabled: enabled && activityDigest,
    staleTime: 60_000,
  });
}

/** The generate mutation (the ONLY billing path). Shared mutation key per scope — read the
 *  in-flight state via `useSynthesisGenerating`, never a per-mount `isPending` alone. */
export function useGenerateSynthesis(workspaceId: number | null, d: SynthesisDescriptor) {
  const qc = useQueryClient();
  const slots = synthesisKeySlots(workspaceId, d);
  return useMutation({
    mutationKey: ['synthesis-generate', ...slots],
    // The mutation cannot be skipToken-gated, so it refuses outright: generating for an
    // unresolved workspace would BILL for the account's Default and cache under 'ws:pending'.
    mutationFn: () => {
      if (workspaceId == null) throw new Error('No workspace selected');
      return api.synthesisGenerate(requestParams(workspaceId, d));
    },
    onSuccess: (data) => {
      // Written under the SAME slots the read uses — a hand-spelled key here is how a
      // "Summarise" click appears to do nothing until the next refetch.
      qc.setQueryData<SynthesisResponse>(['synthesis', ...slots], data);
      // A generation may have spent credits → refresh the meter + the out-of-credits gate.
      void qc.invalidateQueries({ queryKey: ['ai-usage'] });
    },
  });
}

/** True while ANY mount of this scope is generating (the shared-mutation-key read). */
export function useSynthesisGenerating(
  workspaceId: number | null,
  d: SynthesisDescriptor,
): boolean {
  return (
    useIsMutating({ mutationKey: ['synthesis-generate', ...synthesisKeySlots(workspaceId, d)] }) >
    0
  );
}

/**
 * LAZY-ON-READ narration for the ORDERING grains ('brief'/'rollup'/'person'): the cached
 * synthesis when present, plus at most ONE auto-generation attempt per (scope identity +
 * staleness observation). Moved here from BriefStrip so the 1:1 section reuses the exact same
 * guard rather than a second spelling of it — the digest pattern, per-scope.
 *
 * The guard ref keys on the stored generatedAt: a served cache hit doesn't re-fire, while a NEW
 * staleness (the content hash moved) allows exactly one fresh attempt. Silent about failure by
 * design (§8.20) — the caller renders its templated/deterministic surface either way.
 */
export function useAutoNarration(
  workspaceId: number | null,
  d: SynthesisDescriptor,
  wanted: boolean,
): StoredSynthesis | null {
  const { activityDigest } = useProCapabilities();
  const enabled = wanted && activityDigest;
  const { data } = useSynthesis(workspaceId, d, enabled);
  const generate = useGenerateSynthesis(workspaceId, d);
  const generating = useSynthesisGenerating(workspaceId, d);
  const attemptedRef = useRef<string | null>(null);
  const needsGeneration =
    enabled && data?.enabled === true && (data.synthesis == null || data.stale === true);
  useEffect(() => {
    if (!needsGeneration || generating || workspaceId == null) return;
    // The person grain's identity varies by subject + period, so those join the attempt key —
    // switching periods (or people) allows a fresh attempt while re-renders of one never do.
    const attemptKey = `${workspaceId}|${d.kind}|${d.userId ?? '-'}|${d.fromMs ?? '-'}|${
      d.toMs ?? '-'
    }|${data?.synthesis?.generatedAt ?? '-'}`;
    if (attemptedRef.current === attemptKey) return;
    attemptedRef.current = attemptKey;
    generate.mutate();
    // `generate` is identity-stable enough for this once-per-key guard; the ref is the gate.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    needsGeneration,
    generating,
    workspaceId,
    d.kind,
    d.userId,
    d.fromMs,
    d.toMs,
    data?.synthesis?.generatedAt,
  ]);
  return data?.synthesis ?? null;
}
