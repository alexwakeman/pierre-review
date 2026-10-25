// Entry of Limn's Codex PreToolUse hook (`hook.ts` builds its config; `hook-rule.ts` decides).
// Codex runs it with the call's JSON on stdin; EXIT 2 + a reason on stderr blocks the call
// (CODEX-SPIKE.md § 5). It FAILS CLOSED: any other outcome — no roots in the environment, bad input,
// an exception — is also exit 2, because a hook that exits 1 lets the call through.
// ⚠ Node built-ins and relative files ONLY (scripts/build-release.mjs asserts it).
import { appendFileSync, writeSync } from 'node:fs';
import { decideCodexToolCall, decodeGuardRoots, GUARD_ENV } from './hook-rule.js';

const MAX_INPUT_BYTES = 16 * 1024 * 1024;

function finish(code: 0 | 2, reason: string | null, payload: unknown): never {
  const logFile = process.env.LIMN_CODEX_GUARD_LOG;
  if (logFile) {
    try {
      const p = payload && typeof payload === 'object' ? (payload as Record<string, unknown>) : {};
      appendFileSync(
        logFile,
        `${JSON.stringify({ t: Date.now(), tool: p.tool_name, input: JSON.stringify(p.tool_input ?? null).slice(0, 4000), allow: code === 0, reason })}\n`,
      );
    } catch {
      /* logging never changes the decision */
    }
  }
  // writeSync: a pipe write is asynchronous on macOS, and process.exit would drop it.
  if (reason) {
    try {
      writeSync(2, `${reason}\n`);
    } catch {
      /* the exit code still blocks the call */
    }
  }
  process.exit(code);
}

let size = 0;
const chunks: Buffer[] = [];
process.stdin.on('data', (c: Buffer) => {
  size += c.length;
  if (size > MAX_INPUT_BYTES) finish(2, 'Limn path guard: refused: the tool call is too large to check.', null);
  chunks.push(c);
});
process.stdin.on('end', () => {
  let payload: unknown = null;
  try {
    payload = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    const p = payload as { tool_name?: unknown; tool_input?: unknown; cwd?: unknown };
    const roots = decodeGuardRoots(process.env[GUARD_ENV]);
    if (!roots) finish(2, 'Limn path guard: refused: the guard was started without its folders.', payload);
    if (typeof p.tool_name !== 'string') finish(2, 'Limn path guard: refused: the call names no tool.', payload);
    const d = decideCodexToolCall(p.tool_name, p.tool_input, roots, typeof p.cwd === 'string' ? p.cwd : null);
    if (d.allow) finish(0, null, payload);
    finish(2, d.reason, payload);
  } catch {
    finish(2, 'Limn path guard: refused: the tool call could not be read.', payload);
  }
});
process.stdin.on('error', () => finish(2, 'Limn path guard: refused: the tool call could not be read.', null));
