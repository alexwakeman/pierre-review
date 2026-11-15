// THE USER-SET ENVIRONMENT VARIABLES, after the Limn → Ensemble rename (packages/shared/src/product.ts).
//
// Every variable a person sets (`ENSEMBLE_DATA_DIR`, `ENSEMBLE_AI_PROVIDER`, `ENSEMBLE_ML_DISABLED` …)
// has a new `ENSEMBLE_` name. The old `LIMN_` name is still read as a FALLBACK, so a shell profile or
// launch script written for Limn keeps working: `ENSEMBLE_X` wins when it is set and not blank,
// else `LIMN_X` is read as it is.
//
// ⚠ ONLY for variables a person sets. Test-only variables (`LIMN_TEST_RUN_DIR`, `LIMN_SCRATCH*`,
// `LIMN_SANDBOX_LIVE`, `LIMN_CODEX_LIVE*` …) and the variables the backend passes to its OWN child
// processes (`LIMN_PROXY`, `LIMN_CODEX_GUARD`, `LIMN_PROXY_CONFIG`, `LIMN_ML_SCORER_INIT` …) keep
// their one name: the child reads exactly the name the parent writes.

/** Every user-set variable, by its name without the prefix. The test config blanks their
 *  `ENSEMBLE_` names (vitest.config.ts), so a shell's setting cannot override a test's `LIMN_` one. */
export const USER_ENV_NAMES: readonly string[] = [
  'DATA_DIR',
  'DOCS_DIR',
  'AI_PROVIDER',
  'AI_DISABLED',
  'AI_USE_API_KEY',
  'AI_AUTO_INSTALL',
  'CLAUDE_PATH',
  'CODEX_PATH',
  'ML_DISABLED',
  'ML_SCORER',
  'ML_ON_BATTERY',
  'ML_MODELS_DIR',
  'ML_IDLE_MS',
  'ML_THREADS',
  'ML_CPU_SHARE',
  'SANDBOX_MAX_SESSIONS',
  'SANDBOX_MAX_BUILDS',
  'SANDBOX_IDLE_MINUTES',
  'SANDBOX_TURN_MAX_MINUTES',
  'SANDBOX_RECLAIM_IDLE_SECONDS',
  'STORY_CHAT_MAX_LIVE',
];

/** The new prefix (written in docs and messages). */
export const ENV_PREFIX = 'ENSEMBLE_';
/** The old prefix, still read as a fallback. */
export const LEGACY_ENV_PREFIX = 'LIMN_';

/** The name a person should set: `envName('DATA_DIR')` → `ENSEMBLE_DATA_DIR`. */
export function envName(name: string): string {
  return `${ENV_PREFIX}${name}`;
}

/** The old name, still read: `legacyEnvName('DATA_DIR')` → `LIMN_DATA_DIR`. */
export function legacyEnvName(name: string): string {
  return `${LEGACY_ENV_PREFIX}${name}`;
}

/**
 * A user-set variable by its name without the prefix: `readEnv(process.env, 'DATA_DIR')` →
 * `ENSEMBLE_DATA_DIR` when it is set and not blank, else `LIMN_DATA_DIR` (untrimmed, possibly
 * undefined). Callers trim and parse as before.
 */
export function readEnv(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const next = env[envName(name)];
  if (next != null && next.trim() !== '') return next;
  return env[legacyEnvName(name)];
}

/** Which of the two names is set (non-blank), for a message that names it; null when neither. */
export function envNameSet(env: NodeJS.ProcessEnv, name: string): string | null {
  if ((env[envName(name)] ?? '').trim() !== '') return envName(name);
  if ((env[legacyEnvName(name)] ?? '').trim() !== '') return legacyEnvName(name);
  return null;
}
