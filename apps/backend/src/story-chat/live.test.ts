// STORY CHAT — the live manager over the REAL core client (a scratch SQLite, migrations applied), with
// the agent, git and the reader's files faked. Pinned: a prepared agent answers and the turn is stored;
// ONE warm session serves every question of a chat; a busy chat refuses a second question; Codex answers
// read-only with the earlier turns; no sandbox ⇒ no shell; Stop; the 10-minute reaper removes the
// worktrees and the temp folder; the boot sweep settles cut-off turns and deletes leftover folders.
import { existsSync, mkdirSync, rmSync } from 'node:fs';
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
let support = { ok: true, why: null as string | null };
const sessions: any[] = [];
const runs: any[] = [];

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
  L = await import('./live.js');
  S = await import('./store.js');
  L.setStoryChatDepsForTest({
    now: () => now,
    provider: () => provider,
    support: () => support,
    readTicket: async () => ticket,
    heads: async () => new Map([['acme/api#12', 'abc1234def']]),
    checkout: async (_a, _i, prs) => ({
      checkouts: prs.map((p) => ({ ...p, path: `/wt/${p.number}`, error: null, paths: { path: `/wt/${p.number}`, commonDir: '/c/.git', gitDir: '/c/.git/worktrees/w' } })),
      cleanup: async () => {
        cleanups += 1;
      },
    }),
    readerContext: async () => ({ memories: [], userClaudeMd: null, allowedHosts: [], borrowed: new Map() }),
    tmpBase: () => TMP_BASE,
    diff: async (repo, n) => `diff --git a/x b/x\n# ${repo}#${n}\n`,
  });
});

beforeEach(async () => {
  await L.closeAll();
  L.resetLiveForTest();
  provider = claude;
  support = { ok: true, why: null };
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
  it('prepares a warm, sandboxed agent before any question (no model call)', async () => {
    await L.prepare(ctx, 1, ws, IDENT);
    const live = L.liveOf(1, ws, IDENT);
    expect(live.state).toBe('ready');
    expect(live.shell).toBe(true);
    expect(live.checkouts).toEqual([{ repo: 'acme/api', number: 12, ok: true }]);
    expect(sessions).toHaveLength(1);
    expect(sessions[0].asked).toEqual([]);
    const spec = sessions[0].spec;
    expect(spec.kind).toBe('story_chat');
    expect(spec.cwd).toBe('/wt/12');
    expect(spec.sandbox.allowWrite).toEqual(expect.arrayContaining(['/wt/12', '/c/.git/worktrees/w']));
    expect(spec.sandbox.denyRead.length).toBe(1);
    expect(spec.env.GH_TOKEN).toBeUndefined();
    expect(spec.system).toContain('Every command runs in a SANDBOX');
    // The PR's diff is written on the host (the checkout is blobless; the sandbox has no GitHub).
    expect(spec.system).toMatch(/its full diff: .*acme__api-12\.diff/);
  });

  it('answers on the warm session, stores the turn, and serves the next question on the SAME session', async () => {
    const a = await L.ask(ctx, 1, ws, IDENT, null, 'What is the test strategy?');
    let turns = await settle(a.chatId);
    expect(turns).toHaveLength(1);
    expect(turns[0]).toMatchObject({ status: 'done', answer: 'Answer to: What is the test strategy?', shell: true, provider: 'claude', costUsd: 0.25 });
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

  it('no sandbox here ⇒ the agent gets no shell, and says why', async () => {
    support = { ok: false, why: 'Commands are off: install bubblewrap and socat to turn them on.' };
    await L.prepare(ctx, 1, ws, IDENT);
    expect(L.liveOf(1, ws, IDENT)).toMatchObject({ shell: false, shellNote: support.why });
    expect(sessions[0].spec.sandbox).toBeNull();
    expect(sessions[0].spec.system).toContain('You cannot run commands in this chat');
  });

  it('Codex answers read-only, one run per question, told the earlier turns', async () => {
    provider = codex;
    const a = await L.ask(ctx, 1, ws, IDENT, null, 'First?');
    await settle(a.chatId);
    await L.ask(ctx, 1, ws, IDENT, a.chatId, 'Second?');
    const turns = await settle(a.chatId);
    expect(turns.map((t: any) => [t.status, t.shell, t.answer])).toEqual([
      ['done', false, 'Read-only answer'],
      ['done', false, 'Read-only answer'],
    ]);
    expect(runs).toHaveLength(2);
    expect(runs[1].kind).toBe('story_chat');
    expect(runs[1].writeRoots).toEqual([]);
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
    expect(cleanups).toBe(1);
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
    await S.startTurn(1, chatId, { question: 'Cut off?', provider: 'claude', model: 'm', shell: true });
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
