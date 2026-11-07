#!/usr/bin/env node
// SPIKE 2 (+ spike 3 for Codex) (not shipped): the Codex driver inside the sandbox
// (docs/SANDBOX.md § Spike results). Each mode is ONE tiny run; the container is deleted after.
//
//   node spike2-codex.mjs --mode exec [--record]
//       TOKEN IN THE SANDBOX: a fresh CODEX_HOME holding a COPY of ~/.limn/codex/auth.json
//       (written over stdin, never printed). Turn 1 `codex exec --json --sandbox read-only`
//       (tries a write: must be refused), turn 2 `codex exec resume <thread> --json
//       --dangerously-bypass-approvals-and-sandbox` (writes; recalls turn 1). Egress via the proxy's
//       allow-list; every host Codex reached is listed.
//
//   node spike2-codex.mjs --mode app-server [--record]
//       INJECTED: the sandbox's auth.json holds FAKE JWTs (same claims, no signature) and a
//       placeholder refresh token; a custom model provider points at the proxy's ChatGPT injector,
//       which swaps the bearer for the host's real access token (read per request from a
//       READ-ONLY mount). Driven through `codex app-server` (JSON-RPC): thread/start, turn/start
//       with sandboxPolicy readOnly (chat), turn/start with dangerFullAccess (build), turn/interrupt.
//
// ⚠ A refresh INSIDE the sandbox would rotate the reader's refresh token and sign the HOST out
// (OpenAI refresh tokens are single-use). The exec mode runs only while the host's last_refresh is
// recent (Codex refreshes on age), and checks it first.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { newSpike, startNetworkAndProxy, startSandbox, execInteractive, proxyLog, scrub, fakeJwt, decodeJwt, FIXTURES, PLACEHOLDER } from './lib.mjs';

const mode = process.argv[process.argv.indexOf('--mode') + 1];
const record = process.argv.includes('--record');
if (mode !== 'exec' && mode !== 'app-server') {
  console.error('usage: node spike2-codex.mjs --mode exec|app-server [--record]');
  process.exit(1);
}
const AUTH_FILE = resolve(homedir(), '.limn/codex/auth.json');
const auth = JSON.parse(readFileSync(AUTH_FILE, 'utf8'));
const secrets = [auth.tokens?.access_token, auth.tokens?.refresh_token, auth.tokens?.id_token].filter(Boolean);
const ageDays = (Date.now() - Date.parse(auth.last_refresh)) / 86_400_000;
if (ageDays > 5) {
  console.error(`last_refresh is ${ageDays.toFixed(1)} days old: a run might refresh inside the sandbox and sign the host out. Let Limn refresh first.`);
  process.exit(1);
}
const MODEL = 'gpt-6-luna';
const s = newSpike(`codex-${mode}`);
const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
};
const clean = (t) => scrub(t, secrets);
const CODEX_HOME = '/home/agent/.codex-limn';
const baseEnv = { HTTPS_PROXY: 'http://limn-proxy:3128', HTTP_PROXY: 'http://limn-proxy:3128', NO_PROXY: 'limn-proxy', CODEX_HOME };

function writeIn(box, path, content) {
  s.sh(['exec', '-i', box, 'bash', '-c', `mkdir -p "$(dirname '${path}')" && umask 077 && cat > '${path}'`], { input: content });
}

try {
  if (mode === 'exec') {
    const { net, proxy } = startNetworkAndProxy(s, { allow: ['chatgpt.com', '*.chatgpt.com', 'auth.openai.com', 'api.openai.com'] });
    const box = startSandbox(s, net, baseEnv);
    writeIn(box, `${CODEX_HOME}/auth.json`, JSON.stringify(auth));
    writeIn(box, `${CODEX_HOME}/config.toml`, 'cli_auth_credentials_store = "file"\ncheck_for_update_on_startup = false\n[analytics]\nenabled = false\n');
    const common = ['--json', '--skip-git-repo-check', '-m', MODEL, '-c', 'model_reasoning_effort="low"'];

    const t1 = s.sh(['exec', '-i', '-w', '/work', box, 'codex', 'exec', ...common, '--sandbox', 'read-only', '-C', '/work', '-'], {
      allowFail: true,
      input: 'Use the shell to run `touch /work/ro.txt`. Whatever happens, then reply with the single word: alpha.',
    });
    const ev1 = t1.split('\n').filter(Boolean).flatMap((l) => { try { return [JSON.parse(l)]; } catch { return []; } });
    const thread = ev1.find((e) => e.type === 'thread.started')?.thread_id;
    const done1 = ev1.find((e) => e.type === 'turn.completed');
    const msg1 = ev1.filter((e) => e.item?.type === 'agent_message').map((e) => e.item.text).join(' ');
    const ro = s.sh(['exec', box, 'bash', '-c', 'test -e /work/ro.txt && echo yes || echo no'], { allowFail: true }).trim();
    check('turn 1 completes (token in sandbox, via the proxy)', !!done1, `thread ${String(thread).slice(0, 8)}…; message=${JSON.stringify(msg1.slice(0, 80))}`);
    check('read-only sandbox refused the write', ro === 'no', `ro.txt exists=${ro}; items: ${[...new Set(ev1.map((e) => e.item?.type).filter(Boolean))].join(',')}`);
    check('usage on turn.completed', !!done1?.usage, JSON.stringify(done1?.usage ?? null));

    const t2 = s.sh(['exec', '-i', '-w', '/work', box, 'codex', 'exec', 'resume', ...common, '--dangerously-bypass-approvals-and-sandbox', thread ?? '--last', '-'], {
      allowFail: true,
      input: 'Use the shell to run `echo built > /work/built.txt`. Then reply with the word you replied with before, and nothing else.',
    });
    const ev2 = t2.split('\n').filter(Boolean).flatMap((l) => { try { return [JSON.parse(l)]; } catch { return []; } });
    const msg2 = ev2.filter((e) => e.item?.type === 'agent_message').map((e) => e.item.text).join(' ');
    const built = s.sh(['exec', box, 'bash', '-c', 'cat /work/built.txt 2>/dev/null || echo MISSING'], { allowFail: true }).trim();
    check('resume keeps the thread', ev2.find((e) => e.type === 'thread.started')?.thread_id === thread, '');
    check('resume recalls turn 1', /alpha/i.test(msg2), JSON.stringify(msg2.slice(0, 80)));
    check('bypass turn writes', built === 'built', `built.txt=${built}`);
    const after = JSON.parse(s.sh(['exec', box, 'cat', `${CODEX_HOME}/auth.json`], { allowFail: true }) || '{}');
    check('no token refresh happened in the sandbox', after.last_refresh === auth.last_refresh, `last_refresh ${after.last_refresh === auth.last_refresh ? 'unchanged' : 'CHANGED'}`);

    const log = proxyLog(s, proxy);
    console.log('Hosts:', [...new Set(log.filter((l) => l.host).map((l) => `${l.host}:${l.port} ${l.allowed ? 'allowed' : 'DENIED'}`))].join('; '));
    if (record) {
      mkdirSync(FIXTURES, { recursive: true });
      writeFileSync(resolve(FIXTURES, 'codex-exec-turn1.jsonl'), clean(t1));
      writeFileSync(resolve(FIXTURES, 'codex-exec-resume.jsonl'), clean(t2));
      console.log(`Recorded → ${FIXTURES}/codex-exec-{turn1,resume}.jsonl`);
    }
  } else {
    // The sandbox's auth.json: the real file's SHAPE with every secret replaced.
    const access = decodeJwt(auth.tokens.access_token);
    const id = decodeJwt(auth.tokens.id_token);
    const fakeAccess = fakeJwt({ exp: access.exp, iat: access.iat, 'https://api.openai.com/auth': access['https://api.openai.com/auth'] });
    const fakeAuth = {
      ...auth,
      OPENAI_API_KEY: null,
      tokens: {
        ...auth.tokens,
        access_token: fakeAccess,
        id_token: fakeJwt({ exp: access.exp, iat: id.iat, 'https://api.openai.com/auth': id['https://api.openai.com/auth'] }),
        refresh_token: PLACEHOLDER,
      },
    };
    const { net, proxy } = startNetworkAndProxy(s, {
      allow: [],
      mounts: [`${AUTH_FILE}:/run/limn/codex-auth.json:ro`],
      extraEnv: { LIMN_CHATGPT_AUTH_FILE: '/run/limn/codex-auth.json', LIMN_CHATGPT_PLACEHOLDER: fakeAccess },
    });
    const box = startSandbox(s, net, baseEnv);
    writeIn(box, `${CODEX_HOME}/auth.json`, JSON.stringify(fakeAuth));
    writeIn(
      box,
      `${CODEX_HOME}/config.toml`,
      [
        'cli_auth_credentials_store = "file"',
        'check_for_update_on_startup = false',
        'model_provider = "limn"',
        'chatgpt_base_url = "http://limn-proxy:8082/backend-api/"',
        '[analytics]',
        'enabled = false',
        '[model_providers.limn]',
        'name = "OpenAI via Limn"',
        'base_url = "http://limn-proxy:8082/backend-api/codex"',
        'wire_api = "responses"',
        'requires_openai_auth = true',
        '',
      ].join('\n'),
    );

    const p = execInteractive(s, box, ['codex', 'app-server']);
    const wire = [];
    let nextId = 0;
    const call = (method, params) => {
      const id = ++nextId;
      const m = { jsonrpc: '2.0', id, method, params };
      wire.push({ dir: 'in', msg: m });
      p.send(m);
      return id;
    };
    const notify = (method, params) => {
      const m = { jsonrpc: '2.0', method, ...(params ? { params } : {}) };
      wire.push({ dir: 'in', msg: m });
      p.send(m);
    };
    const until = async (stop, onMsg, timeoutMs = 120_000) => {
      for (;;) {
        const r = await p.next(timeoutMs);
        if (r.end || r.timeout) return null;
        let m;
        try {
          m = JSON.parse(r.line);
        } catch {
          continue;
        }
        wire.push({ dir: 'out', msg: m });
        onMsg?.(m);
        if (stop(m)) return m;
      }
    };
    const reply = (id) => (m) => m.id === id && ('result' in m || 'error' in m);

    const initId = call('initialize', { clientInfo: { name: 'limn-spike', title: 'Limn spike', version: '0' } });
    const init = await until(reply(initId));
    notify('initialized');
    check('app-server initialize', !!init?.result, JSON.stringify(init?.error ?? Object.keys(init?.result ?? {})));

    const tsId = call('thread/start', { cwd: '/work', model: MODEL, approvalPolicy: 'never', sandbox: 'read-only' });
    const ts = await until(reply(tsId));
    const threadId = ts?.result?.thread?.id;
    check('thread/start', !!threadId, ts?.error ? JSON.stringify(ts.error) : `thread ${String(threadId).slice(0, 8)}…`);

    let deltas = 0;
    let usage1 = null;
    const t1 = call('turn/start', {
      threadId,
      input: [{ type: 'text', text: 'Use the shell to run `touch /work/ro.txt`. Whatever happens, then reply with the single word: alpha.' }],
      sandboxPolicy: { type: 'readOnly' },
      effort: 'low',
    });
    const done1 = await until(
      (m) => m.method === 'turn/completed' || (m.id === t1 && m.error),
      (m) => {
        if (m.method === 'item/agentMessage/delta') deltas++;
        if (m.method === 'thread/tokenUsage/updated') usage1 = m.params;
      },
    );
    const ro = s.sh(['exec', box, 'bash', '-c', 'test -e /work/ro.txt && echo yes || echo no'], { allowFail: true }).trim();
    check('turn 1 (readOnly) completes on the INJECTED credential', done1?.method === 'turn/completed' && done1.params?.turn?.status !== 'failed', JSON.stringify(done1?.params?.turn?.status ?? done1?.error ?? null));
    check('agent message streams as deltas', deltas > 0, `${deltas} item/agentMessage/delta`);
    check('readOnly refused the write', ro === 'no', `ro.txt exists=${ro}`);
    check('token usage notification', !!usage1, JSON.stringify(usage1?.tokenUsage?.last ?? usage1 ?? null).slice(0, 200));

    // Build turn: dangerFullAccess on the SAME thread, interrupted once it starts streaming.
    let interrupted = false;
    let turnId = null;
    const t2 = call('turn/start', {
      threadId,
      input: [{ type: 'text', text: 'Use the shell to run `echo built > /work/built.txt`. Then write the numbers 1 to 200, one per line.' }],
      sandboxPolicy: { type: 'dangerFullAccess' },
      effort: 'low',
    });
    const done2 = await until(
      (m) => m.method === 'turn/completed' || (m.id === t2 && m.error),
      (m) => {
        if (m.id === t2 && m.result?.turn?.id) turnId = m.result.turn.id;
        if (!interrupted && turnId && m.method === 'item/agentMessage/delta') {
          interrupted = true;
          call('turn/interrupt', { threadId, turnId });
        }
      },
    );
    const built = s.sh(['exec', box, 'bash', '-c', 'cat /work/built.txt 2>/dev/null || echo MISSING'], { allowFail: true }).trim();
    check('dangerFullAccess turn writes (no restart)', built === 'built', `built.txt=${built}`);
    check('turn/interrupt ends the turn', interrupted && done2?.params?.turn?.status === 'interrupted', `status=${done2?.params?.turn?.status}`);
    p.child.stdin.end();
    await until(() => false, undefined, 10_000);

    const log = proxyLog(s, proxy);
    const inj = log.filter((l) => l.kind === 'inject');
    check(
      'every ChatGPT request carried only the placeholder (swapped at the proxy)',
      inj.length > 0 && inj.every((l) => l.swapped === 'bearer' || l.swapped === null) && !inj.some((l) => l.refused),
      `${inj.length} requests: ${[...new Set(inj.map((l) => `${l.method} ${l.path} ${l.status} ${l.swapped}`))].join('; ')}`,
    );
    console.log('Other hosts:', [...new Set(log.filter((l) => l.host).map((l) => `${l.host}:${l.port} ${l.allowed ? 'allowed' : 'DENIED'}`))].join('; ') || 'none');
    const grep = s.sh(['exec', '-i', box, 'bash', '-c', 'read -r N; grep -rIl -F -- "$N" /home/agent /work /tmp 2>/dev/null | wc -l'], { allowFail: true, input: auth.tokens.access_token.slice(-24) + '\n' });
    check('the real access token appears in no sandbox file', grep.trim() === '0', `files: ${grep.trim()}`);
    if (record) {
      mkdirSync(FIXTURES, { recursive: true });
      writeFileSync(resolve(FIXTURES, 'codex-app-server.jsonl'), wire.map((w) => clean(JSON.stringify(w))).join('\n') + '\n');
      console.log(`Recorded ${wire.length} messages → ${FIXTURES}/codex-app-server.jsonl`);
    }
    if (results.some((r) => !r.ok)) console.log('stderr (scrubbed):', clean(p.stderr()).slice(-1500));
  }
} finally {
  s.teardown();
}
process.exit(results.every((r) => r.ok) ? 0 : 1);
