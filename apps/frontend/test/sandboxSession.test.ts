// THE BUILD TAB'S SESSION HALF (lib/sandboxSession.ts; docs/SANDBOX.md § Sessions) and Settings →
// Sandbox's form (components/settings/sandboxSettingsForm.ts).
//
// Pins: the stream fold (snapshot first; boot/item/network upserts by key; partial text appended and
// dropped when the whole message arrives or the turn ends; `done` closes), which frames re-read the query,
// the merge (the stream owns what it streams while the read says live; a closed read wins), the phase
// words and step line, which buttons a phase offers, the Network rows (blocked first) and the Allow
// rule; the settings draft → the WHOLE PUT body, the dirty test, and the memory ticks.
//
//   ./apps/backend/node_modules/.bin/vitest run --root apps/frontend test/sandboxSession.test.ts
import { describe, expect, it } from 'vitest';
import type { SandboxMemoryProject, SandboxNetworkEntry, SandboxWorkspaceSettings, StoryBuildSession } from '@pierre-review/shared';
import {
  applySessionEvent,
  bootProgress,
  EMPTY_SESSION_STREAM,
  mergeSessionViews,
  networkAllowRule,
  networkRows,
  sessionCanDiscard,
  sessionCanSend,
  sessionCanStartBuild,
  sessionClosedForGood,
  sessionEventNeedsRefetch,
  sessionStatusLine,
  sessionSteps,
  sessionTurnRunning,
  shortBytes,
  visiblePartialText,
} from '../src/lib/sandboxSession.js';
import { sandboxBodyOf, sandboxDraftDirty, sandboxDraftOf, sandboxMemoryTicks } from '../src/components/settings/sandboxSettingsForm.js';

const at = '2026-11-07T10:00:00.000Z';

function session(o: Partial<StoryBuildSession> = {}): StoryBuildSession {
  return {
    phase: 'ready',
    runtime: 'docker',
    runtimeNote: null,
    provider: 'claude',
    model: 'claude-sonnet-5',
    effort: null,
    agentState: 'ready',
    mode: 'chat',
    live: true,
    resumable: false,
    boot: [],
    notes: [],
    conversation: [],
    repos: [],
    startDir: null,
    credentialLine: null,
    services: null,
    network: [],
    spend: { costUsd: 0.1, inputTokens: 10, outputTokens: 5, turns: 1 },
    idleCloseAt: null,
    ticket: { criteria: ['AC1: A button.'], openPoints: [] },
    plan: null,
    ...o,
  };
}

const net = (o: Partial<SandboxNetworkEntry>): SandboxNetworkEntry => ({
  key: o.host ?? 'k',
  source: null,
  host: 'api.anthropic.com',
  port: 443,
  allowed: true,
  reason: null,
  via: 'forward',
  count: 1,
  up: 0,
  down: 0,
  lastStatus: 200,
  firstAt: at,
  lastAt: at,
  ...o,
});

describe('the stream fold', () => {
  it('ignores changes before the snapshot, but keeps partial text', () => {
    let s = applySessionEvent(EMPTY_SESSION_STREAM, { type: 'phase', phase: 'chatting', error: null });
    expect(s.session).toBeNull();
    s = applySessionEvent(s, { type: 'agent', event: { type: 'text', messageId: 'a', partial: true, text: 'Hel' } });
    expect(s.partials.get('a')).toBe('Hel');
  });

  it('upserts boot steps, items and network rows by key, and appends deltas', () => {
    let s = applySessionEvent(EMPTY_SESSION_STREAM, { type: 'snapshot', session: session({ phase: 'booting' }) });
    s = applySessionEvent(s, { type: 'boot', step: { key: 'runtime', label: 'Finding', state: 'running', detail: null } });
    s = applySessionEvent(s, { type: 'boot', step: { key: 'runtime', label: 'Finding', state: 'done', detail: 'colima' } });
    s = applySessionEvent(s, { type: 'boot', step: { key: 'image', label: 'Image', state: 'running', detail: null } });
    expect(s.session?.boot.map((b) => `${b.key}:${b.state}`)).toEqual(['runtime:done', 'image:running']);

    s = applySessionEvent(s, { type: 'phase', phase: 'chatting', error: null });
    s = applySessionEvent(s, { type: 'agent', event: { type: 'text', messageId: 'm1', partial: true, text: 'Two ' } });
    s = applySessionEvent(s, { type: 'agent', event: { type: 'text', messageId: 'm1', partial: true, text: 'files.' } });
    expect(s.partials.get('m1')).toBe('Two files.');
    s = applySessionEvent(s, { type: 'item', item: { kind: 'tool', id: 't1', tool: 'Bash', summary: 'ls', ok: null, output: null, at } });
    s = applySessionEvent(s, { type: 'item', item: { kind: 'tool', id: 't1', tool: 'Bash', summary: 'ls', ok: true, output: 'a\nb', at } });
    s = applySessionEvent(s, { type: 'item', item: { kind: 'agent', id: 'm-m1', text: 'Two files.', at } });
    expect(s.session?.conversation.map((c) => c.id)).toEqual(['t1', 'm-m1']);
    expect(s.session?.conversation[0]).toMatchObject({ ok: true, output: 'a\nb' });
    expect(s.partials.has('m1')).toBe(false);

    s = applySessionEvent(s, { type: 'network', entry: net({ key: 'x', count: 1 }) });
    s = applySessionEvent(s, { type: 'network', entry: net({ key: 'x', count: 4 }) });
    expect(s.session?.network).toHaveLength(1);
    expect(s.session?.network[0]?.count).toBe(4);
  });

  it('drops the words in flight when a turn ends, and closes on done', () => {
    let s = applySessionEvent(EMPTY_SESSION_STREAM, { type: 'snapshot', session: session({ phase: 'chatting', agentState: 'working' }) });
    s = applySessionEvent(s, { type: 'agent', event: { type: 'text', messageId: 'z', partial: true, text: 'half' } });
    s = applySessionEvent(s, { type: 'item', item: { kind: 'turn', id: 'e1', turn: 1, mode: 'chat', outcome: 'interrupted', costUsd: 0.01, at } });
    expect(s.partials.size).toBe(0);
    s = applySessionEvent(s, { type: 'agent', event: { type: 'status', state: 'ready', mode: 'build', detail: null } });
    expect(s.session).toMatchObject({ agentState: 'ready', mode: 'build' });
    s = applySessionEvent(s, { type: 'done' });
    expect(s.done).toBe(true);
    expect(s.session).toMatchObject({ live: false, agentState: null });
  });

  it('keeps a failed phase error line', () => {
    let s = applySessionEvent(EMPTY_SESSION_STREAM, { type: 'snapshot', session: session({ phase: 'booting' }) });
    s = applySessionEvent(s, { type: 'phase', phase: 'failed', error: 'Docker is not running.' });
    expect(s.error).toBe('Docker is not running.');
    expect(sessionStatusLine(s.session!, s.error)).toBe('Docker is not running.');
  });

  it('re-reads the query on a phase, a turn end and done only', () => {
    expect(sessionEventNeedsRefetch({ type: 'phase', phase: 'built', error: null })).toBe(true);
    expect(sessionEventNeedsRefetch({ type: 'done' })).toBe(true);
    expect(sessionEventNeedsRefetch({ type: 'item', item: { kind: 'turn', id: 'e', turn: 1, mode: 'build', outcome: 'completed', costUsd: null, at } })).toBe(true);
    expect(sessionEventNeedsRefetch({ type: 'item', item: { kind: 'notice', id: 'n', text: 'x', at } })).toBe(false);
    // Plan first: the planned PRs live on the build, so their frame brings the read again.
    expect(sessionEventNeedsRefetch({ type: 'prs', prs: [] })).toBe(true);
    expect(sessionEventNeedsRefetch({ type: 'agent', event: { type: 'text', messageId: 'a', partial: true, text: 'x' } })).toBe(false);
  });
});

describe('the merge', () => {
  it('the stream owns what it streams while the read is live; the read owns spend and the ticket', () => {
    const read = session({ phase: 'ready', spend: { costUsd: 0.5, inputTokens: 1, outputTokens: 1, turns: 2 } });
    const stream = session({ phase: 'chatting', agentState: 'working', spend: { costUsd: 0, inputTokens: 0, outputTokens: 0, turns: 0 }, network: [net({})] });
    const m = mergeSessionViews(read, stream)!;
    expect(m.phase).toBe('chatting');
    expect(m.agentState).toBe('working');
    expect(m.network).toHaveLength(1);
    expect(m.spend.costUsd).toBe(0.5);
  });

  it('a closed read is the last word', () => {
    const m = mergeSessionViews(session({ phase: 'built', live: false, resumable: true }), session({ phase: 'building' }))!;
    expect(m).toMatchObject({ phase: 'built', live: false, resumable: true });
  });

  it('with no stream, the read', () => {
    const read = session();
    expect(mergeSessionViews(read, null)).toBe(read);
    expect(mergeSessionViews(null, null)).toBeNull();
  });
});

describe('the words and the buttons', () => {
  it('steps follow the phase', () => {
    const cur = (p: StoryBuildSession['phase']) => sessionSteps({ phase: p }).find((s) => s.state === 'current')?.word ?? null;
    expect(sessionSteps(null).every((s) => s.state === 'next')).toBe(true);
    expect(cur('booting')).toBe('Set up');
    expect(cur('chatting')).toBe('Talk');
    expect(cur('building')).toBe('Build');
    expect(cur('built')).toBe('Push');
    expect(sessionSteps({ phase: 'pushed' }).every((s) => s.state === 'done')).toBe(true);
  });

  it('a closed built session says the changes are kept', () => {
    expect(sessionStatusLine({ phase: 'built', live: false, resumable: true })).toContain('The changes are kept');
    expect(sessionStatusLine({ phase: 'built', live: true, resumable: false })).toContain('Review the changes');
  });

  it('offers Send, Start build and Stop by phase', () => {
    expect(sessionCanSend(session({ phase: 'ready' }))).toBe(true);
    expect(sessionCanSend(session({ phase: 'chatting' }))).toBe(false);
    expect(sessionCanSend(session({ phase: 'ready', live: false }))).toBe(false);
    expect(sessionCanSend(session({ phase: 'ready', agentState: 'stopped' }))).toBe(false);
    expect(sessionCanStartBuild(session({ phase: 'ready', mode: 'chat' }))).toBe(true);
    expect(sessionCanStartBuild(session({ phase: 'built', mode: 'build' }))).toBe(false);
    // Plan first: the build starts only from the plan panel's Approve, never from Start build.
    const planView = { latest: null, revisions: 0, decisions: {}, replies: [], unanswered: 0, approvedRevision: null, approvedAt: null, status: 'failed' as const, problem: 'x', withDocs: false, fillGaps: false };
    expect(sessionCanStartBuild(session({ phase: 'ready', mode: 'chat', plan: planView }))).toBe(false);
    expect(sessionTurnRunning(session({ phase: 'building' }))).toBe(true);
    expect(sessionTurnRunning(session({ phase: 'building', live: false }))).toBe(false);
    expect(sessionCanDiscard({ phase: 'built' })).toBe(true);
    expect(sessionCanDiscard({ phase: 'discarded' })).toBe(false);
  });

  it('a row of the old flow, or a failed session, shows the start state', () => {
    expect(sessionClosedForGood({ status: 'plan_ready', session: null })).toBe(false);
    expect(sessionClosedForGood({ status: 'failed', session: null })).toBe(true);
    expect(sessionClosedForGood({ status: 'ready', session: { phase: 'built' } })).toBe(false);
    expect(sessionClosedForGood({ status: 'failed', session: { phase: 'failed' } })).toBe(true);
  });

  it('boot progress counts skipped as done', () => {
    const p = bootProgress([
      { key: 'runtime', label: 'a', state: 'done', detail: null },
      { key: 'services', label: 'b', state: 'skipped', detail: null },
      { key: 'agent', label: 'c', state: 'running', detail: null },
    ]);
    expect(p).toMatchObject({ done: 2, total: 3, failed: null });
    expect(p.current?.key).toBe('agent');
  });

  it('puts blocked hosts first and names the port only when unusual', () => {
    const rows = networkRows([net({ key: 'a', host: 'a.com', count: 9 }), net({ key: 'b', host: 'b.com', allowed: false }), net({ key: 'c', host: 'c.com', count: 20 })]);
    expect(rows.map((r) => r.host)).toEqual(['b.com', 'c.com', 'a.com']);
    expect(networkAllowRule({ host: 'x.io', port: 443 })).toBe('x.io');
    expect(networkAllowRule({ host: 'x.io', port: 5432 })).toBe('x.io:5432');
    expect(shortBytes(812)).toBe('812 B');
    expect(shortBytes(4100)).toBe('4.1 kB');
    expect(shortBytes(12_000_000)).toBe('12 MB');
  });
});

describe('Settings → Sandbox form', () => {
  const saved: SandboxWorkspaceSettings = {
    workspaceId: 3,
    localFolder: '/Users/a/Projects/bng',
    memoryProjects: null,
    userClaudeMd: true,
    userSkills: false,
    startDir: null,
    globalProxyEnv: false,
    resources: { cpus: null, memoryGb: 12, diskGb: null },
    services: [{ repo: 'DEFRA/bng-metric-backend', file: 'compose.yml', egress: [] }],
    alwaysAllowedHosts: ['registry.example.com'],
  };

  it('sends the WHOLE setting (the PUT replaces it)', () => {
    const d = { ...sandboxDraftOf(saved), cpus: '6', startDir: '/Users/a/Projects/bng/harness/' };
    expect(sandboxBodyOf(d)).toEqual({
      localFolder: '/Users/a/Projects/bng',
      memoryProjects: null,
      userClaudeMd: true,
      userSkills: false,
      startDir: '/Users/a/Projects/bng/harness',
      globalProxyEnv: false,
      resources: { cpus: 6, memoryGb: 12, diskGb: null },
      services: [{ repo: 'DEFRA/bng-metric-backend', file: 'compose.yml', egress: [] }],
    });
    expect(sandboxBodyOf({ ...d, localFolder: '  ' }).localFolder).toBeNull();
  });

  it('is dirty only when the body changes', () => {
    expect(sandboxDraftDirty(sandboxDraftOf(saved), saved)).toBe(false);
    expect(sandboxDraftDirty({ ...sandboxDraftOf(saved), memoryGb: '12' }, saved)).toBe(false);
    expect(sandboxDraftDirty({ ...sandboxDraftOf(saved), userSkills: true }, saved)).toBe(true);
  });

  it('turns the default ticks into an explicit list on the first change', () => {
    const found: SandboxMemoryProject[] = [
      { dir: '/p/a', key: '-p-a', memoryCount: 3, ticked: true },
      { dir: '/p/b', key: '-p-b', memoryCount: 1, ticked: true },
      { dir: '/p/c', key: '-p-c', memoryCount: 0, ticked: false },
    ];
    const ticks = sandboxMemoryTicks(found, null);
    expect(ticks.map((t) => t.ticked)).toEqual([true, true, false]);
    expect(ticks[1]!.toggle(false)).toEqual(['/p/a']);
    expect(ticks[2]!.toggle(true)).toEqual(['/p/a', '/p/b', '/p/c']);
    expect(sandboxMemoryTicks(found, ['/p/c']).map((t) => t.ticked)).toEqual([false, false, true]);
  });
});

describe('the plan block while it streams', () => {
  it('hides an opened ```limn-plan block behind one line, and leaves other text alone', () => {
    expect(visiblePartialText('I read the code.\n\n```limn-plan\n{"schema":"limn.plan/1",')).toBe('I read the code.\n\nWriting the plan…');
    expect(visiblePartialText('```limn-plan\n{')).toBe('Writing the plan…');
    expect(visiblePartialText('Some `code` and ```ts\nx\n```')).toBe('Some `code` and ```ts\nx\n```');
  });
});
