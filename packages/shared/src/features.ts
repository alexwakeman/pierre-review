// SETTINGS → FEATURES — which sidebar destinations show (docs/FRONTEND.md § Features shown).
//
// Hiding changes VISIBILITY ONLY: the sidebar, the phone's bottom bar and the ⌘K palette leave a
// hidden destination out. A deep link (`?view=sprint`, `?activityRepo=bots` …) still opens it, and no
// background work (syncs, ML scoring, tracker reads) changes with a switch.
//
// One rule for all four: a stored switch wins; with none stored, the DEFAULT applies:
//   • an EXISTING install (the account had repositories before migration 0153) shows everything;
//   • otherwise Bots Monitoring and Feed start hidden, Reports shows once a repository's 90-day
//     backfill has finished, and This Sprint shows once a sprint source exists.
// Stored as overrides only (`accounts.feature_settings`), so a later change to a default reaches
// everyone who never touched the switch.

export type FeatureId = 'bots' | 'feed' | 'reports' | 'sprint';

/** Settings order. */
export const FEATURE_IDS: readonly FeatureId[] = ['feed', 'reports', 'sprint', 'bots'];

/** The stored switches, overrides only. An absent key = the default. */
export type FeatureSettings = Partial<Record<FeatureId, boolean>>;

/** The server-side facts the defaults read (all DB-only, computed per GET /api/me). */
export interface FeatureFacts {
  /** The account had repositories before Features existed: everything shows by default. */
  existingInstall: boolean;
  /** At least one repository's 90-day backfill has finished (`sync_state.last_full_sync_at`). */
  reportsReady: boolean;
  /** A sprint source exists (db/feature-gates.ts `hasSprintSource`). */
  sprintSource: boolean;
}

export interface FeatureStatus {
  /** What the sidebar and ⌘K show. */
  visible: boolean;
  /** The stored switch; null = the default applies. */
  setting: boolean | null;
  /** What the default is right now. */
  defaultOn: boolean;
}

export type FeaturesStatus = Record<FeatureId, FeatureStatus>;

/** The default for one feature, from the facts. */
export function featureDefault(id: FeatureId, facts: FeatureFacts): boolean {
  if (facts.existingInstall) return true;
  switch (id) {
    case 'bots':
    case 'feed':
      return false;
    case 'reports':
      return facts.reportsReady;
    case 'sprint':
      return facts.sprintSource;
  }
}

/** The ONE resolver: stored switch, else the default. */
export function resolveFeatures(settings: FeatureSettings | null | undefined, facts: FeatureFacts): FeaturesStatus {
  const out = {} as FeaturesStatus;
  for (const id of FEATURE_IDS) {
    const stored = settings?.[id];
    const setting = typeof stored === 'boolean' ? stored : null;
    const defaultOn = featureDefault(id, facts);
    out[id] = { visible: setting ?? defaultOn, setting, defaultOn };
  }
  return out;
}

/** Keep only known keys with boolean values; `{}` → null (nothing stored). */
export function compactFeatureSettings(settings: FeatureSettings | null | undefined): FeatureSettings | null {
  if (settings == null) return null;
  const out: FeatureSettings = {};
  for (const id of FEATURE_IDS) {
    const v = settings[id];
    if (typeof v === 'boolean') out[id] = v;
  }
  return Object.keys(out).length === 0 ? null : out;
}

/** Body of PUT /api/me/feature-settings: the WHOLE overrides object; `null` resets every switch. */
export interface FeatureSettingsBody {
  settings: FeatureSettings | null;
}

/** Response of PUT /api/me/feature-settings: what was stored, and the resolved result. */
export interface FeatureSettingsResponse {
  status: 'ok';
  featureSettings: FeatureSettings | null;
  features: FeaturesStatus;
}
