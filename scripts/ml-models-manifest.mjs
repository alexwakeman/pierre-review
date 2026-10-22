#!/usr/bin/env node
// Write apps/backend/ml-models.json — the model files a release tells "Set up" to download
// (`limnMlModels` in the npm manifest; docs/ML-NODE-PORT.md, Phase 4).
//
//   node scripts/ml-models-manifest.mjs --base-url <url> [--assets <dir>]
//
// It hashes the severity head in packages/ml/serving_assets (v1 ships severity only) and lists
// each file as `<base-url>/<asset name>`, where the asset name is the file's path with `/`
// replaced by `__` (a GitHub release holds a flat list of assets). It UPLOADS NOTHING: publish the
// files under exactly those names first, then run this, then commit the JSON.
//
// The version is the model's own identity (`sev-<digest>`), so a retrained model is a new
// directory on every machine and an unchanged one is never downloaded twice.
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const repoRoot = resolve(new URL('..', import.meta.url).pathname);
const args = process.argv.slice(2);
const arg = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const baseUrl = arg('--base-url');
const assets = resolve(arg('--assets') ?? join(repoRoot, 'packages', 'ml', 'serving_assets'));
if (!baseUrl || !baseUrl.startsWith('https://')) {
  console.error('usage: node scripts/ml-models-manifest.mjs --base-url https://… [--assets <dir>]');
  process.exit(1);
}

// What the local scorer loads (ml/onnx-head.ts + ml/model.ts's identity digest).
const FILES = [
  'modernbert-onnx/input_format.json',
  'modernbert-onnx/severity/model_quantized.onnx',
  'modernbert-onnx/severity/config.json',
  'modernbert-onnx/severity/tokenizer.json',
  'modernbert-onnx/severity/calibration.json',
];

const files = FILES.map((path) => {
  const full = join(assets, ...path.split('/'));
  if (!existsSync(full)) {
    console.error(`missing ${full}`);
    process.exit(1);
  }
  const size = statSync(full).size;
  if (path.endsWith('.onnx') && size < 1_000_000) {
    console.error(`${full} is ${size} bytes — a Git LFS pointer, not the model (git lfs pull)`);
    process.exit(1);
  }
  const sha256 = createHash('sha256').update(readFileSync(full)).digest('hex');
  return { path, url: `${baseUrl.replace(/\/$/, '')}/${path.replaceAll('/', '__')}`, sha256, size };
});

// Short, stable, content-derived: the weights' and calibration's hashes.
const version = `sev-${createHash('sha256')
  .update(files.map((f) => `${f.path}:${f.sha256}`).join('\n'))
  .digest('hex')
  .slice(0, 12)}`;

const out = join(repoRoot, 'apps', 'backend', 'ml-models.json');
writeFileSync(out, JSON.stringify({ version, files }, null, 2) + '\n');
console.log(`wrote ${out}: ${version}, ${files.length} files, ${Math.round(files.reduce((n, f) => n + f.size, 0) / 1e6)} MB`);
console.log('Upload each file under its asset name before releasing:');
for (const f of files) console.log(`  ${join(assets, ...f.path.split('/'))}  →  ${f.path.replaceAll('/', '__')}`);
