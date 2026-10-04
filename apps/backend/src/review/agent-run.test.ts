// THE REVIEW RUN's confinement and peer checkouts (review/agent.ts `runReview`), with the Agent SDK,
// the clone cache and auth faked. What this pins:
//   1. ⚠ EVERY run carries the PATH GUARD as a PreToolUse hook — a deep run AND a diff-only one: a
//      Read outside cwd and the peers' checkouts is denied, one inside is allowed;
//   2. a DEEP run checks out its ticket peers (capped), hands the checkouts to the SDK as
//      `additionalDirectories`, appends where each sits (or that it could not be checked out) to the
//      prompt, and removes them afterwards;
//   3. a diff-only run checks out no peer, whatever it is handed.
//
//   pnpm --filter @pierre-review/backend test agent-run
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { TICKET_REVIEW_PEER_MAX_FOR_PR_REVIEW } from '@pierre-review/shared';
import type { RunReviewArgs } from '../pro/contract.js';

/* eslint-disable @typescript-eslint/no-explicit-any */

const root = mkdtempSync(join(tmpdir(), 'agent-run-'));
const dir = (name: string): string => mkdtempSync(join(root, `${name}-`));

let captured: { prompt: string; options: any } | null = null;
const peerCalls: any[] = [];
let peerCleanups = 0;
let failPeer: string | null = null;

vi.mock('../ai/runtime.js', () => ({
  claudeExecutableOptions: () => ({}),
  loadAgentSdk: async () => ({
    tool: (name: string, _d: string, _s: unknown, handler: (a: unknown) => Promise<unknown>) => ({ name, handler }),
    createSdkMcpServer: (o: { tools: Array<{ handler: (a: unknown) => Promise<unknown> }> }) => o,
    query: ({ prompt, options }: { prompt: string; options: any }) => {
      captured = { prompt, options };
      return (async function* () {
        await options.mcpServers.review.tools[0].handler({
          summary: 'ok',
          verdict: 'COMMENT',
          scopeUsed: 'diff_only',
          findings: [],
        });
        yield { type: 'result', subtype: 'success', total_cost_usd: 0, num_turns: 1 };
      })();
    },
  }),
}));
vi.mock('./schema.js', () => ({ submitReviewShape: async () => ({}) }));
vi.mock('./auth.js', () => ({ applyClaudeReviewAuth: () => () => {} }));
vi.mock('./clone-manager.js', () => ({
  prepWorktree: async () => ({ repoCloneDir: dir('clone'), worktreePath: dir('pr') }),
  removeWorktreeLocked: async () => {},
  cleanupCloneCache: () => {},
  prepPeerWorktrees: async (peers: Array<{ owner: string; name: string; number: number; headSha: string }>) => {
    peerCalls.push(peers);
    return {
      peers: peers.map((p) =>
        p.name === failPeer
          ? { ...p, path: null, repoCloneDir: null, error: 'checkout failed' }
          : { ...p, path: dir(`peer-${p.name}`), repoCloneDir: dir('peer-clone'), error: null },
      ),
      cleanup: async () => {
        peerCleanups += 1;
      },
    };
  },
}));

const { runReview } = await import('./agent.js');

const args = (over: Partial<RunReviewArgs> = {}): RunReviewArgs => ({
  owner: 'acme',
  name: 'api',
  prNumber: 7,
  headSha: 'a'.repeat(40),
  model: 'claude-opus-5-5',
  mode: 'worktree',
  systemPrompt: 'sys',
  prompt: 'PROMPT',
  strippedDiff: '',
  applyAuthEnv: false,
  abortController: new AbortController(),
  onProgress: () => {},
  ...over,
});

const peer = (i: number) => ({ ref: `X${i}`, owner: 'acme', name: `web${i}`, prNumber: 10 + i, headSha: 'b'.repeat(40) });

// Run every PreToolUse hook the way the SDK does: a call goes ahead only when none denies it.
async function decide(toolName: string, toolInput: unknown): Promise<'allow' | 'deny'> {
  for (const entry of captured!.options.hooks.PreToolUse as Array<{ hooks: Array<(i: unknown) => Promise<any>> }>) {
    for (const h of entry.hooks) {
      const out = await h({ hook_event_name: 'PreToolUse', tool_name: toolName, tool_input: toolInput });
      if (out?.hookSpecificOutput?.permissionDecision === 'deny') return 'deny';
    }
  }
  return 'allow';
}

beforeEach(() => {
  captured = null;
  peerCalls.length = 0;
  peerCleanups = 0;
  failPeer = null;
});

afterAll(() => rmSync(root, { recursive: true, force: true }));

describe('runReview — the path guard', () => {
  it('⚠ a deep run: cwd is readable, anything outside is not', async () => {
    const r = await runReview(args());
    expect(r.submitted).toBe(true);
    const cwd = captured!.options.cwd as string;
    expect(await decide('Read', { file_path: join(cwd, 'src/a.ts') })).toBe('allow');
    expect(await decide('Read', { file_path: '/etc/passwd' })).toBe('deny');
    expect(await decide('Grep', { pattern: 'x', path: '/' })).toBe('deny');
    expect(captured!.options).not.toHaveProperty('additionalDirectories');
  });

  it('⚠ a diff-only run is guarded too, and checks out no peer whatever it is handed', async () => {
    await runReview(args({ mode: 'diff_only', peers: [peer(1)] }));
    expect(peerCalls).toEqual([]);
    expect(await decide('Read', { file_path: '/etc/passwd' })).toBe('deny');
    expect(captured!.prompt).toBe('PROMPT');
  });
});

describe('runReview — ticket peers on a deep run', () => {
  it('checks out at most the cap, reads them through additionalDirectories, and says where they are', async () => {
    failPeer = 'web2';
    const peers = Array.from({ length: TICKET_REVIEW_PEER_MAX_FOR_PR_REVIEW + 1 }, (_, i) => peer(i + 1));
    await runReview(args({ peers }));
    expect(peerCalls).toHaveLength(1);
    expect(peerCalls[0]).toHaveLength(TICKET_REVIEW_PEER_MAX_FOR_PR_REVIEW);
    expect(peerCalls[0][0]).toEqual({ owner: 'acme', name: 'web1', number: 11, headSha: 'b'.repeat(40) });

    const extra = captured!.options.additionalDirectories as string[];
    expect(extra).toHaveLength(TICKET_REVIEW_PEER_MAX_FOR_PR_REVIEW - 1); // web2 failed
    expect(captured!.prompt.startsWith('PROMPT\n')).toBe(true);
    expect(captured!.prompt).toContain('## Related checkouts');
    expect(captured!.prompt).toContain(`- X1: ${extra[0]}`);
    expect(captured!.prompt).toContain('- X2: could not be checked out. Do not guess at its code.');
    expect(captured!.prompt).not.toContain('X5');

    // A peer's checkout is readable; a sibling directory is not.
    expect(await decide('Read', { file_path: join(extra[0]!, 'src/b.ts') })).toBe('allow');
    expect(await decide('Glob', { pattern: `${root}/**` })).toBe('deny');
    expect(peerCleanups).toBe(1);
  });
});
