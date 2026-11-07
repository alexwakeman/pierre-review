// The microsandbox argv and parsers (msb-spec.ts). ⚠ The JSON inputs below are HAND-WRITTEN from the
// documented columns (docs.microsandbox.dev), not recorded from a real `msb`: no machine here runs it.
import { describe, expect, it } from 'vitest';
import {
  doctorProblem,
  GUEST_RELAY,
  guestSetupScript,
  labelsOf,
  msbCreateArgs,
  msbExecArgs,
  msbMountArgs,
  msbSize,
  parseMsbImages,
  parseMsbList,
  parseMsbMetrics,
  parseMsbVersion,
  platformProblem,
  VSOCK_PORTS,
} from './msb-spec.js';
import { DEFAULT_RESOURCES, type SandboxSpec } from './types.js';

const sockets = { forward: '/d/s/forward.sock', anthropic: '/d/s/anthropic.sock', chatgpt: '/d/s/chatgpt.sock', control: '/d/s/control.sock' };
const spec: SandboxSpec = {
  sessionId: 's1',
  accountId: 1,
  image: 'ghcr.io/o/limn-sandbox@sha256:abc',
  network: 'limn-s1-net',
  env: { ANTHROPIC_BASE_URL: 'http://limn-proxy:8081', CLAUDE_CODE_OAUTH_TOKEN: 'limn-placeholder' },
  mounts: [
    { kind: 'bind', source: '/Users/a/.limn/clones/o/r', target: '/limn/src/o/r' },
    { kind: 'volume', name: 'limn-s1-vol-ws', target: '/Users/a/Projects' },
  ],
  resources: { ...DEFAULT_RESOURCES, cpus: 1.5 },
  workdir: '/Users/a/Projects/home',
};

describe('msbCreateArgs', () => {
  const argv = msbCreateArgs(spec, 'limn-s1-sandbox', { 'limn.managed': 'd1', 'limn.session': 's1' }, sockets);

  it('has NO network and reaches the proxy only over the three vsock routes (never control)', () => {
    expect(argv).toContain('--no-net');
    expect(argv.join(' ')).not.toMatch(/--net(?!-)|--net-rule|--net-default|--proxy|-p /);
    const vsock = argv.flatMap((a, i) => (a === '--vsock' ? [argv[i + 1]] : []));
    expect(vsock).toEqual([`/d/s/forward.sock:${VSOCK_PORTS.forward}`, `/d/s/anthropic.sock:${VSOCK_PORTS.anthropic}`, `/d/s/chatgpt.sock:${VSOCK_PORTS.chatgpt}`]);
    expect(argv.join(' ')).not.toContain('control.sock');
  });

  it('binds read-only + noexec, the workspace on a sized private disk, caps, labels, image last', () => {
    expect(argv).toEqual(expect.arrayContaining(['-v', '/Users/a/.limn/clones/o/r:/limn/src/o/r:ro,noexec']));
    expect(argv).toEqual(expect.arrayContaining(['--mount-owned', '/Users/a/Projects:kind=disk,size=30G']));
    expect(argv).toEqual(expect.arrayContaining(['-c', '2', '-m', '8G', '--label', 'limn.session=s1', '-w', '/Users/a/Projects/home']));
    expect(argv).toEqual(expect.arrayContaining(['-e', 'CLAUDE_CODE_OAUTH_TOKEN=limn-placeholder']));
    expect(argv[0]).toBe('create');
    expect(argv[argv.length - 1]).toBe(spec.image);
  });

  it('refuses forbidden sources, colons, reserved labels and long socket paths', () => {
    expect(() => msbMountArgs({ kind: 'bind', source: '/var/run/docker.sock', target: '/x' }, 0)).toThrow(/Refusing/);
    expect(() => msbMountArgs({ kind: 'bind', source: '/a:b', target: '/x' }, 0)).toThrow(/colon/);
    expect(() => msbCreateArgs(spec, 'n', { 'microsandbox.x': '1' }, sockets)).toThrow(/Reserved/);
    expect(() => msbCreateArgs(spec, 'n', {}, { ...sockets, forward: `/${'x'.repeat(120)}` })).toThrow(/socket path/);
  });
});

describe('msbExecArgs', () => {
  it('streams stdin when there is input, else gives EOF; non-root gets the process cap', () => {
    expect(msbExecArgs('box', ['claude', '-p'], { stdin: true, cwd: '/w', env: { A: '1' }, pids: 2048 })).toEqual([
      'exec', '--quiet', '--stream', '-u', 'agent', '-w', '/w', '-e', 'A=1', '--rlimit', 'nproc=2048', 'box', '--', 'claude', '-p',
    ]);
    expect(msbExecArgs('box', ['id'], { stdin: false, user: 'root', pids: 10 })).toEqual(['exec', '--quiet', '--no-stdin', '-u', 'root', 'box', '--', 'id']);
    expect(msbExecArgs('box', ['python3'], { stdin: false, detach: true })).toContain('--detach');
    expect(() => msbExecArgs('box', [], { stdin: false })).toThrow();
    expect(() => msbExecArgs('box', ['x'], { stdin: false, user: 'a b' })).toThrow();
  });
});

describe('guest side', () => {
  it('maps limn-proxy to the guest loopback and chowns the given disks', () => {
    const s = guestSetupScript();
    expect(s).toContain('127.0.0.1 limn-proxy');
    expect(s).toContain('chown agent:agent "$d"');
  });
  it('the relay connects to host CID 2 over vsock for each port, on loopback only', () => {
    expect(GUEST_RELAY).toContain('socket.AF_VSOCK');
    expect(GUEST_RELAY).toContain('v.connect((2, vsock_port))');
    expect(GUEST_RELAY).toContain("s.bind(('127.0.0.1', listen_port))");
  });
});

describe('parsers (hand-written shapes)', () => {
  it('ls: an array, a wrapped list, JSON lines; labels as a map or k=v strings', () => {
    const arr = JSON.stringify([{ name: 'limn-a-sandbox', status: 'running', labels: { 'limn.managed': 'd1', 'limn.session': 'a' } }]);
    expect(parseMsbList(arr)).toEqual([{ name: 'limn-a-sandbox', status: 'running', labels: { 'limn.managed': 'd1', 'limn.session': 'a' } }]);
    const wrapped = JSON.stringify({ sandboxes: [{ name: 'b', state: 'stopped', labels: ['limn.session=b', 'flag'] }] });
    expect(parseMsbList(wrapped)).toEqual([{ name: 'b', status: 'stopped', labels: { 'limn.session': 'b', flag: '' } }]);
    expect(parseMsbList('{"name":"c"}\n{"name":"d"}\nnot json')).toHaveLength(2);
    expect(parseMsbList('')).toEqual([]);
    expect(labelsOf([{ key: 'k', value: 'v' }])).toEqual({ k: 'v' });
  });

  it('metrics: percent, or busy cores, and memory', () => {
    const rows = parseMsbMetrics(JSON.stringify([{ name: 'x', cpu: 0.8, cpus: 2, memory_used_bytes: 100, memory_limit_bytes: 800 }]), () => 'sandbox');
    expect(rows).toEqual([{ name: 'x', role: 'sandbox', cpuPercent: 80, memoryBytes: 100, memoryLimitBytes: 800 }]);
    expect(parseMsbMetrics('{"name":"y","cpu_percent":12.5,"memory":{"used":5}}', () => null)[0]).toMatchObject({ cpuPercent: 12.5, memoryBytes: 5, memoryLimitBytes: null });
  });

  it('images, version, doctor', () => {
    expect(parseMsbImages('a\n b \n\n')).toEqual(new Set(['a', 'b']));
    expect(parseMsbVersion('msb 0.7.9\n')).toBe('0.7.9');
    expect(doctorProblem('✓ runtime files\n✗ KVM: /dev/kvm not accessible\n')).toMatch(/not ready: KVM: \/dev\/kvm not accessible/);
    expect(doctorProblem('')).toMatch(/msb doctor/);
  });

  it('sizes round down to whole MiB', () => {
    expect(msbSize(8 * 1024 ** 3)).toBe('8G');
    expect(msbSize(1536 * 1024 ** 2)).toBe('1536M');
    expect(() => msbSize(0)).toThrow();
  });
});

describe('platformProblem', () => {
  it('Intel Mac and Linux without KVM are refused in one line; Apple Silicon and KVM pass', () => {
    expect(platformProblem('darwin', 'x64', false)).toMatch(/Apple Silicon/);
    expect(platformProblem('darwin', 'arm64', false)).toBeNull();
    expect(platformProblem('linux', 'x64', false)).toMatch(/\/dev\/kvm/);
    expect(platformProblem('linux', 'arm64', true)).toBeNull();
    expect(platformProblem('win32', 'x64', false)).toBeNull();
  });
});
