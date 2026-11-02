import { randomBytes } from 'node:crypto';
import type { ReferenceDocCitation, ReferenceDocsChatResponse } from '@pierre-review/shared';
import { providerName } from '../ai/prompt-tools.js';
import type { AgentContext } from '../review/agent-context.js';
import { chatMayApplyAuthEnv } from '../review/claude-review/manager.js';
import { pickReviewNonce } from '../review/claude-review/prompts.js';
import { docsContextFor } from './context.js';
import { readLibraryFile } from './library.js';
import { parseLibraryPath } from './paths.js';
import { buildChatPrompt, chatSystemPrompt, type ChatPassage, type ChatPriorTurn } from './prompts.js';
import { retrieveSections } from './retrieve.js';
import { extractCitations } from './chat-quotes.js';
import { conversationRows, insertChatTurn, listDocRows, toChatMessage, type DocRow } from './store.js';

// THE DOCS CHAT (docs/REFERENCE-DOCS.md § The chat). Ad hoc questions about a workspace's library,
// answered by Sonnet 5 reading the markdown tree with Read/Glob/Grep (no shell, no writes, the path
// guard on the library folder), told to start at INDEX.md and read only what is relevant.
//
//   • THE TRANSCRIPT IS SERVER-REBUILT from stored rows every turn. The client sends only the new
//     question, so it can never inject an earlier "answer".
//   • ONE TURN AT A TIME PER ACCOUNT, claimed SYNCHRONOUSLY before the first await.
//   • Nothing is stored unless an answer came back; a failed turn that still cost money is metered.
//   • CITATIONS are the answer's links that name a real file of THIS library (a strict path grammar,
//     then a read) — the SPA opens them through GET /api/docs/section. A section citation carries the
//     quote beside its link when it passes the review quote check (chat-quotes.ts), so the viewer
//     highlights it.
//   • PASSAGES FIRST: before the run, full-text search (retrieve.ts) over the question AND the previous
//     question (a follow-up rarely names its subject) puts the best CHAT_PASSAGES sections' best passages
//     in the prompt, at most CHAT_PASSAGES_PER_DOC from one document, ≤ CHAT_PASSAGES_CHARS in all. The
//     tools stay: a passage is where to start, never a citation by itself. A search failure ⇒ none.

export const CHAT_MAX_PRIOR_TURNS = 8;
export const CHAT_TRANSCRIPT_MAX_CHARS = 40_000;
const STORED_ANSWER_CHARS = 20_000;
const CHAT_TIMEOUT_MS = 5 * 60_000;
export const CONVERSATION_ID = /^[a-f0-9]{16,32}$/;
export const CHAT_PASSAGES = 6;
export const CHAT_PASSAGES_PER_DOC = 3;
export const CHAT_PASSAGES_CHARS = 12_000;

export { extractCitations };

const inFlight = new Set<number>();

export class DocsChatError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'DocsChatError';
  }
}

/** The earlier turns to re-send, newest kept, oldest dropped first past the caps. */
export function priorTurns(rows: ReadonlyArray<{ role: string; content: string }>): ChatPriorTurn[] {
  const turns = rows.map((r) => ({ role: r.role === 'assistant' ? ('assistant' as const) : ('user' as const), text: r.content }));
  const kept: ChatPriorTurn[] = [];
  let chars = 0;
  for (let i = turns.length - 1; i >= 0 && kept.length < CHAT_MAX_PRIOR_TURNS * 2; i--) {
    const t = turns[i]!;
    if (chars + t.text.length > CHAT_TRANSCRIPT_MAX_CHARS) break;
    chars += t.text.length;
    kept.unshift(t);
  }
  return kept;
}

/** The search text for a turn: the question, and the previous question when there is one. */
export function chatRetrievalQuery(prior: readonly ChatPriorTurn[], question: string): string {
  const lastQuestion = [...prior].reverse().find((t) => t.role === 'user');
  return lastQuestion != null ? `${question}\n${lastQuestion.text}` : question;
}

/** Retrieved sections → prompt passages, best first, within the character budget. Pure. */
export function chatPassagesOf(found: ReadonlyArray<{ path: string; anchor: string | null; passage: string }>, budget = CHAT_PASSAGES_CHARS): ChatPassage[] {
  const out: ChatPassage[] = [];
  let used = 0;
  for (const f of found) {
    if (used + f.passage.length > budget) continue;
    used += f.passage.length;
    out.push({ link: f.anchor != null ? `${f.path}#${f.anchor}` : f.path, text: f.passage });
  }
  return out;
}

export interface AskArgs {
  accountId: number;
  workspaceId: number;
  conversationId: string | null;
  question: string;
  /** Aborted when the client goes away (watch the REPLY socket — a POST's request `close` fires early). */
  signal: AbortSignal;
}

export async function askDocs(ctx: AgentContext, a: AskArgs): Promise<ReferenceDocsChatResponse> {
  if (a.conversationId != null && !CONVERSATION_ID.test(a.conversationId)) {
    throw new DocsChatError(400, 'BadConversation', 'Not a conversation id.');
  }
  if (inFlight.has(a.accountId)) {
    throw new DocsChatError(409, 'Busy', `${providerName()} is still answering your last question.`);
  }
  inFlight.add(a.accountId); // claimed before the first await
  try {
    const auth = ctx.llm.detectAuth('docs_chat');
    if (auth.status === 'none') throw new DocsChatError(400, 'NoClaudeAuth', auth.message ?? `No ${providerName()} credential found.`);
    const library = await docsContextFor(a.accountId, a.workspaceId);
    if (!library.hasDocs) throw new DocsChatError(409, 'EmptyLibrary', 'There are no documents to ask about yet.');
    const conversationId = a.conversationId ?? randomBytes(12).toString('hex');
    const prior = a.conversationId != null ? priorTurns(await conversationRows(a.accountId, a.workspaceId, conversationId)) : [];
    const found = await retrieveSections({
      accountId: a.accountId,
      workspaceId: a.workspaceId,
      query: chatRetrievalQuery(prior, a.question),
      k: CHAT_PASSAGES,
      perDocCap: CHAT_PASSAGES_PER_DOC,
    }).catch((err: unknown) => {
      ctx.log.warn({ err }, 'docs chat: passage search failed');
      return null;
    });
    const passages = chatPassagesOf(found ?? []);
    const nonce = pickReviewNonce([a.question, ...prior.map((t) => t.text), ...passages.map((p) => `${p.link}\n\n${p.text}`)]);

    const controller = new AbortController();
    const onAbort = (): void => controller.abort();
    a.signal.addEventListener('abort', onAbort);
    const timer = setTimeout(() => controller.abort(), CHAT_TIMEOUT_MS);
    let res;
    try {
      const { runDocsChatAgent } = await import('./agent.js');
      res = await runDocsChatAgent({
        cwd: library.dir,
        systemPrompt: chatSystemPrompt(),
        prompt: buildChatPrompt(prior, a.question, nonce, passages),
        applyAuthEnv: chatMayApplyAuthEnv(),
        abortController: controller,
        // Codex records its own ledger row from this (its model, US$ 0 on a ChatGPT login, its tokens).
        usageRecord: { accountId: a.accountId, seam: 'agent', feature: 'reference_docs_chat' },
      });
    } finally {
      clearTimeout(timer);
      a.signal.removeEventListener('abort', onAbort);
    }
    // A Codex run's row is already written (by its provider, as Codex): never a second, Claude-named one.
    if (res.provider !== 'codex' && res.costUsd != null && res.costUsd > 0) {
      await ctx
        .recordAiUsage({
          accountId: a.accountId,
          seam: 'agent',
          feature: 'reference_docs_chat',
          model: 'claude-sonnet-5',
          costUsd: res.costUsd,
          inputTokens: res.inputTokens,
          outputTokens: res.outputTokens,
        })
        .catch(() => {});
    }
    if (!res.ok) {
      if (res.aborted) throw new DocsChatError(499, 'Cancelled', 'The question was cancelled.');
      ctx.log.warn(`docs chat failed: ${res.failureReason ?? 'unknown'}`);
      throw new DocsChatError(502, 'NoAnswer', `${providerName(res.provider)} could not answer that. Try again.`);
    }
    const text = res.text.length > STORED_ANSWER_CHARS ? `${res.text.slice(0, STORED_ANSWER_CHARS)}…` : res.text;
    const docs = await listDocRows(a.accountId, a.workspaceId);
    const citations = extractCitations(text, docs, (path) => {
      const parsed = parseLibraryPath(path);
      return parsed != null ? readLibraryFile(a.accountId, a.workspaceId, parsed.path) : null;
    });
    const saved = await insertChatTurn(a.accountId, a.workspaceId, conversationId, a.question, {
      text,
      citations,
      provider: res.provider,
      model: res.model,
      costUsd: res.costUsd,
      inputTokens: res.inputTokens,
      outputTokens: res.outputTokens,
    });
    return {
      workspaceId: a.workspaceId,
      conversationId,
      question: toChatMessage(saved.question),
      answer: toChatMessage(saved.answer),
    };
  } finally {
    inFlight.delete(a.accountId);
  }
}
