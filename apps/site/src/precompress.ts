// Build step: write `<file>.br` and `<file>.gz` beside every compressible file in the
// given folders, at maximum quality, so the server streams them as they are and never
// compresses a big bundle while a visitor waits (static.ts).
//
//   node dist/precompress.js <dir> [<dir> ...]
//
// Run by the Dockerfile over the assembled landing and demo folders. Uses the same
// COMPRESSIBLE list and size floor as the server, so the two cannot disagree about which
// files get a sidecar. A sidecar no smaller than its file is not written; the server then
// compresses that file on demand, which is the same answer.
import { readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { brotliCompress, constants as zlib, gzip } from 'node:zlib';
import { COMPRESSIBLE, MIN_COMPRESS_BYTES, SIDECAR_EXT } from './static.js';

const brotliAsync = promisify(brotliCompress);
const gzipAsync = promisify(gzip);

async function* walk(dir: string): AsyncGenerator<string> {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(full);
    else if (entry.isFile()) yield full;
  }
}

export interface PrecompressResult {
  files: number;
  written: number;
  bytesIn: number;
  bytesOut: number;
}

/** Precompress every eligible file under `dir`. */
export async function precompressDir(dir: string): Promise<PrecompressResult> {
  const result: PrecompressResult = { files: 0, written: 0, bytesIn: 0, bytesOut: 0 };
  for await (const file of walk(dir)) {
    if (!COMPRESSIBLE.has(extname(file).toLowerCase())) continue;
    const st = await stat(file);
    if (st.size <= MIN_COMPRESS_BYTES) continue;
    const body = await readFile(file);
    result.files += 1;
    const [br, gz] = await Promise.all([
      brotliAsync(body, {
        params: {
          [zlib.BROTLI_PARAM_QUALITY]: zlib.BROTLI_MAX_QUALITY,
          [zlib.BROTLI_PARAM_SIZE_HINT]: body.length,
        },
      }),
      gzipAsync(body, { level: 9 }),
    ]);
    for (const [out, ext] of [
      [br, SIDECAR_EXT.br],
      [gz, SIDECAR_EXT.gzip],
    ] as const) {
      if (out.length >= body.length) continue;
      await writeFile(file + ext, out);
      result.written += 1;
      result.bytesIn += body.length;
      result.bytesOut += out.length;
    }
  }
  return result;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const dirs = process.argv.slice(2);
  if (dirs.length === 0) {
    process.stderr.write('usage: precompress <dir> [<dir> ...]\n');
    process.exit(2);
  }
  for (const dir of dirs) {
    const r = await precompressDir(dir);
    process.stdout.write(
      `precompress ${dir}: ${r.files} files, ${r.written} sidecars, ${r.bytesIn} → ${r.bytesOut} bytes\n`,
    );
  }
}
