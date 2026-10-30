// THE SCRUBBED ENVIRONMENT a check runs with (docs/SECURITY.md § Sandboxed checks). An ALLOW-LIST:
// a check sees the handful of variables a toolchain needs to start (PATH, locale, terminal), Limn's own
// HOME / TMPDIR / cache folders, and nothing else — no GitHub, Anthropic or OpenAI token, no SSH agent,
// no cloud credentials, whatever the reader's shell exported. Pure. Node built-ins only.
import { join } from 'node:path';

/** Passed through from Limn's own environment when set. Everything else is dropped. */
export const PASSED_THROUGH: readonly string[] = [
  'PATH',
  'LANG',
  'LANGUAGE',
  'LC_ALL',
  'LC_CTYPE',
  'LC_MESSAGES',
  'TERM',
  'TZ',
  'USER',
  'LOGNAME',
  'SHELL',
  // Toolchain locations (where a version manager put the compiler), never their credentials.
  'JAVA_HOME',
  'GOROOT',
  'NVM_BIN',
  'VOLTA_HOME',
  'PNPM_HOME',
  'BUN_INSTALL',
  'PYENV_ROOT',
  'SDKMAN_DIR',
];

/**
 * A name that must never reach a check even if a later edit adds it to PASSED_THROUGH (belt and
 * braces, pinned by the test): anything that looks like a credential, or an agent socket.
 */
export const NEVER_PASSED = /TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|API_?KEY|PRIVATE|AUTH|SESSION|COOKIE|^GH_|^GITHUB_|^ANTHROPIC|^OPENAI|^CLAUDE|^CODEX|^AWS_|^AZURE_|^GOOGLE_|^GCLOUD|^NPM_CONFIG_|^NODE_AUTH|SSH_AUTH_SOCK|GPG_AGENT|^LIMN_|^PIERRE_|^DATABASE_URL$|^DOCKER_/i;

export interface CheckEnvFolders {
  /** The run's own temporary folder: HOME and TMPDIR live inside it. */
  tmp: string;
  /** Limn's private toolchain cache (`<data dir>/check-cache`): package stores, module caches. */
  cache: string;
  /** The reader's real home, read only for the version-manager homes below (rustup), never as HOME. */
  realHome: string;
}

/** The environment one check or dependency step runs with. */
export function scrubbedEnv(source: NodeJS.ProcessEnv, f: CheckEnvFolders, extra: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = {};
  for (const name of PASSED_THROUGH) {
    const v = source[name];
    if (typeof v === 'string' && v !== '' && !NEVER_PASSED.test(name)) env[name] = v;
  }
  const home = join(f.tmp, 'home');
  Object.assign(env, {
    HOME: home,
    TMPDIR: join(f.tmp, 'tmp'),
    TMP: join(f.tmp, 'tmp'),
    TEMP: join(f.tmp, 'tmp'),
    XDG_CONFIG_HOME: join(home, '.config'),
    XDG_CACHE_HOME: join(f.cache, 'xdg'),
    XDG_DATA_HOME: join(home, '.local', 'share'),
    CI: 'true',
    NO_COLOR: '1',
    FORCE_COLOR: '0',
    // git, when a check or the hook runs it: no system or global config (credential helpers, hooks).
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_TERMINAL_PROMPT: '0',
    // Node package managers: Limn's private caches, never the reader's ~/.npmrc (it may hold a token).
    npm_config_cache: join(f.cache, 'npm'),
    npm_config_userconfig: join(home, '.npmrc'),
    npm_config_update_notifier: 'false',
    COREPACK_HOME: join(f.cache, 'corepack'),
    COREPACK_ENABLE_DOWNLOAD_PROMPT: '0',
    YARN_CACHE_FOLDER: join(f.cache, 'yarn'),
    YARN_ENABLE_TELEMETRY: '0',
    BUN_INSTALL_CACHE_DIR: join(f.cache, 'bun'),
    // Python.
    UV_CACHE_DIR: join(f.cache, 'uv'),
    PIP_CACHE_DIR: join(f.cache, 'pip'),
    PYTHONDONTWRITEBYTECODE: '1',
    // Rust: the registry in Limn's cache; the toolchain itself stays the reader's (rustup, read only).
    CARGO_HOME: join(f.cache, 'cargo'),
    RUSTUP_HOME: source.RUSTUP_HOME ?? join(f.realHome, '.rustup'),
    // Go: never download a toolchain the go.mod asks for.
    GOPATH: join(f.cache, 'go'),
    GOMODCACHE: join(f.cache, 'go', 'pkg', 'mod'),
    GOCACHE: join(f.cache, 'go-build'),
    GOTOOLCHAIN: 'local',
    GOFLAGS: '-mod=readonly',
    // JVM.
    GRADLE_USER_HOME: join(f.cache, 'gradle'),
    MAVEN_OPTS: `-Dmaven.repo.local=${join(f.cache, 'm2')}`,
    ...extra,
  });
  // Cargo and rustup put their binaries under the real home: keep that on PATH even though HOME moved.
  return env;
}
