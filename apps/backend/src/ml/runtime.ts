// THE ML RUNTIME — the ONE module allowed to import onnxruntime-node or the tokenizer, and the
// owner of the severity model's files. Local bot-comment scoring (docs/ML-NODE-PORT.md) needs
// two things the npm package does NOT carry:
//
//   1. the packages: onnxruntime-node (~300 MB unpacked: every platform's native binaries) and
//      @huggingface/tokenizers — installed ON FIRST USE into `<dataDir>/ml-runtime` at the exact
//      pins in the release manifest's `limnMlRuntime`, by the same npm machinery as the AI
//      runtime (ai/runtime.ts), then pruned to this machine's platform;
//   2. the model: one int8 ModernBERT severity head (~150 MB), downloaded file by file from the
//      URLs in `limnMlModels`, each checked against its pinned sha256, into
//      `<dataDir>/ml-models/<version>/`.
//
// Neither starts without the reader asking ("Set up" in the app, or `limn ml install`): never a
// silent 200 MB on `npx`. Separate from the AI runtime on purpose — LIMN_AI_DISABLED does not
// switch off a non-LLM classifier.
//
// ⚠ DEV IS UNCHANGED BY ANY OF IT. The workspace resolves both packages, and the model is read
// from LIMN_ML_MODELS_DIR or, failing that, the packages/ml checkout's serving_assets — so
// `pnpm dev` scores locally with nothing to download.
//
// ⚠ NOTHING ELSE MAY IMPORT onnxruntime-node OR @huggingface/tokenizers. Type-only imports are
// fine; build-release.mjs greps the emitted JS for value imports.
import { createHash } from 'node:crypto';
import {
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { esmEntryOf, findPackageDir, installedVersion, resolveNpm, spawnNpm, type NpmCommand } from '../ai/runtime.js';
import { resolveDataDir } from '../data-dir.js';
import { headAvailable } from './onnx-head.js';

export type OrtModule = typeof import('onnxruntime-node');
export type TokenizersModule = typeof import('@huggingface/tokenizers');

export const ML_RUNTIME_PACKAGES = ['onnxruntime-node', '@huggingface/tokenizers'] as const;
export type MlRuntimePackage = (typeof ML_RUNTIME_PACKAGES)[number];
export type MlRuntimePins = Record<MlRuntimePackage, string>;

/** The release manifest's fields. Spelled once here; build-release.mjs mirrors both. */
export const ML_RUNTIME_MANIFEST_FIELD = 'limnMlRuntime';
export const ML_MODELS_MANIFEST_FIELD = 'limnMlModels';

/** One downloadable model file. `path` is relative to the version directory. */
export interface MlModelFile {
  path: string;
  url: string;
  sha256: string;
  size: number;
}
export interface MlModelsManifest {
  version: string;
  files: MlModelFile[];
}

/** Inside a model directory: the head the scorer loads. Mirrors the service's serving_assets. */
export const SEVERITY_HEAD_SUBDIR = join('modernbert-onnx', 'severity');

const EXACT_VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const SHA256 = /^[0-9a-f]{64}$/;
/** A model version names a directory: keep it to a safe, boring alphabet. */
const SAFE_VERSION = /^[0-9A-Za-z._-]{1,64}$/;

export type MlState = 'ready' | 'absent' | 'installing' | 'failed';
export interface MlStatus {
  state: MlState;
  message: string | null;
  /** Where the model is read from, when there is one. */
  modelsDir: string | null;
}
export interface MlInstallProgress {
  phase: 'starting' | 'downloading' | 'verifying' | 'done' | 'failed';
  message: string;
}
export type MlInstallResult = { ok: true } | { ok: false; message: string };

export const ML_MISSING_MESSAGE =
  'Bot comment scoring is not set up yet. Press "Set up" in Limn, or run: limn ml install';

const HERE = dirname(fileURLToPath(import.meta.url));

function readJsonSafe(path: string): Record<string, unknown> | null {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** A real model file, not a Git LFS pointer (a ~130-byte text stub) left by a clone without LFS. */
function isRealModelDir(dir: string): boolean {
  const head = join(dir, SEVERITY_HEAD_SUBDIR);
  if (!headAvailable(head)) return false;
  try {
    return statSync(join(head, 'model_quantized.onnx')).size > 1_000_000;
  } catch {
    return false;
  }
}

export interface MlRuntimeOptions {
  dataDir?: string;
  workspaceFrom?: string;
  /** The package root whose package.json carries the manifest fields. Default: two levels up. */
  packageRoot?: string;
  /** The dev checkout's model (packages/ml/serving_assets); null for none. */
  devModelsDir?: string | null;
  env?: NodeJS.ProcessEnv;
}

export interface MlInstallOptions {
  timeoutMs?: number;
  /** Test seam: stands in for npm. */
  npm?: NpmCommand;
  /** Test seam: stands in for the global fetch. */
  fetch?: typeof fetch;
}

export function createMlRuntime(opts: MlRuntimeOptions = {}) {
  const env = opts.env ?? process.env;
  const dataDir = opts.dataDir ?? resolveDataDir(env);
  const runtimeDir = join(dataDir, 'ml-runtime');
  const modelsRoot = join(dataDir, 'ml-models');
  const workspaceFrom = opts.workspaceFrom ?? HERE;
  const packageRoot = opts.packageRoot ?? resolve(HERE, '..', '..');
  // src/ml → apps/backend → the repo → packages/ml/serving_assets: a dev checkout only.
  const devModelsDir =
    opts.devModelsDir === undefined
      ? resolve(HERE, '..', '..', '..', '..', 'packages', 'ml', 'serving_assets')
      : opts.devModelsDir;

  const manifest = (): Record<string, unknown> | null => readJsonSafe(join(packageRoot, 'package.json'));

  // ---- pins ----
  function pins(): MlRuntimePins | null {
    const field = manifest()?.[ML_RUNTIME_MANIFEST_FIELD];
    const out: Partial<MlRuntimePins> = {};
    for (const name of ML_RUNTIME_PACKAGES) {
      let v: unknown = field && typeof field === 'object' ? (field as Record<string, unknown>)[name] : undefined;
      if (v === undefined) v = installedVersion(findPackageDir(name, workspaceFrom));
      if (typeof v !== 'string' || !EXACT_VERSION.test(v)) return null;
      out[name] = v;
    }
    return out as MlRuntimePins;
  }

  /** The model files this copy of Limn downloads, or null when it lists none (a dev checkout). */
  function modelsManifest(): MlModelsManifest | null {
    const raw = manifest()?.[ML_MODELS_MANIFEST_FIELD];
    if (!raw || typeof raw !== 'object') return null;
    const { version, files } = raw as { version?: unknown; files?: unknown };
    if (typeof version !== 'string' || !SAFE_VERSION.test(version) || !Array.isArray(files) || files.length === 0) {
      return null;
    }
    const out: MlModelFile[] = [];
    for (const f of files as Record<string, unknown>[]) {
      const { path, url, sha256, size } = f;
      if (
        typeof path !== 'string' ||
        path.split('/').some((seg) => seg === '' || seg === '.' || seg === '..') ||
        typeof url !== 'string' ||
        !url.startsWith('https://') ||
        typeof sha256 !== 'string' ||
        !SHA256.test(sha256) ||
        typeof size !== 'number'
      ) {
        return null;
      }
      out.push({ path, url, sha256, size });
    }
    return { version, files: out };
  }

  // ---- packages ----
  const workspaceHas = (name: MlRuntimePackage): boolean => findPackageDir(name, workspaceFrom) !== null;

  function runtimeDirReady(): boolean {
    if (!existsSync(join(runtimeDir, 'package.json'))) return false;
    const want = pins();
    return ML_RUNTIME_PACKAGES.every((name) => {
      const dir = findPackageDir(name, runtimeDir);
      return dir !== null && esmEntryOf(dir) !== null && (!want || installedVersion(dir) === want[name]);
    });
  }

  const packagesReady = (): boolean => ML_RUNTIME_PACKAGES.every(workspaceHas) || runtimeDirReady();

  // ---- model ----
  /** The model directory to read, in order: the override, the dev checkout, the download. */
  function modelsDir(): string | null {
    const override = env.LIMN_ML_MODELS_DIR?.trim();
    if (override) return isRealModelDir(override) ? resolve(override) : null;
    if (devModelsDir && isRealModelDir(devModelsDir)) return devModelsDir;
    const want = modelsManifest();
    if (want) {
      const dir = join(modelsRoot, want.version);
      if (isRealModelDir(dir)) return dir;
    }
    return null;
  }

  // ---- status ----
  let inFlight: Promise<MlInstallResult> | null = null;
  const listeners = new Set<(p: MlInstallProgress) => void>();
  let lastFailure: string | null = null;

  function status(): MlStatus {
    const dir = modelsDir();
    if (inFlight) return { state: 'installing', message: null, modelsDir: dir };
    if (packagesReady() && dir) return { state: 'ready', message: null, modelsDir: dir };
    if (lastFailure) return { state: 'failed', message: lastFailure, modelsDir: dir };
    return { state: 'absent', message: null, modelsDir: dir };
  }

  // ---- loading ----
  const loaded = new Map<MlRuntimePackage, Promise<unknown>>();

  function load<T>(name: MlRuntimePackage): Promise<T> {
    const hit = loaded.get(name);
    if (hit) return hit as Promise<T>;
    const p = (async () => {
      let mod: unknown;
      if (workspaceHas(name) && workspaceFrom === HERE) {
        mod = name === 'onnxruntime-node' ? await import('onnxruntime-node') : await import('@huggingface/tokenizers');
      } else {
        const from = workspaceHas(name) ? workspaceFrom : runtimeDirReady() ? runtimeDir : null;
        const dir = from ? findPackageDir(name, from) : null;
        const entry = dir ? esmEntryOf(dir) : null;
        if (!entry) throw new Error(ML_MISSING_MESSAGE);
        mod = await import(pathToFileURL(entry).href);
      }
      // onnxruntime-node is CommonJS: an ESM import hands its exports over as `default`.
      const m = mod as { default?: unknown; InferenceSession?: unknown };
      return (m.InferenceSession === undefined && m.default ? m.default : mod) as T;
    })();
    loaded.set(name, p);
    p.catch(() => loaded.delete(name));
    return p;
  }

  // ---- install ----
  function emit(p: MlInstallProgress): void {
    for (const l of listeners) {
      try {
        l(p);
      } catch {
        /* a listener's failure is its own */
      }
    }
  }

  function install(onProgress?: (p: MlInstallProgress) => void, installOpts: MlInstallOptions = {}): Promise<MlInstallResult> {
    if (onProgress) listeners.add(onProgress);
    const detach = (): void => {
      if (onProgress) listeners.delete(onProgress);
    };
    if (inFlight) return inFlight.finally(detach);
    inFlight = runInstall(installOpts).finally(() => {
      inFlight = null;
    });
    return inFlight.finally(detach);
  }

  async function runInstall(installOpts: MlInstallOptions): Promise<MlInstallResult> {
    const failWith = (message: string): MlInstallResult => {
      lastFailure = message;
      emit({ phase: 'failed', message });
      return { ok: false, message };
    };
    lastFailure = null;

    if (!packagesReady()) {
      const r = await installPackages(installOpts, failWith);
      if (!r.ok) return r;
    }
    if (!modelsDir()) {
      const r = await downloadModel(installOpts, failWith);
      if (!r.ok) return r;
    }
    emit({ phase: 'done', message: 'Bot comment scoring is set up.' });
    return { ok: true };
  }

  async function installPackages(
    installOpts: MlInstallOptions,
    failWith: (m: string) => MlInstallResult,
  ): Promise<MlInstallResult> {
    const want = pins();
    if (!want) return failWith('This copy of Limn does not list which versions to download. Update Limn and try again.');
    const npm = installOpts.npm ?? resolveNpm(env);
    if (!npm) return failWith('npm was not found. Install Node.js with npm, then try again.');

    emit({ phase: 'starting', message: 'Downloading the model runtime (about 90 MB).' });
    const staging = `${runtimeDir}.staging-${process.pid}-${Date.now()}`;
    try {
      mkdirSync(staging, { recursive: true });
      writeFileSync(
        join(staging, 'package.json'),
        JSON.stringify(
          {
            name: 'limn-ml-runtime',
            private: true,
            description: 'The model runtime Limn downloads on first use. Safe to delete; Limn can download it again.',
            dependencies: want,
          },
          null,
          2,
        ) + '\n',
      );
    } catch (err) {
      rmSync(staging, { recursive: true, force: true });
      return failWith(`Could not write to ${dataDir}: ${(err as Error).message}`);
    }

    const timeoutMs = installOpts.timeoutMs ?? 10 * 60_000;
    // `--ignore-scripts`: onnxruntime-node's only script fetches GPU builds we do not use.
    const exit = await spawnNpm(
      npm,
      [...npm.args, 'install', '--prefix', staging, '--no-audit', '--no-fund', '--no-update-notifier', '--ignore-scripts', '--no-package-lock'],
      { cwd: staging, env, timeoutMs, onLine: (line) => emit({ phase: 'downloading', message: line.slice(0, 200) }) },
    );
    if (exit.error || exit.timedOut || exit.code !== 0) {
      rmSync(staging, { recursive: true, force: true });
      if (exit.error) return failWith(exit.error);
      if (exit.timedOut) return failWith('The download took too long and was stopped. Check your network and try again: limn ml install');
      const last = exit.tail.filter((l) => /err/i.test(l)).slice(-2).join(' ') || exit.tail.slice(-1)[0] || '';
      return failWith(
        `The download failed (npm exit code ${exit.code}). Try again: limn ml install${last ? `. npm said: ${last.slice(0, 300)}` : ''}`,
      );
    }

    emit({ phase: 'verifying', message: 'Checking the download.' });
    for (const name of ML_RUNTIME_PACKAGES) {
      const dir = findPackageDir(name, staging);
      if (!dir || installedVersion(dir) !== want[name] || !esmEntryOf(dir)) {
        rmSync(staging, { recursive: true, force: true });
        return failWith(`The download finished but ${name} ${want[name]} is missing from it. Try again: limn ml install`);
      }
    }
    pruneOtherPlatforms(findPackageDir('onnxruntime-node', staging)!);

    const old = `${runtimeDir}.old-${process.pid}-${Date.now()}`;
    try {
      if (existsSync(runtimeDir)) renameSync(runtimeDir, old);
      renameSync(staging, runtimeDir);
    } catch (err) {
      if (!existsSync(runtimeDir) && existsSync(old)) renameSync(old, runtimeDir);
      rmSync(staging, { recursive: true, force: true });
      return failWith(`Could not finish the setup in ${runtimeDir}: ${(err as Error).message}`);
    }
    rmSync(old, { recursive: true, force: true });
    loaded.clear();
    return { ok: true };
  }

  async function downloadModel(
    installOpts: MlInstallOptions,
    failWith: (m: string) => MlInstallResult,
  ): Promise<MlInstallResult> {
    const want = modelsManifest();
    if (!want) return failWith('This copy of Limn does not list a model to download. Update Limn and try again.');
    const doFetch = installOpts.fetch ?? fetch;
    const total = want.files.reduce((n, f) => n + f.size, 0);
    emit({ phase: 'starting', message: `Downloading the model (about ${Math.round(total / 1e6)} MB).` });

    const finalDir = join(modelsRoot, want.version);
    const staging = `${finalDir}.staging-${process.pid}-${Date.now()}`;
    let done = 0;
    try {
      for (const f of want.files) {
        const dest = join(staging, ...f.path.split('/'));
        mkdirSync(dirname(dest), { recursive: true });
        const res = await doFetch(f.url, { redirect: 'follow', signal: AbortSignal.timeout(installOpts.timeoutMs ?? 30 * 60_000) });
        if (!res.ok || !res.body) throw new Error(`${f.path}: the server answered ${res.status}`);
        const hash = createHash('sha256');
        let got = 0;
        let lastPct = -1;
        const meter = new Transform({
          transform(chunk: Buffer, _enc, cb) {
            hash.update(chunk);
            got += chunk.length;
            const pct = total > 0 ? Math.floor(((done + got) / total) * 100) : 0;
            if (pct !== lastPct) {
              lastPct = pct;
              emit({ phase: 'downloading', message: `Downloading the model: ${pct}%` });
            }
            cb(null, chunk);
          },
        });
        await pipeline(Readable.fromWeb(res.body as Parameters<typeof Readable.fromWeb>[0]), meter, createWriteStream(dest));
        if (got !== f.size || hash.digest('hex') !== f.sha256) {
          throw new Error(`${f.path} did not match its checksum`);
        }
        done += got;
      }
      emit({ phase: 'verifying', message: 'Checking the model.' });
      if (!isRealModelDir(staging)) throw new Error('the downloaded files do not form a model');
      rmSync(finalDir, { recursive: true, force: true });
      renameSync(staging, finalDir);
    } catch (err) {
      rmSync(staging, { recursive: true, force: true });
      return failWith(`The model download failed: ${(err as Error).message}. Try again: limn ml install`);
    }
    // Older versions' directories are dead weight once this one is in place.
    for (const name of readdirSafe(modelsRoot)) {
      if (name !== want.version && !name.includes('.staging-')) rmSync(join(modelsRoot, name), { recursive: true, force: true });
    }
    return { ok: true };
  }

  return { runtimeDir, modelsRoot, pins, modelsManifest, modelsDir, status, install, load };
}

function readdirSafe(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

/** Keep only this machine's native binaries: the package ships every platform's (~250 MB). */
export function pruneOtherPlatforms(ortDir: string): void {
  const bin = join(ortDir, 'bin');
  for (const napi of readdirSafe(bin)) {
    for (const platform of readdirSafe(join(bin, napi))) {
      const pdir = join(bin, napi, platform);
      if (platform !== process.platform) {
        rmSync(pdir, { recursive: true, force: true });
        continue;
      }
      for (const arch of readdirSafe(pdir)) {
        if (arch !== process.arch) rmSync(join(pdir, arch), { recursive: true, force: true });
      }
    }
  }
}

// ---- the app's runtime ----------------------------------------------------------------------

const runtime = createMlRuntime();

export const getMlStatus = (): MlStatus => runtime.status();
export const installMl = (onProgress?: (p: MlInstallProgress) => void, opts?: MlInstallOptions): Promise<MlInstallResult> =>
  runtime.install(onProgress, opts);
export const mlModelsDir = (): string | null => runtime.modelsDir();
export const loadOrt = (): Promise<OrtModule> => runtime.load<OrtModule>('onnxruntime-node');
export const loadTokenizers = (): Promise<TokenizersModule> => runtime.load<TokenizersModule>('@huggingface/tokenizers');
