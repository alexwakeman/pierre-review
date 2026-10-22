// Compression: precompressed sidecars, the async on-demand fallback, and the build step.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { brotliCompressSync, brotliDecompressSync, gunzipSync } from 'node:zlib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { precompressDir } from './precompress.js';
import { compressedOnDemand, fileAt, sendFile } from './static.js';

let root: string;
let server: Server;
let base: string;

const BIG = `console.log("original");${' '.repeat(5000)}`;

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'limn-static-'));
  mkdirSync(join(root, 'assets'), { recursive: true });
  server = createServer((req, res) => {
    const file = join(root, (req.url ?? '/').split('?')[0] ?? '/');
    const st = fileAt(file);
    if (!st) {
      res.statusCode = 404;
      res.end();
      return;
    }
    void sendFile(req, res, file, st, { cache: 'immutable' });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  rmSync(root, { recursive: true, force: true });
});

describe('precompressed sidecars', () => {
  it('streams the build’s .br sidecar instead of compressing the file', async () => {
    const file = join(root, 'assets', 'side.js');
    writeFileSync(file, BIG);
    // A sidecar whose content differs from the file, so the answer proves which was sent.
    writeFileSync(`${file}.br`, brotliCompressSync(Buffer.from('from the sidecar')));
    const res = await fetch(`${base}/assets/side.js`, { headers: { 'accept-encoding': 'br' } });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-encoding')).toBe('br');
    expect(res.headers.get('vary')).toBe('Accept-Encoding');
    expect(await res.text()).toBe('from the sidecar');
  });

  it('ignores a sidecar older than its file, and compresses on demand instead', async () => {
    const file = join(root, 'assets', 'stale.js');
    writeFileSync(file, BIG);
    writeFileSync(`${file}.gz`, Buffer.from('not even gzip'));
    const old = new Date(statSync(file).mtimeMs - 60_000);
    utimesSync(`${file}.gz`, old, old);
    const res = await fetch(`${base}/assets/stale.js`, { headers: { 'accept-encoding': 'gzip' } });
    expect(res.headers.get('content-encoding')).toBe('gzip');
    expect(await res.text()).toBe(BIG);
  });

  it('sends the file as it is when the browser accepts no encoding', async () => {
    const file = join(root, 'assets', 'plain.js');
    writeFileSync(file, BIG);
    const res = await fetch(`${base}/assets/plain.js`, { headers: { 'accept-encoding': 'identity' } });
    expect(res.headers.get('content-encoding')).toBeNull();
    expect(await res.text()).toBe(BIG);
  });
});

describe('on-demand compression', () => {
  it('runs one job per file and encoding, shared by concurrent first requests', async () => {
    const file = join(root, 'assets', 'shared.js');
    writeFileSync(file, BIG);
    const st = statSync(file);
    const a = compressedOnDemand(file, st, 'br');
    const b = compressedOnDemand(file, st, 'br');
    expect(a).toBe(b);
    expect(brotliDecompressSync(await a).toString()).toBe(BIG);
    expect(compressedOnDemand(file, st, 'gzip')).not.toBe(a);
  });

  it('forgets a failed job, so the next request tries again', async () => {
    const file = join(root, 'assets', 'gone.js');
    writeFileSync(file, BIG);
    const st = statSync(file);
    rmSync(file);
    const first = compressedOnDemand(file, st, 'br');
    await expect(first).rejects.toThrow();
    expect(compressedOnDemand(file, st, 'br')).not.toBe(first);
    await compressedOnDemand(file, st, 'br').catch(() => {});
  });
});

describe('precompressDir', () => {
  it('writes .br and .gz beside each big text file and nothing else', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'limn-precompress-'));
    try {
      mkdirSync(join(dir, 'assets'));
      writeFileSync(join(dir, 'assets', 'big.js'), BIG);
      writeFileSync(join(dir, 'small.css'), 'a{}');
      writeFileSync(join(dir, 'clip.mp4'), Buffer.alloc(5000, 1));
      const r = await precompressDir(dir);
      expect(r.files).toBe(1);
      expect(r.written).toBe(2);
      expect(brotliDecompressSync(readFileSync(join(dir, 'assets', 'big.js.br'))).toString()).toBe(BIG);
      expect(gunzipSync(readFileSync(join(dir, 'assets', 'big.js.gz'))).toString()).toBe(BIG);
      expect(existsSync(join(dir, 'small.css.br'))).toBe(false);
      expect(existsSync(join(dir, 'clip.mp4.br'))).toBe(false);
      // A second run does not compress its own sidecars.
      expect((await precompressDir(dir)).files).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
