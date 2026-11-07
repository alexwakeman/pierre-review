// The Codex app-server fold: the RECORDED usage-limit session (spike 2) and a successful turn built from
// the 0.164 protocol schema (no successful turn could be recorded: the account was over its limit).
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { CodexStreamFold, codexErrorCode, type CodexFoldOutput } from './codex-parse.js';
import { SUCCESS_TURN, usage } from './codex.test-support.js';

const wire = readFileSync(fileURLToPath(new URL('./__fixtures__/codex-app-server-usage-limit.jsonl', import.meta.url)), 'utf8')
  .split('\n')
  .filter(Boolean)
  .map((l) => JSON.parse(l) as { dir: 'in' | 'out'; msg: { method?: string; params?: unknown } });

describe('CodexStreamFold', () => {
  it('the recorded usage-limit session: both turns fail with the usage limit', () => {
    const fold = new CodexStreamFold();
    const outs: CodexFoldOutput[] = wire.filter((w) => w.dir === 'out' && w.msg.method).map((w) => fold.feed(w.msg.method!, w.msg.params));
    expect(outs.flatMap((o) => (o.turnStarted ? [o.turnStarted] : []))).toEqual(['01a1b35f-5887-7e00-9d08-d80ca5d423e2', '01a1b35f-5c73-7ce2-af4b-f19bcc86dca5']);
    const ends = outs.flatMap((o) => (o.turnEnd ? [o.turnEnd] : []));
    expect(ends).toHaveLength(2);
    for (const e of ends) {
      expect(e.outcome).toBe('failed');
      expect(e.error?.code).toBe('usage_limit');
      expect(e.error?.message).toMatch(/usage limit/);
      expect(e.usage).toBeNull(); // no model call was made: tokens unknown, never zero
    }
    // Nothing else is shown (user-message items, rate limits, MCP start-up).
    expect(outs.flatMap((o) => o.events)).toEqual([]);
  });

  it('a successful turn: tool calls, results, streamed text, and THIS turn\'s tokens', () => {
    const fold = new CodexStreamFold();
    const outs = SUCCESS_TURN.map((m) => fold.feed(m.method, m.params));
    expect(outs.flatMap((o) => o.events)).toEqual([
      { type: 'tool_call', id: 'c1', tool: 'shell', summary: 'npm test' },
      { type: 'tool_result', id: 'c1', ok: false, output: '1 failing' },
      { type: 'tool_call', id: 'f1', tool: 'edit', summary: '/w/a.ts' },
      { type: 'tool_result', id: 'f1', ok: true, output: '/w/a.ts' },
      { type: 'text', messageId: 'm1', partial: true, text: 'Fixed ' },
      { type: 'text', messageId: 'm1', partial: true, text: 'it.' },
      { type: 'text', messageId: 'm1', partial: false, text: 'Fixed it.' },
    ]);
    const end = outs.at(-1)!.turnEnd!;
    expect(end).toMatchObject({ turnId: 'tu-1', outcome: 'completed', text: 'Fixed it.', error: null });
    // 2500 input of which 1200 cached; the ledger keeps the raw input, as every Codex row does.
    expect(end.usage).toEqual({ inputTokens: 1300, outputTokens: 90, cacheReadTokens: 1200, cacheCreationTokens: 0, costUsd: null });
    expect(end.ledgerInputTokens).toBe(2500);
    expect(fold.turnId).toBeNull();
  });

  it("after a resume the thread's total includes the old turns; only this turn is counted", () => {
    const fold = new CodexStreamFold();
    fold.feed('turn/started', { turn: { id: 'tu-9' } });
    // First request of the turn: the thread already had 10,000 input / 500 output.
    fold.feed(usage([10_300, 0, 520], [300, 0, 20]).method, usage([10_300, 0, 520], [300, 0, 20]).params);
    fold.feed(usage([10_700, 0, 560], [400, 0, 40]).method, usage([10_700, 0, 560], [400, 0, 40]).params);
    const end = fold.feed('turn/completed', { turn: { id: 'tu-9', status: 'completed' } }).turnEnd!;
    expect(end.usage).toMatchObject({ inputTokens: 700, outputTokens: 60 });
  });

  it('an interrupted turn is not an error; a retried error is not shown', () => {
    const fold = new CodexStreamFold();
    expect(fold.feed('error', { willRetry: true, error: { message: 'reconnecting' } }).events).toEqual([]);
    const end = fold.feed('turn/completed', { turn: { id: 'x', status: 'interrupted' } }).turnEnd!;
    expect(end).toMatchObject({ outcome: 'interrupted', error: null, usage: null });
  });

  it('a failed turn with no error notification takes the turn\'s own error', () => {
    const fold = new CodexStreamFold();
    const end = fold.feed('turn/completed', { turn: { id: 'x', status: 'failed', error: { message: 'Unauthorized', codexErrorInfo: 'unauthorized' } } }).turnEnd!;
    expect(end.error).toEqual({ code: 'auth', message: 'Unauthorized' });
  });

  it('maps the error kinds', () => {
    expect(codexErrorCode('usageLimitExceeded')).toBe('usage_limit');
    expect(codexErrorCode('rateLimitExceeded')).toBe('usage_limit');
    expect(codexErrorCode('unauthorized')).toBe('auth');
    expect(codexErrorCode({ httpConnectionFailed: { httpStatusCode: 502 } })).toBe('turn_failed');
  });
});
