// THE ALLOW-LIST (docs/SECURITY.md § Sandboxed checks): which checks a repository DECLARES, derived
// from its own files and nothing else. The agent can only name one of these; the reader ticks which
// may run. Every entry is a fixed argv Limn builds (no shell string, no model text, no reader text):
//
//   Node     package.json scripts named test / test:* / lint / lint:* / typecheck / check …, run
//            through the package manager the LOCKFILE names (pnpm, npm, yarn, bun)
//   Make     Makefile targets test / lint / check / typecheck (and test-*), run as `make <target>`
//   Python   pytest (pyproject / setup.cfg / pytest.ini), tox, nox
//   Rust     cargo test          Go  go test ./... + go vet ./...
//   Gradle   gradle test         Maven  mvn test
//
// A script whose text (and every script or target it calls) breaks the DENY SCAN (deny-scan.ts) is
// listed with the reason and never runs. Pure: file contents in, a plan out — the same function reads a
// worktree (local.ts) and the PR head through GitHub (remote.ts), so the picker and the run agree.
import { denyReason } from './deny-scan.js';
import type { CheckDef, CheckKind, CheckPlan, HookDef, NodePackageManager, PrepareStep } from './types.js';

/** The repository files discovery reads (root-relative). Everything else is never looked at. */
export const CHECK_MANIFEST_FILES = [
  'package.json',
  'pnpm-lock.yaml',
  'package-lock.json',
  'npm-shrinkwrap.json',
  'yarn.lock',
  '.yarnrc.yml',
  '.yarnrc',
  'bun.lockb',
  'bun.lock',
  'Makefile',
  'makefile',
  'GNUmakefile',
  'pyproject.toml',
  'setup.cfg',
  'pytest.ini',
  'tox.ini',
  'noxfile.py',
  'uv.lock',
  'Cargo.toml',
  'Cargo.lock',
  'go.mod',
  'build.gradle',
  'build.gradle.kts',
  'gradlew',
  'pom.xml',
  '.mvn/extensions.xml',
  'docker-compose.yml',
  'docker-compose.yaml',
  'compose.yml',
  'compose.yaml',
  '.husky/pre-commit',
  'lefthook.yml',
  'lefthook.yaml',
  '.lefthook.yml',
  '.pre-commit-config.yaml',
  '.lintstagedrc',
  '.lintstagedrc.json',
  '.lintstagedrc.yml',
  '.lintstagedrc.yaml',
] as const;

/** A read-only view of the repository's root files: content, or null when absent / unreadable. */
export interface RepoFiles {
  read(path: string): string | null;
}

/** Script names that end in one of these never run as a check: they watch, fix files or serve. */
const NOT_A_CHECK = /(?:^|[:_-])(?:watch|fix|write|update|u|dev|serve|server|start|debug|ui|open|interactive|snapshot|record|e2e:ui|ci:local)(?:$|[:_-])/i;

/** The check kind a script or target name declares, or null when it is not a check. */
export function kindOfName(name: string): CheckKind | null {
  if (name.length > 60 || !/^[\w.:-]+$/.test(name)) return null;
  if (NOT_A_CHECK.test(name)) return null;
  const head = name.split(/[:_-]/)[0]!.toLowerCase();
  if (head === 'test' || head === 'tests') return 'test';
  if (head === 'lint') return 'lint';
  if (/^(?:typecheck|type-check|check-types|types|tsc)$/i.test(name) || /^typecheck[:_-]/i.test(name)) return 'typecheck';
  if (head === 'check') return 'check';
  return null;
}

/** On by default: the plain `test`, `lint` and `typecheck` (not their variants). */
function defaultOnFor(name: string, kind: CheckKind): boolean {
  if (kind === 'hook') return true;
  return (kind === 'test' || kind === 'lint' || kind === 'typecheck') && !/[:_-]/.test(name.replace(/^type-check$|^check-types$/, 'x'));
}

/** The package manager the lockfile names (corepack's `packageManager` field breaks a tie). */
export function nodePackageManager(files: RepoFiles): NodePackageManager | null {
  if (files.read('package.json') == null) return null;
  const field = parsePackageJson(files.read('package.json'))?.packageManager;
  const named = typeof field === 'string' ? /^(pnpm|npm|yarn|bun)@/.exec(field)?.[1] : undefined;
  if (named) return named as NodePackageManager;
  if (files.read('pnpm-lock.yaml') != null) return 'pnpm';
  if (files.read('bun.lockb') != null || files.read('bun.lock') != null) return 'bun';
  if (files.read('yarn.lock') != null) return 'yarn';
  return 'npm';
}

interface PackageJson {
  scripts?: Record<string, unknown>;
  packageManager?: unknown;
  dependencies?: Record<string, unknown>;
  devDependencies?: Record<string, unknown>;
  'simple-git-hooks'?: Record<string, unknown>;
  'lint-staged'?: unknown;
}

function parsePackageJson(text: string | null): PackageJson | null {
  if (text == null) return null;
  try {
    const v = JSON.parse(text) as unknown;
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as PackageJson) : null;
  } catch {
    return null;
  }
}

function stringScripts(pkg: PackageJson | null): Map<string, string> {
  const out = new Map<string, string>();
  const s = pkg?.scripts;
  if (!s || typeof s !== 'object') return out;
  for (const [k, v] of Object.entries(s)) if (typeof v === 'string') out.set(k, v);
  return out;
}

/**
 * Every script a script runs, followed through `npm run x` / `pnpm x` / `yarn x` / `bun run x`,
 * `run-s` / `run-p` / `npm-run-all` (globs like `lint:*`) and npm's `pre<x>` / `post<x>`, so the deny
 * scan reads the whole chain and not only the first link.
 */
export function scriptClosure(scripts: Map<string, string>, root: string): string[] {
  const seen = new Set<string>();
  const order: string[] = [];
  const visit = (name: string): void => {
    if (seen.has(name) || !scripts.has(name)) return;
    seen.add(name);
    order.push(name);
    const body = scripts.get(name)!;
    for (const pre of [`pre${name}`, `post${name}`]) visit(pre);
    for (const ref of referencedScripts(body, scripts)) visit(ref);
  };
  visit(root);
  return order;
}

function referencedScripts(body: string, scripts: Map<string, string>): string[] {
  const out: string[] = [];
  const names = [...scripts.keys()];
  const add = (token: string): void => {
    const t = token.replace(/^["']|["']$/g, '');
    if (t.includes('*')) {
      const re = new RegExp(`^${t.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`);
      for (const n of names) if (re.test(n)) out.push(n);
    } else if (scripts.has(t)) out.push(t);
  };
  // `npm run x`, `pnpm run x`, `yarn run x`, `bun run x`, `pnpm x`, `yarn x`, `npm test` …
  const pm = /\b(?:npm|pnpm|yarn|bun)(?:\s+(?:-[\w-]+(?:=\S+)?|--filter\s+\S+|-F\s+\S+|-r|--recursive|-w|--workspace-root))*\s+(?:run(?:-script)?\s+)?([\w.:*-]+)/g;
  for (const m of body.matchAll(pm)) {
    const tok = m[1]!;
    if (tok === 'test' || tok === 'start' || tok === 'stop' || tok === 'restart') add(tok);
    else add(tok);
  }
  // npm-run-all family: every following bare word until an operator.
  const runAll = /\b(?:run-s|run-p|npm-run-all|npm-run-all2)\b([^;&|]*)/g;
  for (const m of body.matchAll(runAll)) {
    for (const tok of m[1]!.trim().split(/\s+/)) if (tok && !tok.startsWith('-')) add(tok);
  }
  return out;
}

/** The argv that runs a package.json script through the project's package manager. */
export function nodeScriptArgv(pm: NodePackageManager, name: string): string[] {
  return [pm, 'run', name];
}

/** The dependency step for a Node project: the lockfile, no lifecycle scripts, no hooks file. */
export function nodePrepare(pm: NodePackageManager, files: RepoFiles): PrepareStep {
  const yarnrc = files.read('.yarnrc.yml');
  // Yarn 1 reads `yarn-path` from `.yarnrc` (not .yml) and runs THAT file instead of itself.
  const classicRc = files.read('.yarnrc');
  if (
    pm === 'yarn' &&
    ((yarnrc != null && /^\s*(?:yarnPath|plugins)\s*:/m.test(yarnrc)) || (classicRc != null && /^\s*["']?yarn-path["']?\s/m.test(classicRc)))
  ) {
    return {
      ecosystem: 'node',
      argv: ['yarn', 'install'],
      refused: 'Yarn here runs a copy of itself (or plugins) from the repository, so Limn does not install with the network on.',
    };
  }
  // Corepack fetches the package manager the `packageManager` field names — and that may be a URL to
  // any tarball (code that would run with the network on). Only a plain `name@version[+hash]`.
  const field = parsePackageJson(files.read('package.json'))?.packageManager;
  if (typeof field === 'string' && !/^(?:pnpm|npm|yarn|bun)@\d[\w.-]*(?:\+[\w.:-]+)?$/.test(field)) {
    return {
      ecosystem: 'node',
      argv: [pm, 'install'],
      refused: 'package.json names its package manager by a link, not a version, so Limn does not install with the network on.',
    };
  }
  const argv: Record<NodePackageManager, string[]> = {
    // --ignore-pnpmfile: .pnpmfile.cjs is repository CODE that runs during install.
    pnpm: ['pnpm', 'install', '--frozen-lockfile', '--ignore-scripts', '--ignore-pnpmfile', '--config.confirmModulesPurge=false'],
    npm: files.read('package-lock.json') != null || files.read('npm-shrinkwrap.json') != null
      ? ['npm', 'ci', '--ignore-scripts', '--no-audit', '--no-fund']
      : ['npm', 'install', '--ignore-scripts', '--no-audit', '--no-fund'],
    yarn: files.read('yarn.lock') != null && /__metadata:/m.test(files.read('yarn.lock') ?? '')
      ? ['yarn', 'install', '--immutable', '--mode=skip-build']
      : ['yarn', 'install', '--frozen-lockfile', '--ignore-scripts', '--non-interactive'],
    bun: ['bun', 'install', '--frozen-lockfile', '--ignore-scripts'],
  };
  return { ecosystem: 'node', argv: argv[pm], refused: null };
}

// ---- Makefile ------------------------------------------------------------------------------------

interface MakeTarget {
  prereqs: string[];
  recipe: string[];
}

/** Targets (with prerequisites and recipe lines) and every variable assignment, of one Makefile. */
export function parseMakefile(text: string): { targets: Map<string, MakeTarget>; assignments: string[]; includes: boolean } {
  const targets = new Map<string, MakeTarget>();
  const assignments: string[] = [];
  let includes = false;
  let current: MakeTarget[] = [];
  const lines = text.replace(/\\\r?\n/g, ' ').split(/\r?\n/);
  for (const line of lines) {
    if (line.startsWith('\t')) {
      for (const t of current) t.recipe.push(line.slice(1));
      continue;
    }
    if (/^\s*(?:-|s)?include\s/.test(line)) {
      includes = true;
      current = [];
      continue;
    }
    const assign = /^\s*(?:export\s+|override\s+)?[A-Za-z_][\w.]*\s*(?::{1,3}=|\?=|\+=|!=|=)(.*)$/.exec(line);
    if (assign && !/^[^=]*:[^=]/.test(line.split('=')[0]!)) {
      assignments.push(assign[1]!);
      current = [];
      continue;
    }
    const rule = /^([A-Za-z0-9_./%-][A-Za-z0-9_./%\s-]*?)\s*::?(?!=)\s*([^;#]*)(?:;\s*(.*))?$/.exec(line);
    if (rule) {
      const names = rule[1]!.trim().split(/\s+/);
      const prereqs = rule[2]!.trim().split(/\s+/).filter(Boolean);
      current = [];
      for (const n of names) {
        const t = targets.get(n) ?? { prereqs: [], recipe: [] };
        t.prereqs.push(...prereqs);
        if (rule[3]) t.recipe.push(rule[3]);
        targets.set(n, t);
        current.push(t);
      }
      continue;
    }
    if (line.trim() !== '' && !line.trim().startsWith('#')) current = [];
  }
  return { targets, assignments, includes };
}

/** All the text a `make <target>` may run: its recipe, its prerequisites' and sub-makes', recursively. */
export function makeClosureText(parsed: ReturnType<typeof parseMakefile>, root: string): string {
  const seen = new Set<string>();
  const out: string[] = [];
  const visit = (name: string): void => {
    if (seen.has(name)) return;
    seen.add(name);
    const t = parsed.targets.get(name);
    if (!t) return;
    out.push(...t.recipe);
    for (const p of t.prereqs) visit(p);
    for (const line of t.recipe) {
      const sub = /\$\(MAKE\)|\$\{MAKE\}|\bmake\b/.exec(line);
      if (!sub) continue;
      for (const tok of line.slice(sub.index + sub[0].length).split(/[\s;&|]+/)) if (/^[\w.-]+$/.test(tok)) visit(tok);
    }
  };
  visit(root);
  return out.join('\n');
}

// ---- Docker ----------------------------------------------------------------------------------------

const COMPOSE_FILES = ['docker-compose.yml', 'docker-compose.yaml', 'compose.yml', 'compose.yaml'];

/** The repository uses Docker for tests: a compose file, or testcontainers in a manifest. */
export function repoUsesDocker(files: RepoFiles): boolean {
  if (COMPOSE_FILES.some((f) => files.read(f) != null)) return true;
  for (const f of ['package.json', 'pom.xml', 'build.gradle', 'build.gradle.kts', 'go.mod', 'pyproject.toml', 'Cargo.toml']) {
    const text = files.read(f);
    if (text != null && /testcontainers/i.test(text)) return true;
  }
  return false;
}

const MENTIONS_DOCKER = /\b(?:docker|podman|compose|testcontainers)\b/i;

// ---- discovery -------------------------------------------------------------------------------------

/** Every check the repository declares, its dependency steps and its commit hook. */
export function discoverChecks(files: RepoFiles): CheckPlan {
  const checks: CheckDef[] = [];
  const prepare: PrepareStep[] = [];
  const usesDocker = repoUsesDocker(files);
  const add = (c: Omit<CheckDef, 'defaultOn' | 'needsDocker'> & { text: string }): void => {
    if (checks.some((x) => x.name === c.name)) return;
    const { text, ...rest } = c;
    checks.push({
      ...rest,
      defaultOn: rest.refused == null && defaultOnFor(rest.name, rest.kind),
      needsDocker: MENTIONS_DOCKER.test(text) || (usesDocker && rest.kind === 'test'),
    });
  };

  // Node.
  const pkg = parsePackageJson(files.read('package.json'));
  const pm = nodePackageManager(files);
  if (pkg && pm) {
    const scripts = stringScripts(pkg);
    let any = false;
    for (const name of [...scripts.keys()].sort()) {
      const kind = kindOfName(name);
      if (!kind) continue;
      any = true;
      const chain = scriptClosure(scripts, name);
      const text = chain.map((n) => scripts.get(n)!).join('\n');
      add({
        name,
        kind,
        ecosystem: 'node',
        argv: nodeScriptArgv(pm, name),
        source: `package.json script "${name}"`,
        refused: denyReason(text),
        text,
      });
    }
    if (any) prepare.push(nodePrepare(pm, files));
  }

  // Make.
  const makefile = files.read('GNUmakefile') ?? files.read('makefile') ?? files.read('Makefile');
  if (makefile != null) {
    const parsed = parseMakefile(makefile);
    const vars = parsed.assignments.join('\n');
    for (const name of [...parsed.targets.keys()].sort()) {
      const kind = kindOfName(name);
      if (!kind || name.includes('%')) continue;
      if (kind === 'test' && /[:]/.test(name)) continue;
      const text = `${makeClosureText(parsed, name)}\n${vars}`;
      add({
        name: checks.some((c) => c.name === name) ? `make ${name}` : name,
        kind,
        ecosystem: 'make',
        argv: ['make', name],
        source: `Makefile target "${name}"`,
        refused: denyReason(text) ?? (parsed.includes ? 'The Makefile includes other files Limn cannot read first.' : null),
        text,
      });
    }
  }

  // Python.
  const pyproject = files.read('pyproject.toml');
  const usesPytest =
    files.read('pytest.ini') != null ||
    /\[tool\.pytest|\bpytest\b/.test(pyproject ?? '') ||
    /\[tool:pytest\]/.test(files.read('setup.cfg') ?? '');
  const uv = files.read('uv.lock') != null;
  if (usesPytest) {
    add({
      name: checks.some((c) => c.name === 'test') ? 'pytest' : 'test',
      kind: 'test',
      ecosystem: 'python',
      argv: uv ? ['uv', 'run', '--frozen', '--no-sync', 'python', '-m', 'pytest'] : ['python3', '-m', 'pytest'],
      source: 'pytest (pyproject.toml)',
      refused: null,
      text: pyproject ?? '',
    });
    if (uv) prepare.push({ ecosystem: 'python', argv: ['uv', 'sync', '--frozen', '--no-install-project', '--no-build'], refused: null });
  }
  if (files.read('tox.ini') != null || /\[tool\.tox\]/.test(pyproject ?? '')) {
    add({ name: 'tox', kind: 'test', ecosystem: 'python', argv: ['tox'], source: 'tox', refused: null, text: files.read('tox.ini') ?? '' });
  }
  if (files.read('noxfile.py') != null) {
    add({ name: 'nox', kind: 'test', ecosystem: 'python', argv: ['nox'], source: 'nox (noxfile.py)', refused: null, text: '' });
  }

  // Rust.
  if (files.read('Cargo.toml') != null) {
    const locked = files.read('Cargo.lock') != null;
    add({
      name: checks.some((c) => c.name === 'test') ? 'cargo test' : 'test',
      kind: 'test',
      ecosystem: 'rust',
      argv: ['cargo', 'test', ...(locked ? ['--locked'] : []), '--offline'],
      source: 'cargo test (Cargo.toml)',
      refused: null,
      text: files.read('Cargo.toml') ?? '',
    });
    prepare.push({ ecosystem: 'rust', argv: ['cargo', 'fetch', ...(locked ? ['--locked'] : [])], refused: null });
  }

  // Go.
  if (files.read('go.mod') != null) {
    add({
      name: checks.some((c) => c.name === 'test') ? 'go test' : 'test',
      kind: 'test',
      ecosystem: 'go',
      argv: ['go', 'test', './...'],
      source: 'go test (go.mod)',
      refused: null,
      text: files.read('go.mod') ?? '',
    });
    add({
      name: checks.some((c) => c.name === 'lint') ? 'go vet' : 'lint',
      kind: 'lint',
      ecosystem: 'go',
      argv: ['go', 'vet', './...'],
      source: 'go vet (go.mod)',
      refused: null,
      text: '',
    });
    prepare.push({ ecosystem: 'go', argv: ['go', 'mod', 'download'], refused: null });
  }

  // Gradle — no dependency step: its build scripts are code, and they would run with the network on.
  const gradle = files.read('build.gradle.kts') ?? files.read('build.gradle');
  if (gradle != null) {
    const wrapper = files.read('gradlew') != null;
    add({
      name: checks.some((c) => c.name === 'test') ? 'gradle test' : 'test',
      kind: 'test',
      ecosystem: 'gradle',
      argv: [wrapper ? './gradlew' : 'gradle', 'test', '--offline', '--no-daemon'],
      source: 'Gradle test task',
      refused: null,
      text: gradle,
    });
  }

  // Maven. The dependency step runs only with the system `mvn` and no build extensions (repo code).
  const pom = files.read('pom.xml');
  if (pom != null) {
    add({
      name: checks.some((c) => c.name === 'test') ? 'mvn test' : 'test',
      kind: 'test',
      ecosystem: 'maven',
      argv: ['mvn', '-B', '-o', 'test'],
      source: 'Maven test phase (pom.xml)',
      refused: null,
      text: pom,
    });
    prepare.push(
      // Build extensions (`.mvn/extensions.xml`, or `<extensions>` in the POM) are code Maven loads
      // before any goal — they would run with the network on.
      files.read('.mvn/extensions.xml') != null || /<extensions\s*>/i.test(pom)
        ? { ecosystem: 'maven', argv: ['mvn', '-B', 'dependency:go-offline'], refused: 'Maven here loads build extensions from the repository, so Limn does not fetch with the network on.' }
        : { ecosystem: 'maven', argv: ['mvn', '-B', 'dependency:go-offline'], refused: null },
    );
  }

  const hook = discoverHook(files, pkg);
  if (hook.def) {
    checks.push({
      name: 'pre-commit hook',
      kind: 'hook',
      ecosystem: 'git',
      argv: ['git', 'commit'],
      source: hook.def.source,
      defaultOn: hook.refused == null,
      needsDocker: MENTIONS_DOCKER.test(hook.text),
      refused: hook.refused,
    });
  } else if (hook.refused) {
    checks.push({
      name: 'pre-commit hook',
      kind: 'hook',
      ecosystem: 'git',
      argv: ['git', 'commit'],
      source: '.pre-commit-config.yaml',
      defaultOn: false,
      needsDocker: false,
      refused: hook.refused,
    });
  }

  return { checks, prepare, hook: hook.refused == null ? hook.def : null, packageManager: pkg ? pm : null };
}

function stringLeaves(v: unknown, out: string[] = [], depth = 0): string[] {
  if (depth > 6) return out;
  if (typeof v === 'string') out.push(v);
  else if (Array.isArray(v)) for (const x of v) stringLeaves(x, out, depth + 1);
  else if (v && typeof v === 'object') for (const x of Object.values(v)) stringLeaves(x, out, depth + 1);
  return out;
}

/** The repository's pre-commit hook, the text the deny scan reads for it, and why it cannot run. */
function discoverHook(files: RepoFiles, pkg: PackageJson | null): { def: HookDef | null; text: string; refused: string | null } {
  const lintStaged = [
    // Every command string in the config, one per line (so a rule sees each at a line start).
    stringLeaves(pkg?.['lint-staged']).join('\n'),
    files.read('.lintstagedrc') ?? '',
    files.read('.lintstagedrc.json') ?? '',
    files.read('.lintstagedrc.yml') ?? '',
    files.read('.lintstagedrc.yaml') ?? '',
  ].join('\n');
  const scripts = stringScripts(pkg);
  // A hook that calls `npm run x` is scanned through x too.
  const withScripts = (text: string): string => {
    const refs = referencedScripts(text, scripts).flatMap((n) => scriptClosure(scripts, n));
    return [text, ...refs.map((n) => scripts.get(n)!)].join('\n');
  };

  const husky = files.read('.husky/pre-commit');
  if (husky != null) {
    const text = withScripts(`${husky}\n${/lint-staged/.test(husky) ? lintStaged : ''}`);
    return { def: { kind: 'husky', script: husky, source: '.husky/pre-commit' }, text, refused: denyReason(text) };
  }
  const lefthook = files.read('lefthook.yml') ?? files.read('lefthook.yaml') ?? files.read('.lefthook.yml');
  if (lefthook != null && /^\s*pre-commit\s*:/m.test(lefthook)) {
    const text = withScripts(lefthook);
    return {
      def: { kind: 'lefthook', script: 'exec lefthook run pre-commit "$@"\n', source: 'lefthook.yml' },
      text,
      refused: denyReason(text),
    };
  }
  const simple = pkg?.['simple-git-hooks']?.['pre-commit'];
  if (typeof simple === 'string') {
    const text = withScripts(`${simple}\n${/lint-staged/.test(simple) ? lintStaged : ''}`);
    return { def: { kind: 'simple-git-hooks', script: `${simple}\n`, source: 'package.json "simple-git-hooks"' }, text, refused: denyReason(text) };
  }
  if (files.read('.pre-commit-config.yaml') != null) {
    return {
      def: null,
      text: '',
      refused: 'The pre-commit framework installs its hooks over the network, which a check never has.',
    };
  }
  return { def: null, text: '', refused: null };
}
