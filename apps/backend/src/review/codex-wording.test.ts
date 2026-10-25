// CODEX WORDING FOR THE REVIEW STREAM (review/codex-wording.ts). What this pins:
//   1. ⚠ DRIFT: every prompt variant the review stream builds — diff-only and worktree, with and
//      without the reference library, specialists offered, the user message with peers, a truncated
//      diff and review threads, every specialist's instructions, the chat (worktree, diff-only, explain)
//      and Check threads (system + message) — comes out of the Codex functions with NO Claude-only word
//      left (`submit_review`, "Read, Glob", "the Agent tool", "Leave … out", "(Claude)"…). A Claude
//      sentence edited without its Codex twin fails here instead of reaching a Codex run.
//   2. every swap is LIVE: its Claude sentence is found in at least one real prompt (a dead swap is a
//      sentence that moved);
//   3. the Codex text names Codex's tools (the prompt seam's table) and the final JSON answer;
//   4. the specialists section is replaced whole: the lead is told the reports are in its message, the
//      "Design comments" part is kept, and the dispatch instructions are gone.
//
//   pnpm --filter @pierre-review/backend test review/codex-wording
import { describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  // chat.ts / thread-check.ts reach the DB client at import time: never the real database.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const os = require('node:os') as typeof import('node:os');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const path = require('node:path') as typeof import('node:path');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const fs = require('node:fs') as typeof import('node:fs');
  process.env.DATABASE_URL = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'codex-wording-')), 'db.sqlite');
});

import { CLAUDE_FINDING_LENSES, type ClaudeFindingLens } from '@pierre-review/shared';
import type { ReviewThreadForReview } from '../db/review-threads-for-review.js';
import { buildUserPrompt, relatedCheckoutsSection, systemPromptForMode } from './claude-review/prompts.js';
import { specialistPrompt, specialistsPromptSection } from './claude-review/specialists.js';
import { planThreadReview } from './claude-review/threads.js';
import {
  ALL_CODEX_SWAPS,
  CLAUDE_ONLY_WORDS,
  codexChatText,
  codexReviewSystemPrompt,
  codexReviewUserPrompt,
  codexSpecialistInstructions,
  codexThreadCheckText,
} from './codex-wording.js';

const { chatSystemPrompt } = await import('./claude-review/chat.js');
const { EXPLAIN_INSTRUCTION, EXPLAIN_SYSTEM_ADDENDUM } = await import('./claude-review/chat-explain.js');
const { THREAD_CHECK_SYSTEM_PROMPT, buildThreadCheckPrompt } = await import('./claude-review/thread-check.js');

const HEAD = 'b'.repeat(40);
const NONCE = '0123456789abcdef';
const thread = (id: number): ReviewThreadForReview => ({
  threadId: id,
  path: `src/f${id}.ts`,
  line: id,
  isOutdated: false,
  derivedState: 'untouched',
  isResolved: false,
  url: null,
  comments: [{ authorLogin: 'alice', authorIsBot: false, createdAt: new Date(Date.UTC(2026, 8, 1)), body: `Comment ${id}` }],
  commitsAfterFirstComment: 0,
  commitsAfterLastComment: 0,
});
const threads = planThreadReview([thread(1), thread(2)], HEAD, null);

const user = (mode: 'diff_only' | 'worktree'): string =>
  buildUserPrompt({
    repoFullName: 'acme/api',
    prNumber: 7,
    title: 'Add a thing',
    body: 'Body',
    headSha: HEAD,
    baseRef: 'main',
    changedFiles: ['src/a.ts', 'web/b.tsx'],
    excludedFiles: ['pnpm-lock.yaml'],
    diff: '+x',
    mode,
    omittedFiles: ['src/c.ts'],
    threads,
    peers: mode === 'worktree' ? [{ ref: 'X1', repoFullName: 'acme/web', number: 9, title: 'Peer', state: 'open', ticketKeys: ['T-1'], files: ['a.ts'] }] : [],
    nonce: NONCE,
  }) + (mode === 'worktree' ? `\n${relatedCheckoutsSection([{ ref: 'X1', path: '/tmp/x1' }])}` : '');

const lenses: ClaudeFindingLens[] = [...CLAUDE_FINDING_LENSES];

/** Every Claude prompt of this stream, and its Codex rendering. */
function variants(): Array<{ name: string; claude: string; codex: string }> {
  const out: Array<{ name: string; claude: string; codex: string }> = [];
  for (const mode of ['diff_only', 'worktree'] as const) {
    for (const docs of [null, '/lib/docs']) {
      const offered = mode === 'worktree' ? lenses : [];
      const sys = systemPromptForMode(mode, offered, docs);
      out.push({ name: `system ${mode} docs=${docs != null}`, claude: sys, codex: codexReviewSystemPrompt(sys, offered) });
    }
    const sysNoSpecialists = systemPromptForMode(mode, [], null);
    out.push({ name: `system ${mode} bare`, claude: sysNoSpecialists, codex: codexReviewSystemPrompt(sysNoSpecialists, []) });
    const u = user(mode);
    out.push({ name: `user ${mode}`, claude: u, codex: codexReviewUserPrompt(u) });
  }
  for (const lens of lenses) {
    const p = specialistPrompt(lens);
    out.push({ name: `specialist ${lens}`, claude: p, codex: codexSpecialistInstructions(p) });
  }
  for (const mode of ['worktree', 'diff_only'] as const) {
    const sys = chatSystemPrompt(mode) + EXPLAIN_SYSTEM_ADDENDUM;
    out.push({ name: `chat ${mode}`, claude: sys, codex: codexChatText(sys) });
  }
  const ex = EXPLAIN_INSTRUCTION(['P1', 'P2']);
  out.push({ name: 'chat explain message', claude: ex, codex: codexChatText(ex) });
  out.push({ name: 'thread check system', claude: THREAD_CHECK_SYSTEM_PROMPT, codex: codexThreadCheckText(THREAD_CHECK_SYSTEM_PROMPT) });
  for (const worktreePath of ['/tmp/wt', null]) {
    const m = buildThreadCheckPrompt({ repoFullName: 'acme/api', number: 7, title: 'T', headSha: HEAD, worktreePath, diff: '+x', plan: threads, nonce: NONCE });
    out.push({ name: `thread check message wt=${worktreePath != null}`, claude: m, codex: codexThreadCheckText(m) });
  }
  return out;
}

describe('Codex wording: nothing Claude-only survives', () => {
  it('every variant renders free of Claude-only words', () => {
    const v = variants();
    expect(v.length).toBeGreaterThan(15);
    for (const { name, codex } of v) {
      for (const word of CLAUDE_ONLY_WORDS) expect(codex, `${name}: ${word}`).not.toMatch(word);
    }
  });

  it('the Claude prompts DO carry those words (the test is not vacuous)', () => {
    const hits = variants().filter(({ claude }) => CLAUDE_ONLY_WORDS.some((w) => w.test(claude)));
    expect(hits.length).toBeGreaterThan(10);
  });

  it('every swap is live: its Claude sentence is in a real prompt', () => {
    const all = variants().map((v) => v.claude).join('\n');
    for (const [claude] of ALL_CODEX_SWAPS) expect(all, claude).toContain(claude);
  });

  it('names Codex’s own tools and the final JSON answer', () => {
    const sys = codexReviewSystemPrompt(systemPromptForMode('worktree', [], null));
    expect(sys).toContain('You may use read_file, list_files and search.');
    expect(sys).toContain('When you are done, give your final answer: ONE JSON object matching the given schema');
    expect(sys).toContain('Set each to null otherwise.');
    const diff = codexReviewSystemPrompt(systemPromptForMode('diff_only', [], '/lib'));
    expect(diff).toContain('read_file, list_files and search reach ONLY the team');
    expect(codexReviewUserPrompt(user('diff_only'))).toContain('Review the diff and give your final answer (ONE JSON object) with your { summary, verdict, scopeUsed, findings, threads }.');
    expect(codexThreadCheckText(THREAD_CHECK_SYSTEM_PROMPT)).toContain('Give your final answer as ONE JSON object { threads }.');
  });
});

describe('the specialists section on Codex', () => {
  it('is replaced whole: reports in the message, design comments kept, no dispatch', () => {
    const claude = specialistsPromptSection(['security', 'tests']);
    const sys = systemPromptForMode('worktree', ['security', 'tests'], null);
    const codex = codexReviewSystemPrompt(sys, ['security', 'tests']);
    expect(codex).not.toContain(claude);
    expect(codex).toContain('their reports are in the user message under "Specialist reports"');
    expect(codex).toContain('# Design comments');
    expect(codex).not.toMatch(/Agent tool|subagent_type|At most \d+ per review/);
  });

  it('a prompt without the section it is told about is refused, never half-rendered', () => {
    expect(() => codexReviewSystemPrompt(systemPromptForMode('worktree', [], null), ['security'])).toThrow(/specialists section/);
  });
});

describe('Claude is untouched', () => {
  it('the builders still produce the Claude sentences (Codex text only on a Codex run)', () => {
    expect(systemPromptForMode('diff_only', [], null)).toContain('The ONLY tool available to you is submit_review.');
    expect(THREAD_CHECK_SYSTEM_PROMPT).toContain('Call submit_threads EXACTLY ONCE with { threads }.');
  });
});
