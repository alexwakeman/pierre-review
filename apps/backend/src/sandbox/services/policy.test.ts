// THE COMPOSE POLICY over normalised models (`docker compose config --format json` shapes). The first
// model is shaped like spike 4's BNG backend file (localstack with a port range and binds, postgres with
// a named volume, caddy with `extra_hosts`, links, a named bridge network); the real file is exercised
// by services-real.test.ts.
import { describe, expect, it } from 'vitest';
import { DEFAULT_ALLOWED_REGISTRIES, DEFAULT_SERVICE_LIMITS, insideRoot, parseComposeBytes, policeCompose, registryOf, type PolicyContext } from './policy.js';

const ROOT = '/Users/limn-test/ws';
const REPO = `${ROOT}/acme-backend`;

const ctx = (over: Partial<PolicyContext> = {}): PolicyContext => ({
  project: 'limn-s1-acme-backend',
  network: 'limn-s1-net',
  workspaceRoot: ROOT,
  workspaceVolume: 'limn-s1-vol-work',
  serviceLabels: { 'limn.managed': 't', 'limn.session': 's1', 'limn.role': 'service' },
  volumeLabels: { 'limn.managed': 't', 'limn.session': 's1', 'limn.role': 'volume' },
  builtImages: new Map(),
  plannedTag: (s) => `limn-s1-svc-acme-backend-${s}:0`,
  egressServices: new Set(),
  proxyUrl: 'http://limn-proxy:3128',
  limits: DEFAULT_SERVICE_LIMITS,
  allowedRegistries: DEFAULT_ALLOWED_REGISTRIES,
  ...over,
});

const port = (p: number, published: number | string = p) => ({ mode: 'ingress', target: p, published: String(published), protocol: 'tcp' });

function backendModel(): Record<string, unknown> {
  return {
    name: 'acme-backend',
    services: {
      localstack: {
        image: 'localstack/localstack:3.0.2',
        environment: { SERVICES: 's3,sqs', HTTP_PROXY: 'should-stay-only-if-set-by-file' },
        networks: { 'cdp-tenant': null },
        ports: [port(4566), port(4510), port(4511)],
        volumes: [
          { type: 'bind', source: `${REPO}/localstack`, target: '/var/lib/localstack', bind: { create_host_path: true } },
          { type: 'bind', source: `${REPO}/compose/start-localstack.sh`, target: '/etc/localstack/init/ready.d/start-localstack.sh', bind: { create_host_path: true } },
        ],
      },
      redis: { image: 'redis:7.2.3-alpine3.18', networks: { 'cdp-tenant': null }, ports: [port(6379)], restart: 'always' },
      postgres: {
        image: 'postgis/postgis:16-3.5',
        networks: { 'cdp-tenant': null },
        ports: [port(5432)],
        volumes: [{ type: 'volume', source: 'pgdata', target: '/var/lib/postgresql/data', volume: {} }],
      },
      'cdp-defra-id-stub': { image: 'defradigital/cdp-defra-id-stub:latest', links: ['redis:redis', 'redis:cache'], networks: { 'cdp-tenant': null }, ports: [port(3200)] },
      caddy: {
        image: 'caddy:2-alpine',
        extra_hosts: ['host.docker.internal=host-gateway'],
        networks: { 'cdp-tenant': null },
        ports: [port(4001)],
        volumes: [{ type: 'bind', source: `${REPO}/compose/Caddyfile`, target: '/etc/caddy/Caddyfile', read_only: true, bind: { create_host_path: true } }],
      },
      'cdp-uploader': { image: 'defradigital/cdp-uploader:latest', networks: { 'cdp-tenant': null }, ports: [port(7337)], container_name: 'uploader' },
    },
    networks: { 'cdp-tenant': { name: 'cdp-tenant', driver: 'bridge', ipam: {} } },
    volumes: { pgdata: { name: 'acme-backend_pgdata' } },
  };
}

type Svc = Record<string, unknown> & { networks?: Record<string, { aliases: string[] } | null>; volumes?: Record<string, unknown>[]; environment?: Record<string, string> };

describe('policeCompose: a BNG-shaped file is allowed and rewritten', () => {
  const r = policeCompose(backendModel(), ctx());
  if (!r.ok) throw new Error(r.reasons.join('; '));
  const model = r.stack.model as { name: string; services: Record<string, Svc>; networks: Record<string, unknown>; volumes: Record<string, unknown> };

  it('joins only the session network, under the project name', () => {
    expect(model.name).toBe('limn-s1-acme-backend');
    expect(model.networks).toEqual({ limn: { external: true, name: 'limn-s1-net' } });
    for (const s of Object.values(model.services)) {
      expect(Object.keys(s.networks ?? {})).toEqual(['limn']);
      expect(s.ports).toBeUndefined();
      expect(s.extra_hosts).toBeUndefined();
      expect(s.links).toBeUndefined();
      expect(s.container_name).toBeUndefined();
    }
  });

  it('turns links and container names into aliases on that network', () => {
    expect(model.services.redis!.networks!.limn).toEqual({ aliases: ['cache'] });
    expect(model.services['cdp-uploader']!.networks!.limn).toEqual({ aliases: ['uploader'] });
    expect(model.services.postgres!.networks!.limn).toBeNull();
  });

  it('forwards every published TCP port to localhost in the sandbox', () => {
    expect(r.stack.forwards.map((f) => `${f.port}>${f.host}:${f.target}`)).toEqual([
      '4566>localstack:4566', '4510>localstack:4510', '4511>localstack:4511', '6379>redis:6379', '5432>postgres:5432', '3200>cdp-defra-id-stub:3200', '4001>caddy:4001', '7337>cdp-uploader:7337',
    ]);
  });

  it('mounts workspace binds as subpaths of the workspace volume, keeping read-only', () => {
    expect(model.services.caddy!.volumes).toEqual([
      { type: 'volume', source: 'limn-workspace', target: '/etc/caddy/Caddyfile', read_only: true, volume: { nocopy: true, subpath: 'acme-backend/compose/Caddyfile' } },
    ]);
    expect(model.services.localstack!.volumes![0]).toEqual({ type: 'volume', source: 'limn-workspace', target: '/var/lib/localstack', volume: { nocopy: true, subpath: 'acme-backend/localstack' } });
    expect(model.volumes['limn-workspace']).toEqual({ external: true, name: 'limn-s1-vol-work' });
    expect(r.stack.bindDirs).toContain(`${REPO}/localstack`);
  });

  it("names the project's volumes and labels them", () => {
    expect(model.volumes.pgdata).toEqual({ name: 'limn-s1-acme-backend_pgdata', labels: { 'limn.managed': 't', 'limn.session': 's1', 'limn.role': 'volume' } });
  });

  it('caps every service, labels it, and sets no-new-privileges', () => {
    for (const s of Object.values(model.services)) {
      expect(s.labels).toMatchObject({ 'limn.session': 's1', 'limn.role': 'service' });
      expect(s.security_opt).toEqual(['no-new-privileges:true']);
      expect(s.mem_limit).toBe(768 * 1024 ** 2);
      expect(s.memswap_limit).toBe(s.mem_limit);
      expect(s.pids_limit).toBe(DEFAULT_SERVICE_LIMITS.perServicePids);
    }
  });

  it('gives no service a proxy unless the reader opted it in', () => {
    expect(model.services.redis!.environment).toEqual({});
    const opted = policeCompose(backendModel(), ctx({ egressServices: new Set(['redis']) }));
    if (!opted.ok) throw new Error('refused');
    const env = (opted.stack.model.services as Record<string, Svc>).redis!.environment!;
    expect(env.HTTPS_PROXY).toBe('http://limn-proxy:3128');
    expect(env.NO_PROXY).toContain('postgres');
  });

  it('says what it dropped', () => {
    expect(r.stack.notes.join('\n')).toMatch(/caddy.*extra host/);
    expect(r.stack.notes.join('\n')).toMatch(/localhost inside the sandbox: 4566 → localstack/);
  });
});

describe('policeCompose: refusals', () => {
  const withService = (svc: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({ services: { bad: { image: 'alpine:3.20', ...svc } }, ...extra });
  const reasons = (model: unknown, c = ctx()): string[] => {
    const r = policeCompose(model, c);
    return r.ok ? [] : r.reasons;
  };

  it.each([
    [{ privileged: true }, /privileged/],
    [{ cap_add: ['SYS_ADMIN'] }, /adds capabilities \(SYS_ADMIN\)/],
    [{ devices: ['/dev/kvm:/dev/kvm'] }, /host devices/],
    [{ network_mode: 'host' }, /network mode `host`/],
    [{ network_mode: 'bridge' }, /network mode `bridge`/],
    [{ pid: 'host' }, /host's PID namespace/],
    [{ ipc: 'container:other' }, /another container.s IPC/],
    [{ userns_mode: 'host' }, /user namespace/],
    [{ security_opt: ['seccomp=unconfined'] }, /loosens its security/],
    [{ security_opt: ['apparmor:unconfined'] }, /loosens its security/],
    [{ logging: { driver: 'syslog', options: { 'syslog-address': 'tcp://203.0.113.9:514' } } }, /`syslog` driver/],
    [{ use_api_socket: true }, /Docker socket/],
    [{ gpus: 'all' }, /GPUs/],
    [{ volumes: [{ type: 'bind', source: '/var/run/docker.sock', target: '/var/run/docker.sock' }] }, /mounts `\/var\/run\/docker.sock`, which is outside/],
    [{ volumes: [{ type: 'bind', source: '/Users/limn-test', target: '/h' }] }, /outside the session's workspace/],
    [{ volumes: [{ type: 'bind', source: `${ROOT}/../etc`, target: '/e' }] }, /outside the session's workspace/],
    [{ volumes: [{ type: 'npipe', source: 'x', target: '/x' }] }, /`npipe` mount/],
    [{ image: 'evil.example.com/x/y:1' }, /`evil.example.com`, which is not an allowed registry/],
    [{ image: 'localhost:5000/app' }, /`localhost:5000`/],
    [{ build: { context: '/etc', dockerfile: 'Dockerfile' }, image: undefined }, /builds from `\/etc`/],
    [{ build: { context: `${REPO}`, ssh: ['default'] } }, /build\.ssh/],
    [{ external_links: ['other:db'] }, /outside the project/],
    [{ oom_score_adj: -1000 }, /out-of-memory killer/],
    [{ oom_kill_disable: true }, /out-of-memory killer/],
  ] as [Record<string, unknown>, RegExp][])('%j is refused', (svc, why) => {
    expect(reasons(withService(svc)).join('\n')).toMatch(why);
  });

  it('refuses disguised host mounts and outside volumes', () => {
    expect(reasons(withService({ volumes: [{ type: 'volume', source: 'v', target: '/v' }] }, { volumes: { v: { driver: 'local', driver_opts: { type: 'none', o: 'bind', device: '/etc' } } } })).join('\n')).toMatch(/driver options/);
    expect(reasons(withService({}, { volumes: { v: { external: true, name: 'readers-data' } } })).join('\n')).toMatch(/external/);
    expect(reasons(withService({}, { secrets: { s: { file: '/Users/limn-test/.npmrc' } } })).join('\n')).toMatch(/read from a file/);
    // `environment:` would be read from LIMN's environment on the host.
    expect(reasons(withService({}, { secrets: { s: { environment: 'GH_TOKEN' } } })).join('\n')).toMatch(/environment variable on this computer/);
    expect(reasons(withService({}, { configs: { c: { environment: 'HOME' } } })).join('\n')).toMatch(/environment variable on this computer/);
  });

  it('drops a variable with no value (compose would fill it from the host) and keeps the rest', () => {
    const r = policeCompose(withService({ environment: { KEEP: 'x', EMPTY: '', FROM_HOST: null } }), ctx());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect((r.stack.model.services as Record<string, { environment: unknown }>).bad!.environment).toEqual({ KEEP: 'x', EMPTY: '' });
    expect(r.stack.notes.join('\n')).toMatch(/FROM_HOST/);
  });

  it('refuses the WHOLE file and lists every reason', () => {
    const r = policeCompose({ services: { a: { image: 'alpine', privileged: true }, b: { image: 'alpine', cap_add: ['NET_ADMIN'] }, ok: { image: 'redis' } } }, ctx());
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reasons).toEqual(['`a` asks for privileged mode.', '`b` adds capabilities (NET_ADMIN).']);
  });

  it('refuses more memory than the session allows', () => {
    const svcs = Object.fromEntries(Array.from({ length: 5 }, (_, i) => [`s${i}`, { image: 'redis', mem_limit: '2g' }]));
    expect(reasons({ services: svcs }).join('\n')).toMatch(/need 10 GB of memory\. The limit is 8 GB/);
  });

  it('allows a service network mode inside the file and none', () => {
    expect(policeCompose({ services: { a: { image: 'redis' }, b: { image: 'redis', network_mode: 'service:a' }, c: { image: 'redis', network_mode: 'none' } } }, ctx()).ok).toBe(true);
    expect(reasons({ services: { b: { image: 'redis', network_mode: 'service:elsewhere' } } }).join()).toMatch(/service:elsewhere/);
  });
});

describe('builds', () => {
  const model = { services: { api: { build: { context: `${REPO}`, dockerfile: 'Dockerfile', target: 'production', args: { PORT: 3001 } }, image: 'acme/api:latest' } } };

  it('a build section plans a Limn image, never a pull', () => {
    const r = policeCompose(model, ctx());
    if (!r.ok) throw new Error(r.reasons.join());
    const svc = (r.stack.model.services as Record<string, Svc>).api!;
    expect(svc.image).toBe('limn-s1-svc-acme-backend-api:0');
    expect(svc.pull_policy).toBe('never');
    expect(svc.build).toBeUndefined();
    expect(r.stack.services[0]).toMatchObject({ build: { context: REPO, dockerfile: 'Dockerfile', target: 'production', args: { PORT: '3001' } }, built: false });
  });

  it('a built image replaces the pull of a service with no build section', () => {
    const r = policeCompose({ services: { api: { image: 'defradigital/api:latest' } } }, ctx({ builtImages: new Map([['api', 'limn-s1-svc-acme-backend-api:3']]) }));
    if (!r.ok) throw new Error(r.reasons.join());
    expect((r.stack.model.services as Record<string, Svc>).api).toMatchObject({ image: 'limn-s1-svc-acme-backend-api:3', pull_policy: 'never' });
    expect(r.stack.services[0]!.built).toBe(true);
  });
});

describe('microsandbox bind mode', () => {
  it('keeps a workspace bind as a bind (Docker is beside the files) and still refuses outside ones', () => {
    const r = policeCompose(backendModel(), ctx({ bindMode: 'bind' }));
    if (!r.ok) throw new Error(r.reasons.join());
    expect((r.stack.model.services as Record<string, Svc>).caddy!.volumes).toEqual([{ type: 'bind', source: `${REPO}/compose/Caddyfile`, target: '/etc/caddy/Caddyfile', read_only: true, bind: { create_host_path: true } }]);
    expect((r.stack.model.volumes as Record<string, unknown>)['limn-workspace']).toBeUndefined();
    expect(policeCompose({ services: { a: { image: 'redis', volumes: [{ type: 'bind', source: '/', target: '/h' }] } } }, ctx({ bindMode: 'bind' })).ok).toBe(false);
  });
});

describe('helpers', () => {
  it('reads registries', () => {
    expect(registryOf('postgres')).toBe('docker.io');
    expect(registryOf('postgis/postgis:16')).toBe('docker.io');
    expect(registryOf('ghcr.io/o/r@sha256:abc')).toBe('ghcr.io');
    expect(registryOf('registry-1.docker.io/library/redis')).toBe('docker.io');
    expect(registryOf('10.0.0.5:5000/x')).toBe('10.0.0.5:5000');
  });
  it('reads sizes and paths', () => {
    expect(parseComposeBytes('512m')).toBe(512 * 1024 ** 2);
    expect(parseComposeBytes('2g')).toBe(2 * 1024 ** 3);
    expect(parseComposeBytes(1024)).toBe(1024);
    expect(parseComposeBytes('lots')).toBeNull();
    expect(insideRoot(ROOT, `${ROOT}/a/b`)).toBe(true);
    expect(insideRoot(ROOT, ROOT)).toBe(true);
    expect(insideRoot(ROOT, `${ROOT}-other/x`)).toBe(false);
    expect(insideRoot(ROOT, `${ROOT}/a/../../x`)).toBe(false);
  });
});
