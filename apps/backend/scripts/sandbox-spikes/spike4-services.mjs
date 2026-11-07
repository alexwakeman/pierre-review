#!/usr/bin/env node
// Spike 4 (docs/SANDBOX.md § Spike results → "Services (spike 4)"). Not shipped.
//
// Brings a repository's compose stack up on an `--internal` Docker network whose ONLY way out is
// Limn's allow-list proxy (egress-proxy.mjs), then runs the repository's integration tests from a
// locked-down sandbox container on the same network. Plain `docker` CLI, no SDK.
//
//   node apps/backend/scripts/sandbox-spikes/spike4-services.mjs \
//     --repo ~/Projects/DEFRA/bng-fe-be/bng-metric-backend [--out <dir>] [--keep] [--record]
//
// --record   allow-list `*` (log every host, deny nothing) instead of the candidate list.
// --service-proxy  give service containers the proxy env too (off: see rewriteCompose).
// --keep     leave everything up for `docker exec -it limn-spike4-sandbox bash`.
//
// The repository is mounted READ-ONLY and cloned inside (committed HEAD only). Compose support
// files come from `git archive HEAD` in a temp dir, never from the working tree. Every resource is
// labelled limn.test=1 and removed at the end.
//
// BNG-specific steps (named here so WP6 can generalise them): Node from `.nvmrc`, `npm ci` with
// CI's `.npmrc` tweak, Liquibase migrations run as a host-side ONE-OFF JOB on the internal network
// (the repo's own `db:update` needs the Docker socket), and localhost port forwards because the
// tests hard-code `localhost:<port>`.

import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const flag = (n) => args.includes(`--${n}`);
const opt = (n, d) => {
  const i = args.indexOf(`--${n}`);
  return i >= 0 ? args[i + 1] : d;
};
const REPO = path.resolve(opt('repo', path.join(os.homedir(), 'Projects/DEFRA/bng-fe-be/bng-metric-backend')));
const OUT = path.resolve(opt('out', fs.mkdtempSync(path.join(os.tmpdir(), 'limn-spike4-'))));
const CLI = process.env.SANDBOX_CLI ?? 'docker';
const IMAGE = opt('image', 'limn-sandbox:proto');
const ID = 'limn-spike4';
const NET = `${ID}-int`;
const PROXY = `${ID}-proxy`;
const SANDBOX = `${ID}-sandbox`;
const CACHE_VOL = `${ID}-cache`;
const LABEL = ['--label', 'limn.test=1', '--label', 'limn.spike=spike4'];
const MINE = 'label=limn.spike=spike4'; // teardown never touches another spike's resources
const PROXY_URL = 'http://limn-proxy:3128';
const SERVICE_NAMES_FOR_NO_PROXY = []; // filled from compose
const LIQUIBASE_IMAGE = opt('liquibase', 'liquibase/liquibase:latest');
const PG_JDBC = '42.7.8';

// Candidate default allow-list. Spike 4's log decides what stays.
const ALLOW = flag('record')
  ? '*'
  : ['registry.npmjs.org', 'github.com', 'codeload.github.com', 'nodejs.org', 'repo1.maven.org'].join(',');

fs.mkdirSync(OUT, { recursive: true });
const timings = {};
const t0 = Date.now();
const log = (m) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s] ${m}`);

function sh(argv, { allowFail = false, input, quiet = false } = {}) {
  try {
    return execFileSync(CLI, argv, { encoding: 'utf8', input, stdio: ['pipe', 'pipe', quiet ? 'pipe' : 'inherit'], maxBuffer: 256 * 1024 * 1024 });
  } catch (e) {
    if (allowFail) return '';
    throw e;
  }
}
async function phase(name, fn) {
  const s = Date.now();
  log(`▶ ${name}`);
  try {
    return await fn();
  } finally {
    timings[name] = Math.round((Date.now() - s) / 100) / 10;
    log(`✔ ${name} (${timings[name]}s)`);
  }
}
// Exec in the sandbox as `agent`, streaming output to a file and the console.
function sandboxExec(script, { env = {}, logFile, allowFail = false } = {}) {
  return new Promise((resolve, reject) => {
    const envArgs = Object.entries(env).flatMap(([k, v]) => ['-e', `${k}=${v}`]);
    const p = spawn(CLI, ['exec', ...envArgs, SANDBOX, 'bash', '-lc', script], { stdio: ['ignore', 'pipe', 'pipe'] });
    const out = logFile ? fs.createWriteStream(path.join(OUT, logFile)) : null;
    const tee = (c) => {
      out?.write(c);
      process.stdout.write(c);
    };
    p.stdout.on('data', tee);
    p.stderr.on('data', tee);
    p.on('close', (code) => {
      out?.end();
      if (code === 0 || allowFail) resolve(code);
      else reject(new Error(`sandbox exec failed (${code}): ${script.slice(0, 80)}`));
    });
  });
}

const proxyEnv = () => ({
  HTTP_PROXY: PROXY_URL,
  HTTPS_PROXY: PROXY_URL,
  http_proxy: PROXY_URL,
  https_proxy: PROXY_URL,
  NO_PROXY: ['localhost', '127.0.0.1', ...SERVICE_NAMES_FOR_NO_PROXY].join(','),
  no_proxy: ['localhost', '127.0.0.1', ...SERVICE_NAMES_FOR_NO_PROXY].join(','),
});

// ── Compose rewrite: normalise with `docker compose config`, then police and rewrite the JSON. ──
function rewriteCompose(srcDir) {
  const json = JSON.parse(
    execFileSync(CLI, ['compose', '-f', path.join(srcDir, 'compose.yml'), 'config', '--format', 'json'], { encoding: 'utf8', cwd: srcDir }),
  );
  const refused = [];
  const changes = [];
  // Every service name first: NO_PROXY must hold all of them before any service's env is built.
  SERVICE_NAMES_FOR_NO_PROXY.push(...Object.keys(json.services ?? {}));
  for (const [name, svc] of Object.entries(json.services ?? {})) {
    for (const bad of ['privileged', 'cap_add', 'devices', 'pid', 'ipc', 'security_opt']) if (svc[bad]) refused.push(`${name}: ${bad}`);
    if (svc.network_mode) refused.push(`${name}: network_mode ${svc.network_mode}`);
    if (svc.ports) changes.push(`${name}: dropped ports ${svc.ports.map((p) => p.published ?? p.target).join(',')}`);
    delete svc.ports;
    if (svc.extra_hosts) changes.push(`${name}: dropped extra_hosts ${JSON.stringify(svc.extra_hosts)}`);
    delete svc.extra_hosts;
    if (svc.links) changes.push(`${name}: dropped links (names resolve on the network)`);
    delete svc.links;
    svc.networks = { limn: {} };
    // Services get NO proxy env by default: none of BNG's needs the internet, and CDP-style apps read
    // HTTP_PROXY themselves and IGNORE NO_PROXY (undici ProxyAgent as the global dispatcher), so a
    // proxy env sends their calls to sibling services out through the proxy, where they are denied.
    if (flag('service-proxy')) svc.environment = { ...(svc.environment ?? {}), ...proxyEnv() };
    svc.labels = { ...(svc.labels ?? {}), 'limn.test': '1', 'limn.spike': 'spike4' };
    svc.volumes = (svc.volumes ?? []).map((v) => {
      if (v.type !== 'bind') return v;
      if (v.source === '/var/run/docker.sock') refused.push(`${name}: docker socket`);
      if (!v.source.startsWith(srcDir + path.sep)) refused.push(`${name}: bind outside the repository: ${v.source}`);
      const ro = v.read_only === true || /\.(sh|conf|env)$|Caddyfile/.test(v.source);
      const stat = fs.existsSync(v.source) ? fs.statSync(v.source) : null;
      if (stat?.isDirectory() && !v.read_only) {
        // A writable directory bind (e.g. ./localstack state) becomes an anonymous volume.
        // NAMED, not anonymous: an anonymous volume carries no labels, so a label sweep cannot find it.
        const key = `${name}-${path.basename(v.source)}`;
        json.volumes = { ...(json.volumes ?? {}), [key]: {} };
        changes.push(`${name}: writable bind ${path.relative(srcDir, v.source)} → labelled volume ${key}`);
        return { type: 'volume', source: key, target: v.target };
      }
      return { ...v, read_only: ro };
    });
  }
  json.networks = { limn: { external: true, name: NET } };
  for (const [key, vol] of Object.entries(json.volumes ?? {})) (vol.name = `${ID}_${key}`), (vol.labels = { ...(vol.labels ?? {}), 'limn.test': '1', 'limn.spike': 'spike4' });
  delete json.name;
  return { json, refused, changes };
}

// ── Sampling ──
const samples = [];
let sampling = null;
function startSampler() {
  sampling = setInterval(() => {
    const out = sh(['stats', '--no-stream', '--format', '{{json .}}'], { allowFail: true, quiet: true });
    const rows = out
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l))
      .filter((r) => r.Name.startsWith(ID));
    samples.push({ t: Date.now(), rows });
  }, 4000);
}
function toMiB(s) {
  const m = /([\d.]+)\s*([KMG]i?B|B)/.exec(s);
  if (!m) return 0;
  const n = Number(m[1]);
  return { B: n / 1048576, KiB: n / 1024, KB: n / 1000 / 1024, MiB: n, MB: n, GiB: n * 1024, GB: n * 1000 }[m[2]] ?? n;
}

function teardown(composeFile) {
  if (sampling) clearInterval(sampling);
  if (flag('keep')) return log('--keep: left running');
  log('teardown');
  if (composeFile) sh(['compose', '-p', ID, '-f', composeFile, 'down', '-v', '--remove-orphans'], { allowFail: true, quiet: true });
  for (const c of sh(['ps', '-aq', '--filter', MINE], { allowFail: true, quiet: true }).split('\n').filter(Boolean))
    sh(['rm', '-f', c], { allowFail: true, quiet: true });
  sh(['network', 'rm', NET], { allowFail: true, quiet: true });
  for (const v of sh(['volume', 'ls', '-q', '--filter', MINE], { allowFail: true, quiet: true }).split('\n').filter(Boolean))
    sh(['volume', 'rm', '-f', v], { allowFail: true, quiet: true });
  sh(['volume', 'rm', '-f', CACHE_VOL], { allowFail: true, quiet: true });
}

async function main() {
  const src = path.join(OUT, 'src');
  let composeFile = null;
  const result = { repo: REPO, out: OUT, allow: ALLOW };
  try {
    await phase('archive HEAD for compose support files', () => {
      fs.mkdirSync(src, { recursive: true });
      execFileSync('sh', ['-c', `git -C "${REPO}" archive HEAD | tar -x -C "${src}"`]);
      result.head = execFileSync('git', ['-C', REPO, 'rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).trim();
    });

    await phase('internal network + proxy', () => {
      sh(['network', 'create', '--internal', ...LABEL, NET], { quiet: true });
      sh(
        ['run', '-d', '--name', PROXY, ...LABEL, '--network', 'bridge', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
          '--read-only', '--memory', '128m', '-e', `PROXY_ALLOW=${ALLOW}`,
          '-v', `${path.join(HERE, 'egress-proxy.mjs')}:/proxy/egress-proxy.mjs:ro`, IMAGE, 'node', '/proxy/egress-proxy.mjs'],
        { quiet: true },
      );
      sh(['network', 'connect', '--alias', 'limn-proxy', NET, PROXY], { quiet: true });
    });

    await phase('rewrite + police compose', () => {
      const { json, refused, changes } = rewriteCompose(src);
      result.composeChanges = changes;
      result.composeRefused = refused;
      if (refused.length) throw new Error(`compose refused: ${refused.join('; ')}`);
      composeFile = path.join(OUT, 'compose.limn.json');
      fs.writeFileSync(composeFile, JSON.stringify(json, null, 2));
      result.images = Object.values(json.services).map((s) => s.image).filter(Boolean);
    });

    await phase('pull images (host daemon, not via the proxy)', () => {
      sh(['compose', '-p', ID, '-f', composeFile, 'pull', '--quiet', '--ignore-pull-failures'], { allowFail: true });
    });

    startSampler();
    await phase('services up (--wait)', () => {
      sh(['compose', '-p', ID, '-f', composeFile, 'up', '-d', '--wait', '--wait-timeout', '240']);
    });

    await phase('sandbox container + clone (committed HEAD)', async () => {
      const envArgs = Object.entries(proxyEnv()).flatMap(([k, v]) => ['-e', `${k}=${v}`]);
      sh(
        ['run', '-d', '--name', SANDBOX, ...LABEL, '--network', NET, '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
          '--memory', '4g', '--cpus', '4', '--pids-limit', '2048', ...envArgs,
          '-e', 'NODE_USE_ENV_PROXY=1', '-e', 'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1',
          '-v', `${REPO}:/src:ro`, IMAGE, 'sleep', 'infinity'],
        { quiet: true },
      );
      await sandboxExec(
        'git -c safe.directory="*" clone -q --no-hardlinks /src /work/repo && git -C /work/repo log -1 --oneline && ' +
          // No SSH keys in the sandbox: GitHub ssh specs (lockfile git+ssh) go over HTTPS via the proxy.
          'git config --global url."https://github.com/".insteadOf "ssh://git@github.com/" && ' +
          'git config --global --add url."https://github.com/".insteadOf "git@github.com:"',
      );
    });

    await phase('node from .nvmrc (nodejs.org via the proxy)', () =>
      sandboxExec(
        `set -e; V=$(cat /work/repo/.nvmrc | tr -d 'v \\n'); A=$(uname -m | sed 's/x86_64/x64/;s/aarch64/arm64/');
         node -e "fetch('https://nodejs.org/dist/v'+process.argv[1]+'/node-v'+process.argv[1]+'-linux-'+process.argv[2]+'.tar.gz').then(r=>{if(!r.ok)throw new Error(r.status);return r.arrayBuffer()}).then(b=>require('fs').writeFileSync('/tmp/node.tgz',Buffer.from(b)))" $V $A;
         mkdir -p ~/.local/node && tar -xzf /tmp/node.tgz -C ~/.local/node --strip-components=1 && rm /tmp/node.tgz && ~/.local/node/bin/node -v`,
      ),
    );

    const P = 'export PATH=$HOME/.local/node/bin:$PATH; cd /work/repo;';
    await phase('npm ci (registry + GitHub via the proxy)', () =>
      sandboxExec(`${P} sed -i '/^min-release-age=/d' .npmrc; npm -v; npm ci --no-audit --no-fund 2>&1 | tail -25`, { logFile: 'npm-ci.log' }),
    );

    await phase('migrations (host-side one-off job on the internal network)', async () => {
      sh(['volume', 'create', ...LABEL, CACHE_VOL], { quiet: true });
      // The JDBC driver download also goes through the proxy (a throwaway helper on the internal net).
      const envArgs = Object.entries(proxyEnv()).flatMap(([k, v]) => ['-e', `${k}=${v}`]);
      sh(['run', '--rm', ...LABEL, '--network', NET, '--cap-drop', 'ALL', '-u', '0', ...envArgs, '-e', 'NODE_USE_ENV_PROXY=1',
        '-v', `${CACHE_VOL}:/cache`, IMAGE, 'node', '-e',
        `fetch('https://repo1.maven.org/maven2/org/postgresql/postgresql/${PG_JDBC}/postgresql-${PG_JDBC}.jar').then(r=>{if(!r.ok)throw new Error(r.status);return r.arrayBuffer()}).then(b=>{require('fs').writeFileSync('/cache/pg.jar',Buffer.from(b));require('fs').chmodSync('/cache/pg.jar',0o644)})`]);
      const jopts = '-Dhttp.proxyHost=limn-proxy -Dhttp.proxyPort=3128 -Dhttps.proxyHost=limn-proxy -Dhttps.proxyPort=3128';
      sh(['run', '--rm', ...LABEL, '--network', NET, '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
        '-e', `JAVA_TOOL_OPTIONS=${jopts}`, '-v', `${path.join(src, 'changelog')}:/liquibase/changelog:ro`, '-v', `${CACHE_VOL}:/cache:ro`,
        LIQUIBASE_IMAGE, '--classpath=/cache/pg.jar', '--search-path=/liquibase', '--changelog-file=changelog/db.changelog.xml',
        '--url=jdbc:postgresql://postgres:5432/bng_metric_backend', '--username=dev', '--password=dev', 'update']);
    });

    await phase('localhost forwards (tests hard-code localhost:<port>)', async () => {
      const fwd = { 5432: 'postgres', 4566: 'localstack', 6379: 'redis', 7337: 'cdp-uploader', 3200: 'cdp-defra-id-stub' };
      const code = `const net=require('net');const m=${JSON.stringify(fwd)};for(const[p,h]of Object.entries(m))net.createServer(c=>{const u=net.connect(+p,h);c.pipe(u).pipe(c);u.on('error',()=>c.destroy());c.on('error',()=>u.destroy())}).listen(+p,'127.0.0.1');`;
      fs.writeFileSync(path.join(OUT, 'fwd.js'), code);
      sh(['cp', path.join(OUT, 'fwd.js'), `${SANDBOX}:/tmp/fwd.js`], { quiet: true });
      sh(['exec', '-d', SANDBOX, 'node', '/tmp/fwd.js'], { quiet: true });
    });

    result.testExit = await phase('npm run test:integration', () =>
      sandboxExec(`${P} env -u HTTP_PROXY -u HTTPS_PROXY -u http_proxy -u https_proxy -u NODE_USE_ENV_PROXY npm run test:integration 2>&1`, { env: { SKIP_MIGRATIONS: '1', TZ: 'UTC' }, logFile: 'test-integration.log', allowFail: true }),
    );

    await phase('measure disk', () => {
      result.sandboxDisk = sh(['exec', SANDBOX, 'du', '-sh', '/work/repo', '/work/repo/node_modules', '/home/agent/.local/node', '/home/agent/.npm'], { allowFail: true, quiet: true });
      result.containersSize = sh(['ps', '-s', '--filter', MINE, '--format', '{{.Names}}\t{{.Size}}'], { allowFail: true, quiet: true });
      result.volumes = sh(['system', 'df', '-v', '--format', '{{json .Volumes}}'], { allowFail: true, quiet: true });
      result.imageSizes = sh(['image', 'ls', '--format', '{{.Repository}}:{{.Tag}}\t{{.Size}}'], { quiet: true })
        .split('\n')
        .filter((l) => [...(result.images ?? []), IMAGE, LIQUIBASE_IMAGE].some((i) => l.startsWith(i + '\t')));
    });
  } catch (e) {
    result.error = String(e.message ?? e);
    log(`✖ ${result.error}`);
  } finally {
    // Proxy log BEFORE teardown.
    const proxyLog = sh(['logs', PROXY], { allowFail: true, quiet: true });
    fs.writeFileSync(path.join(OUT, 'proxy.jsonl'), proxyLog);
    const hosts = {};
    // Source attribution: the proxy logs the client IP; map it to a container on the internal net.
    const ipName = {};
    try {
      const net = JSON.parse(sh(['network', 'inspect', NET], { allowFail: true, quiet: true }) || '[]')[0];
      for (const c of Object.values(net?.Containers ?? {})) ipName[c.IPv4Address.split('/')[0]] = c.Name.replace(`${ID}-`, '');
    } catch {}
    const who = (ip) => ipName[String(ip ?? '').replace(/^::ffff:/, '')] ?? ip ?? '?';
    for (const line of proxyLog.split('\n').filter((l) => l.startsWith('{'))) {
      const r = JSON.parse(line);
      if (!r.host) continue;
      const k = `${r.allowed ? 'allowed' : 'DENIED '} ${r.host}:${r.port} ← ${who(r.from)}`;
      hosts[k] ??= { n: 0, down: 0, up: 0 };
      hosts[k].n++;
      hosts[k].down += r.down ?? 0;
      hosts[k].up += r.up ?? 0;
    }
    result.hosts = hosts;
    // Peak memory per container and in total.
    const peak = {};
    let peakTotal = 0;
    for (const s of samples) {
      let total = 0;
      for (const r of s.rows) {
        const mib = toMiB(r.MemUsage.split('/')[0]);
        peak[r.Name] = Math.max(peak[r.Name] ?? 0, mib);
        total += mib;
      }
      peakTotal = Math.max(peakTotal, total);
    }
    result.peakMemMiB = Object.fromEntries(Object.entries(peak).map(([k, v]) => [k, Math.round(v)]));
    result.peakTotalMiB = Math.round(peakTotal);
    result.timings = timings;
    fs.writeFileSync(path.join(OUT, 'result.json'), JSON.stringify(result, null, 2));
    teardown(composeFile);
    console.log(JSON.stringify(result, null, 2));
  }
}

main();
