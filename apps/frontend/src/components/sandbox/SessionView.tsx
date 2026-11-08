import { useEffect, useId, useMemo, useState, type ReactNode } from 'react';
import { useIsMutating } from '@tanstack/react-query';
import {
  SANDBOX_MESSAGE_MAX,
  aiRunLabel,
  type AiProviderId,
  type AiRunKind,
  type SandboxConversationItem,
  type SandboxNetworkAllowBody,
  type SandboxNetworkEntry,
  type SandboxSessionRepo,
  type StoryBuildSession,
} from '@pierre-review/shared';
import { ApiError } from '../../api/client.js';
import { useRunCostText } from '../../hooks/useAiBudget.js';
import { useFollowBottom } from '../../hooks/useFollowBottom.js';
import {
  bootProgress,
  networkAllowRule,
  networkRows,
  sessionCanSend,
  sessionCanStartBuild,
  sessionErrorText,
  sessionTurnRunning,
  shortBytes,
  turnOutcomeWords,
  visiblePartialText,
} from '../../lib/sandboxSession.js';
import { REVIEW_SUBHEAD } from '../../lib/reviewStyles.js';
import { dateTime } from '../../lib/ui.js';
import { useSettingsModal } from '../../store/settingsModal.js';
import { AiRunGate } from '../AiSetup.js';
import { CheckIcon, ChevronIcon, CloseIcon, WarningIcon, WrenchIcon } from '../Icons.js';
import { Markdown } from '../Markdown.js';
import { Button } from '../ui/Button.js';
import { cx } from '../ui/cx.js';

// THE WORKSPACE SESSION VIEW, shared by the build tab ("Implement story") and the AI Fix tab
// (docs/SANDBOX.md § Sessions, § AI Fix sessions; docs/FRONTEND.md § The build tab, § The AI Fix tab).
// While it boots: each boot step. Then two panes: the CONVERSATION (drawn like the agent's own terminal,
// below: the reader after a prompt mark, the agent and its tool calls after a bullet, the agent's words
// as they arrive) with the composer, Start build/fix and Stop under
// it; and the RAIL: the caller's own panel first (Ticket / What to fix), then Repositories, Services,
// Network (with the Allow buttons), Spend. Nothing here pushes, and every billed press sits inside the
// ONE AiRunGate. The caller passes its actions as HOOKS (`SessionActions`), so each surface keeps its
// own query keys and invalidation; a hook here is always called in the same order.

/** One press as the view needs it: run it, and what it is doing now. */
export interface SessionActionHandle<V> {
  run: (v: V, onDone?: () => void) => void;
  pending: boolean;
  error: unknown;
  succeeded: boolean;
}

export interface SessionActions {
  /** Every billed press on this session shares this key (read with `useIsMutating`). */
  busyKey: readonly unknown[];
  useSend(): SessionActionHandle<string>;
  /** Start build (Implement) / Start fix (Plan first). The words in the box go with it. */
  useStartBuild(): SessionActionHandle<string>;
  useStop(): SessionActionHandle<void>;
  useResume(): SessionActionHandle<void>;
  useAllow(): SessionActionHandle<SandboxNetworkAllowBody>;
}

/** What differs in words and gates between the two surfaces. */
export interface SessionWords {
  /** The button that moves a chat-mode session to build mode. */
  startBuild: string;
  startBuildTitle: string;
  /** The label on the reader's own build press in the conversation. */
  readerBuildLabel: string;
  /** The conversation before anything is said. */
  empty: string;
  chatPlaceholder: string;
  buildPlaceholder: string;
  /** Resume's one line beside the button. */
  resumeNote: string;
  /** The gate kinds: a chat turn, and a build turn. */
  gate: { chat: AiRunKind; build: AiRunKind };
}

/** A repository row's right-hand word and an optional line under it. */
export interface SessionRepoStatus {
  status: string;
  note?: string | null;
}

export interface SharedSessionViewProps {
  session: StoryBuildSession;
  /** The agent's words still arriving, by message id (the stream fold). */
  partials: ReadonlyMap<string, string>;
  actions: SessionActions;
  words: SessionWords;
  /** The provider when the session has not said yet (the row's). */
  provider: AiProviderId | null;
  /** `data-testid` prefix: 'story-session' (the build tab) or 'fix-session'. */
  testPrefix: string;
  /** The data attribute the action buttons carry (the ⌘K commands and the e2e press them). */
  actionAttr: 'data-story-build-action' | 'data-ai-fix-action';
  /** The rail's first panel (Ticket, What to fix). */
  railTop: ReactNode;
  repoStatus: (r: SandboxSessionRepo) => SessionRepoStatus;
  /** More buttons on the composer's row (Discard), live or closed. */
  composerExtra?: ReactNode;
}

type Ctx = Pick<SharedSessionViewProps, 'actions' | 'words' | 'provider' | 'testPrefix' | 'actionAttr'>;

const act = (attr: Ctx['actionAttr'], name: string): Record<string, string> => ({ [attr]: name });

export function SharedSessionView(props: SharedSessionViewProps): JSX.Element {
  const { session, partials, testPrefix } = props;
  if (session.phase === 'booting') return <SessionBoot session={session} testPrefix={testPrefix} />;
  return (
    <div data-testid={testPrefix} data-phase={session.phase} data-live={session.live} className="mt-5 grid gap-4 lg:grid-cols-[minmax(0,1fr)_19rem]">
      <div className="min-w-0">
        <Conversation session={session} partials={partials} c={props} />
        <Composer session={session} c={props} extra={props.composerExtra} />
      </div>
      <aside aria-label="Session" className="min-w-0 space-y-3">
        {props.railTop}
        <ReposPanel session={session} testPrefix={testPrefix} repoStatus={props.repoStatus} />
        <ServicesPanel session={session} testPrefix={testPrefix} />
        <NetworkPanel session={session} c={props} />
        <SpendPanel session={session} c={props} />
      </aside>
    </div>
  );
}

// ── the boot ────────────────────────────────────────────────────────────────────────────────────

function SessionBoot({ session, testPrefix }: { session: StoryBuildSession; testPrefix: string }): JSX.Element {
  const p = bootProgress(session.boot);
  return (
    <section data-testid={`${testPrefix}-boot`} className="mt-5 rounded-ui bg-ui-surface p-4" aria-live="polite">
      <h3 className="text-title text-ui-ink">Setting up the sandbox</h3>
      <p className="mt-0.5 text-meta text-ui-mute">
        {p.done > 0 ? `${p.done} step${p.done === 1 ? '' : 's'} done.` : 'Starting.'} The first session on this computer also gets the sandbox
        image, which takes longer.
      </p>
      <ol className="mt-3 space-y-1.5">
        {session.boot.map((s) => (
          <li key={s.key} data-testid={`${testPrefix}-boot-step`} data-step={s.key} data-state={s.state} className="flex items-start gap-2 text-body">
            <StepMark state={s.state} />
            <span className={cx('min-w-0', s.state === 'running' ? 'font-semibold text-ui-ink' : s.state === 'failed' ? 'text-ui-danger' : 'text-ui-ink')}>
              {s.label}
              {s.state === 'skipped' && <span className="text-ui-mute"> (not needed)</span>}
              {s.detail != null && <span className="block break-words text-meta font-normal text-ui-mute">{s.detail}</span>}
            </span>
          </li>
        ))}
      </ol>
      {session.notes.length > 0 && <Notes notes={session.notes} testPrefix={testPrefix} />}
    </section>
  );
}

function StepMark({ state }: { state: 'running' | 'done' | 'failed' | 'skipped' }): JSX.Element {
  const label = state === 'done' ? 'Done' : state === 'failed' ? 'Failed' : state === 'skipped' ? 'Skipped' : 'Running';
  return (
    <span className="mt-0.5 inline-flex h-4 w-4 shrink-0 items-center justify-center" role="img" aria-label={label}>
      {state === 'done' ? (
        <CheckIcon size={13} className="text-ui-success" />
      ) : state === 'failed' ? (
        <WarningIcon size={13} className="text-ui-danger" />
      ) : state === 'skipped' ? (
        <span className="decorative-mark h-1.5 w-1.5 rounded-full bg-ui-faint" />
      ) : (
        <span className="decorative-mark h-2 w-2 animate-pulse rounded-full bg-ui-accent-fill" />
      )}
    </span>
  );
}

function Notes({ notes, testPrefix }: { notes: string[]; testPrefix: string }): JSX.Element {
  return (
    <ul data-testid={`${testPrefix}-notes`} className="mt-3 space-y-0.5 text-meta text-ui-mute">
      {notes.map((n, i) => (
        <li key={i}>{n}</li>
      ))}
    </ul>
  );
}

// ── the conversation: drawn like the agent's own terminal ───────────────────────────────────────
//
// Claude Code's and Codex's terminal look, in the app's own tokens (every colour scheme, measured):
// a monospaced pane, a header box naming the agent, model and starting folder, the reader's words after
// a prompt mark, the agent's words and each tool call after a bullet, a tool's output under an elbow
// (its first lines; pressing the call's row shows the rest), and a spinner while a turn runs. The glyphs follow the
// session's provider. Words, test ids and data-kinds are the same as the chat look's.

interface TerminalGlyphs {
  /** The header box's first line. */
  title: string;
  /** Before the header title. */
  logo: string;
  prompt: string;
  bullet: string;
  elbow: string;
  /** What follows the tool's name on its row, as the agent's own terminal writes it. */
  args: (summary: string) => string;
}

const GLYPHS: Record<'claude' | 'codex', TerminalGlyphs> = {
  claude: {
    title: 'Claude Code',
    logo: '✻',
    prompt: '>',
    bullet: '⏺',
    elbow: '⎿',
    args: (summary) => (summary.trim() === '' ? '' : `(${summary})`),
  },
  codex: {
    title: 'Codex',
    logo: '>_',
    prompt: '›',
    bullet: '•',
    elbow: '└',
    args: (summary) => (summary.trim() === '' ? '' : ` ${summary}`),
  },
};

const glyphsFor = (provider: AiProviderId | null | undefined): TerminalGlyphs => GLYPHS[provider === 'codex' ? 'codex' : 'claude'];

/** A tool's output shows this many lines until the reader opens it. */
const TOOL_PREVIEW_LINES = 3;

/** Claude Code's spinner frames; Codex's is a pulse of its bullet. */
const SPINNER_FRAMES = ['·', '✢', '✳', '✶', '✻', '✽', '✻', '✶', '✳', '✢'];

function Conversation({ session, partials, c }: { session: StoryBuildSession; partials: ReadonlyMap<string, string>; c: Ctx }): JSX.Element {
  // Follow the newest output while the reader is at the bottom — a new row, a tool's output landing
  // in a row already drawn, words streaming in (hooks/useFollowBottom.ts watches the content, not a
  // dependency list). Scrolled up, nothing moves; back at the bottom, it follows again.
  const follow = useFollowBottom<HTMLDivElement>();
  const provider = session.provider ?? c.provider ?? null;
  const g = glyphsFor(provider);
  const live = [...partials.entries()].map(([id, t]) => [id, visiblePartialText(t)] as const).filter(([, t]) => t.trim() !== '');
  const running = sessionTurnRunning(session);
  return (
    <section aria-label="Conversation" className="relative rounded-ui bg-ui-surface font-mono text-body">
      {/* ⚠ `relative` IS LOAD-BEARING: the rows hold `sr-only` spans (position: absolute). In a scroll
          box that is not positioned, they belong to the PAGE's scroll area instead, at their place
          far down the conversation, and a long session made the whole build page scroll for
          thousands of pixels of nothing. Positioned, the box contains and clips them. */}
      <div
        ref={follow.ref}
        data-testid={`${c.testPrefix}-conversation`}
        data-terminal={provider === 'codex' ? 'codex' : 'claude'}
        className="relative max-h-[60vh] min-h-[12rem] overflow-y-auto overscroll-contain px-3 py-2.5"
        onScroll={follow.onScroll}
      >
        <TerminalHeader session={session} g={g} />
        {session.conversation.length === 0 && live.length === 0 && <p className="mt-3 text-ui-mute">{c.words.empty}</p>}
        <ol className="mt-3 space-y-3">
          {session.conversation.map((item) => (
            <ConversationRow key={item.id} item={item} provider={session.provider} g={g} c={c} />
          ))}
          {live.map(([id, text]) => (
            <li key={`live-${id}`} data-testid={`${c.testPrefix}-partial`} className="flex gap-2 text-ui-ink">
              <Bullet g={g} />
              <div className="min-w-0 flex-1 whitespace-pre-wrap break-words">{text}</div>
            </li>
          ))}
        </ol>
        {running && live.length === 0 && (
          <p data-testid={`${c.testPrefix}-working`} className="mt-3 flex gap-2 text-ai-signal">
            <Spinner g={g} />
            <span>{session.phase === 'building' ? 'Building and testing…' : 'Working…'}</span>
          </p>
        )}
      </div>
      {follow.away && (
        <button
          type="button"
          data-testid={`${c.testPrefix}-jump-latest`}
          className="hit absolute bottom-2 right-4 inline-flex items-center gap-1 rounded-ui bg-ui-raise px-2 py-1 font-sans text-meta font-medium text-ui-ink shadow ring-1 ring-ui-line hover:bg-ui-hover"
          onClick={follow.jump}
        >
          <ChevronIcon dir="down" size={11} />
          Jump to latest
        </button>
      )}
    </section>
  );
}

function TerminalHeader({ session, g }: { session: StoryBuildSession; g: TerminalGlyphs }): JSX.Element {
  const dir = session.startDir ?? session.repos[0]?.path ?? null;
  return (
    <div className="inline-block max-w-full rounded-ui border border-ui-line px-3 py-1.5">
      <div className="text-ui-ink">
        <span aria-hidden className="text-ai-signal">
          {g.logo}
        </span>{' '}
        <span className="font-semibold">{g.title}</span>
      </div>
      {session.model != null && (
        <div className="break-all text-ui-mute">
          model: <span className="text-ui-ink">{aiRunLabel(session.provider, session.model)}</span>
        </div>
      )}
      {dir != null && (
        <div className="break-all text-ui-mute">
          directory: <span className="text-ui-ink">{dir}</span>
        </div>
      )}
    </div>
  );
}

function Bullet({ g, className }: { g: TerminalGlyphs; className?: string }): JSX.Element {
  return (
    <span aria-hidden className={cx('decorative-mark w-[1.25ch] shrink-0 select-none text-center', className ?? 'text-ui-ink')}>
      {g.bullet}
    </span>
  );
}

function Spinner({ g }: { g: TerminalGlyphs }): JSX.Element {
  const [frame, setFrame] = useState(0);
  const claude = g === GLYPHS.claude;
  useEffect(() => {
    if (!claude || window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return;
    const t = window.setInterval(() => setFrame((f) => (f + 1) % SPINNER_FRAMES.length), 120);
    return () => window.clearInterval(t);
  }, [claude]);
  return (
    <span aria-hidden className={cx('w-[1.25ch] shrink-0 select-none text-center', !claude && 'motion-safe:animate-pulse')}>
      {claude ? SPINNER_FRAMES[frame] : g.bullet}
    </span>
  );
}

function ConversationRow({ item, provider, g, c }: { item: SandboxConversationItem; provider: StoryBuildSession['provider']; g: TerminalGlyphs; c: Ctx }): JSX.Element {
  const itemId = `${c.testPrefix}-item`;
  switch (item.kind) {
    case 'reader':
      return (
        <li data-testid={itemId} data-kind="reader" className="flex gap-2 rounded-ui bg-ui-raise px-1.5 py-1 text-ui-ink">
          <span aria-hidden className="w-[1.25ch] shrink-0 select-none text-center text-ui-mute">
            {g.prompt}
          </span>
          <div className="min-w-0 flex-1">
            {item.text !== '' && <div className="whitespace-pre-wrap break-words">{item.text}</div>}
            {item.build ? <div className="text-ui-mute">{c.words.readerBuildLabel}</div> : <span className="sr-only">You</span>}
          </div>
        </li>
      );
    case 'agent':
      return (
        <li data-testid={itemId} data-kind="agent" className="flex gap-2 text-ui-ink">
          <Bullet g={g} />
          <div className="min-w-0 flex-1">
            <Markdown>{item.text}</Markdown>
          </div>
        </li>
      );
    case 'tool':
      return <ToolRow item={item} itemId={itemId} g={g} />;
    case 'turn':
      return <TurnDivider item={item} provider={provider} itemId={itemId} />;
    case 'notice':
      return (
        <li data-testid={itemId} data-kind="notice" className="flex gap-2 text-ui-mute">
          <Bullet g={g} className="text-ui-mute" />
          <span className="min-w-0 flex-1 break-words">{item.text}</span>
        </li>
      );
    case 'error':
      return (
        <li data-testid={itemId} data-kind="error" className="flex gap-2 text-ui-danger">
          <Bullet g={g} className="text-ui-danger" />
          <span className="min-w-0 flex-1 break-words">{item.text}</span>
        </li>
      );
  }
}

function ToolRow({ item, itemId, g }: { item: Extract<SandboxConversationItem, { kind: 'tool' }>; itemId: string; g: TerminalGlyphs }): JSX.Element {
  const [open, setOpen] = useState(false);
  const outId = useId();
  const state = item.ok == null ? 'running' : item.ok ? 'ok' : 'failed';
  const lines = item.output == null ? [] : item.output.replace(/\n+$/, '').split('\n');
  const hidden = open ? 0 : Math.max(0, lines.length - TOOL_PREVIEW_LINES);
  const shown = open ? lines : lines.slice(0, TOOL_PREVIEW_LINES);
  return (
    <li data-testid={itemId} data-kind="tool" data-state={state}>
      <button
        type="button"
        className="hit flex w-full min-w-0 gap-2 rounded-ui text-left hover:bg-ui-hover disabled:hover:bg-transparent"
        aria-expanded={open}
        aria-controls={outId}
        disabled={item.output == null}
        onClick={() => setOpen((v) => !v)}
      >
        <Bullet g={g} className={state === 'failed' ? 'text-ui-danger' : state === 'ok' ? 'text-ui-success' : 'text-ui-mute motion-safe:animate-pulse'} />
        <span className="min-w-0 flex-1 break-all text-ui-ink">
          <span className="font-semibold">{item.tool}</span>
          {g.args(item.summary)}
        </span>
        <span className="sr-only">{state === 'running' ? 'Running' : state === 'failed' ? 'Failed' : 'Done'}</span>
      </button>
      {item.output != null && (
        <div id={outId} className="flex gap-2 text-ui-mute">
          <span aria-hidden className="w-[1.25ch] shrink-0 select-none text-right">
            {g.elbow}
          </span>
          <div className="min-w-0 flex-1">
            {state === 'failed' && <div className="text-ui-danger">Failed</div>}
            <pre className={cx('whitespace-pre-wrap break-words font-mono', open && 'max-h-64 overflow-auto')}>
              {item.output === '' ? '(no output)' : shown.join('\n')}
            </pre>
            {hidden > 0 && <div>… +{hidden} line{hidden === 1 ? '' : 's'}</div>}
          </div>
        </div>
      )}
    </li>
  );
}

function TurnDivider({ item, provider, itemId }: { item: Extract<SandboxConversationItem, { kind: 'turn' }>; provider: StoryBuildSession['provider']; itemId: string }): JSX.Element {
  const costText = useRunCostText();
  const cost = costText(item.costUsd, provider);
  return (
    <li data-testid={itemId} data-kind="turn" className="flex items-center gap-2 text-ui-mute">
      <span aria-hidden className="decorative-mark h-px flex-1 border-t border-dashed border-ui-line" />
      <span>
        {item.mode === 'build' ? 'Build turn' : 'Turn'} {item.turn}: {turnOutcomeWords(item.outcome)}
        {cost != null && ` · ${cost}`}
      </span>
      <span aria-hidden className="decorative-mark h-px flex-1 border-t border-dashed border-ui-line" />
    </li>
  );
}

// ── the composer: Send, Start build / Start fix, Stop, Resume ──────────────────────────────────

function actionErrorText(err: unknown): string | null {
  if (err == null) return null;
  return sessionErrorText(err instanceof ApiError ? err : { message: (err as Error).message });
}

function Composer({ session, c, extra }: { session: StoryBuildSession; c: Ctx; extra?: ReactNode }): JSX.Element {
  const [text, setText] = useState('');
  const send = c.actions.useSend();
  const start = c.actions.useStartBuild();
  const stop = c.actions.useStop();
  const resume = c.actions.useResume();
  const busy = useIsMutating({ mutationKey: [...c.actions.busyKey] }) > 0;
  const provider = session.provider ?? c.provider ?? null;
  const canSend = sessionCanSend(session);
  const canBuild = sessionCanStartBuild(session);
  const running = sessionTurnRunning(session);
  const trimmed = text.trim();
  const tooLong = trimmed.length > SANDBOX_MESSAGE_MAX;
  const errText = actionErrorText([send.error, start.error, stop.error, resume.error].find((e) => e != null) ?? null);
  const a = (name: string): Record<string, string> => act(c.actionAttr, name);
  const doSend = (): void => {
    if (!canSend || busy || trimmed === '' || tooLong) return;
    send.run(trimmed, () => setText(''));
  };
  const sendButton = (
    <Button size="sm" data-ai-run {...a('send')} disabled={!canSend || busy || trimmed === '' || tooLong} onClick={doSend}>
      Send
    </Button>
  );
  if (!session.live) {
    return (
      <div data-testid={`${c.testPrefix}-closed`} className="mt-3 flex flex-wrap items-center gap-2 text-meta text-ui-mute">
        <span>The sandbox is closed.</span>
        {session.resumable && (
          <AiRunGate kind={c.words.gate.build} followUp provider={provider}>
            <Button size="sm" data-ai-run {...a('resume')} disabled={busy} onClick={() => resume.run()}>
              Resume
            </Button>
          </AiRunGate>
        )}
        {session.resumable && <span>{c.words.resumeNote}</span>}
        {extra}
        {errText != null && <span className="text-ui-danger">{errText}</span>}
      </div>
    );
  }
  return (
    <div data-testid={`${c.testPrefix}-composer`} className="mt-3 space-y-2">
      <div className="flex gap-2 rounded-ui bg-ui-surface px-2.5 py-1.5 font-mono text-body ring-1 ring-inset ring-ui-line focus-within:ring-2 focus-within:ring-ui-accent">
        <span aria-hidden className="w-[1.25ch] shrink-0 select-none text-center leading-normal text-ui-mute">
          {glyphsFor(provider).prompt}
        </span>
        <textarea
          aria-label={session.mode === 'build' ? 'Message the agent (it can change the code)' : 'Message the agent'}
          className="min-w-0 flex-1 resize-y bg-transparent leading-normal text-ui-ink placeholder:text-ui-faint focus:outline-none"
          rows={3}
          placeholder={session.mode === 'build' ? c.words.buildPlaceholder : c.words.chatPlaceholder}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              doSend();
            }
          }}
        />
      </div>
      <div className="flex flex-wrap items-center gap-2">
        {/* A message after Start build / Start fix is a BUILD turn: the gate reads that kind's answer. */}
        {session.mode === 'build' ? (
          <AiRunGate kind={c.words.gate.build} followUp provider={provider} meter={false}>
            {sendButton}
          </AiRunGate>
        ) : (
          <AiRunGate kind={c.words.gate.chat} followUp provider={provider} meter={false}>
            {sendButton}
          </AiRunGate>
        )}
        {canBuild && (
          <AiRunGate kind={c.words.gate.build} followUp provider={provider}>
            <Button
              variant="primary"
              size="sm"
              data-ai-run
              {...a('build')}
              icon={<WrenchIcon size={12} />}
              disabled={busy || tooLong}
              title={c.words.startBuildTitle}
              onClick={() => start.run(trimmed, () => setText(''))}
            >
              {c.words.startBuild}
            </Button>
          </AiRunGate>
        )}
        {running && (
          <Button size="sm" variant="secondary" icon={<CloseIcon size={11} />} {...a('stop')} disabled={stop.pending} onClick={() => stop.run()}>
            Stop
          </Button>
        )}
        {extra}
        {tooLong && <span className="text-meta text-ui-warn">Keep it under {SANDBOX_MESSAGE_MAX.toLocaleString('en-GB')} characters.</span>}
        {session.idleCloseAt != null && !running && (
          <span className="text-meta text-ui-mute">Closes at {dateTime(session.idleCloseAt)} if nothing happens. The changes are kept.</span>
        )}
        {errText != null && <span className="text-meta text-ui-danger">{errText}</span>}
      </div>
    </div>
  );
}

// ── the rail ───────────────────────────────────────────────────────────────────────────────────

export function RailSection({ title, testId, children, end }: { title: string; testId: string; children: ReactNode; end?: ReactNode }): JSX.Element {
  return (
    <section data-testid={testId} className="rounded-ui bg-ui-surface p-3">
      <div className="mb-1.5 flex items-center justify-between gap-2">
        <h4 className={REVIEW_SUBHEAD}>{title}</h4>
        {end}
      </div>
      {children}
    </section>
  );
}

function ReposPanel({ session, testPrefix, repoStatus }: { session: StoryBuildSession; testPrefix: string; repoStatus: (r: SandboxSessionRepo) => SessionRepoStatus }): JSX.Element {
  return (
    <RailSection title={`Repositories (${session.repos.length})`} testId={`${testPrefix}-repos`}>
      <ul className="space-y-1.5 text-meta">
        {session.repos.map((r) => {
          const st = repoStatus(r);
          return (
            <li key={r.repoId} data-repo={r.fullName}>
              <div className="flex items-baseline justify-between gap-2">
                <span className="min-w-0 truncate font-medium text-ui-ink">{r.fullName}</span>
                <span className="shrink-0 text-ui-mute">{st.status}</span>
              </div>
              <div className="break-all font-mono text-ui-mute">{r.path}</div>
              <div className="text-ui-mute">
                <span className="font-mono">{r.branch}</span> from <span className="font-mono">{r.baseSha.slice(0, 7)}</span>
              </div>
              {st.note != null && <div className="text-ui-mute">{st.note}</div>}
            </li>
          );
        })}
      </ul>
      {session.startDir != null && (
        <p className="mt-1.5 text-meta text-ui-mute">
          Starts in <span className="break-all font-mono">{session.startDir}</span>
        </p>
      )}
      {session.notes.length > 0 && <Notes notes={session.notes} testPrefix={testPrefix} />}
    </RailSection>
  );
}

const SERVICE_STATE_WORDS: Record<string, string> = {
  stopped: 'Not started',
  starting: 'Starting',
  running: 'Running',
  stopping: 'Stopping',
  failed: 'Failed',
  refused: 'Refused',
};

function ServicesPanel({ session, testPrefix }: { session: StoryBuildSession; testPrefix: string }): JSX.Element {
  const openSettings = useSettingsModal((s) => s.openSettings);
  const stacks = session.services?.stacks ?? [];
  return (
    <RailSection title="Services" testId={`${testPrefix}-services`}>
      {stacks.length === 0 ? (
        <p className="text-meta text-ui-mute">
          None picked.{' '}
          <button type="button" className="hit font-medium text-ui-ink underline underline-offset-2" onClick={() => openSettings('sandbox')}>
            Pick compose files
          </button>{' '}
          for integration tests.
        </p>
      ) : (
        <ul className="space-y-1.5 text-meta">
          {stacks.map((s) => (
            <li key={s.key} data-state={s.state}>
              <div className="flex items-baseline justify-between gap-2">
                <span className="min-w-0 truncate font-mono text-ui-ink">{s.from}</span>
                <span className={cx('shrink-0', s.state === 'failed' || s.state === 'refused' ? 'text-ui-danger' : 'text-ui-mute')}>
                  {SERVICE_STATE_WORDS[s.state] ?? s.state}
                </span>
              </div>
              {s.services.length > 0 && <div className="text-ui-mute">{s.services.join(', ')}</div>}
              {s.reasons.map((r, i) => (
                <div key={`r${i}`} className="text-ui-danger">
                  {r}
                </div>
              ))}
              {s.notes.map((n, i) => (
                <div key={`n${i}`} className="text-ui-mute">
                  {n}
                </div>
              ))}
            </li>
          ))}
        </ul>
      )}
      {stacks.length > 0 && <p className="mt-1.5 text-meta text-ui-mute">The agent starts them with limn-svc when it needs them.</p>}
    </RailSection>
  );
}

function NetworkPanel({ session, c }: { session: StoryBuildSession; c: Ctx }): JSX.Element {
  const rows = useMemo(() => networkRows(session.network), [session.network]);
  const blocked = rows.filter((r) => !r.allowed).length;
  return (
    <RailSection
      title="Network"
      testId={`${c.testPrefix}-network`}
      end={blocked > 0 ? <span className="text-meta font-medium text-ui-warn">{blocked} blocked</span> : undefined}
    >
      {session.credentialLine != null && <p className="mb-1.5 text-meta text-ui-mute">{session.credentialLine}</p>}
      {rows.length === 0 ? (
        <p className="text-meta text-ui-mute">No requests yet.</p>
      ) : (
        <ul className="space-y-1.5">
          {rows.map((e) => (
            <NetworkRow key={e.key} entry={e} live={session.live} c={c} />
          ))}
        </ul>
      )}
    </RailSection>
  );
}

function NetworkRow({ entry, live, c }: { entry: SandboxNetworkEntry; live: boolean; c: Ctx }): JSX.Element {
  // One handle per row: "Allowed." shows on the row that was pressed.
  const allow = c.actions.useAllow();
  const rule = networkAllowRule(entry);
  const err = allow.error instanceof Error ? allow.error.message : null;
  return (
    <li data-testid={`${c.testPrefix}-network-row`} data-allowed={entry.allowed} className="text-meta">
      <div className="flex items-baseline justify-between gap-2">
        <span className="min-w-0 truncate font-mono text-ui-ink" title={`${entry.host}:${entry.port}`}>
          {entry.host}
          {entry.port !== 443 && <span className="text-ui-mute">:{entry.port}</span>}
        </span>
        <span className={cx('shrink-0', entry.allowed ? 'text-ui-mute' : 'font-medium text-ui-warn')}>{entry.allowed ? 'Allowed' : 'Blocked'}</span>
      </div>
      <div className="text-ui-mute">
        {entry.count} request{entry.count === 1 ? '' : 's'}
        {entry.allowed && entry.down + entry.up > 0 && ` · ${shortBytes(entry.down + entry.up)}`}
        {entry.source != null && ` · from ${entry.source}`}
        {!entry.allowed && entry.reason != null && ` · ${entry.reason}`}
      </div>
      {!entry.allowed && live && (
        <div className="mt-1 flex flex-wrap gap-1.5">
          <Button size="sm" variant="secondary" disabled={allow.pending || allow.succeeded} onClick={() => allow.run({ rule, scope: 'session' })}>
            Allow for this session
          </Button>
          <Button size="sm" variant="ghost" disabled={allow.pending || allow.succeeded} onClick={() => allow.run({ rule, scope: 'workspace' })}>
            Always allow
          </Button>
        </div>
      )}
      {allow.succeeded && <div className="mt-0.5 text-ui-mute">Allowed. The next request goes through.</div>}
      {err != null && <div className="mt-0.5 text-ui-danger">{err}</div>}
    </li>
  );
}

function SpendPanel({ session, c }: { session: StoryBuildSession; c: Ctx }): JSX.Element {
  const costText = useRunCostText();
  const cost = costText(session.spend.costUsd, session.provider ?? c.provider ?? null);
  const tokens = session.spend.inputTokens + session.spend.outputTokens;
  return (
    <RailSection title="Spend" testId={`${c.testPrefix}-spend`}>
      <p data-testid={`${c.testPrefix}-spend-line`} className="text-meta text-ui-mute">
        {cost != null && <span className="text-ui-ink">{cost} · </span>}
        {session.spend.turns} turn{session.spend.turns === 1 ? '' : 's'}
        {tokens > 0 && ` · ${tokens.toLocaleString('en-GB')} tokens`}
      </p>
      {session.runtimeNote != null && <p className="mt-1 text-meta text-ui-mute">{session.runtimeNote}</p>}
    </RailSection>
  );
}
