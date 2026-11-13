// STORY CHAT — quick, READ-ONLY questions about one story: advice, integration, how to prove it is done.
// An agent answers from the ticket, the story's pull requests (diffs and checked-out code) and the
// reader's memory; it runs no commands and changes nothing (docs/STORY-CHAT.md). The wire contract between
// apps/backend/src/story-chat/ and the story view (apps/frontend/src/components/Ticket/StoryChat.tsx).
//
// A chat belongs to (workspace, ticket ident). Its turns are kept in Limn's database, so a chat can be
// read and continued later. The agent itself is LIVE only while the story is open: it is prepared when
// the story view opens and closed after STORY_CHAT_IDLE_MINUTES without use.

/** A live chat with no question and no keep-alive for this long is closed and its scratch removed. */
export const STORY_CHAT_IDLE_MINUTES = 10;

/** The longest question the server accepts. */
export const STORY_CHAT_MAX_QUESTION = 4_000;

/** The ready-made questions shown under the box. */
export const STORY_CHAT_PRESETS: ReadonlyArray<{ label: string; question: string }> = [
  {
    label: 'How to test',
    question:
      'Once these pull requests are merged, what must I do to prove this ticket is done? Give the manual test steps in order, with what to expect at each step, and name anything still missing from the pull requests or that needs doing outside the code.',
  },
  {
    label: 'Integration',
    question:
      'How do these changes fit with the rest of the system? Name the other services, repositories, configuration and data they depend on or affect, and what to check when they are deployed together.',
  },
  {
    label: 'Risks',
    question: 'What is risky in these changes? Name what is most likely to break, where, and how I would notice.',
  },
  {
    label: 'Criteria check',
    question: 'For each acceptance criterion, say whether the pull requests meet it and point at the code that does. Name what is left.',
  },
];

export type StoryChatTurnStatus = 'running' | 'done' | 'failed' | 'stopped';

export interface StoryChatTurn {
  id: number;
  question: string;
  /** The answer (markdown). null while running, or when it failed before answering. */
  answer: string | null;
  status: StoryChatTurnStatus;
  error: string | null;
  provider: string | null;
  model: string | null;
  costUsd: number | null;
  createdAt: string;
  finishedAt: string | null;
}

export interface StoryChatSummary {
  id: number;
  workspaceId: number;
  ident: string;
  /** The first question, shortened. */
  title: string;
  turnCount: number;
  createdAt: string;
  updatedAt: string;
}

/**
 * The live agent for a story (memory only, never stored):
 *   cold       nothing prepared (closed after the idle time, or never opened)
 *   preparing  checking out the PRs and starting the agent
 *   ready      waiting for a question
 *   answering  a turn is running
 *   failed     preparing failed (`note` says why); asking prepares again
 */
export type StoryChatLiveState = 'cold' | 'preparing' | 'ready' | 'answering' | 'failed';

export interface StoryChatLive {
  state: StoryChatLiveState;
  /** The chat the live agent is attached to (null before the first question). */
  chatId: number | null;
  /** One line when something is worth knowing (a PR that could not be checked out, a failure). */
  note: string | null;
  /** The running turn's activity lines (tool calls), oldest first, capped. */
  activity: string[];
  /** The running turn's text so far. */
  partial: string;
  /** The checkouts the agent works in. */
  checkouts: Array<{ repo: string; number: number; ok: boolean }>;
}

export interface StoryChatListResponse {
  workspaceId: number;
  ident: string;
  chats: StoryChatSummary[];
  live: StoryChatLive;
}

export interface StoryChatDetailResponse {
  chat: StoryChatSummary;
  turns: StoryChatTurn[];
  live: StoryChatLive;
}

export interface StoryChatPrepareBody {
  workspaceId: number;
  ident: string;
  /** Continue this saved chat (its turns are given to a freshly started agent). */
  chatId?: number | null;
}

export interface StoryChatAskBody {
  workspaceId: number;
  ident: string;
  /** Absent/null ⇒ a new chat. */
  chatId?: number | null;
  question: string;
}

export interface StoryChatAskResponse {
  chatId: number;
  turnId: number;
}
