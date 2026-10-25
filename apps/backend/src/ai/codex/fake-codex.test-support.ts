// A STAND-IN `codex` PROGRAM for the offline tests: `codex app-server` speaking newline JSON-RPC with
// the answers the spike recorded from 0.164.0 (docs/CODEX-SPIKE.md § 6), and `codex login|logout` that
// just log and exit. Written to a temp folder as an executable node script; its behaviour is chosen by
// `mode` and every call is appended to `log` (method, CODEX_HOME, whether an API key reached it) so a
// test can assert what Limn sent and with which environment. ⚠ Both ride a SIDECAR file
// (`<script>.json`, `setFakeCodex`), never the environment: Limn hands a Codex process only its
// allow-list (config.ts `codexBaseEnv`), so a variable set in the test's environment never arrives.
import { chmodSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const SCRIPT = String.raw`#!/usr/bin/env node
const { appendFileSync, readFileSync } = require('node:fs');
let side = {};
try { side = JSON.parse(readFileSync(process.argv[1] + '.json', 'utf8')); } catch {}
const mode = side.mode || 'signedin';
const logFile = side.log;
const log = (o) => { if (logFile) appendFileSync(logFile, JSON.stringify(o) + '\n'); };
const sub = process.argv[2];
log({ argv: process.argv.slice(2), codexHome: process.env.CODEX_HOME || null, apiKey: !!(process.env.OPENAI_API_KEY || process.env.CODEX_API_KEY), cwd: process.cwd() });
if (sub !== 'app-server') process.exit(0);
const send = (o) => process.stdout.write(JSON.stringify(o) + '\n');
let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1);
    if (!line.trim()) continue;
    const m = JSON.parse(line);
    if (m.id === undefined) { log({ notification: m.method }); continue; }
    log({ method: m.method, params: m.params ?? null });
    const ok = (result) => send({ jsonrpc: '2.0', id: m.id, result });
    switch (m.method) {
      case 'initialize': ok({ userAgent: 'fake-codex/0.164.0', codexHome: process.env.CODEX_HOME }); break;
      case 'account/read':
        if (mode === 'hang') break;
        if (mode === 'error') { send({ jsonrpc: '2.0', id: m.id, error: { code: -32000, message: 'refresh failed' } }); break; }
        ok(mode === 'signedout'
          ? { account: null, requiresOpenaiAuth: true }
          : { account: { type: 'chatgpt', email: 'x@y', planType: 'plus' }, requiresOpenaiAuth: true });
        break;
      case 'account/rateLimits/read':
        ok({ rateLimits: {
          limitId: 'codex',
          primary: { usedPercent: 1, windowDurationMins: 300, resetsAt: 1792939601 },
          secondary: { usedPercent: 3, windowDurationMins: 10080, resetsAt: 1793526401 },
          planType: 'plus',
        } });
        break;
      case 'account/usage/read':
        ok({ summary: { lifetimeTokens: 12345 }, dailyUsageBuckets: [{ startDate: '2026-10-25', tokens: 500 }] });
        break;
      case 'account/login/start':
        if (mode === 'login-slow') { setTimeout(() => ok({ type: 'chatgpt', loginId: 'L1', authUrl: 'https://auth.openai.com/oauth/authorize?x=1' }), 400); break; }
        if (m.params?.type === 'chatgptDeviceCode') ok({ type: 'chatgptDeviceCode', loginId: 'L2', userCode: 'ABCD-1234', verificationUrl: 'https://auth.openai.com/codex/device' });
        else ok({ type: 'chatgpt', loginId: 'L1', authUrl: 'https://auth.openai.com/oauth/authorize?x=1' });
        if (mode === 'login-ok') setTimeout(() => send({ jsonrpc: '2.0', method: 'account/login/completed', params: { success: true, loginId: m.params?.type === 'chatgptDeviceCode' ? 'L2' : 'L1', error: null } }), 50);
        if (mode === 'login-fail') setTimeout(() => send({ jsonrpc: '2.0', method: 'account/login/completed', params: { success: false, loginId: 'L1', error: 'access denied' } }), 50);
        break;
      case 'account/login/cancel': ok({}); break;
      case 'account/logout': ok({}); break;
      default: send({ jsonrpc: '2.0', id: m.id, error: { code: -32601, message: 'unknown method ' + m.method } });
    }
  }
});
process.stdin.on('end', () => process.exit(0));
process.on('SIGTERM', () => { log({ signal: 'SIGTERM' }); process.exit(0); });
`;

/** Write the fake `codex` into `dir` and return its path (executable). */
export function writeFakeCodex(dir: string): string {
  const file = join(dir, 'codex');
  writeFileSync(file, SCRIPT);
  chmodSync(file, 0o755);
  return file;
}

const sidecars = new Map<string, { mode?: string; log?: string }>();

/** Set the fake's behaviour (`mode`) and call log (`log`) — merged into its sidecar file. */
export function setFakeCodex(fake: string, patch: { mode?: string; log?: string }): void {
  const next = { ...(sidecars.get(fake) ?? {}), ...patch };
  sidecars.set(fake, next);
  writeFileSync(`${fake}.json`, JSON.stringify(next));
}
