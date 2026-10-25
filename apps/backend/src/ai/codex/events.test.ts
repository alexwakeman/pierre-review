// THE CODEX EVENT STREAM (ai/codex/events.ts), over RECORDED streams from the Phase 0 spike
// (`__fixtures__/`, @openai/codex 0.164.0, gpt-6-luna):
//   read-mcp      — a read-only review through the workspace MCP server, one refused outside read;
//   write-bypass  — an edit + two refused patches (stderr only) + the bypass-flag warning items;
//   hook-deny     — a patch the PreToolUse hook denied: NO event at all, only stderr and prose;
//   auth-401      — no sign-in: reconnect errors, then turn.failed and no usage.
//
//   pnpm --filter @pierre-review/backend test ai/codex/events
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  addUsage,
  cleanCodexError,
  isBypassWarning,
  parseEventLine,
  codexTokensAsAgentTokens,
  progressFromEvent,
  stepFromEvent,
  stderrRefusals,
  stderrTail,
  summarizeEvents,
  usageDelta,
  type CodexEvent,
} from './events.js';

const fx = (name: string): string => readFileSync(new URL(`./__fixtures__/${name}`, import.meta.url), 'utf8');
const events = (name: string): CodexEvent[] =>
  fx(name)
    .split('\n')
    .map(parseEventLine)
    .filter((e): e is CodexEvent => e !== null);

describe('parsing', () => {
  it('parses every line of a recorded stream', () => {
    const lines = fx('read-mcp.jsonl').split('\n').filter((l) => l.trim());
    expect(events('read-mcp.jsonl')).toHaveLength(lines.length);
  });
  it('ignores what is not an event: blanks, non-JSON, unknown types, missing fields', () => {
    for (const l of ['', 'Reading prompt from stdin...', '{bad', '[]', '{"type":"x"}', '{"type":"thread.started"}', '{"type":"item.completed"}']) {
      expect(parseEventLine(l)).toBeNull();
    }
  });
  it('defaults missing usage figures to 0 rather than NaN', () => {
    expect(parseEventLine('{"type":"turn.completed","usage":{"input_tokens":5}}')).toEqual({
      type: 'turn.completed',
      usage: { input_tokens: 5, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: 0, reasoning_output_tokens: 0 },
    });
  });
});

describe('a read-only run through the workspace MCP server', () => {
  const s = summarizeEvents(events('read-mcp.jsonl'));
  it('takes the thread id, the LAST agent message as the answer, and the usage', () => {
    expect(s.threadId).toBe('01a17352-5ce1-70a3-bb8f-32904b146612');
    expect(JSON.parse(s.finalResponse).findings[0].file).toBe('src/math.ts');
    expect(s.usage).toEqual({ inputTokens: 79402, cachedInputTokens: 52480, outputTokens: 329, reasoningOutputTokens: 0 });
    expect(s.turnFailures).toEqual([]);
    expect(s.claimedChanges).toEqual([]);
  });
  it('turns tool calls into status sentences, and a refused read into a failed step with its reason', () => {
    const p = events('read-mcp.jsonl').map(progressFromEvent).filter(Boolean);
    const tools = p.filter((x) => x!.kind === 'tool');
    expect(tools.map((t) => t!.kind === 'tool' && t!.text)).toContain('Reading src/math.ts');
    expect(tools.map((t) => t!.kind === 'tool' && t!.text)).toContain('Listing files');
    const refused = tools.find((t) => t!.kind === 'tool' && t!.status === 'failed');
    expect(refused).toMatchObject({ kind: 'tool', tool: 'read_file', detail: 'refused: ../outside/secret.env is outside the workspace' });
    expect(p[0]).toEqual({ kind: 'status', text: 'Working' });
  });
});

describe('a write run', () => {
  const ev = events('write-bypass.jsonl');
  it('filters the two bypass-flag warning items (noise), and only those', () => {
    expect(ev.filter(isBypassWarning)).toHaveLength(2);
    expect(summarizeEvents(ev).errors).toEqual([]);
    expect(ev.map(progressFromEvent).filter((p) => p?.kind === 'error')).toEqual([]);
  });
  it('reports the edit the stream CLAIMS (informational: the provider verifies with git)', () => {
    expect(summarizeEvents(ev).claimedChanges).toEqual(['/tmp/limn-codex-spike/fixture/src/math.ts']);
    expect(ev.map(progressFromEvent)).toContainEqual({
      kind: 'file_change',
      paths: ['/tmp/limn-codex-spike/fixture/src/math.ts'],
      status: 'completed',
    });
  });
  it('the refused patches exist ONLY on stderr', () => {
    expect(stderrRefusals(fx('write-bypass.stderr'))).toEqual([
      'patch rejected: writing outside of the project; rejected by user approval settings',
      'Command blocked by PreToolUse hook: Limn path guard: refused. Command: *** Begin Patch',
    ]);
  });
});

describe('a hook denial', () => {
  it('emits no file_change and no error event — only prose and stderr', () => {
    const ev = events('hook-deny.jsonl');
    const s = summarizeEvents(ev);
    expect(s.claimedChanges).toEqual([]);
    expect(s.errors).toEqual([]);
    expect(stderrRefusals(fx('hook-deny.stderr'))).toHaveLength(1);
    expect(stderrRefusals(fx('hook-deny.stderr'))[0]).toMatch(/blocked by PreToolUse hook/);
  });
});

describe('no sign-in', () => {
  it('ends in turn.failed with NO usage (never a zero)', () => {
    const s = summarizeEvents(events('auth-401.jsonl'));
    expect(s.turnFailures).toHaveLength(1);
    expect(s.turnFailures[0]).toMatch(/401 Unauthorized/);
    expect(s.usage).toBeNull();
    expect(s.errors.length).toBeGreaterThan(1);
  });
  it('shows transport retries as a status, and the final error without its transport tail', () => {
    const p = events('auth-401.jsonl').map(progressFromEvent).filter(Boolean);
    expect(p.filter((x) => x!.kind === 'status' && x!.text === 'Reconnecting').length).toBeGreaterThan(5);
    const errs = p.filter((x) => x!.kind === 'error');
    expect(errs.length).toBeGreaterThan(0);
    for (const e of errs) {
      expect(e).toMatchObject({ message: 'unexpected status 401 Unauthorized: Missing bearer or basic authentication in header' });
    }
  });
});

describe('the neutral step (ai/provider.ts)', () => {
  it('a read-only run: a line per tool call as it starts, the messages with their text, the tokens at turn end', () => {
    const steps = events('read-mcp.jsonl').map(stepFromEvent).filter((s) => s !== null);
    const lines = steps.flatMap((s) => s!.lines);
    expect(lines).toContain('Listing files');
    expect(lines).toContain('Reading README.md');
    // The tool's COMPLETION adds no second line.
    expect(lines.filter((l) => l === 'Reading README.md')).toHaveLength(1);
    const texts = steps.map((s) => s!.text).filter(Boolean);
    expect(texts[texts.length - 1]).toBe(summarizeEvents(events('read-mcp.jsonl')).finalResponse.trim());
    const withUsage = steps.filter((s) => s!.usage);
    expect(withUsage).toHaveLength(1);
    expect(withUsage[0]!.usage).toEqual(summarizeEvents(events('read-mcp.jsonl')).usage);
  });

  it('a write run names the files it edited; the bypass warnings are no step', () => {
    const steps = events('write-bypass.jsonl').map(stepFromEvent).filter((s) => s !== null);
    expect(steps.flatMap((s) => s!.lines).some((l) => l.startsWith('Edited '))).toBe(true);
    for (const e of events('write-bypass.jsonl').filter(isBypassWarning)) expect(stepFromEvent(e)).toBeNull();
  });

  it('Codex tokens in the neutral shape: cached input counted once, as cache reads; reasoning never added', () => {
    expect(codexTokensAsAgentTokens({ inputTokens: 100, cachedInputTokens: 30, outputTokens: 10, reasoningOutputTokens: 7 })).toEqual({
      inputTokens: 70,
      outputTokens: 10,
      cacheReadTokens: 30,
      cacheCreationTokens: 0,
    });
  });
});

describe('usage', () => {
  const t1 = { inputTokens: 8270, cachedInputTokens: 6000, outputTokens: 41, reasoningOutputTokens: 0 };
  // Spike run 6: the resumed turn reported the THREAD total, 16603 / 86.
  const cumulative = { inputTokens: 16603, cachedInputTokens: 14000, outputTokens: 86, reasoningOutputTokens: 0 };
  it('a resumed turn’s own tokens are the delta from the thread total before it', () => {
    expect(usageDelta(cumulative, t1)).toEqual({ inputTokens: 8333, cachedInputTokens: 8000, outputTokens: 45, reasoningOutputTokens: 0 });
    expect(usageDelta(t1, null)).toEqual(t1);
  });
  it('never invents a negative: a figure that went down is kept as is', () => {
    expect(usageDelta(t1, cumulative)).toEqual(t1);
  });
  it('adding a turn whose tokens are unknown makes the run’s tokens unknown', () => {
    expect(addUsage(t1, null)).toBeNull();
    expect(addUsage(t1, usageDelta(cumulative, t1))).toEqual(cumulative);
  });
});

describe('cleanCodexError', () => {
  it('drops the url / cf-ray / request id tail and keeps everything else', () => {
    expect(cleanCodexError('boom, url: https://x, cf-ray: 1')).toBe('boom');
    expect(cleanCodexError('no tail here')).toBe('no tail here');
  });
});

describe('stderr', () => {
  it('the tail drops the stdin notice', () => {
    expect(stderrTail('Reading additional input from stdin...\nError loading config.toml: unknown field\n')).toBe(
      'Error loading config.toml: unknown field',
    );
    expect(stderrTail('Reading additional input from stdin...\n')).toBe('');
  });
});
