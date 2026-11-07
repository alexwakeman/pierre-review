import { describe, expect, it } from 'vitest';
import { labelArgs, repoStoreName, resourceLabels, resourceName, storeLabels } from './labels.js';
import { composeArgs, mountArgs, proxyRunArgs, sandboxRunArgs, serviceBuildArgv, storeMaintenanceArgs, volumeChownArgs } from './spec.js';
import { DEFAULT_RESOURCES, type SandboxSpec } from './types.js';

const spec: SandboxSpec = {
  sessionId: 's1',
  accountId: 1,
  image: 'limn-sandbox:local-abc',
  network: 'limn-s1-net',
  env: { LIMN_PROXY: 'http://limn-proxy:3128' },
  mounts: [
    { kind: 'bind', source: '/Users/alex/.limn/clones/o/r', target: '/limn/src/o/r' },
    { kind: 'volume', name: 'limn-s1-vol-work', target: '/Users/alex/Projects/x' },
  ],
  resources: DEFAULT_RESOURCES,
  workdir: '/Users/alex/Projects/x/home',
};

describe('the sandbox argv', () => {
  const labels = resourceLabels('1', spec, 'sandbox', { 'limn.test': '1' });
  const argv = sandboxRunArgs(spec, resourceName('s1', 'sandbox'), labels);

  it('carries every hardening flag, and only the internal network', () => {
    const joined = argv.join(' ');
    for (const flag of ['--cap-drop ALL', '--security-opt no-new-privileges', '--init', '--user agent', '--network limn-s1-net', '--pids-limit 2048', '--cpus 4']) {
      expect(joined).toContain(flag);
    }
    expect(joined).toContain(`--memory ${8 * 1024 ** 3} --memory-swap ${8 * 1024 ** 3}`);
    expect(argv.filter((a) => a === '--network')).toHaveLength(1);
    expect(joined).not.toMatch(/privileged|cap-add|docker\.sock|--volume|-v /);
  });

  it('binds are read-only, volumes are named', () => {
    expect(argv).toContain('type=bind,src=/Users/alex/.limn/clones/o/r,dst=/limn/src/o/r,readonly');
    expect(argv).toContain('type=volume,src=limn-s1-vol-work,dst=/Users/alex/Projects/x,volume-nocopy');
  });

  it('labels every resource', () => {
    expect(labelArgs(labels)).toEqual([
      '--label', 'limn.test=1',
      '--label', 'limn.managed=1',
      '--label', 'limn.session=s1',
      '--label', 'limn.account=1',
      '--label', 'limn.role=sandbox',
    ]);
  });

  it('refuses the Docker socket, credential folders and system paths, even read-only', () => {
    for (const source of ['/var/run/docker.sock', '/Users/alex/.docker/run/docker.sock', '/Users/alex/.docker', '/home/a/.ssh', '/home/a/.config/gh', '/', '/proc', '/private/var/run/x', '/run/podman/podman.sock', 'relative/path', '/a,b']) {
      expect(() => mountArgs({ kind: 'bind', source, target: '/x' }), source).toThrow();
    }
    expect(() => mountArgs({ kind: 'volume', name: 'Bad Name', target: '/x' })).toThrow();
    expect(() => mountArgs({ kind: 'volume', name: 'ok', target: 'rel' })).toThrow();
  });

  it('refuses bad env names and out-of-range resources', () => {
    expect(() => sandboxRunArgs({ ...spec, env: { 'A B': 'x' } }, 'n', labels)).toThrow();
    expect(() => sandboxRunArgs({ ...spec, resources: { ...DEFAULT_RESOURCES, memoryBytes: 1 } }, 'n', labels)).toThrow();
  });

  it('session ids are checked before they become names or labels', () => {
    expect(() => resourceName('../x', 'net')).toThrow();
    expect(() => resourceLabels('1', { sessionId: 'A B', accountId: 1 }, 'network')).toThrow();
  });
});

describe('the proxy and setup argv', () => {
  it('the proxy is non-root, read-only, small, on the bridge, its program inline', () => {
    const argv = proxyRunArgs(
      { sessionId: 's1', accountId: 1, image: 'img', network: 'limn-s1-net', alias: 'limn-proxy', source: 'console.log(1)', env: { LIMN_PROXY_MAIN: '1' } },
      'limn-s1-proxy',
      resourceLabels('1', { sessionId: 's1', accountId: 1 }, 'proxy'),
      'bridge',
    );
    const joined = argv.join(' ');
    expect(joined).toContain('--network bridge');
    expect(joined).toContain('--read-only');
    expect(joined).toContain('--cap-drop ALL');
    expect(joined).toContain('--user agent');
    expect(argv.slice(-4)).toEqual(['node', '--input-type=module', '-e', 'console.log(1)']);
  });

  it('the volume step holds CHOWN only, with no network', () => {
    const argv = volumeChownArgs('img', 'limn-s1-vol-work', {}).join(' ');
    expect(argv).toContain('--cap-drop ALL --cap-add CHOWN');
    expect(argv).toContain('--network none');
    expect(argv).toContain('--rm');
    expect(argv).toMatch(/chown agent:agent \/v$/);
  });
});

describe('services argv', () => {
  it('compose always reads the model from stdin, in an empty project folder', () => {
    expect(composeArgs('limn-s1-bng', { verb: 'up', services: ['postgres'] }, '/tmp/empty')).toEqual([
      'compose', '--ansi', 'never', '--progress', 'plain', '--project-name', 'limn-s1-bng', '--project-directory', '/tmp/empty', '--file', '-',
      'up', '--detach', '--wait', '--wait-timeout', '300', '--pull', 'missing', '--no-build', 'postgres',
    ]);
    expect(composeArgs('p', { verb: 'logs', service: 'api', tail: 99999 }, '/e').slice(-4)).toEqual(['--no-color', '--tail', '2000', 'api']);
    // A command is argv for the one-off container, never a shell of Limn's.
    expect(composeArgs('p', { verb: 'run', service: 'job', command: ['sh', '-c', 'echo hi'] }, '/e').slice(-8)).toEqual(['run', '--rm', '--no-TTY', '--quiet-pull', 'job', 'sh', '-c', 'echo hi']);
    expect(() => composeArgs('Bad Name', { verb: 'ps' }, '/e')).toThrow(/project name/);
    expect(() => composeArgs('p', { verb: 'up', services: ['--privileged'] }, '/e')).toThrow(/service name/);
  });

  it('a service build runs its steps on the session network with the proxy as build args', () => {
    const argv = serviceBuildArgv(
      { sessionId: 's1', accountId: 1, tag: 'limn-s1-svc-bng-api:2', from: { container: 'c', dir: '/w/api' }, dockerfile: 'docker/Dockerfile', target: 'production', network: 'limn-s1-net', proxyUrl: 'http://limn-proxy:3128', memoryBytes: 4 * 1024 ** 3, buildArgs: { PORT: '3001' } },
      { 'limn.session': 's1' },
    );
    expect(argv.slice(0, 5)).toEqual(['build', '--rm', '--force-rm', '--network', 'limn-s1-net']);
    expect(argv).toContain('HTTPS_PROXY=http://limn-proxy:3128');
    expect(argv).toContain('PORT=3001');
    expect(argv.at(-1)).toBe('-');
    const base = { sessionId: 's1', accountId: 1, from: { container: 'c', dir: '/w' }, network: 'n', proxyUrl: 'p', memoryBytes: 1 };
    expect(() => serviceBuildArgv({ ...base, tag: 'limn-s1-x:1', dockerfile: '../Dockerfile' }, {})).toThrow(/inside the build folder/);
    expect(() => serviceBuildArgv({ ...base, tag: 'evil.example.com/x:1', dockerfile: 'Dockerfile' }, {})).toThrow(/Limn service image tag/);
  });
});

describe('the repo store argv (docs/SANDBOX.md § The repo store)', () => {
  it('a read-only volume mount says readonly', () => {
    expect(mountArgs({ kind: 'volume', name: 'limn-repo-store-d1', target: '/limn-store', readOnly: true })).toEqual([
      '--mount',
      'type=volume,src=limn-repo-store-d1,dst=/limn-store,volume-nocopy,readonly',
    ]);
  });

  it('the maintenance container: no network, no capabilities, read-only root, the store read-write', () => {
    const argv = storeMaintenanceArgs('limn-sandbox:local-abc', 'limn-repo-store-d1', resourceLabels('d1', { sessionId: 's1', accountId: 1 }, 'setup'), ['sh', '-c', 'true']);
    const at = (flag: string): string | undefined => argv[argv.indexOf(flag) + 1];
    expect(argv.slice(0, 3)).toEqual(['run', '--rm', '--interactive']);
    expect(at('--network')).toBe('none');
    expect(at('--cap-drop')).toBe('ALL');
    expect(argv).not.toContain('--cap-add');
    expect(argv).toContain('--read-only');
    expect(at('--security-opt')).toBe('no-new-privileges');
    expect(argv).toContain('type=volume,src=limn-repo-store-d1,dst=/limn-store');
    expect(argv.slice(-4)).toEqual(['limn-sandbox:local-abc', 'sh', '-c', 'true']);
    expect(() => storeMaintenanceArgs('i', 'v', {}, [])).toThrow();
  });

  it('the store volume never carries limn.managed (the sweep cannot see it)', () => {
    expect(repoStoreName('d1')).toBe('limn-repo-store-d1');
    expect(() => repoStoreName('../x')).toThrow();
    expect(storeLabels('d1', { 'limn.test': '1', 'limn.managed': 'x' })).toEqual({ 'limn.test': '1', 'limn.store': 'd1', 'limn.role': 'store' });
  });
});
