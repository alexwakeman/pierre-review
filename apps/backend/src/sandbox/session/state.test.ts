// The session's shown state (pure): the conversation fold from agent events, the bounds, the boot
// steps, a stored value read back, and the wire mapper.
import { describe, expect, it } from 'vitest';
import { SANDBOX_CONVERSATION_MAX, sandboxSessionStatus, type SandboxNetworkEntry } from '@pierre-review/shared';
import {
  STORED_TOOL_OUTPUT_MAX,
  emptySessionState,
  itemForAgentEvent,
  putItem,
  putNetworkEntry,
  readSessionState,
  setBootStep,
  toStoryBuildSession,
} from './state.js';

const AT = '2026-11-07T10:00:00.000Z';
const row = {
  sessionPhase: 'ready',
  runtime: 'docker',
  provider: 'claude',
  model: 'claude-sonnet-5',
  effort: 'medium',
  planCostUsd: 0.1,
  buildCostUsd: 0.25,
  inputTokens: 10,
  outputTokens: 4,
  numTurns: 2,
};

describe('the conversation fold', () => {
  it('stores final texts, tool calls with their results, turn ends and errors; never partials or status', () => {
    const s = emptySessionState('implement');
    const tools = new Map<string, string>();
    expect(itemForAgentEvent(s, { type: 'status', state: 'working', mode: 'chat', detail: null }, AT, tools)).toBeNull();
    expect(itemForAgentEvent(s, { type: 'text', messageId: 'm1', partial: true, text: 'Hel' }, AT, tools)).toBeNull();
    itemForAgentEvent(s, { type: 'text', messageId: 'm1', partial: false, text: 'Hello.' }, AT, tools);
    itemForAgentEvent(s, { type: 'tool_call', id: 'tu_1', tool: 'Bash', summary: 'npm test' }, AT, tools);
    const done = itemForAgentEvent(s, { type: 'tool_result', id: 'tu_1', ok: false, output: 'x'.repeat(5_000) }, AT, tools);
    expect(done).toMatchObject({ kind: 'tool', ok: false });
    expect((done as { output: string }).output.length).toBe(STORED_TOOL_OUTPUT_MAX);
    // A result for a tool never seen is dropped, not invented.
    expect(itemForAgentEvent(s, { type: 'tool_result', id: 'nope', ok: true, output: '' }, AT, tools)).toBeNull();
    itemForAgentEvent(
      s,
      { type: 'turn_end', turn: 1, mode: 'chat', outcome: 'completed', provider: 'claude', model: 'm', usage: { costUsd: 0.02, inputTokens: 1, outputTokens: 1, cacheReadTokens: null, cacheCreationTokens: null }, changedInChat: [] },
      AT,
      tools,
    );
    itemForAgentEvent(s, { type: 'error', code: 'usage_limit', message: 'Limit reached.' }, AT, tools);
    expect(s.conversation.map((c) => c.kind)).toEqual(['agent', 'tool', 'turn', 'error']);
    expect(s.conversation[2]).toMatchObject({ turn: 1, costUsd: 0.02 });
    // The same message id replaces (the final text after partials), never appends.
    itemForAgentEvent(s, { type: 'text', messageId: 'm1', partial: false, text: 'Hello again.' }, AT, tools);
    expect(s.conversation.filter((c) => c.kind === 'agent')).toHaveLength(1);
  });

  it('keeps at most SANDBOX_CONVERSATION_MAX items, dropping the oldest', () => {
    const s = emptySessionState('implement');
    for (let i = 0; i < SANDBOX_CONVERSATION_MAX + 5; i++) putItem(s, { kind: 'notice', id: `n${i}`, text: String(i), at: AT });
    expect(s.conversation).toHaveLength(SANDBOX_CONVERSATION_MAX);
    expect(s.conversation[0]!.id).toBe('n5');
  });

  it('boot steps keep their first order; the network panel keeps one row per key, newest first', () => {
    const s = emptySessionState('implement');
    setBootStep(s, 'runtime', 'running');
    setBootStep(s, 'image', 'running', 'pulling');
    setBootStep(s, 'runtime', 'done', 'colima');
    expect(s.boot.map((b) => [b.key, b.state, b.detail])).toEqual([
      ['runtime', 'done', 'colima'],
      ['image', 'running', 'pulling'],
    ]);
    const e = (key: string, lastAt: string): SandboxNetworkEntry => ({ key, source: 'sandbox', host: key, port: 443, allowed: true, reason: null, via: 'forward', count: 1, up: 0, down: 0, lastStatus: 200, firstAt: lastAt, lastAt });
    putNetworkEntry(s, e('a', '2026-11-07T10:00:00Z'));
    putNetworkEntry(s, e('b', '2026-11-07T10:01:00Z'));
    putNetworkEntry(s, { ...e('a', '2026-11-07T10:02:00Z'), count: 2 });
    expect(s.network.map((n) => [n.key, n.count])).toEqual([
      ['a', 2],
      ['b', 1],
    ]);
  });

  it('reads a stored value back, and an unreadable one as a fresh state', () => {
    const s = emptySessionState('fill_gaps');
    putItem(s, { kind: 'reader', id: 'r1', text: 'hi', at: AT, build: false });
    expect(readSessionState(JSON.parse(JSON.stringify(s)))).toEqual(s);
    expect(readSessionState(null, 'implement')).toEqual(emptySessionState('implement'));
    expect(readSessionState({ version: 9 })).toEqual(emptySessionState('implement'));
  });
});

describe('toStoryBuildSession', () => {
  it('maps a session row; null for a row of the old flow', () => {
    const s = emptySessionState('implement');
    expect(toStoryBuildSession({ ...row, sessionPhase: null }, s, null, false)).toBeNull();
    const live = toStoryBuildSession(row, s, { agentState: 'ready', idleCloseAt: AT }, false)!;
    expect(live).toMatchObject({ phase: 'ready', live: true, resumable: false, agentState: 'ready', idleCloseAt: AT, provider: 'claude' });
    expect(live.spend).toEqual({ costUsd: 0.35, inputTokens: 10, outputTokens: 4, turns: 2 });
    // A closed `built` session with patches is resumable; one with none is not.
    expect(toStoryBuildSession({ ...row, sessionPhase: 'built' }, s, null, true)!.resumable).toBe(true);
    expect(toStoryBuildSession({ ...row, sessionPhase: 'built' }, s, null, false)!.resumable).toBe(false);
    expect(toStoryBuildSession({ ...row, sessionPhase: 'failed' }, s, null, true)!.resumable).toBe(false);
  });

  it('carries the ticket as the agent was told it (the Ticket panel); an older stored state has no open points', () => {
    const s = emptySessionState('implement');
    s.criteria = ['AC1: A button.'];
    s.openPoints = ['Which reports?'];
    expect(toStoryBuildSession(row, s, null, false)!.ticket).toEqual({ criteria: ['AC1: A button.'], openPoints: ['Which reports?'] });
    const older = readSessionState({ ...emptySessionState('implement'), openPoints: undefined, criteria: ['AC1: x'] });
    expect(toStoryBuildSession(row, older, null, false)!.ticket).toEqual({ criteria: ['AC1: x'], openPoints: [] });
  });

  it('stores each phase as the old status word, so the one-open index and the sprint mark hold', () => {
    expect(['booting', 'ready', 'chatting', 'building', 'built', 'pushed', 'discarded', 'failed'].map((p) => sandboxSessionStatus(p as never))).toEqual([
      'assessing',
      'plan_ready',
      'planning',
      'building',
      'ready',
      'ready',
      'discarded',
      'failed',
    ]);
  });
});
