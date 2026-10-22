import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createMlRuntime, pruneOtherPlatforms, type MlModelFile } from './runtime.js';

// The model download and its guards. The packages come from the workspace (the dev checkout), so
// only the model half is exercised; `fetch` is a stub serving bytes from memory.
let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'limn-ml-runtime-'));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');
/** A model whose ONNX file is "real" (over the 1 MB LFS-pointer floor). */
function modelBytes(): Record<string, Buffer> {
  return {
    'modernbert-onnx/input_format.json': Buffer.from('{"path_in_text": true}'),
    'modernbert-onnx/severity/model_quantized.onnx': Buffer.alloc(1_100_000, 7),
    'modernbert-onnx/severity/config.json': Buffer.from('{"id2label": {"0": "NIT"}}'),
    'modernbert-onnx/severity/tokenizer.json': Buffer.from('{}'),
  };
}

function setup(files: Record<string, Buffer>, tweak?: (f: MlModelFile) => MlModelFile) {
  const pkgRoot = join(root, 'pkg');
  mkdirSync(pkgRoot, { recursive: true });
  const listed = Object.entries(files).map(([path, b]) =>
    (tweak ?? ((f) => f))({ path, url: `https://models.example/${path}`, sha256: sha(b), size: b.length }),
  );
  writeFileSync(join(pkgRoot, 'package.json'), JSON.stringify({ limnMlModels: { version: 'sev-test1', files: listed } }));
  const served = new Map(Object.entries(files).map(([p, b]) => [`https://models.example/${p}`, b]));
  const fetchStub = (async (url: string) => {
    const b = served.get(String(url));
    return b ? new Response(new Uint8Array(b)) : new Response('nope', { status: 404 });
  }) as unknown as typeof fetch;
  const rt = createMlRuntime({ dataDir: join(root, 'data'), packageRoot: pkgRoot, devModelsDir: null, env: {} });
  return { rt, fetchStub };
}

describe('ml runtime: the model download', () => {
  it('is absent before, downloads every listed file, and is ready after', async () => {
    const { rt, fetchStub } = setup(modelBytes());
    expect(rt.status().state).toBe('absent');
    expect(rt.modelsDir()).toBeNull();
    const result = await rt.install(undefined, { fetch: fetchStub });
    expect(result).toEqual({ ok: true });
    const dir = join(root, 'data', 'ml-models', 'sev-test1');
    expect(rt.modelsDir()).toBe(dir);
    expect(rt.status().state).toBe('ready');
    expect(readFileSync(join(dir, 'modernbert-onnx/severity/config.json'), 'utf8')).toContain('NIT');
  });

  it('refuses a file that does not match its checksum, and leaves nothing behind', async () => {
    const { rt, fetchStub } = setup(modelBytes(), (f) =>
      f.path.endsWith('.onnx') ? { ...f, sha256: '0'.repeat(64) } : f,
    );
    const result = await rt.install(undefined, { fetch: fetchStub });
    expect(result.ok).toBe(false);
    expect(rt.status().state).toBe('failed');
    expect(existsSync(join(root, 'data', 'ml-models', 'sev-test1'))).toBe(false);
  });

  it('reports a server error by file', async () => {
    const files = modelBytes();
    const { rt } = setup(files);
    const notFound = (async () => new Response('gone', { status: 404 })) as unknown as typeof fetch;
    const result = await rt.install(undefined, { fetch: notFound });
    expect(result).toMatchObject({ ok: false });
    expect((result as { message: string }).message).toMatch(/answered 404/);
  });

  it('ignores a manifest that could write outside its directory or fetch over http', () => {
    expect(setup(modelBytes(), (f) => ({ ...f, path: `../${f.path}` })).rt.modelsManifest()).toBeNull();
    expect(setup(modelBytes(), (f) => ({ ...f, url: f.url.replace('https', 'http') })).rt.modelsManifest()).toBeNull();
  });

  it('treats a Git LFS pointer as no model', () => {
    const dir = join(root, 'lfs');
    mkdirSync(join(dir, 'modernbert-onnx', 'severity'), { recursive: true });
    for (const f of ['model_quantized.onnx', 'config.json', 'tokenizer.json']) {
      writeFileSync(join(dir, 'modernbert-onnx', 'severity', f), 'version https://git-lfs.github.com/spec/v1\n');
    }
    const rt = createMlRuntime({ dataDir: join(root, 'data'), packageRoot: root, devModelsDir: dir, env: {} });
    expect(rt.modelsDir()).toBeNull();
  });
});

describe('pruneOtherPlatforms', () => {
  it("keeps only this machine's binaries", () => {
    const bin = join(root, 'ort', 'bin', 'napi-v6');
    for (const p of ['darwin', 'linux', 'win32']) for (const a of ['x64', 'arm64']) mkdirSync(join(bin, p, a), { recursive: true });
    pruneOtherPlatforms(join(root, 'ort'));
    for (const p of ['darwin', 'linux', 'win32']) {
      for (const a of ['x64', 'arm64']) {
        expect(existsSync(join(bin, p, a))).toBe(p === process.platform && a === process.arch);
      }
    }
  });
});
