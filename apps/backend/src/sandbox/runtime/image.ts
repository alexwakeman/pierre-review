// THE SANDBOX IMAGE: which one, and where it comes from (docs/SANDBOX.md § The image; owner decision
// Q3). In order:
//
//   1. a LOCAL image tagged `limn-sandbox:local-<recipe>` → use it;
//   2. the release's PINNED image (`limnSandboxImage` in the release manifest: GHCR repository + the
//      manifest-list DIGEST CI pushed), pulled BY DIGEST and tagged locally — only when the pin's recipe
//      equals the shipped Dockerfile's, so a pull can never stand in for a different build;
//   3. else, or when the pull fails, a LOCAL BUILD from the shipped Dockerfile.
//
// THE RECIPE is a short hash of the Dockerfile's bytes, the files it COPYs, and the two pinned CLI versions (Claude Code =
// the Agent SDK's bundled CLI, Codex = `limnAiRuntime`). It is the local tag and an image label
// (`limn.recipe`), so a Dockerfile edit or a pin bump rebuilds instead of reusing a stale image. CI and
// build-release.mjs compute it with THIS module (scripts/sandbox-image.ts, dist import), never a copy.
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { findPackageDir } from '../../ai/runtime.js';

const HERE = dirname(fileURLToPath(import.meta.url));

/** The release manifest's field: `{ repository, tag, digest, recipe, buildArgs }`. build-release.mjs writes it. */
export const SANDBOX_IMAGE_MANIFEST_FIELD = 'limnSandboxImage';
export const LOCAL_IMAGE_REPO = 'limn-sandbox';
export const RECIPE_LABEL = 'limn.recipe';

export interface ImageBuildArgs {
  CLAUDE_CODE_VERSION: string;
  CODEX_VERSION: string;
}

export interface ImageRecipe {
  /** 16 hex characters. */
  recipe: string;
  buildArgs: ImageBuildArgs;
  /** `limn-sandbox:local-<recipe>`. */
  localTag: string;
  /** The folder holding the Dockerfile (the build context). */
  contextDir: string;
}

export interface ImagePin {
  repository: string;
  tag: string;
  digest: string;
  recipe: string;
}

const EXACT = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const DIGEST = /^sha256:[0-9a-f]{64}$/;
const REPOSITORY = /^[a-z0-9][a-z0-9._/-]*[a-z0-9]$/;

/** The other files the Dockerfile COPYs (`limn-svc`, `limn-svcd.mjs`): part of the recipe too, so an
 *  edit to one rebuilds the image. */
export interface ContextFile {
  name: string;
  bytes: Buffer;
}

export function recipeHash(dockerfile: string | Buffer, args: ImageBuildArgs, files: readonly ContextFile[] = []): string {
  const h = createHash('sha256')
    .update('limn-sandbox-recipe-v1\n')
    .update(dockerfile)
    .update(`\nCLAUDE_CODE_VERSION=${args.CLAUDE_CODE_VERSION}\nCODEX_VERSION=${args.CODEX_VERSION}\n`);
  for (const f of [...files].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
    h.update(`FILE ${f.name} ${f.bytes.length}\n`).update(f.bytes);
  }
  return h.digest('hex').slice(0, 16);
}

/** Every regular file in the build context except the Dockerfile, by relative path (symlinks skipped). */
export function contextFiles(contextDir: string, rel = ''): ContextFile[] {
  const out: ContextFile[] = [];
  for (const e of readdirSync(join(contextDir, rel), { withFileTypes: true })) {
    const name = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...contextFiles(contextDir, name));
    else if (e.isFile() && name !== 'Dockerfile') out.push({ name, bytes: readFileSync(join(contextDir, name)) });
  }
  return out;
}

/** src/sandbox/runtime → apps/backend/sandbox-image; dist/sandbox/runtime → dist/sandbox-image (release). */
export function sandboxImageDir(from: string = HERE): string | null {
  for (const dir of [resolve(from, '..', '..', 'sandbox-image'), resolve(from, '..', '..', '..', 'sandbox-image')]) {
    if (existsSync(join(dir, 'Dockerfile'))) return dir;
  }
  return null;
}

function readJson(path: string): Record<string, unknown> | null {
  try {
    const v: unknown = JSON.parse(readFileSync(path, 'utf8'));
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** The package root whose package.json is Limn's (apps/backend in dev, the release root). */
export function packageRootFrom(from: string = HERE): string {
  return resolve(from, '..', '..', '..');
}

/**
 * The two CLI pins. The release manifest's `limnSandboxImage.buildArgs` first (the release has no SDK
 * in node_modules); in a dev checkout the workspace's Agent SDK `claudeCodeVersion` and the backend's
 * own `limnAiRuntime['@openai/codex']`. Null when either is not an exact version.
 */
export function imageBuildArgs(packageRoot: string = packageRootFrom(), workspaceFrom: string = HERE): ImageBuildArgs | null {
  const manifest = readJson(join(packageRoot, 'package.json'));
  const field = manifest?.[SANDBOX_IMAGE_MANIFEST_FIELD] as { buildArgs?: Partial<ImageBuildArgs> } | undefined;
  let claude: unknown = field?.buildArgs?.CLAUDE_CODE_VERSION;
  let codex: unknown = field?.buildArgs?.CODEX_VERSION;
  if (claude === undefined) {
    const sdk = findPackageDir('@anthropic-ai/claude-agent-sdk', workspaceFrom);
    claude = sdk ? readJson(join(sdk, 'package.json'))?.claudeCodeVersion : undefined;
  }
  if (codex === undefined) {
    const runtime = manifest?.limnAiRuntime as Record<string, unknown> | undefined;
    codex = runtime?.['@openai/codex'];
  }
  if (typeof claude !== 'string' || !EXACT.test(claude) || typeof codex !== 'string' || !EXACT.test(codex)) return null;
  return { CLAUDE_CODE_VERSION: claude, CODEX_VERSION: codex };
}

export function imageRecipe(opts: { contextDir?: string | null; buildArgs?: ImageBuildArgs | null } = {}): ImageRecipe | null {
  const contextDir = opts.contextDir === undefined ? sandboxImageDir() : opts.contextDir;
  const buildArgs = opts.buildArgs === undefined ? imageBuildArgs() : opts.buildArgs;
  if (!contextDir || !buildArgs) return null;
  const recipe = recipeHash(readFileSync(join(contextDir, 'Dockerfile')), buildArgs, contextFiles(contextDir));
  return { recipe, buildArgs, localTag: `${LOCAL_IMAGE_REPO}:local-${recipe}`, contextDir };
}

/** The release's pinned image, or null (a dev checkout, or a release CI could not push an image for). */
export function readImagePin(packageRoot: string = packageRootFrom()): ImagePin | null {
  const field = readJson(join(packageRoot, 'package.json'))?.[SANDBOX_IMAGE_MANIFEST_FIELD];
  if (!field || typeof field !== 'object') return null;
  const f = field as Record<string, unknown>;
  if (typeof f.repository !== 'string' || !REPOSITORY.test(f.repository)) return null;
  if (typeof f.digest !== 'string' || !DIGEST.test(f.digest)) return null;
  if (typeof f.recipe !== 'string' || !/^[0-9a-f]{16}$/.test(f.recipe)) return null;
  return { repository: f.repository, tag: typeof f.tag === 'string' ? f.tag : '', digest: f.digest, recipe: f.recipe };
}

/** `docker build` argv for the local fallback. The recipe rides as a build arg into the label. */
export function buildArgv(r: ImageRecipe): string[] {
  return [
    'build',
    '--tag', r.localTag,
    '--build-arg', `CLAUDE_CODE_VERSION=${r.buildArgs.CLAUDE_CODE_VERSION}`,
    '--build-arg', `CODEX_VERSION=${r.buildArgs.CODEX_VERSION}`,
    '--build-arg', `LIMN_RECIPE=${r.recipe}`,
    r.contextDir,
  ];
}

/** The pull reference for a pin, or null when the pin is for a different recipe. */
export function pinnedPullRef(pin: ImagePin | null, r: ImageRecipe): string | null {
  if (!pin || pin.recipe !== r.recipe) return null;
  return `${pin.repository}@${pin.digest}`;
}
