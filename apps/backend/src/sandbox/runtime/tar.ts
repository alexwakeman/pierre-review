// A minimal ustar writer (file entries only) for `copyIn`: the files go into the sandbox as one tar
// stream on `tar -x`'s stdin, run AS THE AGENT, so they are the agent's and nothing touches the host.
// GNU tar creates missing parent folders itself, so no folder entries are written (a folder entry for
// an existing root-owned mount point would fail to extract as a non-root user).
import type { FileToCopy } from './types.js';

const BLOCK = 512;

function octal(n: number, width: number): string {
  return n.toString(8).padStart(width - 1, '0') + '\0';
}

function splitPath(path: string): { name: string; prefix: string } {
  const p = path.replace(/^\/+/, '');
  if (Buffer.byteLength(p) <= 100) return { name: p, prefix: '' };
  for (let i = p.lastIndexOf('/'); i > 0; i = p.lastIndexOf('/', i - 1)) {
    const prefix = p.slice(0, i);
    const name = p.slice(i + 1);
    if (Buffer.byteLength(prefix) <= 155 && Buffer.byteLength(name) <= 100) return { name, prefix };
  }
  throw new Error(`Path too long for the sandbox copy: ${path}`);
}

function header(path: string, size: number, mode: number, mtime: number): Buffer {
  const h = Buffer.alloc(BLOCK, 0);
  const { name, prefix } = splitPath(path);
  h.write(name, 0, 100, 'utf8');
  h.write(octal(mode & 0o7777, 8), 100, 8, 'ascii');
  h.write(octal(0, 8), 108, 8, 'ascii');
  h.write(octal(0, 8), 116, 8, 'ascii');
  h.write(octal(size, 12), 124, 12, 'ascii');
  h.write(octal(mtime, 12), 136, 12, 'ascii');
  h.write('        ', 148, 8, 'ascii'); // checksum placeholder: spaces
  h.write('0', 156, 1, 'ascii'); // regular file
  h.write('ustar\0', 257, 6, 'ascii');
  h.write('00', 263, 2, 'ascii');
  h.write(prefix, 345, 155, 'utf8');
  let sum = 0;
  for (const b of h) sum += b;
  h.write(octal(sum, 7) + ' ', 148, 8, 'ascii');
  return h;
}

/** One tar archive holding `files` at their absolute paths (stored relative to `/`). */
export function tarFiles(files: FileToCopy[], mtime: number = Math.floor(Date.now() / 1000)): Buffer {
  const parts: Buffer[] = [];
  for (const f of files) {
    if (!f.path.startsWith('/') || f.path.split('/').includes('..') || f.path.endsWith('/')) {
      throw new Error(`Sandbox copy path must be an absolute file path: ${JSON.stringify(f.path)}`);
    }
    const body = typeof f.content === 'string' ? Buffer.from(f.content, 'utf8') : f.content;
    parts.push(header(f.path, body.length, f.mode ?? 0o644, mtime), body);
    const pad = (BLOCK - (body.length % BLOCK)) % BLOCK;
    if (pad) parts.push(Buffer.alloc(pad, 0));
  }
  parts.push(Buffer.alloc(BLOCK * 2, 0));
  return Buffer.concat(parts);
}
