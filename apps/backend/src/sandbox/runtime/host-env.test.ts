// The runtime CLI's environment (host-env.ts): no credential reaches `docker` / `podman` / `msb`.
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { dockerCliEnv, findOnPath } from './host-env.js';

describe('dockerCliEnv', () => {
  it('drops credential-shaped names and keeps the Docker CLI settings', () => {
    const env = dockerCliEnv({
      PATH: '/usr/bin',
      HOME: '/home/a',
      GITHUB_TOKEN: 'x',
      GH_TOKEN: 'x',
      ANTHROPIC_API_KEY: 'x',
      CLAUDE_CODE_OAUTH_TOKEN: 'x',
      AWS_SECRET_ACCESS_KEY: 'x',
      SSH_AUTH_SOCK: '/tmp/s',
      LIMN_AI_PROVIDER: 'claude',
      DATABASE_URL: 'x',
      DOCKER_HOST: 'unix:///d.sock',
      DOCKER_CONTEXT: 'colima',
      DOCKER_AUTH_CONFIG: 'x',
    });
    expect(env).toEqual({ PATH: '/usr/bin', HOME: '/home/a', DOCKER_HOST: 'unix:///d.sock', DOCKER_CONTEXT: 'colima' });
  });
});

describe('findOnPath', () => {
  it('finds an executable and skips a missing one', () => {
    const dir = mkdtempSync(join(tmpdir(), 'limn-host-env-'));
    try {
      const bin = join(dir, 'tool');
      writeFileSync(bin, '#!/bin/sh\n');
      chmodSync(bin, 0o755);
      expect(findOnPath('tool', `/nope:${dir}`)).toBe(bin);
      expect(findOnPath('missing', dir)).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
