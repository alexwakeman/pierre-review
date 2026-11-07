// A SERVICE BUILD'S DOCKERFILE, CHECKED AS IT LEAVES THE SANDBOX (docs/SANDBOX.md § Services → Builds).
//
// The classic builder runs each `RUN` step on the session network (only the proxy is reachable), but two
// things a Dockerfile asks for are done by the HOST'S DAEMON, on the host's network, never through the
// proxy:
//   • `ADD <url>` (and `ADD git@…`): the daemon downloads it — a way out to ANY host, the URL carrying
//     whatever the agent puts in it;
//   • `FROM <image>` and `COPY --from=<image>`: the daemon pulls the image.
// So `ADD` from a URL (or from a variable, which can expand to one) is REFUSED, and a pulled image must
// come from an allowed registry, as a compose `image:` must (policy.ts). An image named through a
// variable (`FROM $BASE`) cannot be checked here and stays the documented residual.
//
// ⚠ NO TIME-OF-CHECK GAP: the text checked is the text the daemon gets. `DockerfileTap` reads the
// Dockerfile's entry OUT OF THE BUILD CONTEXT'S TAR as it streams to `docker build -`; the daemon starts
// nothing before the stream ends, and the stream is ended only after the check passed.
import { posix } from 'node:path';
import { DEFAULT_ALLOWED_REGISTRIES, registryOf } from '../services/policy.js';

/** The largest Dockerfile the tap keeps (a bigger one is refused, never cut). */
export const DOCKERFILE_MAX_BYTES = 1024 * 1024;

/** Logical lines (continuations joined, comments dropped), with the escape character honoured. */
export function dockerfileLines(text: string): string[] {
  const raw = text.replace(/^﻿/, '').split(/\r?\n/);
  let escape = '\\';
  // Parser directives: only before the first instruction, comment, or blank line.
  for (const line of raw) {
    const m = /^#\s*([a-zA-Z]+)\s*=\s*(\S+)\s*$/.exec(line);
    if (!m) break;
    if (m[1]!.toLowerCase() === 'escape' && (m[2] === '`' || m[2] === '\\')) escape = m[2]!;
  }
  const out: string[] = [];
  let cur = '';
  for (const line of raw) {
    const trimmed = line.trim();
    if (trimmed.startsWith('#')) continue;
    if (cur === '' && trimmed === '') continue;
    if (trimmed.endsWith(escape)) {
      cur += `${trimmed.slice(0, -1).trimEnd()} `;
      continue;
    }
    cur += trimmed;
    if (cur.trim() !== '') out.push(cur.trim());
    cur = '';
  }
  if (cur.trim() !== '') out.push(cur.trim());
  return out;
}

function argsOf(rest: string): string[] {
  const t = rest.trim();
  if (t.startsWith('[')) {
    try {
      const v = JSON.parse(t) as unknown;
      if (Array.isArray(v)) return v.map(String);
    } catch {
      /* not JSON: the shell form below */
    }
  }
  return t.split(/\s+/).filter(Boolean);
}

const isUrlish = (s: string): boolean => /:\/\//.test(s) || /^git@/i.test(s);

/** Every reason this Dockerfile may not be built here (empty: it may). Pure. */
export function vetDockerfile(text: string, allowedRegistries: readonly string[] = DEFAULT_ALLOWED_REGISTRIES): string[] {
  const reasons: string[] = [];
  const say = (r: string): void => {
    if (!reasons.includes(r)) reasons.push(r);
  };
  const stages = new Set<string>(['scratch']);
  const checkImage = (image: string, where: string): void => {
    const ref = image.trim();
    if (ref === '' || ref.includes('$')) return; // a variable: the documented residual
    if (stages.has(ref.toLowerCase()) || /^\d+$/.test(ref)) return;
    const registry = registryOf(ref);
    if (!allowedRegistries.includes(registry)) say(`The Dockerfile's ${where} pulls from \`${registry}\`, which is not an allowed registry.`);
  };
  for (const line of dockerfileLines(text)) {
    let m = /^(\S+)\s*(.*)$/.exec(line);
    if (!m) continue;
    let instr = m[1]!.toUpperCase();
    let rest = m[2] ?? '';
    if (instr === 'ONBUILD') {
      m = /^(\S+)\s*(.*)$/.exec(rest);
      if (!m) continue;
      instr = m[1]!.toUpperCase();
      rest = m[2] ?? '';
    }
    const args = argsOf(rest);
    if (instr === 'FROM') {
      const words = args.filter((a) => !a.startsWith('--'));
      if (words[0]) checkImage(words[0], '`FROM`');
      const as = words.findIndex((w) => w.toUpperCase() === 'AS');
      if (as >= 0 && words[as + 1]) stages.add(words[as + 1]!.toLowerCase());
    } else if (instr === 'COPY') {
      for (const a of args) {
        const from = /^--from=(.*)$/i.exec(a);
        if (from) checkImage(from[1]!, '`COPY --from`');
      }
    } else if (instr === 'ADD') {
      const words = args.filter((a) => !a.startsWith('--'));
      const sources = words.slice(0, -1);
      if (sources.some(isUrlish)) say('The Dockerfile `ADD`s from a URL, which the builder downloads outside the sandbox. Download it in a `RUN` step instead (it goes through the proxy).');
      else if (sources.some((s) => s.includes('$'))) say('The Dockerfile `ADD`s from a variable, which can name a URL. Use `COPY`, or name the file.');
    }
  }
  return reasons;
}

// ── the tap ─────────────────────────────────────────────────────────────────────────────────────

const BLOCK = 512;

function cstr(buf: Buffer, start: number, len: number): string {
  const b = buf.subarray(start, start + len);
  const nul = b.indexOf(0);
  return (nul >= 0 ? b.subarray(0, nul) : b).toString('utf8');
}

function octal(buf: Buffer, start: number, len: number): number {
  const b = buf.subarray(start, start + len);
  if (b[0]! & 0x80) {
    // GNU base-256.
    let n = 0;
    for (let i = 1; i < b.length; i++) n = n * 256 + b[i]!;
    return n;
  }
  const s = cstr(buf, start, len).trim();
  return s === '' ? 0 : Number.parseInt(s, 8);
}

export function tarEntryName(raw: string): string {
  const n = posix.normalize(raw.replace(/^\/+/, '')).replace(/^(\.\/)+/, '').replace(/\/+$/, '');
  return n === '.' ? '' : n;
}

/**
 * Reads a tar stream as it passes and keeps every entry named like the Dockerfile (case-insensitive:
 * the daemon falls back to `dockerfile`). `result()` refuses a Dockerfile that is a link, sits under a
 * link, is too large, or is missing — fail closed.
 */
export class DockerfileTap {
  private buf: Buffer = Buffer.alloc(0);
  private readonly target: string;
  private remaining = 0;
  private pad = 0;
  private capture: Buffer[] | null = null;
  private captureBytes = 0;
  private dataKind: 'skip' | 'longname' | 'pax' | 'file' = 'skip';
  private meta: Buffer[] = [];
  private nextName: string | null = null;
  private readonly links = new Set<string>();
  private readonly found: string[] = [];
  private readonly problems: string[] = [];
  private broken = false;

  constructor(dockerfile: string) {
    this.target = tarEntryName(dockerfile).toLowerCase();
  }

  write(chunk: Buffer): void {
    if (this.broken) return;
    this.buf = this.buf.length === 0 ? chunk : Buffer.concat([this.buf, chunk]);
    for (;;) {
      if (this.remaining > 0) {
        const take = Math.min(this.remaining, this.buf.length);
        if (take === 0) return;
        this.data(this.buf.subarray(0, take));
        this.buf = this.buf.subarray(take);
        this.remaining -= take;
        if (this.remaining === 0) this.endEntry();
        continue;
      }
      if (this.pad > 0) {
        const take = Math.min(this.pad, this.buf.length);
        if (take === 0) return;
        this.buf = this.buf.subarray(take);
        this.pad -= take;
        continue;
      }
      if (this.buf.length < BLOCK) return;
      const h = this.buf.subarray(0, BLOCK);
      this.buf = this.buf.subarray(BLOCK);
      if (h.every((b) => b === 0)) continue;
      this.header(h);
    }
  }

  private header(h: Buffer): void {
    const size = octal(h, 124, 12);
    if (!Number.isFinite(size) || size < 0) {
      this.broken = true;
      this.problems.push('The build folder could not be read.');
      return;
    }
    const type = String.fromCharCode(h[156] ?? 0);
    const magic = h.subarray(257, 263).toString('latin1');
    let name = cstr(h, 0, 100);
    if (magic === 'ustar\0') {
      const prefix = cstr(h, 345, 155);
      if (prefix) name = `${prefix}/${name}`;
    }
    this.remaining = size;
    this.pad = (BLOCK - (size % BLOCK)) % BLOCK;
    if (type === 'L' || type === 'x') {
      this.dataKind = type === 'L' ? 'longname' : 'pax';
      this.meta = [];
    } else {
      const entry = tarEntryName(this.nextName ?? name);
      this.nextName = null;
      const lower = entry.toLowerCase();
      if (type === '1' || type === '2') {
        this.links.add(lower);
        if (lower === this.target) this.problems.push('The Dockerfile is a link. Build from a plain file.');
      }
      if ((type === '0' || type === '\0' || type === '7') && lower === this.target) {
        this.dataKind = 'file';
        this.capture = [];
        this.captureBytes = 0;
        if (size > DOCKERFILE_MAX_BYTES) this.problems.push('The Dockerfile is too large to check.');
      } else this.dataKind = 'skip';
    }
    if (size === 0) this.endEntry();
  }

  private data(b: Buffer): void {
    if (this.dataKind === 'longname' || this.dataKind === 'pax') {
      if (this.meta.reduce((n, x) => n + x.length, 0) < 1024 * 1024) this.meta.push(Buffer.from(b));
    } else if (this.dataKind === 'file' && this.capture && this.captureBytes <= DOCKERFILE_MAX_BYTES) {
      this.capture.push(Buffer.from(b));
      this.captureBytes += b.length;
    }
  }

  private endEntry(): void {
    if (this.dataKind === 'longname') {
      this.nextName = cstr(Buffer.concat(this.meta), 0, Number.MAX_SAFE_INTEGER);
    } else if (this.dataKind === 'pax') {
      const text = Buffer.concat(this.meta).toString('utf8');
      for (const rec of text.split('\n')) {
        const m = /^\d+ path=(.*)$/.exec(rec);
        if (m) this.nextName = m[1]!;
      }
    } else if (this.dataKind === 'file' && this.capture) {
      if (this.captureBytes <= DOCKERFILE_MAX_BYTES) this.found.push(Buffer.concat(this.capture).toString('utf8'));
      this.capture = null;
    }
    this.dataKind = 'skip';
    this.meta = [];
  }

  /** The reasons to refuse the build (empty: build it). Call after the last chunk. */
  result(allowedRegistries: readonly string[] = DEFAULT_ALLOWED_REGISTRIES): string[] {
    const out = [...this.problems];
    const parts = this.target.split('/');
    for (let i = 1; i < parts.length; i++) {
      if (this.links.has(parts.slice(0, i).join('/'))) out.push('The Dockerfile sits in a linked folder. Build from a plain folder.');
    }
    if (out.length === 0 && this.found.length === 0) out.push(`There is no Dockerfile at ${this.target} in the build folder.`);
    for (const text of this.found) for (const r of vetDockerfile(text, allowedRegistries)) if (!out.includes(r)) out.push(r);
    return out;
  }
}
