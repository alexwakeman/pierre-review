// srt spike: a warm workspace + a per-chat scratch worktree, sandboxed with
// @anthropic-ai/sandbox-runtime. Measures timings and probes the boundary.
import { SandboxManager } from '@anthropic-ai/sandbox-runtime';
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const SRC = process.env.SPIKE_REPO ?? process.cwd();
const ROOT = process.env.SPIKE_ROOT ?? '/tmp/lq-srt'; // SHORT: srt keeps Unix sockets under TMPDIR (108-byte limit)
const TTL_MS = Number(process.env.SPIKE_TTL_MS ?? 10 * 60_000);
const HOME = os.homedir();
const ms = (t) => `${(performance.now() - t).toFixed(0)} ms`;
const results = [];
// srt's own proxy honours NO_PROXY for its upstream; the host's list must not leak into it
for (const k of Object.keys(process.env)) if (/^no_proxy$/i.test(k)) delete process.env[k];
// the sandboxed child gets an ALLOW-LISTED environment, never the host's (srt passes env through)
const CHILD_ENV = Object.fromEntries(Object.entries(process.env).filter(([k]) =>
  /^(PATH|HOME|LANG|LC_ALL|TERM|USER|SHELL|NODE_EXTRA_CA_CERTS|SSL_CERT_FILE)$/.test(k)));
const note = (name, value) => { results.push([name, value]); console.log(`${name.padEnd(46)} ${value}`); };

// ---- the reaper: any chat scratch dir whose session stamp is older than TTL goes
function reap(now = Date.now()) {
  const dir = path.join(ROOT, 'chats');
  if (!fs.existsSync(dir)) return [];
  const gone = [];
  for (const id of fs.readdirSync(dir)) {
    const stamp = path.join(dir, id, '.limn-last-active');
    const last = fs.existsSync(stamp) ? Number(fs.readFileSync(stamp, 'utf8')) : 0;
    if (now - last > TTL_MS) {
      try { execFileSync('git', ['-C', SRC, 'worktree', 'remove', '--force', path.join(dir, id, 'repo')], { stdio: 'ignore' }); } catch {}
      fs.rmSync(path.join(dir, id), { recursive: true, force: true });
      gone.push(id);
    }
  }
  // a worktree git still lists under ROOT whose chat folder is gone (a crash mid-open)
  const listed = execFileSync('git', ['-C', SRC, 'worktree', 'list', '--porcelain']).toString()
    .split('\n').filter((l) => l.startsWith('worktree ')).map((l) => l.slice(9));
  for (const wt of listed) {
    if (wt.startsWith(ROOT + '/') && !fs.existsSync(path.join(path.dirname(wt), '.limn-last-active'))) {
      try { execFileSync('git', ['-C', SRC, 'worktree', 'remove', '--force', wt], { stdio: 'ignore' }); gone.push(wt); } catch {}
    }
  }
  try { execFileSync('git', ['-C', SRC, 'worktree', 'prune']); } catch {}
  return gone;
}

// ---- one chat's scratch: a detached worktree at HEAD + borrowed node_modules
function openChat(id) {
  const chat = path.join(ROOT, 'chats', id);
  fs.mkdirSync(chat, { recursive: true });
  const repo = path.join(chat, 'repo');
  execFileSync('git', ['-C', SRC, 'worktree', 'add', '--detach', '--quiet', repo, 'HEAD']);
  // node_modules are read-only borrowed from the warm checkout (pnpm symlinks)
  for (const nm of ['node_modules', 'apps/backend/node_modules', 'packages/shared/node_modules']) {
    if (fs.existsSync(path.join(SRC, nm))) fs.symlinkSync(path.join(SRC, nm), path.join(repo, nm));
  }
  fs.mkdirSync(path.join(chat, 'tmp'));
  fs.writeFileSync(path.join(chat, '.limn-last-active'), String(Date.now()));
  return { chat, repo, tmp: path.join(chat, 'tmp') };
}

function config(c) {
  const parent = process.env.HTTPS_PROXY ?? process.env.https_proxy;
  return {
    network: {
      allowedDomains: ['registry.npmjs.org', 'github.com', 'api.anthropic.com'],
      deniedDomains: [],
      ...(parent ? { parentProxy: { http: parent, https: parent, noProxy: '' } } : {}),
    },
    filesystem: {
      // reads: deny the home folder, then allow what a chat needs
      denyRead: [HOME],
      allowRead: [SRC, c.chat, ...(process.env.SPIKE_EXTRA_READ ? process.env.SPIKE_EXTRA_READ.split(':') : [])], // the egress CA; a reader's corporate CA needs the same
      allowWrite: [c.repo, c.tmp],
      denyWrite: [path.join(c.repo, '.git')],
    },
  };
}

function run(cmd, cwd, env = {}) {
  return new Promise((resolve) => {
    const p = spawn('bash', ['-c', cmd], { cwd, env: { ...CHILD_ENV, ...env } });
    let out = ''; let err = '';
    p.stdout.on('data', (d) => (out += d)); p.stderr.on('data', (d) => (err += d));
    p.on('close', (code) => resolve({ code, out: out.trim(), err: err.trim() }));
  });
}
async function sb(cmd, c) {
  const wrapped = await SandboxManager.wrapWithSandbox(`export TMPDIR=${c.tmp}; ${cmd}`);
  const r = await run(wrapped, c.repo);
  SandboxManager.cleanupAfterCommand();
  return r;
}

if (process.argv.includes('--reap-only')) { console.log('reaped:', reap()); process.exit(0); }
const reaped0 = reap();
note('reaped at start (older than TTL)', reaped0.length ? reaped0.join(',') : 'none');

let t = performance.now();
const c = openChat(`chat-${Date.now()}`);
note('open chat: worktree + borrowed node_modules', ms(t));

t = performance.now();
await SandboxManager.initialize(config(c));
await SandboxManager.waitForNetworkInitialization();
note('srt initialize (proxies up)', ms(t));

t = performance.now(); let r = await sb('true', c);
note('wrap + run `true` (first)', `${ms(t)} code=${r.code}`);
const lat = [];
for (let i = 0; i < 10; i++) { t = performance.now(); await sb('true', c); lat.push(performance.now() - t); }
lat.sort((a, b) => a - b);
note('wrap + run `true` (median of 10)', `${lat[5].toFixed(0)} ms`);

t = performance.now(); r = await sb('git status --short | wc -l && git log --oneline -1', c);
note('git status + log', `${ms(t)} code=${r.code} ${r.out.replace(/\n/g, ' | ')}`);
t = performance.now(); r = await sb("rg -l 'automaticRunAllowed' apps/backend/src | wc -l", c);
note('rg over repo', `${ms(t)} files=${r.out}`);

// boundary probes
r = await sb(`cat ${HOME}/.ssh/spike_fake_key`, c);
note('READ ~/.ssh secret (want: denied)', r.code === 0 ? `LEAK: ${r.out}` : `denied (${r.err.split('\n')[0]})`);
r = await sb(`ls ${HOME}/.claude | head -1`, c);
note('READ ~/.claude (want: denied)', r.code === 0 && r.out ? `LEAK: ${r.out}` : 'denied');
r = await sb(`echo x > ${SRC}/SPIKE_SHOULD_NOT_EXIST`, c);
note('WRITE the warm checkout (want: denied)', r.code === 0 ? 'LEAK: wrote' : 'denied');
r = await sb('echo x > .git-probe && echo ok', c);
note('WRITE scratch worktree (want: ok)', r.out === 'ok' ? 'ok' : `failed ${r.err}`);
r = await sb('echo x > "$TMPDIR/p" && echo ok', c);
note('WRITE chat TMPDIR (want: ok)', r.out === 'ok' ? 'ok' : `failed ${r.err}`);
r = await sb('curl -s -o /dev/null -w "%{http_code}" --max-time 8 https://example.com', c);
note('NET example.com (want: blocked)', r.out === '200' ? 'LEAK: 200' : `blocked (${r.out || r.code})`);
r = await sb('curl -sS -o /dev/null -w "%{http_code}" --max-time 8 https://registry.npmjs.org/react 2>&1', c);
note('NET registry.npmjs.org (want: 200)', r.out);
r = await sb('curl -s -o /dev/null -w "%{http_code}" --max-time 3 http://169.254.169.254/', c);
note('NET metadata 169.254.169.254 (want: blocked)', r.out === '200' ? 'LEAK' : `blocked (${r.out || r.code})`);

r = await sb('echo "gh=${GH_TOKEN:-unset} aws=${AWS_SECRET_ACCESS_KEY:-unset}"', c);
note('ENV host tokens visible (want: unset)', r.out);
// a focused test run, the "run code in chats" case
t = performance.now();
r = await sb('cd apps/backend && ./node_modules/.bin/vitest run --cache=false src/review/cheap-usage.test.ts src/review/agentic.test.ts 2>&1 | grep -E "Test Files|Tests |EROFS|Error"', c);
note('vitest two files in sandbox', `${ms(t)} code=${r.code} ${r.out.replace(/\x1b\[[0-9;]*m/g,'').split('\n').map(l=>l.trim()).filter(Boolean).filter(l=>/EROFS|path:|Tests|passed/.test(l)).join(' | ').slice(0, 400)}`);

await SandboxManager.reset();
fs.rmSync(path.join(c.repo, '.git-probe'), { force: true });

// reaper check: age the stamp past TTL, reap, confirm it's gone
fs.writeFileSync(path.join(c.chat, '.limn-last-active'), String(Date.now() - TTL_MS - 1));
t = performance.now();
const gone = reap();
note('reaper removes an idle chat', `${ms(t)} removed=${gone.length} exists=${fs.existsSync(c.chat)}`);
fs.writeFileSync(path.join(ROOT, 'results.json'), JSON.stringify(results, null, 2));
