// SPIKE helpers (not shipped): the docker plumbing the sandbox spikes share. Every resource is
// labelled `limn.test=1` + `limn.spike=<id>` and removed by `teardown()` (also on Ctrl-C).
//
// Secrets: a spike reads a real credential from ITS OWN environment and hands it to the PROXY
// container by NAME only (`-e NAME`, value through the spawn env), so it never appears in an argv,
// a log or a fixture. `scrub()` runs over every line before it is saved.
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const HERE = dirname(fileURLToPath(import.meta.url));
export const BACKEND = resolve(HERE, '../..');
export const FIXTURES = resolve(BACKEND, 'src/sandbox/drivers/__fixtures__');
export const DOCKER = process.env.SANDBOX_CLI || 'docker';
export const IMAGE = process.env.LIMN_SANDBOX_IMAGE || 'limn-sandbox:dev';
export const PLACEHOLDER = 'limn-placeholder';

export function newSpike(name) {
  const id = `limn-spike-${name}-${randomBytes(3).toString('hex')}`;
  const labels = ['--label', 'limn.test=1', '--label', `limn.spike=${id}`];
  const cleanup = [];
  const sh = (argv, opts = {}) => {
    const r = spawnSync(DOCKER, argv, { encoding: 'utf8', input: opts.input, env: opts.env ?? process.env, maxBuffer: 64 << 20 });
    if (r.status !== 0 && !opts.allowFail) throw new Error(`${DOCKER} ${argv.slice(0, 2).join(' ')} failed: ${r.stderr}`);
    return r.stdout;
  };
  const teardown = () => {
    for (const f of cleanup.splice(0).reverse()) {
      try {
        f();
      } catch {
        /* best effort */
      }
    }
  };
  process.on('SIGINT', () => {
    teardown();
    process.exit(130);
  });
  return { id, labels, sh, cleanup, teardown };
}

/**
 * The session network shape: `<id>-int` (--internal: no route out) + a proxy container on it AND the
 * default bridge. Returns the proxy's name (reachable from the sandbox as `limn-proxy`).
 */
export function startNetworkAndProxy(s, { allow = [], secretEnv = {}, mounts = [], extraEnv = {} } = {}) {
  const net = `${s.id}-int`;
  s.sh(['network', 'create', '--internal', ...s.labels, net]);
  s.cleanup.push(() => s.sh(['network', 'rm', net], { allowFail: true }));
  const proxy = `${s.id}-proxy`;
  const env = { ...process.env, ...secretEnv };
  s.sh(
    [
      'run', '-d', '--name', proxy, ...s.labels, '--network', 'bridge',
      '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--read-only',
      '-v', `${HERE}/proxy.mjs:/proxy/proxy.mjs:ro`,
      ...mounts.flatMap((m) => ['-v', m]),
      '-e', `LIMN_ALLOW=${allow.join(',')}`,
      ...Object.entries(extraEnv).flatMap(([k, v]) => ['-e', `${k}=${v}`]),
      // By NAME: the value comes from the spawn env, never the argv.
      ...Object.keys(secretEnv).flatMap((k) => ['-e', k]),
      IMAGE, 'node', '/proxy/proxy.mjs',
    ],
    { env },
  );
  s.cleanup.push(() => s.sh(['rm', '-f', proxy], { allowFail: true }));
  s.sh(['network', 'connect', '--alias', 'limn-proxy', net, proxy]);
  return { net, proxy };
}

/** The sandbox container: non-root, no capabilities, no new privileges, internal network only. */
export function startSandbox(s, net, env = {}, extra = []) {
  const box = `${s.id}-box`;
  s.sh([
    'run', '-d', '--name', box, ...s.labels, '--network', net,
    '--cpus', '2', '--memory', '2g', '--pids-limit', '512',
    '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
    ...Object.entries(env).flatMap(([k, v]) => ['-e', `${k}=${v}`]),
    ...extra,
    IMAGE,
  ]);
  s.cleanup.push(() => s.sh(['rm', '-f', box], { allowFail: true }));
  return box;
}

/** The proxy's log as parsed JSON lines. */
export function proxyLog(s, proxy) {
  return s
    .sh(['logs', proxy], { allowFail: true })
    .split('\n')
    .filter(Boolean)
    .map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return { raw: l };
      }
    });
}

/** `docker exec -i` a long-lived process; returns {child, lines (async iterator), send(obj)}. */
export function execInteractive(s, box, argv, { cwd = '/work', env = {} } = {}) {
  const child = spawn(DOCKER, ['exec', '-i', '-w', cwd, ...Object.entries(env).flatMap(([k, v]) => ['-e', `${k}=${v}`]), box, ...argv], {
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const queue = [];
  const waiters = [];
  let buf = '';
  let ended = false;
  const push = (v) => (waiters.length ? waiters.shift()(v) : queue.push(v));
  child.stdout.on('data', (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      if (line.trim()) push({ line });
    }
  });
  let stderr = '';
  child.stderr.on('data', (d) => (stderr += d));
  child.on('close', (code) => {
    ended = true;
    push({ end: true, code });
  });
  const next = (timeoutMs = 120_000) =>
    queue.length
      ? Promise.resolve(queue.shift())
      : ended
        ? Promise.resolve({ end: true })
        : new Promise((res) => {
            const t = setTimeout(() => res({ timeout: true }), timeoutMs);
            waiters.push((v) => {
              clearTimeout(t);
              res(v);
            });
          });
  return { child, next, send: (o) => child.stdin.write(JSON.stringify(o) + '\n'), stderr: () => stderr };
}

/**
 * Remove every credential-shaped string. `secrets` are exact values to blank (the real tokens the
 * spike holds); the patterns catch anything else token-like.
 */
export function scrub(text, secrets = []) {
  let out = String(text);
  for (const v of secrets) if (v && v.length >= 8) out = out.split(v).join('[SCRUBBED]');
  return out
    .replace(/sk-ant-[A-Za-z0-9_-]{8,}/g, '[SCRUBBED]')
    .replace(/eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]*/g, '[SCRUBBED-JWT]')
    .replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]{12,}/gi, '$1[SCRUBBED]')
    .replace(/("(?:access_token|refresh_token|id_token|api_key|apiKey|authorization|x-api-key)"\s*:\s*")[^"]+"/gi, '$1[SCRUBBED]"')
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, (m) => (m.endsWith('.invalid') ? m : 'reader@example.invalid'));
}

export function fakeJwt(claims) {
  const b = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${b({ alg: 'none', typ: 'JWT' })}.${b(claims)}.limnplaceholder`;
}

export function decodeJwt(jwt) {
  return JSON.parse(Buffer.from(String(jwt).split('.')[1], 'base64url').toString('utf8'));
}
