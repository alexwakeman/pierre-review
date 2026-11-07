#!/usr/bin/env node
// SPIKE 3 (not shipped): credential injection — the sandbox holds only a PLACEHOLDER; the proxy swaps
// in the real credential on the way out (docs/SANDBOX.md § Spike results).
//
//   node spike3-credentials.mjs            plumbing + API-key path checks (FREE, no model call)
//   CLAUDE_CODE_OAUTH_TOKEN=… node spike3-credentials.mjs --claude
//                                          + ONE tiny Claude Code turn through the injector
//
// What it proves:
//   1. the --internal network has no route out (a direct HTTPS request from the sandbox fails);
//   2. the forward proxy allows a listed host and refuses an unlisted one (403, never connects);
//   3. the Anthropic injector refuses any credential that is not the placeholder, and with the
//      placeholder in `x-api-key` forwards with the HOST's key (no real key here: a dummy one proves
//      the swap reached api.anthropic.com — its 401 names the dummy, never the placeholder);
//   4. (--claude) Claude Code with CLAUDE_CODE_OAUTH_TOKEN=<placeholder> + ANTHROPIC_BASE_URL=<proxy>
//      completes a turn on the reader's subscription, and the token was never in the sandbox.
import { newSpike, startNetworkAndProxy, startSandbox, proxyLog, PLACEHOLDER, scrub } from './lib.mjs';

const wantClaude = process.argv.includes('--claude');
const realOauth = process.env.CLAUDE_CODE_OAUTH_TOKEN;
if (wantClaude && !realOauth) {
  console.error('--claude needs CLAUDE_CODE_OAUTH_TOKEN in this process environment.');
  process.exit(1);
}

const s = newSpike('creds');
const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
};

try {
  const { net, proxy } = startNetworkAndProxy(s, {
    allow: ['registry.npmjs.org', 'limn-proxy:8081'],
    // A DUMMY key (not a real one): proves the x-api-key swap reaches upstream.
    secretEnv: { LIMN_REAL_ANTHROPIC_KEY: 'sk-ant-api03-limn-dummy-key-for-spike', ...(realOauth ? { LIMN_REAL_ANTHROPIC_OAUTH: realOauth } : {}) },
  });
  const box = startSandbox(s, net, {
    HTTPS_PROXY: 'http://limn-proxy:3128',
    HTTP_PROXY: 'http://limn-proxy:3128',
    NO_PROXY: 'limn-proxy',
    ANTHROPIC_BASE_URL: 'http://limn-proxy:8081',
    CLAUDE_CODE_OAUTH_TOKEN: PLACEHOLDER,
  });
  // Give the proxy a moment to listen.
  for (let i = 0; i < 20 && !s.sh(['logs', proxy], { allowFail: true }).includes('"ready"'); i++) await new Promise((r) => setTimeout(r, 250));

  const inBox = (cmd) => s.sh(['exec', box, 'bash', '-lc', cmd], { allowFail: true });

  // 1. No route out.
  const direct = inBox('curl -sS -m 8 --noproxy "*" -o /dev/null -w "%{http_code}" https://example.com 2>&1; echo " exit=$?"');
  check('internal network has no direct route out', !/^200/.test(direct.trim()), direct.trim());

  // 2. Allow-list.
  const ok = inBox('curl -sS -m 15 -o /dev/null -w "%{http_code}" https://registry.npmjs.org/ 2>&1');
  check('listed host through the proxy', ok.trim() === '200', `registry.npmjs.org → ${ok.trim()}`);
  const denied = inBox('curl -sS -m 8 -o /dev/null -w "%{http_code}" https://example.com 2>&1; echo " exit=$?"');
  check('unlisted host refused', !/^200/.test(denied.trim()), `example.com → ${denied.trim()}`);

  // 3. Injector credential rules.
  const body = `'{"model":"claude-haiku-4-5","max_tokens":1,"messages":[{"role":"user","content":"x"}]}'`;
  const foreign = inBox(`curl -sS -m 15 http://limn-proxy:8081/v1/messages -H 'x-api-key: sk-ant-api03-agent-own' -H 'anthropic-version: 2023-06-01' -H 'content-type: application/json' -d ${body} 2>&1`);
  check('a credential that is not the placeholder is refused, never forwarded', /unexpected credential/.test(foreign), scrub(foreign).slice(0, 120));
  const swapped = inBox(`curl -sS -m 20 http://limn-proxy:8081/v1/messages -H 'x-api-key: ${PLACEHOLDER}' -H 'anthropic-version: 2023-06-01' -H 'content-type: application/json' -d ${body} 2>&1`);
  check('placeholder x-api-key swapped and sent to api.anthropic.com', /authentication_error|invalid x-api-key/i.test(swapped), scrub(swapped).slice(0, 160));

  // 4. Claude Code through the injector.
  if (wantClaude) {
    const out = inBox(
      `cd /work && timeout 120 claude -p --output-format json --max-turns 1 --model haiku --strict-mcp-config 'Reply with the single word: injected.' 2>&1`,
    );
    let parsed = null;
    try {
      parsed = JSON.parse(out.trim().split('\n').pop());
    } catch {
      /* not json */
    }
    check(
      'Claude Code turn on the subscription via the injector',
      parsed?.subtype === 'success' && /injected/i.test(parsed?.result ?? ''),
      parsed ? `result=${JSON.stringify(parsed.result)} cost=${parsed.total_cost_usd} is_error=${parsed.is_error}` : scrub(out, [realOauth]).slice(0, 300),
    );
    const env = inBox('printf %s "$CLAUDE_CODE_OAUTH_TOKEN"');
    check('the sandbox holds only the placeholder', env.trim().endsWith(PLACEHOLDER), `CLAUDE_CODE_OAUTH_TOKEN=${env.trim().split('\n').pop()}`);
    // The needle goes in on STDIN, never an argv element.
    const grep = s.sh(['exec', '-i', box, 'bash', '-c', 'read -r N; grep -rIl -F -- "$N" /home/agent /work /tmp 2>/dev/null | wc -l'], { allowFail: true, input: realOauth.slice(-24) + '\n' });
    check('the real token appears in no sandbox file', grep.trim() === '0', `files containing the token's tail: ${grep.trim()}`);
  }

  const log = proxyLog(s, proxy);
  console.log('\nProxy log (scrubbed):');
  for (const l of log) console.log(' ', scrub(JSON.stringify(l), [realOauth]));
} finally {
  s.teardown();
}
process.exit(results.every((r) => r.ok) ? 0 : 1);
