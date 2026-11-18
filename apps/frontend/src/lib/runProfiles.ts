// SETTINGS → AI → Review / AI Fix / Implement story — the pure half (shared ai-run-profiles.ts holds the
// shapes; docs/CLAUDE-REVIEW.md § The run profiles). A block writes back ITS surface, concretely, and
// sends the others exactly as stored: a missing AI Fix block must stay missing (auto fix then keeps its
// review's model). While REVIEW_EFFORT decides (`effortSource: 'env'`), the resolved efforts are the
// environment's, so a write keeps the STORED effort instead of copying the env level in.
import {
  resolveAiRunProfiles,
  usualRunProfileModel,
  type AiEffort,
  type AiPickerModel,
  type AiProviderId,
  type AiRunProfiles,
  type AiRunProfilesStatus,
  type MeResponse,
} from '@pierre-review/shared';

type Effort = AiEffort | null;

function effortPart(status: AiRunProfilesStatus, resolved: Effort, stored: { effort?: Effort } | undefined): { effort?: Effort } {
  if (status.effortSource !== 'env') return { effort: resolved };
  return stored != null && 'effort' in stored ? { effort: stored.effort ?? null } : {};
}

/** The profiles with one review vendor changed (both vendors written concretely). */
export function withReviewVendor(
  status: AiRunProfilesStatus,
  provider: AiProviderId,
  patch: { enabled?: boolean; model?: AiPickerModel; effort?: Effort },
): AiRunProfiles {
  const stored = status.stored ?? {};
  const vendor = (p: AiProviderId) => {
    const r = status.review[p];
    const s = stored.review?.[p];
    const base = { enabled: r.enabled, model: r.model, ...effortPart(status, r.effort, s) };
    return p === provider ? { ...base, ...patch } : base;
  };
  return { ...stored, review: { claude: vendor('claude'), codex: vendor('codex') } };
}

/** The profiles with AI Fix's or Implement story's choice changed. A new vendor opens on its usual model. */
export function withSurfaceChoice(
  status: AiRunProfilesStatus,
  surface: 'fix' | 'build',
  patch: { provider?: AiProviderId; model?: AiPickerModel; effort?: Effort; rounds?: number },
): AiRunProfiles {
  const stored = status.stored ?? {};
  const r = status[surface];
  const provider = patch.provider ?? r.provider;
  const model = patch.model ?? (provider === r.provider ? r.model : usualRunProfileModel(surface, provider));
  const block = {
    provider,
    model,
    ...effortPart(status, r.effort, stored[surface]),
    ...(patch.effort !== undefined ? { effort: patch.effort } : {}),
    ...(surface === 'build' ? { rounds: patch.rounds ?? status.build.rounds } : {}),
  };
  return { ...stored, [surface]: block };
}

/** Is `provider` the only review vendor still on? (Its switch cannot turn off: one must stay on.) */
export function isLastReviewVendorOn(status: AiRunProfilesStatus, provider: AiProviderId): boolean {
  const other: AiProviderId = provider === 'claude' ? 'codex' : 'claude';
  return status.review[provider].enabled && !status.review[other].enabled;
}

/**
 * `/api/me` with the profiles about to be saved already in place (the OPTIMISTIC read while the PUT runs),
 * resolved by the SAME shared fold the server uses, so a control shows its new value at once instead of
 * jumping back until the answer arrives. Unchanged when `/api/me` carries no profiles.
 */
export function meWithRunProfiles(me: MeResponse | undefined, next: AiRunProfiles): MeResponse | undefined {
  if (me?.ai?.runProfiles == null) return me;
  const es = me.ai.effortSetting;
  const env = es?.source === 'env' ? es.value : null;
  const runProfiles = resolveAiRunProfiles(next, {
    legacyEffort: env == null ? (es?.value ?? null) : null,
    envEffort: env,
    defaultProvider: me.ai.provider,
  });
  return { ...me, ai: { ...me.ai, runProfiles } };
}
