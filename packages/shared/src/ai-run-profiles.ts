// THE AI RUN PROFILES (Settings → AI; docs/CLAUDE-REVIEW.md § The run profiles) — which vendor, model and
// effort each AI surface runs on, ONE stored object per machine (`accounts.ai_run_profiles`, migration
// 0206). Three surfaces:
//   • REVIEW — per vendor {enabled, model, effort}: every review kind (the PR review and its follow-ups,
//     the CI review, the story check, Check threads, the replies pass, the Build loop's review rounds).
//     Both vendors switched on and signed in = the Claude + Codex pair; each half runs at ITS model and
//     effort. At least one vendor stays on.
//   • FIX — ONE {provider, model, effort}: AI Fix and Plan first, manual and automatic.
//   • BUILD — ONE {provider, model, effort} + the review loop's ROUNDS: Implement story's plan and build.
//
// EVERY FIELD IS OPTIONAL and a missing one means "as before": the effort falls back to the old single
// level (`accounts.ai_effort`), the provider to the default provider (Settings → AI), the model to the
// surface's usual depth. So an install that never opens these blocks runs exactly as it did.
// `effort: null` (stored) is DEFAULT: the provider's own depth. REVIEW_EFFORT, when set, wins over every
// effort here (the controls lock). The backend resolver is apps/backend/src/ai/run-profile.ts; this file
// holds the shapes, the validator and the pure fold both sides share.
import { aiPickerModelFor, aiPickerModelProvider, type AiPickerModel } from './ai-run-label.js';
import { isAiEffort, type AiEffort } from './ai-effort.js';
import { STORY_BUILD_LOOP_ROUNDS_DEFAULT, STORY_BUILD_LOOP_ROUNDS_MAX, STORY_BUILD_LOOP_ROUNDS_MIN } from './story-build-loop.js';
import { DEFAULT_AI_FIX_MODEL, DEFAULT_CLAUDE_REVIEW_MODEL, type AiProviderId } from './types.js';

/** The three surfaces a profile decides. */
export type AiRunSurface = 'review' | 'fix' | 'build';

/** The review vendors, in pair order (Claude first). */
export const AI_REVIEW_VENDORS: readonly AiProviderId[] = ['claude', 'codex'];

/** One review vendor's stored choice. Missing ⇒ on, the usual model, the old effort level. */
export interface AiReviewVendorProfile {
  enabled?: boolean;
  model?: AiPickerModel;
  effort?: AiEffort | null;
}

/** AI Fix's or Implement story's stored choice. Missing provider ⇒ the default provider. */
export interface AiRunChoiceProfile {
  provider?: AiProviderId;
  model?: AiPickerModel;
  effort?: AiEffort | null;
}

/** Implement story's: the choice + the review loop's rounds (MIN..MAX; missing ⇒ the default). */
export interface AiBuildProfile extends AiRunChoiceProfile {
  rounds?: number;
}

/** THE STORED OBJECT (`accounts.ai_run_profiles`, PUT /api/ai/run-profiles). */
export interface AiRunProfiles {
  review?: { claude?: AiReviewVendorProfile; codex?: AiReviewVendorProfile };
  fix?: AiRunChoiceProfile;
  build?: AiBuildProfile;
}

/** A resolved review vendor (every field filled). `effort: null` ⇒ Default. */
export interface AiReviewVendorResolved {
  enabled: boolean;
  model: AiPickerModel;
  effort: AiEffort | null;
}

/** A resolved AI Fix / Implement choice. */
export interface AiRunChoiceResolved {
  provider: AiProviderId;
  model: AiPickerModel;
  effort: AiEffort | null;
}

/**
 * `MeResponse.ai.runProfiles` — every surface resolved (what Settings → AI shows and the run menus open
 * on), plus who decides the effort (`effortSource: 'env'` ⇒ REVIEW_EFFORT wins and locks every effort;
 * the resolved efforts then name its level).
 */
export interface AiRunProfilesStatus {
  review: { claude: AiReviewVendorResolved; codex: AiReviewVendorResolved };
  fix: AiRunChoiceResolved;
  build: AiRunChoiceResolved & { rounds: number };
  effortSource: 'env' | 'settings';
  /** What is stored (null = nothing): a Settings block writes back ITS surface only, so the others stay
   *  as stored (a missing AI Fix block keeps auto fix inheriting its review's model). */
  stored: AiRunProfiles | null;
}

/** PUT /api/ai/run-profiles body: the WHOLE object (it replaces the stored one). */
export interface AiRunProfilesBody {
  profiles: AiRunProfiles;
}

/** PUT /api/ai/run-profiles → the profiles as now resolved. */
export interface AiRunProfilesResponse {
  runProfiles: AiRunProfilesStatus;
}

/** The usual model of a surface on a provider (what a missing `model` means). */
export function usualRunProfileModel(surface: AiRunSurface, provider: AiProviderId): AiPickerModel {
  return aiPickerModelFor(provider, surface === 'fix' ? DEFAULT_AI_FIX_MODEL : DEFAULT_CLAUDE_REVIEW_MODEL);
}

const modelOn = (model: unknown, provider: AiProviderId): AiPickerModel | null =>
  aiPickerModelProvider(model) === provider ? (model as AiPickerModel) : null;

/** A stored rounds number, or the default (missing, or out of range). */
export function profileLoopRounds(stored: AiRunProfiles | null | undefined): number {
  const n = stored?.build?.rounds;
  return typeof n === 'number' && Number.isInteger(n) && n >= STORY_BUILD_LOOP_ROUNDS_MIN && n <= STORY_BUILD_LOOP_ROUNDS_MAX
    ? n
    : STORY_BUILD_LOOP_ROUNDS_DEFAULT;
}

/** A stored effort field: `undefined` (missing ⇒ the old level), null (Default) or a level. */
function effortField(block: { effort?: unknown } | undefined): AiEffort | null | undefined {
  if (block == null || !('effort' in block)) return undefined;
  return isAiEffort(block.effort) ? block.effort : null;
}

/**
 * THE STORED EFFORT a surface sends on `provider`, BEFORE the environment: a level, null (Default), or
 * `undefined` — no profile says, so the old single level (`accounts.ai_effort`) applies.
 *   • review: that vendor's own effort.
 *   • fix / build: the block's effort when the run's provider IS the block's provider (missing ⇒ the
 *     default provider); a run on the OTHER provider (a fallback, or a menu pick of it) runs at that
 *     provider's Default. No block ⇒ undefined (the old level, either provider). Pure.
 */
export function profileEffortFor(
  stored: AiRunProfiles | null | undefined,
  surface: AiRunSurface,
  provider: AiProviderId,
  defaultProvider: AiProviderId,
): AiEffort | null | undefined {
  if (surface === 'review') return effortField(stored?.review?.[provider]);
  const block = stored?.[surface];
  if (block == null) return undefined;
  if ((block.provider ?? defaultProvider) !== provider) return null;
  return effortField(block);
}

/** Is a review vendor switched on? Missing ⇒ on. Pure. */
export function reviewVendorEnabled(stored: AiRunProfiles | null | undefined, provider: AiProviderId): boolean {
  return stored?.review?.[provider]?.enabled !== false;
}

/**
 * EVERY SURFACE RESOLVED (`MeResponse.ai.runProfiles`): `legacyEffort` is the old level (the env's when
 * REVIEW_EFFORT is set — then it IS every effort), `defaultProvider` the default provider now. Pure.
 */
export function resolveAiRunProfiles(
  stored: AiRunProfiles | null | undefined,
  o: { legacyEffort: AiEffort | null; envEffort: AiEffort | null; defaultProvider: AiProviderId },
): AiRunProfilesStatus {
  const effortOf = (surface: AiRunSurface, provider: AiProviderId): AiEffort | null => {
    if (o.envEffort != null) return o.envEffort;
    const e = profileEffortFor(stored, surface, provider, o.defaultProvider);
    return e === undefined ? o.legacyEffort : e;
  };
  const vendor = (p: AiProviderId): AiReviewVendorResolved => ({
    enabled: reviewVendorEnabled(stored, p),
    model: modelOn(stored?.review?.[p]?.model, p) ?? usualRunProfileModel('review', p),
    effort: effortOf('review', p),
  });
  const choice = (surface: 'fix' | 'build'): AiRunChoiceResolved => {
    const block = stored?.[surface];
    const provider = block?.provider ?? o.defaultProvider;
    return {
      provider,
      model: modelOn(block?.model, provider) ?? usualRunProfileModel(surface, provider),
      effort: effortOf(surface, provider),
    };
  };
  return {
    review: { claude: vendor('claude'), codex: vendor('codex') },
    fix: choice('fix'),
    build: { ...choice('build'), rounds: profileLoopRounds(stored) },
    effortSource: o.envEffort != null ? 'env' : 'settings',
    stored: stored ?? null,
  };
}

export type ParsedAiRunProfiles = { ok: true; value: AiRunProfiles } | { ok: false; message: string };

/**
 * THE VALIDATOR (PUT /api/ai/run-profiles; also the boot's read, which drops a bad stored value): only
 * known fields, a model of the vendor it is set for, a known effort or null, rounds in range, and at
 * least one review vendor left on. Compacts: empty blocks are dropped. Pure.
 */
export function parseAiRunProfiles(raw: unknown): ParsedAiRunProfiles {
  const bad = (message: string): ParsedAiRunProfiles => ({ ok: false, message });
  if (raw == null || typeof raw !== 'object' || Array.isArray(raw)) return bad('profiles must be an object.');
  const r = raw as Record<string, unknown>;
  for (const k of Object.keys(r)) if (k !== 'review' && k !== 'fix' && k !== 'build') return bad(`Unknown field: ${k}.`);
  const out: AiRunProfiles = {};
  const effortOf = (b: Record<string, unknown>, where: string): { ok: true; v?: AiEffort | null } | { ok: false; message: string } => {
    if (!('effort' in b)) return { ok: true };
    if (b.effort === null || isAiEffort(b.effort)) return { ok: true, v: b.effort as AiEffort | null };
    return { ok: false, message: `${where}: effort must be low, medium, high, xhigh, max or null.` };
  };
  const isObj = (v: unknown): v is Record<string, unknown> => v != null && typeof v === 'object' && !Array.isArray(v);

  if (r.review !== undefined) {
    if (!isObj(r.review)) return bad('review must be an object.');
    const review: NonNullable<AiRunProfiles['review']> = {};
    for (const k of Object.keys(r.review)) if (k !== 'claude' && k !== 'codex') return bad(`Unknown review vendor: ${k}.`);
    for (const p of AI_REVIEW_VENDORS) {
      const b = r.review[p];
      if (b === undefined) continue;
      if (!isObj(b)) return bad(`review.${p} must be an object.`);
      for (const k of Object.keys(b)) if (k !== 'enabled' && k !== 'model' && k !== 'effort') return bad(`Unknown field: review.${p}.${k}.`);
      const v: AiReviewVendorProfile = {};
      if ('enabled' in b) {
        if (typeof b.enabled !== 'boolean') return bad(`review.${p}.enabled must be true or false.`);
        v.enabled = b.enabled;
      }
      if ('model' in b) {
        const m = modelOn(b.model, p);
        if (m == null) return bad(`review.${p}.model is not one of its models.`);
        v.model = m;
      }
      const e = effortOf(b, `review.${p}`);
      if (!e.ok) return bad(e.message);
      if ('v' in e) v.effort = e.v ?? null;
      if (Object.keys(v).length > 0) review[p] = v;
    }
    if (Object.keys(review).length > 0) out.review = review;
  }
  if (!AI_REVIEW_VENDORS.some((p) => reviewVendorEnabled(out, p))) return bad('Keep at least one review vendor on.');

  for (const surface of ['fix', 'build'] as const) {
    const b = r[surface];
    if (b === undefined) continue;
    if (!isObj(b)) return bad(`${surface} must be an object.`);
    const allowed = surface === 'build' ? ['provider', 'model', 'effort', 'rounds'] : ['provider', 'model', 'effort'];
    for (const k of Object.keys(b)) if (!allowed.includes(k)) return bad(`Unknown field: ${surface}.${k}.`);
    const v: AiBuildProfile = {};
    if ('provider' in b) {
      if (b.provider !== 'claude' && b.provider !== 'codex') return bad(`${surface}.provider must be claude or codex.`);
      v.provider = b.provider;
    }
    if ('model' in b) {
      if (v.provider == null) return bad(`${surface}.model needs a provider.`);
      const m = modelOn(b.model, v.provider);
      if (m == null) return bad(`${surface}.model is not one of its provider's models.`);
      v.model = m;
    }
    const e = effortOf(b, surface);
    if (!e.ok) return bad(e.message);
    if ('v' in e) v.effort = e.v ?? null;
    if (surface === 'build' && 'rounds' in b) {
      const n = b.rounds;
      if (typeof n !== 'number' || !Number.isInteger(n) || n < STORY_BUILD_LOOP_ROUNDS_MIN || n > STORY_BUILD_LOOP_ROUNDS_MAX) {
        return bad(`build.rounds must be a whole number from ${STORY_BUILD_LOOP_ROUNDS_MIN} to ${STORY_BUILD_LOOP_ROUNDS_MAX}.`);
      }
      v.rounds = n;
    }
    if (Object.keys(v).length > 0) out[surface] = v;
  }
  return { ok: true, value: out };
}
