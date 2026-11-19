// THE RUN PROFILES' ONE RESOLVER (Settings → AI; shared ai-run-profiles.ts holds the shapes, the
// validator and the pure fold; docs/CLAUDE-REVIEW.md § The run profiles). EVERY surface asks here which
// vendor, model and effort it runs on — no surface keeps its own provider or effort rule:
//   • REVIEW — `reviewProfileFor(p)`, `reviewProvidersEnabled()`, `reviewPairProviders(detect)` (THE pair
//     resolver: switched on AND signed in, used by the manual pair, auto review and the Build loop) and
//     `reviewDefaultProvider(detect)` ("one vendor": the first switched-on, signed-in one with capacity).
//   • FIX — `fixChoice(detect)` (AI Fix, Plan first, auto fix) and `fixLoopRounds()` (its own review loop).
//   • BUILD — `buildChoice(detect)` (story_plan, story_build) and `buildLoopRounds()`.
//   • EFFORT — ai/effort.ts `agenticRunEffort(…, surface)` reads `profileEffortLevel` below.
//
// The stored object (`accounts.ai_run_profiles`) is held HERE in memory (ai/provider-store.ts loads and
// writes it), so a change reaches the next run with no restart. No DB import, like ai/effort.ts.
//
// NULL = TODAY, EXACTLY: no review block ⇒ "one vendor" is the default provider (Settings → AI); no fix /
// build block ⇒ the default provider, the surface's usual model (auto fix keeps inheriting its review's),
// the old single effort level. Only a stored choice turns on the FALLBACK: a configured vendor that is not
// signed in or is over its usage limit at run start ⇒ the other signed-in vendor at ITS usual model and
// Default effort; the run row stores what ran.
import {
  AI_REVIEW_VENDORS,
  aiPickerModelProvider,
  aiPickerRequestModel,
  profileEffortFor,
  profileFixLoopRounds,
  profileLoopRounds,
  reviewVendorEnabled,
  usualRunProfileModel,
  type AiEffort,
  type AiPickerModel,
  type AiProviderId,
  type AiRunKind,
  type AiRunProfiles,
  type AiRunSurface,
  type ClaudeReviewModel,
} from '@pierre-review/shared';
import { activeProviderId } from './provider-setting.js';
import { isLockedOut } from './usage-lockout.js';

/** A per-provider pre-flight (ai/run-choice.ts `preflightFor`). */
export type ProfilePreflight = (provider: AiProviderId, kind: AiRunKind) => { status: 'ok' | 'none'; message?: string };

let stored: AiRunProfiles | null = null;

/** The stored profiles (Settings → AI), or null when none are stored. Memory only. */
export function storedAiRunProfiles(): AiRunProfiles | null {
  return stored;
}

/** Hold the stored profiles in memory (the boot's load, the route's write, tests). null ⇒ none. */
export function setStoredAiRunProfiles(value: AiRunProfiles | null): void {
  stored = value;
}

/**
 * The STORED effort of a surface on `provider` (before REVIEW_EFFORT): a level, null (Default) or
 * `undefined` — no profile says, so the old single level applies (ai/effort.ts).
 */
export function profileEffortLevel(
  surface: AiRunSurface,
  provider: AiProviderId,
  defaultProvider: () => AiProviderId = activeProviderId,
): AiEffort | null | undefined {
  // The default provider is read only when a fix / build block names none.
  const block = surface === 'review' ? null : stored?.[surface];
  const dp = block != null && block.provider == null ? defaultProvider() : (block?.provider ?? provider);
  return profileEffortFor(stored, surface, provider, dp);
}

// ---- REVIEW ----------------------------------------------------------------------------------------

/** A review vendor's model (a picker model of THAT vendor) — its stored one, else the usual one. */
export function reviewProfileModel(provider: AiProviderId): AiPickerModel {
  const m = stored?.review?.[provider]?.model;
  return aiPickerModelProvider(m) === provider ? (m as AiPickerModel) : usualRunProfileModel('review', provider);
}

/** The DEPTH a review on `provider` is queued with (what every run entry point takes). */
export function reviewRunModel(provider: AiProviderId): ClaudeReviewModel {
  return aiPickerRequestModel(reviewProfileModel(provider));
}

/**
 * The depth a SINGLE-RUN review kind (CI review, story check) runs at on `provider`: the Review profile's
 * model once a review block is stored; none stored ⇒ `usual`, the kind's own model, as before.
 */
export function reviewKindModel(provider: AiProviderId, usual: ClaudeReviewModel): ClaudeReviewModel {
  return stored?.review == null ? usual : reviewRunModel(provider);
}

/** A review vendor's profile: on/off, model, stored effort (`undefined` ⇒ the old level). */
export function reviewProfileFor(provider: AiProviderId): { enabled: boolean; model: AiPickerModel; effort: AiEffort | null | undefined } {
  return { enabled: reviewVendorEnabled(stored, provider), model: reviewProfileModel(provider), effort: profileEffortLevel('review', provider) };
}

/** The review vendors switched on, in pair order (Claude first). Never empty (the writer keeps one on). */
export function reviewProvidersEnabled(): AiProviderId[] {
  const on = AI_REVIEW_VENDORS.filter((p) => reviewVendorEnabled(stored, p));
  return on.length > 0 ? on : [...AI_REVIEW_VENDORS];
}

/**
 * THE PAIR RESOLVER: the vendors a "Claude + Codex" review runs right now, in order — switched on AND
 * signed in (able to run a review). Two ⇒ a pair; one ⇒ that one alone; none ⇒ nothing can review.
 * Usage limits are the caller's (a press and an auto run treat them differently).
 */
export function reviewPairProviders(detect: ProfilePreflight): AiProviderId[] {
  return reviewProvidersEnabled().filter((p) => detect(p, 'review').status === 'ok');
}

/**
 * "ONE VENDOR" for a review (a manual run with no vendor named, a workspace's "One vendor" auto reviews,
 * the single-run review kinds — CI review, story check, Check threads, the Build loop's story check):
 * the first switched-on, signed-in vendor not over its usage limit, Claude before Codex (none signed in ⇒
 * the first switched on).
 * With NO review block stored it is the default provider (Settings → AI), as before.
 */
export function reviewDefaultProvider(
  detect?: ProfilePreflight,
  locked: (p: AiProviderId) => boolean = isLockedOut,
): AiProviderId {
  if (stored?.review == null) return activeProviderId();
  const on = reviewProvidersEnabled();
  // Over its usage limit ⇒ the next switched-on vendor with capacity, as the default provider moves
  // (provider-setting.ts `withCapacity`); all locked ⇒ the first able one (the gate then skips).
  const free = on.filter((p) => !locked(p));
  if (detect == null) return free[0] ?? on[0]!;
  const ok = (p: AiProviderId) => detect(p, 'review').status === 'ok';
  return free.find(ok) ?? on.find(ok) ?? on[0]!;
}

// ---- FIX / BUILD -----------------------------------------------------------------------------------

/** What a fix or build runs on. `model` null ⇒ the caller's usual model (auto fix: its review's depth). */
export interface SurfaceRunChoice {
  provider: AiProviderId;
  model: ClaudeReviewModel | null;
  /** A choice is stored for this surface (auto fix then stops inheriting its review's model). */
  configured: boolean;
  /** The stored vendor could not run (signed out, or over its usage limit): the other one runs. */
  fellBack: boolean;
}

function surfaceChoice(
  surface: 'fix' | 'build',
  kind: AiRunKind,
  detect: ProfilePreflight,
  locked: (p: AiProviderId) => boolean,
): SurfaceRunChoice {
  const block = stored?.[surface];
  const configured = block != null && (block.provider != null || block.model != null);
  const modelOf = (p: AiProviderId): ClaudeReviewModel | null =>
    block?.model != null && aiPickerModelProvider(block.model) === p ? aiPickerRequestModel(block.model) : null;
  // No vendor stored: the default provider (which itself moves off a provider over its limit), as before.
  if (block?.provider == null) {
    const p = activeProviderId();
    return { provider: p, model: modelOf(p), configured, fellBack: false };
  }
  const want = block.provider;
  const can = (p: AiProviderId) => detect(p, kind).status === 'ok' && !locked(p);
  if (can(want)) return { provider: want, model: modelOf(want), configured, fellBack: false };
  const other: AiProviderId = want === 'claude' ? 'codex' : 'claude';
  // The other vendor at ITS usual model (null) and Default effort (profileEffortFor: a run off the
  // block's provider is Default). Neither can run ⇒ the stored one, whose pre-flight says why.
  if (can(other)) return { provider: other, model: null, configured, fellBack: true };
  return { provider: want, model: modelOf(want), configured, fellBack: false };
}

/** AI Fix's (and Plan first's) vendor and model now. `kind` is the pre-flight's ('fix' | 'plan'). */
export function fixChoice(detect: ProfilePreflight, kind: AiRunKind = 'fix', locked: (p: AiProviderId) => boolean = isLockedOut): SurfaceRunChoice {
  return surfaceChoice('fix', kind, detect, locked);
}

/** Implement story's vendor and model now (story_plan / story_build). */
export function buildChoice(detect: ProfilePreflight, kind: AiRunKind = 'story_build', locked: (p: AiProviderId) => boolean = isLockedOut): SurfaceRunChoice {
  return surfaceChoice('build', kind, detect, locked);
}

/** AI Fix's own review loop's rounds (Settings → AI → AI Fix; default 5), read when a loop run starts. */
export function fixLoopRounds(): number {
  return profileFixLoopRounds(stored);
}

/** The Build review loop's rounds when a start names none (Settings → AI; default 5). */
export function buildLoopRounds(): number {
  return profileLoopRounds(stored);
}
