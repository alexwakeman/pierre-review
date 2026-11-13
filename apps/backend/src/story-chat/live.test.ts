// STORY CHAT — the live manager over the REAL core client (a scratch SQLite, migrations applied), with
// the agent, git and the reader's files faked. Pinned: a prepared agent answers and the turn is stored;
// ONE warm session serves every question of a chat; a busy chat refuses a second question; Codex answers
// with the earlier turns, nothing writable; Stop; the 10-minute reaper removes the worktrees and the
// temp folder; the boot sweep settles cut-off turns and deletes leftover folders.
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

const RUN_DIR = process.env.LIMN_TEST_RUN_DIR ?? '/tmp';
const DB_PATH = `${RUN_DIR}/pierre-story-chat.live.sqlite`;
const TMP_BASE = `${RUN_DIR}/sc`;
process.env.DATABASE_URL = DB_PATH;
process.env.DISABLE_SCHEDULER = 'true';

/* eslint-disable @typescript-eslint/no-explicit-any */
let db: any;
let schema: any;
let closeDb: (() => Promise<void> | void) | undefined;
let L: typeof import('./live.js');
let S: typeof import('./store.js');
let ws = 0;
const IDENT = 'jira:https://acme.atlassian.net#ACME-9';
const ctx: any = { log: { warn: () => {}, info: () => {}, error: () => {} } };

const ticket = {
  ident: IDENT,
  key: 'ACME-9',
  title: 'Refunds',
  url: null,
  description: 'Refunds wait in a queue.',
  acceptanceCriteriaText: '',
  criteria: [{ n: 1, text: 'Refunds wait' }],
  criteriaSource: 'ticket',
  openPoints: [],
  comments: null,
  prs: [{ fullName: 'acme/api', number: 12, title: 'Queue refunds', state: 'open', byReader: true }],
  gaps: null,
  fresh: false,
  readAt: null,
} as any;

let now = 1_000_000;
let cleanups = 0;
const sessions: any[] = [];
const runs: any[] = [];
const repoCheckoutCalls: string[][] = [];

function fakeSession(spec: any) {
  const s: any = {
    spec,
    asked: [] as string[],
    closed: false,
    interrupted: 0,
    hold: null as null | (() => void),
    async ask(text: string, onProgress: (p: any) => void) {
      s.asked.push(text);
      onProgress({ kind: 'step', lines: ['Ran: pnpm test'], text: 'Working', usage: null });
      if (text.includes('slow')) await new Promise<void>((r) => (s.hold = r));
      if (s.interrupted > 0) return { subtype: 'error_during_execution', text: null, costUsd: 0.01, numTurns: 1, usage: null };
      return { subtype: 'success', text: `Answer to: ${text}`, costUsd: 0.25, numTurns: 2, usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheCreationTokens: 0 } };
    },
    async interrupt() {
      s.interrupted += 1;
      s.hold?.();
    },
    close() {
      s.closed = true;
    },
  };
  sessions.push(s);
  return s;
}

const claude: any = {
  id: 'claude',
  resolveModel: () => 'claude-sonnet-5-5',
  openSession: async (spec: any) => fakeSession(spec),
  runAgent: async () => {
    throw new Error('Claude answers through its session');
  },
};
const codex: any = {
  id: 'codex',
  resolveModel: () => 'gpt-5',
  runAgent: async (spec: any) => {
    runs.push(spec);
    const outcome = { subtype: 'success', text: 'Read-only answer', costUsd: 0, numTurns: 1, usage: null };
    spec.onProgress?.({ kind: 'outcome', outcome });
    return { outcome };
  },
};
let provider: any = claude;

const tmpFolders = (): string[] => {
  try {
    return require('node:fs').readdirSync(TMP_BASE);
  } catch {
    return [];
  }
};

async function settle(chatId: number): Promise<any[]> {
  for (let i = 0; i < 50; i++) {
    const turns = await S.listTurns(1, chatId);
    if (turns.every((t: any) => t.status !== 'running')) return turns;
    await new Promise((r) => setTimeout(r, 10));
  }
  return S.listTurns(1, chatId);
}

beforeAll(async () => {
  for (const s of ['', '-shm', '-wal']) rmSync(DB_PATH + s, { force: true });
  rmSync(TMP_BASE, { recursive: true, force: true });
  mkdirSync(TMP_BASE, { recursive: true });
  const { runMigrations } = await import('../db/run-migrations.js');
  const client = await import('../db/client.js');
  db = client.db;
  schema = client.schema;
  closeDb = client.closeDb;
  await runMigrations();
  const { ensureDefaultWorkspace } = await import('../db/queries.js');
  await db.insert(schema.accounts).values({ id: 1, githubUserId: 'N1', githubLogin: 'u1', isLocal: true }).onConflictDoNothing().execute();
  ws = await ensureDefaultWorkspace(1);
  // The shared trees live in a scratch folder: the boot sweep must never touch a real data folder.
  (await import('./trees.js')).setTreeDepsForTest({ root: () => `${RUN_DIR}/sc-trees` });
  L = await import('./live.js');
  S = await import('./store.js');
  L.setStoryChatDepsForTest({
    now: () => now,
    provider: () => provider,
    readTicket: async () => ticket,
    heads: async () => new Map([['acme/api#12', 'abc1234def']]),
    checkout: async (_a, _i, prs) => ({
      checkouts: prs.map((p) => ({ ...p, path: `/wt/${p.number}`, error: null })),
      cleanup: async () => {
        cleanups += 1;
      },
    }),
    readerContext: async () => ({
      memories: [{ dir: '/home/me/code/api', files: [{ rel: 'MEMORY.md', text: 'Staging needs the REFUNDS_V2 flag.' }] }],
      userClaudeMd: 'Write British English.',
      folderClaudeMd: { folder: '/home/me/code', text: 'api and web deploy together.' },
      userSkills: { dir: '/home/me/.claude/skills', names: ['release'] },
    }),
    repos: async () => [
      { repoId: 1, owner: 'acme', name: 'api', defaultBranch: 'main', headSha: null },
      { repoId: 2, owner: 'acme', name: 'web', defaultBranch: 'develop', headSha: null },
    ],
    repoCheckouts: async (_a, _i, repos) => {
      repoCheckoutCalls.push(repos.map((r) => `${r.owner}/${r.name}@${r.defaultBranch}`));
      return {
        checkouts: repos.map((r) => ({ repo: `${r.owner}/${r.name}`, path: `/repos/${r.name}`, sha: 'feedface00', error: null })),
        cleanup: async () => {
          cleanups += 1;
        },
      };
    },
    docs: async () => ({ dir: '/home/me/.limn/docs/1' }),
    sprint: async () => '- ACME-10 "Refund emails" — In Progress; acme/web#3 (open)',
    tmpBase: () => TMP_BASE,
    diff: async (repo, n) => `diff --git a/x b/x\n# ${repo}#${n}\n`,
  });
});

beforeEach(async () => {
  await L.closeAll();
  L.resetLiveForTest();
  provider = claude;
  sessions.length = 0;
  runs.length = 0;
  cleanups = 0;
});

afterAll(async () => {
  await L.closeAll();
  L.setStoryChatDepsForTest(null);
  await closeDb?.();
  rmSync(TMP_BASE, { recursive: true, force: true });
});

describe('story chat — the live agent', () => {
  it('prepares a warm, read-only agent before any question (no model call)', async () => {
    await L.prepare(ctx, 1, ws, IDENT);
    const live = L.liveOf(1, ws, IDENT);
    expect(live.state).toBe('ready');
    expect(live.checkouts).toEqual([{ repo: 'acme/api', number: 12, ok: true }]);
    expect(sessions).toHaveLength(1);
    expect(sessions[0].asked).toEqual([]);
    const spec = sessions[0].spec;
    expect(spec.kind).toBe('story_chat');
    expect(spec.cwd).toBe('/wt/12');
    expect(spec.sandbox).toBeUndefined();
    expect(spec.system).toContain('This chat is READ-ONLY');
    // Every workspace repository at its default branch, the temp folder, the library and the skills: all read-only roots.
    expect(repoCheckoutCalls.at(-1)).toEqual(['acme/api@main', 'acme/web@develop']);
    expect(spec.roots).toEqual(expect.arrayContaining(['/repos/api', '/repos/web', '/home/me/.limn/docs/1', '/home/me/.claude/skills']));
    expect(L.liveOf(1, ws, IDENT).repos).toEqual([
      { repo: 'acme/api', ok: true },
      { repo: 'acme/web', ok: true },
    ]);
    // The reader's memory, CLAUDE.md files and skills, the library and the sprint are all in the seed.
    expect(spec.system).toContain('Staging needs the REFUNDS_V2 flag.');
    expect(spec.system).toContain('Write British English.');
    expect(spec.system).toContain('api and web deploy together.');
    expect(spec.system).toContain("The developer's skills, in /home/me/.claude/skills: release.");
    expect(spec.system).toContain('# The reference library');
    expect(spec.system).toContain('ACME-10 "Refund emails"');
    expect(spec.system).toContain('- acme/web: /repos/web at feedfac');
    // Every memory file is written in full where the agent can read it.
    const memFile = (spec.system.match(/Every memory file is also in (\S+?)\./) ?? [])[1];
    expect(memFile).toBeTruthy();
    expect(readFileSync(join(memFile!, '1-api', 'MEMORY.md'), 'utf8')).toBe('Staging needs the REFUNDS_V2 flag.');
    // The PR's diff is written on the host (the checkout is blobless; the sandbox has no GitHub).
    expect(spec.system).toMatch(/its full diff: .*acme__api-12\.diff/);
  });

  it('answers on the warm session, stores the turn, and serves the next question on the SAME session', async () => {
    const a = await L.ask(ctx, 1, ws, IDENT, null, 'What is the test strategy?');
    let turns = await settle(a.chatId);
    expect(turns).toHaveLength(1);
    expect(turns[0]).toMatchObject({ status: 'done', answer: 'Answer to: What is the test strategy?', provider: 'claude', costUsd: 0.25 });
    const b = await L.ask(ctx, 1, ws, IDENT, a.chatId, 'And the risks?');
    expect(b.chatId).toBe(a.chatId);
    turns = await settle(a.chatId);
    expect(turns.map((t: any) => t.status)).toEqual(['done', 'done']);
    expect(sessions).toHaveLength(1);
    expect(sessions[0].asked).toEqual(['What is the test strategy?', 'And the risks?']);
    const [chat] = await S.listChats(1, ws, IDENT);
    expect(chat).toMatchObject({ id: a.chatId, title: 'What is the test strategy?', turnCount: 2 });
  });

  it('refuses a second question while one is answering, and Stop ends it', async () => {
    const a = await L.ask(ctx, 1, ws, IDENT, null, 'A slow one');
    await expect(L.ask(ctx, 1, ws, IDENT, a.chatId, 'Another')).rejects.toBeInstanceOf(L.StoryChatBusyError);
    expect(L.liveOf(1, ws, IDENT).state).toBe('answering');
    expect(L.liveOf(1, ws, IDENT).activity).toContain('Ran: pnpm test');
    expect(await L.stop(1, a.chatId)).toBe(true);
    const turns = await settle(a.chatId);
    expect(turns[0].status).toBe('stopped');
    expect(L.liveOf(1, ws, IDENT).state).toBe('ready');
  });

  it('Codex answers read-only, one run per question, told the earlier turns', async () => {
    provider = codex;
    const a = await L.ask(ctx, 1, ws, IDENT, null, 'First?');
    await settle(a.chatId);
    await L.ask(ctx, 1, ws, IDENT, a.chatId, 'Second?');
    const turns = await settle(a.chatId);
    expect(turns.map((t: any) => [t.status, t.answer])).toEqual([
      ['done', 'Read-only answer'],
      ['done', 'Read-only answer'],
    ]);
    expect(runs).toHaveLength(2);
    expect(runs[1].kind).toBe('story_chat');
    expect(runs[1].writeRoots).toEqual([]);
    expect(runs[1].roots).toEqual([]);
    expect(runs[1].claude.disallowedTools).toContain('Bash');
    expect(runs[1].system).toContain('Q: First?');
    expect(runs[1].usageRecord).toMatchObject({ feature: 'story_chat' });
  });

  it('a continued chat on a new agent is told its earlier turns', async () => {
    const a = await L.ask(ctx, 1, ws, IDENT, null, 'Where is the queue?');
    await settle(a.chatId);
    await L.closeAll();
    await L.prepare(ctx, 1, ws, IDENT, a.chatId);
    expect(sessions).toHaveLength(2);
    expect(sessions[1].spec.system).toContain('Q: Where is the queue?\nA: Answer to: Where is the queue?');
  });

  it(`closes an agent idle for ${10} minutes: session stopped, worktrees and temp folder removed`, async () => {
    await L.prepare(ctx, 1, ws, IDENT);
    expect(tmpFolders()).toHaveLength(1);
    now += 9 * 60_000;
    expect(await L.reapIdle(now)).toBe(0);
    // A keep-alive resets the clock.
    await L.prepare(ctx, 1, ws, IDENT);
    now += 9 * 60_000;
    expect(await L.reapIdle(now)).toBe(0);
    now += 2 * 60_000;
    expect(await L.reapIdle(now)).toBe(1);
    expect(sessions[0].closed).toBe(true);
    expect(cleanups).toBe(2); // the PR worktrees and the repositories' worktrees
    expect(tmpFolders()).toHaveLength(0);
    expect(L.liveOf(1, ws, IDENT).state).toBe('cold');
  });

  it('never reaps an agent while it answers', async () => {
    const a = await L.ask(ctx, 1, ws, IDENT, null, 'A slow one');
    now += 60 * 60_000;
    expect(await L.reapIdle(now)).toBe(0);
    await L.stop(1, a.chatId);
    await settle(a.chatId);
  });

  it('at boot: settles turns a restart cut off and deletes this install’s leftover temp folders', async () => {
    const chatId = await S.createChat(1, ws, IDENT, 'Cut off?');
    await S.startTurn(1, chatId, { question: 'Cut off?', provider: 'claude', model: 'm' });
    await L.prepare(ctx, 1, ws, IDENT);
    L.resetLiveForTest(); // a crash: the folder is left behind
    const out = await L.sweepAtBoot();
    expect(out.turns).toBe(1);
    expect(out.folders).toBe(1);
    expect(tmpFolders()).toHaveLength(0);
    const [turn] = await S.listTurns(1, chatId);
    expect(turn).toMatchObject({ status: 'failed', error: 'Limn restarted before this answer finished.' });
  });

  it('the stored chats are this account’s and this story’s only', async () => {
    const chatId = await S.createChat(1, ws, IDENT, 'Mine');
    expect(await S.findChat(1, ws, IDENT, chatId)).not.toBeNull();
    expect(await S.findChat(1, ws, 'jira:https://acme.atlassian.net#ACME-10', chatId)).toBeNull();
    expect(await S.findChat(2, ws, IDENT, chatId)).toBeNull();
    expect(await S.chatById(2, chatId)).toBeNull();
    expect(existsSync(DB_PATH)).toBe(true);
  });
});

describe('story chat — the Claude session is read-only', () => {
  it('offers only the read tools and denies the shell and every write tool', async () => {
    const { SESSION_TOOLS, SESSION_DENIED_TOOLS } = await import('../ai/providers/claude.js');
    expect([...SESSION_TOOLS]).toEqual(['Read', 'Glob', 'Grep']);
    expect(SESSION_DENIED_TOOLS).toEqual(expect.arrayContaining(['Bash', 'Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'WebFetch', 'WebSearch']));
  });
});
