#!/usr/bin/env node
// SPIKE 1 (not shipped): the Claude Code INTERACTIVE driver (docs/SANDBOX.md § Spike results).
//
//   CLAUDE_CODE_OAUTH_TOKEN=… node spike1-claude.mjs [--record]
//
// ONE long-lived process inside the sandbox, credential injected at the proxy (spike 3):
//   claude -p --input-format stream-json --output-format stream-json --verbose
//          --include-partial-messages --permission-mode plan --allow-dangerously-skip-permissions
//          --effort low --model sonnet --max-turns 6 --strict-mcp-config
// and over stdin:
//   0. control_request `initialize`                    (what the SDK sends first)
//   1. user turn  "Reply with the single word: alpha."                    → result #1
//   2. user turn  "touch /work/plan-mode.txt, then the word you said"     → plan mode must NOT write
//   3. control_request `set_permission_mode` → bypassPermissions          → control_response success
//      user turn  "echo built > /work/built.txt"                          → the file exists
//   4. user turn  "count to 300"; at the first text delta, control_request `interrupt` → turn ends
//   5. user turn  "Reply with the single word: still-here."               → the process survived
// --record writes the scrubbed stdout stream (and what was sent) to src/sandbox/drivers/__fixtures__/.
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { newSpike, startNetworkAndProxy, startSandbox, execInteractive, proxyLog, PLACEHOLDER, scrub, FIXTURES } from './lib.mjs';

const realOauth = process.env.CLAUDE_CODE_OAUTH_TOKEN;
if (!realOauth) {
  console.error('Needs CLAUDE_CODE_OAUTH_TOKEN in this process environment.');
  process.exit(1);
}
const record = process.argv.includes('--record');
const s = newSpike('claude');
const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
};
const out = []; // raw stdout lines
const sent = []; // what went in on stdin

try {
  const { net, proxy } = startNetworkAndProxy(s, { allow: [], secretEnv: { LIMN_REAL_ANTHROPIC_OAUTH: realOauth } });
  const box = startSandbox(s, net, {
    HTTPS_PROXY: 'http://limn-proxy:3128',
    HTTP_PROXY: 'http://limn-proxy:3128',
    NO_PROXY: 'limn-proxy',
    ANTHROPIC_BASE_URL: 'http://limn-proxy:8081',
    CLAUDE_CODE_OAUTH_TOKEN: PLACEHOLDER,
  });
  await new Promise((r) => setTimeout(r, 1200));

  const p = execInteractive(s, box, [
    'claude', '-p',
    '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--include-partial-messages',
    '--permission-mode', 'plan', '--allow-dangerously-skip-permissions',
    '--effort', 'low', '--model', 'sonnet', '--max-turns', '6', '--strict-mcp-config',
  ]);
  const send = (o) => {
    sent.push(o);
    p.send(o);
  };
  let reqN = 0;
  const control = (request) => {
    const request_id = `limn_${++reqN}`;
    send({ type: 'control_request', request_id, request });
    return request_id;
  };
  const user = (text) => send({ type: 'user', session_id: '', parent_tool_use_id: null, message: { role: 'user', content: text } });

  /** Read events until `stop(ev)` is true; returns the matching event (or null on end/timeout). */
  const until = async (stop, { onEvent, timeoutMs = 120_000 } = {}) => {
    for (;;) {
      const r = await p.next(timeoutMs);
      if (r.end || r.timeout) return null;
      out.push(r.line);
      let ev;
      try {
        ev = JSON.parse(r.line);
      } catch {
        continue;
      }
      onEvent?.(ev);
      if (stop(ev)) return ev;
    }
  };
  const isResult = (ev) => ev.type === 'result';
  const controlFor = (id) => (ev) => ev.type === 'control_response' && ev.response?.request_id === id;

  // 0. initialize
  const initId = control({ subtype: 'initialize', hooks: null });
  const init = await until(controlFor(initId), { timeoutMs: 60_000 });
  check('initialize control_request answered', init?.response?.subtype === 'success', init ? `keys: ${Object.keys(init.response?.response ?? {}).join(',')}` : p.stderr().slice(0, 200));

  // 1. turn 1
  let partials = 0;
  let sessionId = null;
  user('Reply with the single word: alpha.');
  const r1 = await until(isResult, {
    onEvent: (ev) => {
      if (ev.type === 'stream_event') partials++;
      if (ev.type === 'system' && ev.subtype === 'init') sessionId = ev.session_id;
    },
  });
  check('turn 1 ends with a result', r1?.subtype === 'success', `result=${JSON.stringify(r1?.result)} permissionMode(init)=plan`);
  check('partial messages stream (stream_event)', partials > 0, `${partials} stream_event lines in turn 1`);
  check('usage + cost on the result', r1?.usage != null && typeof r1?.total_cost_usd === 'number', `usage keys: ${Object.keys(r1?.usage ?? {}).join(',')}; cost=${r1?.total_cost_usd}`);

  // 2. plan mode must not write
  user('Use the Bash tool to run `touch /work/plan-mode.txt`. Then tell me, in one word, the word you replied with before.');
  let denials = 0;
  const r2 = await until(isResult);
  denials = r2?.permission_denials?.length ?? 0;
  const planFile = s.sh(['exec', box, 'bash', '-c', 'test -e /work/plan-mode.txt && echo yes || echo no'], { allowFail: true }).trim();
  check('plan mode: no write happened', planFile === 'no', `file exists=${planFile}; permission_denials=${denials}; result=${JSON.stringify(String(r2?.result ?? '').slice(0, 120))}`);
  check('same conversation across turns (one session id)', r2?.session_id === r1?.session_id && !!sessionId, `session ${String(sessionId).slice(0, 8)}…`);
  check('turn 2 remembers turn 1', /alpha/i.test(String(r2?.result ?? '')), '');

  // 3. switch to bypassPermissions
  const modeId = control({ subtype: 'set_permission_mode', mode: 'bypassPermissions' });
  const mode = await until(controlFor(modeId), { timeoutMs: 30_000 });
  check('set_permission_mode bypassPermissions accepted', mode?.response?.subtype === 'success', JSON.stringify(mode?.response ?? null).slice(0, 160));
  user('Use the Bash tool to run `echo built > /work/built.txt`. Then reply: done.');
  const r3 = await until(isResult);
  const built = s.sh(['exec', box, 'bash', '-c', 'cat /work/built.txt 2>/dev/null || echo MISSING'], { allowFail: true }).trim();
  check('after the switch the build writes', built === 'built', `file=${built}; result=${JSON.stringify(r3?.result)}`);

  // 4. interrupt mid-stream
  user('Write the numbers 1 to 300, one per line, nothing else.');
  let interruptId = null;
  let interruptAck = null;
  const r4 = await until(isResult, {
    onEvent: (ev) => {
      if (!interruptId && ev.type === 'stream_event' && ev.event?.type === 'content_block_delta') interruptId = control({ subtype: 'interrupt' });
      if (interruptId && controlFor(interruptId)(ev)) interruptAck = ev;
    },
  });
  check('interrupt acknowledged and the turn ends', !!interruptAck && !!r4, `ack=${interruptAck?.response?.subtype}; result subtype=${r4?.subtype}; is_error=${r4?.is_error}`);

  // 5. still alive
  user('Reply with the single word: still-here.');
  const r5 = await until(isResult);
  check('process survives an interrupt', /still-here/i.test(String(r5?.result ?? '')), `result=${JSON.stringify(r5?.result)}`);

  p.child.stdin.end();
  await until(() => false, { timeoutMs: 20_000 });

  const log = proxyLog(s, proxy);
  const hosts = [...new Set(log.filter((l) => l.kind === 'connect' || l.kind === 'forward').map((l) => `${l.host}:${l.port} ${l.allowed ? 'allowed' : 'DENIED'}`))];
  const injected = log.filter((l) => l.kind === 'inject');
  check('every model call went through the injector', injected.length > 0 && injected.every((l) => l.swapped === 'bearer'), `${injected.length} requests, paths: ${[...new Set(injected.map((l) => l.path))].join(',')}; other hosts tried: ${hosts.join('; ') || 'none'}`);

  if (record) {
    mkdirSync(FIXTURES, { recursive: true });
    const clean = (l) => scrub(l, [realOauth]);
    writeFileSync(resolve(FIXTURES, 'claude-interactive.out.jsonl'), out.map(clean).join('\n') + '\n');
    writeFileSync(resolve(FIXTURES, 'claude-interactive.in.jsonl'), sent.map((o) => clean(JSON.stringify(o))).join('\n') + '\n');
    console.log(`Recorded ${out.length} lines → ${FIXTURES}/claude-interactive.{out,in}.jsonl`);
  }
} finally {
  s.teardown();
}
process.exit(results.every((r) => r.ok) ? 0 : 1);
