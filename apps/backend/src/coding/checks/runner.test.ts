// THE RUNNER'S SECURITY PROPERTIES: argv-only spawning, the scrubbed environment, the sandbox profile
// generation, the frozen run_check tool, the Docker preflight and the commit-hook script.
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { dockerPreflight } from './docker.js';
import { NEVER_PASSED, PASSED_THROUGH, scrubbedEnv } from './env.js';
import { hookScriptBody, commitArgv } from './hooks.js';
import { bwrapArgs, seatbeltProfile, wrapCommand, type SandboxPolicy } from './sandbox.js';
import { CappedOutput, runProcess, stripAnsi } from './spawn.js';
import { CheckToolRunner, parseCheckSpec, type CheckSpec } from './spec.js';

const policy: SandboxPolicy = {
  writable: ['/w/tree', '/w/tmp'],
  protectedPaths: ['/w/tree/.git'],
  darkRoots: ['/Users/me', '/data/limn'],
  readable: ['/Users/me/.nvm', '/w/tree'],
  hiddenPaths: ['/Users/me/.cargo/credentials.toml'],
  network: 'localhost',
};

describe('scrubbedEnv', () => {
  const source = {
    PATH: '/usr/bin',
    LANG: 'en_GB.UTF-8',
    HOME: '/Users/me',
    GITHUB_TOKEN: 'ghp_x',
    GH_TOKEN: 'x',
    ANTHROPIC_API_KEY: 'sk',
    OPENAI_API_KEY: 'sk',
    CLAUDE_CODE_OAUTH_TOKEN: 'x',
    AWS_SECRET_ACCESS_KEY: 'x',
    NPM_TOKEN: 'x',
    SSH_AUTH_SOCK: '/tmp/agent',
    DATABASE_URL: 'file:/x.db',
    LIMN_DATA_DIR: '/data',
    RANDOM_SETTING: 'x',
  };
  const env = scrubbedEnv(source, { tmp: '/run/sbx', cache: '/run/cache', realHome: '/Users/me' });

  it('passes only the allow-list through and moves HOME and TMPDIR into the run', () => {
    expect(env.PATH).toBe('/usr/bin');
    expect(env.LANG).toBe('en_GB.UTF-8');
    expect(env.HOME).toBe('/run/sbx/home');
    expect(env.TMPDIR).toBe('/run/sbx/tmp');
    for (const k of ['GITHUB_TOKEN', 'GH_TOKEN', 'ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN', 'AWS_SECRET_ACCESS_KEY', 'NPM_TOKEN', 'SSH_AUTH_SOCK', 'DATABASE_URL', 'LIMN_DATA_DIR', 'RANDOM_SETTING']) {
      expect(env).not.toHaveProperty(k);
    }
    expect(Object.values(env).join(' ')).not.toMatch(/ghp_x|sk\b/);
  });

  it('no pass-through name looks like a credential', () => {
    for (const n of PASSED_THROUGH) expect(NEVER_PASSED.test(n)).toBe(false);
  });

  it('turns off the reader’s git and npm config (credential helpers, tokens)', () => {
    expect(env.GIT_CONFIG_GLOBAL).toBe('/dev/null');
    expect(env.GIT_CONFIG_NOSYSTEM).toBe('1');
    expect(env.npm_config_userconfig).toBe('/run/sbx/home/.npmrc');
  });
});

describe('the Seatbelt profile', () => {
  const { profile, params } = seatbeltProfile(policy);

  it('denies writes, then allows only the run’s folders, then re-protects .git', () => {
    const deny = profile.indexOf('(deny file-write*)');
    const allow = profile.indexOf('(allow file-write* (subpath (param "W0"))');
    const prot = profile.indexOf('(deny file-write* (subpath (param "P0")))');
    expect(deny).toBeGreaterThan(-1);
    expect(allow).toBeGreaterThan(deny);
    expect(prot).toBeGreaterThan(allow); // the LAST matching rule wins
    expect(params).toMatchObject({ W0: '/w/tree', W1: '/w/tmp', P0: '/w/tree/.git' });
  });

  it('darkens the home and data folders, lists readable folders, hides secrets last', () => {
    expect(profile).toContain('(deny file-read* (subpath (param "D0")) (subpath (param "D1")))');
    expect(params).toMatchObject({ D0: '/Users/me', D1: '/data/limn', R0: '/Users/me/.nvm', S0: '/Users/me/.cargo/credentials.toml' });
    expect(profile.indexOf('(deny file-read* (subpath (param "S0")))')).toBeGreaterThan(profile.indexOf('(allow file-read*'));
  });

  it('a check gets loopback only; the dependency step gets the network but no foreign Unix socket', () => {
    expect(profile).toContain('(deny network*)');
    expect(profile).toContain('(allow network-outbound (remote ip "localhost:*"))');
    expect(profile).not.toContain('(allow network*)');
    const open = seatbeltProfile({ ...policy, network: 'open' }).profile;
    expect(open).toContain('(allow network*)');
    expect(open).toContain('(deny network-outbound (remote unix-socket))');
  });

  it('keeps the keychain daemon out of reach', () => {
    expect(profile).toContain('(global-name "com.apple.SecurityServer")');
  });

  it('never splices a path into the profile text — a hostile folder name changes nothing', () => {
    const evil = '/w/x") (allow default) ("';
    const r = seatbeltProfile({ ...policy, writable: [evil] });
    expect(r.profile).not.toContain(evil);
    expect(r.params.W0).toBe(evil);
    expect(() => seatbeltProfile({ ...policy, writable: ['/w/a\nb'] })).toThrow();
    expect(() => seatbeltProfile({ ...policy, writable: ['relative/path'] })).toThrow();
  });

  it('wrapCommand hands sandbox-exec the profile and parameters as argv', () => {
    const w = wrapCommand('seatbelt', policy, '/w/tree', ['pnpm', 'run', 'test']);
    expect(w.command).toBe('/usr/bin/sandbox-exec');
    expect(w.args[0]).toBe('-p');
    expect(w.args).toContain('W0=/w/tree');
    expect(w.args.slice(-4)).toEqual(['--', 'pnpm', 'run', 'test']);
  });
});

describe('the bubblewrap arguments', () => {
  const args = bwrapArgs(policy, '/w/tree');
  it('read-only root, private loopback, dark home, then readable and writable binds', () => {
    expect(args).toContain('--unshare-net');
    expect(args.join(' ')).toContain('--ro-bind / /');
    const dark = args.indexOf('/Users/me');
    expect(args[dark - 1]).toBe('--tmpfs');
    const rw = args.indexOf('--bind');
    expect(rw).toBeGreaterThan(dark);
    expect(args.slice(-2)).toEqual(['--chdir', '/w/tree']);
    expect(bwrapArgs({ ...policy, network: 'open' }, '/w/tree')).not.toContain('--unshare-net');
  });
  it('wraps the argv after --', () => {
    const w = wrapCommand('bwrap', policy, '/w/tree', ['make', 'test']);
    expect(w.command).toBe('bwrap');
    expect(w.args.slice(-3)).toEqual(['--', 'make', 'test']);
  });
});

describe('runProcess', () => {
  it('spawns argv with NO shell: metacharacters are plain arguments', async () => {
    const r = await runProcess({ command: process.execPath, args: ['-e', 'console.log(JSON.stringify(process.argv.slice(1)))', '$(touch /tmp/x)', '; rm -rf /', '`id`'], cwd: tmpdir(), env: { PATH: process.env.PATH ?? '' }, timeoutMs: 20_000, outputCap: 10_000 });
    expect(r.exitCode).toBe(0);
    expect(JSON.parse(r.output.trim())).toEqual(['$(touch /tmp/x)', '; rm -rf /', '`id`']);
  });

  it('passes exactly the environment it is given', async () => {
    const r = await runProcess({ command: process.execPath, args: ['-e', 'console.log(Object.keys(process.env).sort().join(","))'], cwd: tmpdir(), env: { ONLY: '1' }, timeoutMs: 20_000, outputCap: 10_000 });
    expect(r.output.trim().split(',').filter((k) => !k.startsWith('__CF'))).toEqual(['ONLY']);
  });

  it('kills the whole group at the timeout', async () => {
    const r = await runProcess({ command: process.execPath, args: ['-e', 'require("child_process").spawn(process.execPath,["-e","setInterval(()=>{},1000)"],{stdio:"inherit"}); setInterval(()=>{},1000)'], cwd: tmpdir(), env: {}, timeoutMs: 500, outputCap: 1000 });
    expect(r.timedOut).toBe(true);
  });

  it('a missing program is an error, never a throw', async () => {
    const r = await runProcess({ command: '/nonexistent/prog', args: [], cwd: tmpdir(), env: {}, timeoutMs: 1000, outputCap: 1000 });
    expect(r.spawnError).toBeTruthy();
  });

  it('caps output to head + tail and says what was cut', () => {
    const c = new CappedOutput(100);
    c.push('H'.repeat(50));
    for (let i = 0; i < 100; i++) c.push('x'.repeat(10));
    c.push('THE-END');
    const { text, truncated } = c.result();
    expect(truncated).toBe(true);
    expect(text.startsWith('H'.repeat(25))).toBe(true);
    expect(text.endsWith('THE-END')).toBe(true);
    expect(text).toMatch(/characters cut/);
    expect(stripAnsi('\x1b[31mred\x1b[0m')).toBe('red');
  });
});

describe('the run_check tool', () => {
  const spec: CheckSpec = {
    version: 1,
    maxCalls: 2,
    log: null,
    checks: [{ name: 'test', kind: 'test', display: 'npm run test', command: process.execPath, args: ['-e', 'console.log("ok")'], cwd: tmpdir(), env: {}, timeoutMs: 20_000, outputCap: 1000 }],
  };

  it('runs only a frozen name, refuses anything else, and caps the calls', async () => {
    const r = new CheckToolRunner(spec);
    expect((await r.call({ name: 'rm -rf /' })).isError).toBe(true);
    expect((await r.call({ name: 'test', argv: ['sh', '-c', 'id'] })).text).toMatch(/^test passed/);
    expect((await r.call({})).isError).toBe(true);
    expect((await r.call({ name: 'test' })).text).toMatch(/passed/);
    expect((await r.call({ name: 'test' })).text).toMatch(/used its 2 check runs/);
    expect(r.results).toHaveLength(2);
  });

  it('the spec file is validated before the MCP server trusts it', () => {
    expect(() => parseCheckSpec('{"version":1,"checks":[{"name":"t"}],"maxCalls":1}')).toThrow();
    expect(() => parseCheckSpec(JSON.stringify({ ...spec, checks: [{ ...spec.checks[0], args: [1] }] }))).toThrow();
    expect(parseCheckSpec(JSON.stringify(spec)).checks[0]!.name).toBe('test');
  });
});

describe('dockerPreflight', () => {
  const fakeDocker = (script: string): string => {
    const dir = mkdtempSync(join(tmpdir(), 'limn-docker-'));
    writeFileSync(join(dir, 'docker'), `#!/bin/sh\n${script}\n`);
    chmodSync(join(dir, 'docker'), 0o755);
    return dir;
  };
  it('running when `docker info` answers', async () => {
    const dir = fakeDocker('echo 27.0.1');
    expect(await dockerPreflight({ env: { PATH: `${dir}:/usr/bin:/bin` } })).toEqual({ running: true, note: null });
  });
  it('one plain line when the daemon is down or Docker is missing', async () => {
    const dir = fakeDocker('echo "Cannot connect to the Docker daemon" >&2; exit 1');
    expect((await dockerPreflight({ env: { PATH: `${dir}:/usr/bin:/bin` } })).note).toMatch(/isn’t running/);
    expect((await dockerPreflight({ env: { PATH: '/nonexistent' } })).note).toMatch(/isn’t installed/);
  });
});

describe('the commit hook', () => {
  it('drops husky’s helper line and its shebang, runs under /bin/sh', () => {
    const body = hookScriptBody({ kind: 'husky', source: '.husky/pre-commit', script: '#!/usr/bin/env sh\n. "$(dirname -- "$0")/_/husky.sh"\n\nnpx lint-staged\n' });
    expect(body).toBe('#!/bin/sh\n\nnpx lint-staged\n');
  });
  it('the commit message travels as ONE argv word', () => {
    const argv = commitArgv('fix: x"; rm -rf / #');
    expect(argv.slice(-2)).toEqual(['-m', 'fix: x"; rm -rf / #']);
    expect(argv).not.toContain('--no-verify');
  });
});
