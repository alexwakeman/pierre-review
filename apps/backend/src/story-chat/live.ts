// STORY CHAT — THE LIVE AGENTS (docs/STORY-CHAT.md). Memory only: one live chat per (account,
// workspace, ticket), at most `maxLive()` at once.
//
//   prepare   the story view opened (and every keep-alive while it stays open): check the story's
//             PRs out (clone-manager worktrees, ledgered as kind 'chat'), borrow the reader's
//             node_modules read-only, read the reader's memory, and START the agent — so a question
//             is answered at once (docs/QUICK-CHAT-SPIKE.md: ~1 s warm vs ~5 s cold). No model call.
//   ask       one question: a stored turn, answered by the warm Claude session (commands in the srt
//             process sandbox), or on Codex by one read-only run with the earlier turns in the prompt.
//   reap      every minute: a chat with no question and no keep-alive for STORY_CHAT_IDLE_MINUTES is
//             closed — the agent stopped, its worktrees removed, its temp folder deleted. The stored
//             turns stay; asking again prepares a fresh agent told the earlier turns.
//   boot      leftover temp folders of this install are deleted, running turns marked cut off; a
//             worktree a crash left behind is the worktree sweep's (review/worktree-gc.ts: its process
//             is gone).
import { execFile } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { and, eq, inArray } from 'drizzle-orm';
import {
  STORY_CHAT_IDLE_MINUTES,
  type StoryChatLive,
  type StoryChatLiveState,
} from '@pierre-review/shared';
import type { AgentContext } from '../review/agent-context.js';
import {
  getProvider,
  type AgentOutcome,
  type AgentProgress,
  type AgentProvider,
  type AgentProviderId,
  type AgentSession,
  type ModelChoice,
} from '../ai/provider.js';
import { activeProviderId } from '../ai/provider-setting.js';
import { recordAiUsage } from '../db/usage.js';
import { db, schema } from '../db/client.js';
import { resolveDataDir } from '../data-dir.js';
import { withWorktreeOwner } from '../review/worktree-owner.js';
import { prepPeerWorktrees, cleanupCloneCache } from '../review/clone-manager.js';
import { CHAT_DISALLOWED_TOOLS } from '../review/chat-agent.js';
import { readSessionTicket, defaultSessionTicketSeams, type SessionTicket } from '../sandbox/workspace/ticket.js';
import {
  agentEnv,
  caReadPaths,
  chatAllowedDomains,
  chatSandboxPolicy,
  chatTmpBase,
  chatTmpPrefix,
  real,
  sandboxSupport,
  type ChatCheckoutPaths,
  type SandboxSupport,
} from './policy.js';
import { storyChatSystemPrompt, type SeedCheckout, type SeedMemory, type SeedTurn } from './seed.js';
import * as store from './store.js';

const execFileAsync = promisify(execFile);

/** Most PRs a chat checks out (open ones first, then the newest merged). */
export const STORY_CHAT_MAX_CHECKOUTS = 6;
/** The US$ cap of one live agent (a new one starts, told the earlier turns, when it is reached). */
export const STORY_CHAT_SESSION_BUDGET_USD = 5;
export const STORY_CHAT_TURNS_PER_QUESTION = 40;
const ACTIVITY_MAX = 40;
const DIFF_MAX_CHARS = 2_000_000;
const IDLE_MS = STORY_CHAT_IDLE_MINUTES * 60_000;
const MODEL: ModelChoice = { role: 'standard' };

export function maxLive(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number(env.LIMN_STORY_CHAT_MAX_LIVE);
  return Number.isInteger(n) && n >= 1 && n <= 10 ? n : 3;
}

// ---- seams (tests replace them) -----------------------------------------------------------------

export interface PreparedCheckout extends SeedCheckout {
  paths: ChatCheckoutPaths | null;
}

export interface StoryChatDeps {
  now(): number;
  provider(): AgentProvider;
  support(): SandboxSupport;
  readTicket(ctx: AgentContext, accountId: number, workspaceId: number, ident: string): Promise<SessionTicket | null>;
  /** Check the PRs out. `cleanup` removes every worktree made. */
  checkout(
    accountId: number,
    ident: string,
    prs: ReadonlyArray<{ repo: string; number: number; title: string; state: 'open' | 'merged'; headSha: string | null }>,
  ): Promise<{ checkouts: PreparedCheckout[]; cleanup: () => Promise<void> }>;
  /** The PRs' head commits, by `owner/name#number`. */
  heads(accountId: number, prs: ReadonlyArray<{ repo: string; number: number }>): Promise<Map<string, string>>;
  /** The reader's memory, CLAUDE.md, workspace rules and borrowable node_modules. */
  readerContext(
    accountId: number,
    workspaceId: number,
    checkouts: readonly PreparedCheckout[],
  ): Promise<{ memories: SeedMemory[]; userClaudeMd: string | null; allowedHosts: string[]; borrowed: Map<string, string[]> }>;
  tmpBase(): string;
  /** A PR's unified diff (GitHub's own, so it works for merged PRs and needs no blobs locally). */
  diff(repo: string, number: number): Promise<string>;
}

const realDeps: StoryChatDeps = {
  now: () => Date.now(),
  provider: () => getProvider(activeProviderId()),
  support: () => sandboxSupport(),
  readTicket: (ctx, accountId, workspaceId, ident) =>
    // From Limn's STORED copy: opening a story never reads the tracker (CLAUDE.md § Trackers).
    readSessionTicket(ctx, accountId, workspaceId, ident, {
      seams: { ...defaultSessionTicketSeams, refresh: async () => ({ points: [], fresh: false, fetchedAt: null }) },
    }),
  async checkout(accountId, ident, prs) {
    const wanted = prs.filter((p) => p.headSha != null);
    const { peers, cleanup } = await withWorktreeOwner({ kind: 'chat', accountId, ticket: ident }, () =>
      prepPeerWorktrees(
        wanted.map((p) => {
          const [owner, name] = p.repo.split('/') as [string, string];
          return { owner, name, number: p.number, headSha: p.headSha! };
        }),
      ),
    );
    const out: PreparedCheckout[] = [];
    for (const p of prs) {
      const i = wanted.indexOf(p);
      const peer = i >= 0 ? peers[i] : undefined;
      const path = peer?.path ?? null;
      out.push({
        repo: p.repo,
        number: p.number,
        title: p.title,
        state: p.state,
        headSha: p.headSha,
        path,
        error: p.headSha == null ? 'its head commit is not known yet' : (peer?.error ?? null),
        paths: path ? await gitPaths(path) : null,
      });
    }
    return { checkouts: out, cleanup };
  },
  async heads(accountId, prs) {
    const out = new Map<string, string>();
    if (prs.length === 0) return out;
    const r = schema.repos;
    const p = schema.pullRequests;
    const rows = await db
      .select({ owner: r.owner, name: r.name, number: p.number, headSha: p.headSha })
      .from(p)
      .innerJoin(r, and(eq(r.id, p.repoId), eq(r.accountId, accountId)))
      .where(and(eq(p.accountId, accountId), inArray(p.number, [...new Set(prs.map((x) => x.number))])))
      .execute();
    for (const row of rows) if (row.headSha) out.set(`${row.owner}/${row.name}#${row.number}`.toLowerCase(), row.headSha);
    return out;
  },
  async readerContext(accountId, workspaceId, checkouts) {
    const [{ getSandboxSettings, sandboxWorkspaceRepos }, { resolveWorkspaceLayout, defaultLayoutPlaces }, mem, { discoverReaderClones }] =
      await Promise.all([
        import('../db/sandbox-settings.js'),
        import('../sandbox/workspace/check.js'),
        import('../sandbox/workspace/memories.js'),
        import('../sandbox/workspace/discover.js'),
      ]);
    const [settings, repos] = await Promise.all([getSandboxSettings(accountId, workspaceId), sandboxWorkspaceRepos(accountId, workspaceId)]);
    const places = defaultLayoutPlaces();
    const memories: SeedMemory[] = [];
    let userClaudeMd: string | null = null;
    const borrowed = new Map<string, string[]>();
    if (repos && repos.length > 0) {
      try {
        const resolved = resolveWorkspaceLayout(repos, { memoryProjects: settings?.memoryProjects ?? null }, places);
        for (const p of resolved.projects.filter((x) => x.ticked)) {
          const got = mem.readMemories(places.claude, p.key);
          memories.push({ dir: p.dir, files: got.files.map((f) => ({ rel: f.rel, text: f.content.toString('utf8') })) });
        }
        const clones = discoverReaderClones(repos, places.claude, places.home).clones;
        for (const c of checkouts) {
          if (!c.path) continue;
          const clone = clones.find((x) => x.fullName.toLowerCase() === c.repo.toLowerCase());
          if (clone) borrowed.set(c.path, borrowNodeModules(clone.dir, c.path));
        }
      } catch {
        /* the reader's files are a help, never a reason to fail the chat */
      }
    }
    if (settings?.userClaudeMd !== false) {
      const b = mem.readUserClaudeMd(places.claude);
      if (b) userClaudeMd = b.toString('utf8');
    }
    return { memories, userClaudeMd, allowedHosts: settings?.alwaysAllowedHosts ?? [], borrowed };
  },
  tmpBase: () => chatTmpBase(process.platform, tmpdir(), existsSync('/tmp')),
  async diff(repo, number) {
    const [{ fetchPrUnifiedDiff }, { getGithubToken }] = await Promise.all([import('../github/mutations.js'), import('../github/auth.js')]);
    const [owner, name] = repo.split('/') as [string, string];
    return fetchPrUnifiedDiff(getGithubToken(), owner, name, number);
  },
};

let deps: StoryChatDeps = realDeps;
/** Tests only. */
export function setStoryChatDepsForTest(d: Partial<StoryChatDeps> | null): void {
  deps = d == null ? realDeps : { ...realDeps, ...d };
}

async function gitPaths(path: string): Promise<ChatCheckoutPaths> {
  try {
    const { stdout } = await execFileAsync('git', ['-C', path, 'rev-parse', '--absolute-git-dir', '--git-common-dir'], { timeout: 10_000 });
    const [gitDir, common] = stdout.trim().split('\n');
    return { path, gitDir: gitDir ?? null, commonDir: common ? (isAbsolute(common) ? common : resolve(path, common)) : null };
  } catch {
    return { path, gitDir: null, commonDir: null };
  }
}

/**
 * Link the reader's installed `node_modules` into a checkout, READ-ONLY (the sandbox denies writes to
 * them): the root one and those one or two folders down (apps/x, packages/y) where the checkout has
 * the same folder and none of its own. Returns the borrowed real paths.
 */
export function borrowNodeModules(cloneDir: string, worktree: string): string[] {
  const rels = ['node_modules'];
  const skip = (n: string): boolean => n.startsWith('.') || n === 'node_modules';
  try {
    for (const a of readdirSync(cloneDir)) {
      if (skip(a) || !isDir(join(cloneDir, a))) continue;
      rels.push(`${a}/node_modules`);
      for (const b of readdirSync(join(cloneDir, a)).slice(0, 200)) {
        if (skip(b) || !isDir(join(cloneDir, a, b))) continue;
        rels.push(`${a}/${b}/node_modules`);
      }
    }
  } catch {
    /* unreadable clone: nothing borrowed */
  }
  const out: string[] = [];
  for (const rel of rels.slice(0, 400)) {
    const from = join(cloneDir, rel);
    const to = join(worktree, rel);
    if (!isDir(from) || existsSync(to) || !isDir(join(to, '..'))) continue;
    try {
      symlinkSync(from, to, 'dir');
      out.push(real(from));
    } catch {
      /* skip this one */
    }
  }
  return out;
}

function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory() && !lstatSync(p).isSymbolicLink();
  } catch {
    return false;
  }
}

// ---- the live chats -------------------------------------------------------------------------------

interface Live {
  key: string;
  accountId: number;
  workspaceId: number;
  ident: string;
  chatId: number | null;
  state: StoryChatLiveState;
  note: string | null;
  shell: boolean;
  shellNote: string | null;
  provider: AgentProvider;
  checkouts: PreparedCheckout[];
  cleanup: (() => Promise<void>) | null;
  tmpDir: string | null;
  ticket: SessionTicket | null;
  seedParts: Omit<Parameters<typeof storyChatSystemPrompt>[0], 'earlier'> | null;
  session: AgentSession | null;
  sandbox: Parameters<typeof chatSandboxPolicy>[0] | null;
  env: Record<string, string>;
  lastActive: number;
  activity: string[];
  partial: string;
  running: { turnId: number; chatId: number; abort: AbortController } | null;
  preparing: Promise<void> | null;
  closed: boolean;
}

const lives = new Map<string, Live>();
const keyOf = (accountId: number, workspaceId: number, ident: string): string => `${accountId}:${workspaceId}:${ident}`;

const COLD: StoryChatLive = { state: 'cold', chatId: null, shell: false, shellNote: null, note: null, activity: [], partial: '', checkouts: [] };

/** The live state for the SPA. */
export function liveOf(accountId: number, workspaceId: number, ident: string): StoryChatLive {
  const l = lives.get(keyOf(accountId, workspaceId, ident));
  if (!l) return { ...COLD, shell: deps.support().ok, shellNote: deps.support().why };
  return {
    state: l.state,
    chatId: l.chatId,
    shell: l.shell,
    shellNote: l.shellNote,
    note: l.note,
    activity: [...l.activity],
    partial: l.partial,
    checkouts: l.checkouts.map((c) => ({ repo: c.repo, number: c.number, ok: c.path != null })),
  };
}

/** The live chat currently answering this chat, if any. */
export function liveForChat(accountId: number, chatId: number): Live | null {
  for (const l of lives.values()) if (l.accountId === accountId && l.chatId === chatId) return l;
  return null;
}

/**
 * Make (or keep) the story's live agent. Idempotent: a keep-alive. `chatId` given and different from
 * the one attached ⇒ the live agent is replaced by one told that chat's turns.
 */
export async function prepare(ctx: AgentContext, accountId: number, workspaceId: number, ident: string, chatId: number | null = null): Promise<Live> {
  ensureReaper();
  const key = keyOf(accountId, workspaceId, ident);
  let l = lives.get(key);
  if (l && chatId != null && l.chatId != null && l.chatId !== chatId && !l.running) {
    await close(l);
    l = undefined;
  }
  if (l && l.state === 'failed' && !l.running) {
    await close(l);
    l = undefined;
  }
  if (l) {
    l.lastActive = deps.now();
    if (chatId != null && l.chatId == null) l.chatId = chatId;
    if (l.preparing) await l.preparing;
    return l;
  }
  await evictForRoom();
  const support = deps.support();
  const provider = deps.provider();
  const live: Live = {
    key,
    accountId,
    workspaceId,
    ident,
    chatId,
    state: 'preparing',
    note: null,
    // Commands run only on Claude (its SDK runs srt) and only where the sandbox works here.
    shell: provider.openSession != null && support.ok,
    shellNote: provider.openSession == null ? 'Codex answers by reading the code here; it does not run commands.' : support.why,
    provider,
    checkouts: [],
    cleanup: null,
    tmpDir: null,
    ticket: null,
    seedParts: null,
    session: null,
    sandbox: null,
    env: {},
    lastActive: deps.now(),
    activity: [],
    partial: '',
    running: null,
    preparing: null,
    closed: false,
  };
  lives.set(key, live);
  live.preparing = doPrepare(ctx, live).finally(() => {
    live.preparing = null;
  });
  await live.preparing;
  return live;
}

async function doPrepare(ctx: AgentContext, l: Live): Promise<void> {
  try {
    const ticket = await deps.readTicket(ctx, l.accountId, l.workspaceId, l.ident);
    if (l.closed) return;
    if (ticket == null) throw new Error('This ticket has no story to ask about yet.');
    l.ticket = ticket;
    const prs = [...ticket.prs]
      .sort((a, b) => (a.state === b.state ? b.number - a.number : a.state === 'open' ? -1 : 1))
      .slice(0, STORY_CHAT_MAX_CHECKOUTS);
    const heads = await deps.heads(l.accountId, prs.map((p) => ({ repo: p.fullName, number: p.number })));
    const want = prs.map((p) => ({
      repo: p.fullName,
      number: p.number,
      title: p.title,
      state: p.state,
      headSha: heads.get(`${p.fullName}#${p.number}`.toLowerCase()) ?? null,
    }));
    const { checkouts, cleanup } = await deps.checkout(l.accountId, l.ident, want);
    l.checkouts = checkouts;
    l.cleanup = cleanup;
    if (l.closed) {
      await cleanup().catch(() => {});
      return;
    }
    const failed = checkouts.filter((c) => c.path == null);
    if (failed.length > 0) l.note = `Not checked out: ${failed.map((c) => `${c.repo}#${c.number}`).join(', ')}.`;

    const base = deps.tmpBase();
    mkdirSync(base, { recursive: true });
    l.tmpDir = mkdtempSync(join(base, chatTmpPrefix(resolveDataDir(process.env, homedir()))));

    // The clone cache is BLOBLESS and the sandbox has no GitHub access, so `git show` of a PR could not
    // fetch what it lacks: each PR's diff is written here, on the host, for the agent to read.
    await Promise.all(
      checkouts.map(async (c) => {
        try {
          const text = await deps.diff(c.repo, c.number);
          const file = join(l.tmpDir!, `${c.repo.replace('/', '__')}-${c.number}.diff`);
          writeFileSync(file, text.length > DIFF_MAX_CHARS ? `${text.slice(0, DIFF_MAX_CHARS)}\n[… cut at ${DIFF_MAX_CHARS} characters]\n` : text);
          c.diffFile = file;
        } catch {
          /* no diff: the agent reads the checkout */
        }
      }),
    );
    const reader = await deps.readerContext(l.accountId, l.workspaceId, checkouts);
    const allowedDomains = chatAllowedDomains(reader.allowedHosts);
    const borrowedAll = [...reader.borrowed.values()].flat();
    l.env = agentEnv(process.env, { tmpDir: l.tmpDir, allowedDomains });
    l.sandbox = {
      home: homedir(),
      checkouts: checkouts.flatMap((c) => (c.paths ? [c.paths] : [])),
      borrowed: borrowedAll,
      tmpDir: l.tmpDir,
      extraRead: caReadPaths(process.env),
      allowedDomains,
    };
    l.seedParts = {
      ticket,
      checkouts,
      borrowed: reader.borrowed,
      memories: reader.memories,
      userClaudeMd: reader.userClaudeMd,
      noShell: l.shell ? null : l.shellNote ?? 'commands are off here.',
      tmpDir: l.tmpDir,
    };
    if (l.provider.openSession) await startSession(l);
    l.state = 'ready';
  } catch (err) {
    l.state = 'failed';
    l.note = err instanceof Error ? err.message : String(err);
  }
}

/** Start the warm Claude session, told the attached chat's earlier turns. */
async function startSession(l: Live): Promise<void> {
  if (!l.seedParts || !l.provider.openSession) return;
  const earlier = l.chatId != null ? await earlierTurns(l.accountId, l.chatId) : [];
  const roots = l.checkouts.flatMap((c) => (c.path ? [c.path] : []));
  const cwd = roots[0] ?? l.tmpDir!;
  l.session = await l.provider.openSession({
    kind: 'story_chat',
    model: MODEL,
    system: storyChatSystemPrompt({ ...l.seedParts, earlier }),
    cwd,
    roots: [...roots, l.tmpDir!].filter((r) => r !== cwd),
    readOnlyRoots: [],
    sandbox: l.shell && l.sandbox ? chatSandboxPolicy(l.sandbox) : null,
    env: l.env,
    budgetUsd: STORY_CHAT_SESSION_BUDGET_USD,
    turnsPerQuestion: STORY_CHAT_TURNS_PER_QUESTION,
    claude: { allowedTools: [], disallowedTools: ['WebFetch', 'WebSearch', 'Task', 'NotebookEdit'] },
  });
}

async function earlierTurns(accountId: number, chatId: number): Promise<SeedTurn[]> {
  return (await store.listTurns(accountId, chatId)).filter((t) => t.status !== 'running').map((t) => ({ question: t.question, answer: t.answer }));
}

export class StoryChatBusyError extends Error {}

/** Ask one question. Starts the answer and returns at once; the SPA reads progress through `liveOf`. */
export async function ask(
  ctx: AgentContext,
  accountId: number,
  workspaceId: number,
  ident: string,
  chatId: number | null,
  question: string,
): Promise<{ chatId: number; turnId: number }> {
  const existing = lives.get(keyOf(accountId, workspaceId, ident));
  if (existing?.running) throw new StoryChatBusyError('A question is already being answered.');
  const id = chatId ?? (await store.createChat(accountId, workspaceId, ident, question));
  const l = await prepare(ctx, accountId, workspaceId, ident, id);
  if (l.running) throw new StoryChatBusyError('A question is already being answered.');
  if (l.state === 'failed') throw new Error(l.note ?? 'The chat could not start.');
  l.chatId = id;
  const providerId: AgentProviderId = l.provider.id;
  const turnId = await store.startTurn(accountId, id, {
    question,
    provider: providerId,
    model: l.provider.resolveModel(MODEL),
    shell: l.shell,
  });
  l.running = { turnId, chatId: id, abort: new AbortController() };
  l.state = 'answering';
  l.activity = [];
  l.partial = '';
  l.lastActive = deps.now();
  void runTurn(l, question).catch(() => {});
  return { chatId: id, turnId };
}

async function runTurn(l: Live, question: string): Promise<void> {
  const run = l.running!;
  const onProgress = (p: AgentProgress): void => {
    l.lastActive = deps.now();
    if (p.kind === 'step') {
      for (const line of p.lines) l.activity.push(line);
      if (l.activity.length > ACTIVITY_MAX) l.activity.splice(0, l.activity.length - ACTIVITY_MAX);
      if (p.text) l.partial = p.text;
    }
  };
  let outcome: AgentOutcome | null = null;
  let error: string | null = null;
  try {
    if (l.provider.openSession) {
      if (!l.session || l.session.closed) await startSession(l);
      outcome = await l.session!.ask(question, onProgress);
    } else {
      outcome = await askReadOnly(l, question, run.abort, onProgress);
    }
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
  }
  const stopped = run.abort.signal.aborted;
  const answer = outcome?.text?.trim() || l.partial.trim() || null;
  const ok = outcome?.subtype === 'success' && answer != null;
  const status = stopped ? 'stopped' : ok ? 'done' : 'failed';
  const failure = status === 'failed' ? (error ?? stopReason(outcome?.subtype ?? null)) : null;
  const usage = outcome?.usage ?? null;
  // The agent is free BEFORE the turn is written: a reader who sees the answer may ask at once.
  // A session that ended (its budget, a crash) is dropped: the next question starts a new one.
  if (l.session?.closed) l.session = null;
  l.running = null;
  l.state = l.closed ? 'cold' : 'ready';
  l.lastActive = deps.now();
  await store
    .finishTurn(l.accountId, run.turnId, {
      status,
      answer,
      error: failure,
      costUsd: outcome?.costUsd ?? null,
      inputTokens: usage ? usage.inputTokens + usage.cacheReadTokens + usage.cacheCreationTokens : null,
      outputTokens: usage?.outputTokens ?? null,
    })
    .catch(() => {});
  // Claude's spend is recorded here; Codex records its own (usageRecord on the run).
  if (l.provider.id === 'claude' && outcome?.costUsd != null && outcome.costUsd > 0) {
    await recordAiUsage({
      accountId: l.accountId,
      seam: 'agent',
      feature: 'story_chat',
      model: l.provider.resolveModel(MODEL),
      costUsd: outcome.costUsd,
      inputTokens: usage ? usage.inputTokens + usage.cacheReadTokens + usage.cacheCreationTokens : null,
      outputTokens: usage?.outputTokens ?? null,
      provider: 'claude',
    }).catch(() => {});
  }
}

/** Why an answer stopped, in plain words. Exported for the test. */
export function stopReason(subtype: string | null): string {
  if (subtype === 'error_max_turns') return 'The agent used its step limit before answering. Ask a narrower question.';
  if (subtype === 'error_max_budget_usd') return 'This chat reached its spend limit. Ask again to start a fresh agent.';
  return 'The agent stopped before answering.';
}

/** Codex (no live session): one read-only run per question, the earlier turns in the system prompt. */
async function askReadOnly(l: Live, question: string, abort: AbortController, onProgress: (p: AgentProgress) => void): Promise<AgentOutcome | null> {
  const earlier = await earlierTurns(l.accountId, l.running!.chatId);
  const roots = l.checkouts.flatMap((c) => (c.path ? [c.path] : []));
  const cwd = roots[0] ?? l.tmpDir!;
  let outcome: AgentOutcome | null = null;
  const res = await l.provider.runAgent({
    kind: 'story_chat',
    model: MODEL,
    effort: 'worktree',
    prompt: question,
    system: storyChatSystemPrompt({ ...l.seedParts!, earlier }),
    cwd,
    roots: roots.filter((r) => r !== cwd),
    // The PR diffs written at prepare time.
    readOnlyRoots: l.tmpDir ? [l.tmpDir] : [],
    writeRoots: [],
    budget: { usd: STORY_CHAT_SESSION_BUDGET_USD, turns: STORY_CHAT_TURNS_PER_QUESTION },
    abortController: abort,
    usageRecord: { accountId: l.accountId, seam: 'agent', feature: 'story_chat' },
    claude: { builtinTools: ['Read', 'Glob', 'Grep'], allowedTools: ['Read', 'Glob', 'Grep'], disallowedTools: [...CHAT_DISALLOWED_TOOLS] },
    onProgress: (p) => {
      onProgress(p);
      if (p.kind === 'outcome') outcome = p.outcome;
    },
  });
  return res.outcome ?? outcome;
}

/** Stop the running answer of this chat. false ⇒ nothing was running. */
export async function stop(accountId: number, chatId: number): Promise<boolean> {
  const l = liveForChat(accountId, chatId);
  if (!l?.running) return false;
  l.running.abort.abort();
  await l.session?.interrupt();
  return true;
}

/** Close a live chat: stop the agent, remove its worktrees and its temp folder. Idempotent. */
export async function close(l: Live): Promise<void> {
  if (l.closed) return;
  l.closed = true;
  lives.delete(l.key);
  l.running?.abort.abort();
  try {
    l.session?.close();
  } catch {
    /* already gone */
  }
  l.session = null;
  if (l.preparing) await l.preparing.catch(() => {});
  await l.cleanup?.().catch(() => {});
  if (l.tmpDir) rmSync(l.tmpDir, { recursive: true, force: true });
  setImmediate(() => {
    try {
      cleanupCloneCache();
    } catch {
      /* advisory */
    }
  });
}

export async function closeFor(accountId: number, workspaceId: number, ident: string): Promise<void> {
  const l = lives.get(keyOf(accountId, workspaceId, ident));
  if (l) await close(l);
}

export async function closeAll(): Promise<void> {
  await Promise.all([...lives.values()].map((l) => close(l)));
}

/** Make room under `maxLive()`: the least recently used chat that is not answering goes. */
async function evictForRoom(): Promise<void> {
  while (lives.size >= maxLive()) {
    const idle = [...lives.values()].filter((l) => !l.running).sort((a, b) => a.lastActive - b.lastActive)[0];
    if (!idle) throw new StoryChatBusyError('Too many story chats are answering at once. Try again shortly.');
    await close(idle);
  }
}

/** Close every chat idle past the limit. Returns how many closed. Exported for the test. */
export async function reapIdle(now = deps.now()): Promise<number> {
  const idle = [...lives.values()].filter((l) => !l.running && !l.preparing && now - l.lastActive > IDLE_MS);
  for (const l of idle) await close(l);
  return idle.length;
}

let reaper: NodeJS.Timeout | null = null;
function ensureReaper(): void {
  if (reaper) return;
  reaper = setInterval(() => void reapIdle().catch(() => {}), 60_000);
  reaper.unref();
}

/** Boot: delete this install's leftover temp folders and settle turns a restart cut off. */
export async function sweepAtBoot(): Promise<{ folders: number; turns: number }> {
  let folders = 0;
  const base = deps.tmpBase();
  const prefix = chatTmpPrefix(resolveDataDir(process.env, homedir()));
  try {
    for (const name of readdirSync(base)) {
      if (!name.startsWith(prefix)) continue;
      rmSync(join(base, name), { recursive: true, force: true });
      folders += 1;
    }
  } catch {
    /* no temp base */
  }
  const turns = await store.settleRunningTurns().catch(() => 0);
  return { folders, turns };
}

/** Tests only: forget every live chat without cleanup. */
export function resetLiveForTest(): void {
  lives.clear();
  if (reaper) clearInterval(reaper);
  reaper = null;
}

