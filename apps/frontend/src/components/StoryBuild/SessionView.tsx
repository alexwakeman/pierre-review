import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react';
import { useIsMutating } from '@tanstack/react-query';
import {
  SANDBOX_MESSAGE_MAX,
  aiProviderName,
  aiRunLabel,
  type SandboxConversationItem,
  type SandboxNetworkEntry,
  type StoryBuild,
  type StoryBuildSession,
} from '@pierre-review/shared';
import { ApiError } from '../../api/client.js';
import { useRunCostText } from '../../hooks/useAiBudget.js';
import {
  storyBuildMutationKey,
  useStorySessionAllow,
  useStorySessionBuild,
  useStorySessionInterrupt,
  useStorySessionMessage,
  useStorySessionResume,
} from '../../hooks/useStoryBuild.js';
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
} from '../../lib/sandboxSession.js';
import { storyBuildRefAnchor } from '../../lib/storyBuild.js';
import { CHAT_AI_BUBBLE, CHAT_AI_LABEL, CHAT_AI_ROW, CHAT_YOU_BUBBLE, CHAT_YOU_LABEL, CHAT_YOU_ROW, REVIEW_SUBHEAD } from '../../lib/reviewStyles.js';
import { dateTime } from '../../lib/ui.js';
import { useSettingsModal } from '../../store/settingsModal.js';
import { AiRunGate } from '../AiSetup.js';
import { CheckIcon, ChevronIcon, CloseIcon, WarningIcon, WrenchIcon } from '../Icons.js';
import { Markdown } from '../Markdown.js';
import { Button } from '../ui/Button.js';
import { cx } from '../ui/cx.js';

// THE SESSION (docs/SANDBOX.md § Sessions; docs/FRONTEND.md § The build tab). While it boots: each boot
// step. Then two panes: the CONVERSATION (the reader on the right, the agent on the left — the review
// chat's look, lib/reviewStyles.ts CHAT_* — tool calls as compact rows that open to their output, the
// agent's words as they arrive) with the composer, Start build and Stop under it; and the RAIL: Ticket,
// Repositories, Services, Network (with the Allow buttons), Spend. The per-repository diffs and Push sit
// under both (BuildSection). Nothing here pushes, and every billed press sits inside the ONE AiRunGate.

export function SessionView({
  build,
  session,
  partials,
}: {
  build: StoryBuild;
  session: StoryBuildSession;
  /** The agent's words still arriving, by message id (the stream fold). */
  partials: ReadonlyMap<string, string>;
}): JSX.Element {
  if (session.phase === 'booting') return <SessionBoot session={session} />;
  return (
    <div data-testid="story-session" data-phase={session.phase} data-live={session.live} className="mt-5 grid gap-4 lg:grid-cols-[minmax(0,1fr)_19rem]">
      <div className="min-w-0">
        <Conversation session={session} partials={partials} />
        <Composer build={build} session={session} />
      </div>
      <SessionRail build={build} session={session} />
    </div>
  );
}

// ── the boot ────────────────────────────────────────────────────────────────────────────────────

function SessionBoot({ session }: { session: StoryBuildSession }): JSX.Element {
  const p = bootProgress(session.boot);
  return (
    <section data-testid="story-session-boot" className="mt-5 rounded-ui bg-ui-surface p-4" aria-live="polite">
      <h3 className="text-title text-ui-ink">Setting up the sandbox</h3>
      <p className="mt-0.5 text-meta text-ui-mute">
        {p.done > 0 ? `${p.done} step${p.done === 1 ? '' : 's'} done.` : 'Starting.'} The first session on this computer also gets the sandbox
        image, which takes longer.
      </p>
      <ol className="mt-3 space-y-1.5">
        {session.boot.map((s) => (
          <li key={s.key} data-testid="story-session-boot-step" data-step={s.key} data-state={s.state} className="flex items-start gap-2 text-body">
            <StepMark state={s.state} />
            <span className={cx('min-w-0', s.state === 'running' ? 'font-semibold text-ui-ink' : s.state === 'failed' ? 'text-ui-danger' : 'text-ui-ink')}>
              {s.label}
              {s.state === 'skipped' && <span className="text-ui-mute"> (not needed)</span>}
              {s.detail != null && <span className="block break-words text-meta font-normal text-ui-mute">{s.detail}</span>}
            </span>
          </li>
        ))}
      </ol>
      {session.notes.length > 0 && <Notes notes={session.notes} />}
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

function Notes({ notes }: { notes: string[] }): JSX.Element {
  return (
    <ul data-testid="story-session-notes" className="mt-3 space-y-0.5 text-meta text-ui-mute">
      {notes.map((n, i) => (
        <li key={i}>{n}</li>
      ))}
    </ul>
  );
}

// ── the conversation ───────────────────────────────────────────────────────────────────────────

function Conversation({ session, partials }: { session: StoryBuildSession; partials: ReadonlyMap<string, string> }): JSX.Element {
  const scroller = useRef<HTMLDivElement | null>(null);
  const pinned = useRef(true);
  const who = session.model != null ? aiRunLabel(session.provider, session.model) : aiProviderName(session.provider ?? 'claude');
  const live = [...partials.entries()].filter(([, t]) => t.trim() !== '');
  const running = sessionTurnRunning(session);
  // Follow the newest row while the reader is at the bottom; leave them where they are once they scroll up.
  const size = session.conversation.length + live.reduce((n, [, t]) => n + t.length, 0);
  useEffect(() => {
    const el = scroller.current;
    if (el != null && pinned.current) el.scrollTop = el.scrollHeight;
  }, [size, running]);
  return (
    <section aria-label="Conversation" className="rounded-ui bg-ui-surface">
      <div
        ref={scroller}
        data-testid="story-session-conversation"
        className="max-h-[60vh] min-h-[12rem] overflow-y-auto p-3"
        onScroll={(e) => {
          const el = e.currentTarget;
          pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
        }}
      >
        {session.conversation.length === 0 && live.length === 0 && (
          <p className="text-meta text-ui-mute">
            The agent has read the ticket and the repositories. Ask it for a plan, a question answered, or where to look first.
          </p>
        )}
        <ol className="space-y-2.5">
          {session.conversation.map((item) => (
            <ConversationRow key={item.id} item={item} who={who} provider={session.provider} />
          ))}
          {live.map(([id, text]) => (
            <li key={`live-${id}`} className={CHAT_AI_ROW}>
              <div className={CHAT_AI_BUBBLE} data-chat-role="assistant" data-testid="story-session-partial">
                <div className={CHAT_AI_LABEL}>{who}</div>
                <div className="whitespace-pre-wrap">{text}</div>
              </div>
            </li>
          ))}
        </ol>
        {running && live.length === 0 && (
          <p data-testid="story-session-working" className="mt-2 text-meta text-ai-signal">
            {session.phase === 'building' ? 'Building and testing…' : 'Working…'}
          </p>
        )}
      </div>
    </section>
  );
}

function ConversationRow({ item, who, provider }: { item: SandboxConversationItem; who: string; provider: StoryBuildSession['provider'] }): JSX.Element {
  switch (item.kind) {
    case 'reader':
      return (
        <li className={CHAT_YOU_ROW} data-testid="story-session-item" data-kind="reader">
          <div className={CHAT_YOU_BUBBLE} data-chat-role="user">
            <div className={CHAT_YOU_LABEL}>{item.build ? 'You · Start build' : 'You'}</div>
            <div className="whitespace-pre-wrap">{item.text}</div>
          </div>
        </li>
      );
    case 'agent':
      return (
        <li className={CHAT_AI_ROW} data-testid="story-session-item" data-kind="agent">
          <div className={CHAT_AI_BUBBLE} data-chat-role="assistant">
            <div className={CHAT_AI_LABEL}>{who}</div>
            <Markdown>{item.text}</Markdown>
          </div>
        </li>
      );
    case 'tool':
      return <ToolRow item={item} />;
    case 'turn':
      return <TurnDivider item={item} provider={provider} />;
    case 'notice':
      return (
        <li data-testid="story-session-item" data-kind="notice" className="text-meta text-ui-mute">
          {item.text}
        </li>
      );
    case 'error':
      return (
        <li data-testid="story-session-item" data-kind="error" className="flex items-start gap-1.5 text-meta text-ui-danger">
          <WarningIcon size={12} className="mt-0.5 shrink-0" />
          <span>{item.text}</span>
        </li>
      );
  }
}

function ToolRow({ item }: { item: Extract<SandboxConversationItem, { kind: 'tool' }> }): JSX.Element {
  const [open, setOpen] = useState(false);
  const outId = useId();
  const state = item.ok == null ? 'running' : item.ok ? 'ok' : 'failed';
  return (
    <li data-testid="story-session-item" data-kind="tool" data-state={state} className="text-meta">
      <button
        type="button"
        className="hit flex w-full min-w-0 items-center gap-1.5 rounded-ui px-1 py-0.5 text-left text-ui-mute hover:bg-ui-hover hover:text-ui-ink"
        aria-expanded={open}
        aria-controls={outId}
        disabled={item.output == null}
        onClick={() => setOpen((v) => !v)}
      >
        <ChevronIcon dir={open ? 'down' : 'right'} />
        <span className="shrink-0 font-mono font-medium text-ui-ink">{item.tool}</span>
        <span className="min-w-0 flex-1 truncate font-mono">{item.summary}</span>
        <span className={cx('shrink-0', state === 'failed' ? 'text-ui-danger' : 'text-ui-mute')}>
          {state === 'running' ? 'Running' : state === 'failed' ? 'Failed' : <CheckIcon size={11} />}
        </span>
      </button>
      {open && item.output != null && (
        <pre id={outId} className="mt-1 max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-ui bg-ui-raise p-2 font-mono text-meta text-ui-ink">
          {item.output === '' ? '(no output)' : item.output}
        </pre>
      )}
    </li>
  );
}

function TurnDivider({ item, provider }: { item: Extract<SandboxConversationItem, { kind: 'turn' }>; provider: StoryBuildSession['provider'] }): JSX.Element {
  const costText = useRunCostText();
  const cost = costText(item.costUsd, provider);
  return (
    <li data-testid="story-session-item" data-kind="turn" className="flex items-center gap-2 text-meta text-ui-mute">
      <span aria-hidden className="decorative-mark h-px flex-1 bg-ui-line" />
      <span>
        {item.mode === 'build' ? 'Build turn' : 'Turn'} {item.turn}: {turnOutcomeWords(item.outcome)}
        {cost != null && ` · ${cost}`}
      </span>
      <span aria-hidden className="decorative-mark h-px flex-1 bg-ui-line" />
    </li>
  );
}

// ── the composer: Send, Start build, Stop, Resume ───────────────────────────────────────────────

function Composer({ build, session }: { build: StoryBuild; session: StoryBuildSession }): JSX.Element {
  const [text, setText] = useState('');
  const send = useStorySessionMessage(build.workspaceId, build.ident);
  const start = useStorySessionBuild(build.workspaceId, build.ident);
  const stop = useStorySessionInterrupt(build.workspaceId, build.ident);
  const resume = useStorySessionResume(build.workspaceId, build.ident);
  const busy = useIsMutating({ mutationKey: storyBuildMutationKey(build.ident) }) > 0;
  const provider = session.provider ?? build.provider ?? null;
  const canSend = sessionCanSend(session);
  const canBuild = sessionCanStartBuild(session);
  const running = sessionTurnRunning(session);
  const trimmed = text.trim();
  const tooLong = trimmed.length > SANDBOX_MESSAGE_MAX;
  const err = [send.error, start.error, stop.error, resume.error].find((e) => e != null) ?? null;
  const errText = err == null ? null : sessionErrorText(err instanceof ApiError ? err : { message: (err as Error).message });
  const doSend = (): void => {
    if (!canSend || busy || trimmed === '' || tooLong) return;
    send.mutate({ id: build.id, text: trimmed }, { onSuccess: () => setText('') });
  };
  const sendButton = (
    <Button size="sm" data-ai-run data-story-build-action="send" disabled={!canSend || busy || trimmed === '' || tooLong} onClick={doSend}>
      Send
    </Button>
  );
  if (!session.live) {
    return (
      <div data-testid="story-session-closed" className="mt-3 flex flex-wrap items-center gap-2 text-meta text-ui-mute">
        <span>The sandbox is closed.</span>
        {session.resumable && (
          <AiRunGate kind="story_build" followUp provider={provider}>
            <Button size="sm" data-ai-run data-story-build-action="resume" disabled={busy} onClick={() => resume.mutate(build.id)}>
              Resume
            </Button>
          </AiRunGate>
        )}
        {session.resumable && <span>Resume starts a new sandbox with these changes. The agent does not remember the conversation.</span>}
        {errText != null && <span className="text-ui-danger">{errText}</span>}
      </div>
    );
  }
  return (
    <div data-testid="story-session-composer" className="mt-3 space-y-2">
      <textarea
        aria-label={session.mode === 'build' ? 'Message the agent (it can change the code)' : 'Message the agent'}
        className="w-full resize-y rounded-ui bg-ui-surface px-2.5 py-1.5 text-body leading-normal text-ui-ink ring-1 ring-inset ring-ui-line placeholder:text-ui-faint focus:outline-none focus:ring-2 focus:ring-ui-accent"
        rows={3}
        placeholder={session.mode === 'build' ? 'Ask for a change. It is a build turn: the agent may edit and test.' : 'Ask for a plan, a question answered, or where to look first.'}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            doSend();
          }
        }}
      />
      <div className="flex flex-wrap items-center gap-2">
        {/* A message after Start build is a BUILD turn: the gate reads that kind's answer. */}
        {session.mode === 'build' ? (
          <AiRunGate kind="story_build" followUp provider={provider} meter={false}>
            {sendButton}
          </AiRunGate>
        ) : (
          <AiRunGate kind="story_plan" followUp provider={provider} meter={false}>
            {sendButton}
          </AiRunGate>
        )}
        {canBuild && (
          <AiRunGate kind="story_build" followUp provider={provider}>
            <Button
              variant="primary"
              size="sm"
              data-ai-run
              data-story-build-action="build"
              icon={<WrenchIcon size={12} />}
              disabled={busy || tooLong}
              title="The agent changes the code and runs the tests. The words in the box go with it."
              onClick={() => start.mutate({ id: build.id, text: trimmed }, { onSuccess: () => setText('') })}
            >
              Start build
            </Button>
          </AiRunGate>
        )}
        {running && (
          <Button size="sm" variant="secondary" icon={<CloseIcon size={11} />} data-story-build-action="stop" disabled={stop.isPending} onClick={() => stop.mutate(build.id)}>
            Stop
          </Button>
        )}
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

function RailSection({ title, testId, children, end }: { title: string; testId: string; children: ReactNode; end?: ReactNode }): JSX.Element {
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

function SessionRail({ build, session }: { build: StoryBuild; session: StoryBuildSession }): JSX.Element {
  return (
    <aside aria-label="Session" className="min-w-0 space-y-3">
      <TicketPanel session={session} />
      <ReposPanel build={build} session={session} />
      <ServicesPanel session={session} />
      <NetworkPanel build={build} session={session} />
      <SpendPanel build={build} session={session} />
    </aside>
  );
}

function TicketPanel({ session }: { session: StoryBuildSession }): JSX.Element {
  const t = session.ticket;
  return (
    <RailSection title="Ticket" testId="story-session-ticket">
      {t.criteria.length === 0 ? (
        <p className="text-meta text-ui-mute">No numbered criteria. The agent has the description.</p>
      ) : (
        <ol className="space-y-1 text-meta text-ui-ink">
          {t.criteria.map((c) => {
            const ref = /^(AC\d+):/.exec(c)?.[1] ?? null;
            return (
              <li key={c} id={ref != null ? storyBuildRefAnchor(ref) : undefined} className="break-words">
                {ref != null ? (
                  <>
                    <span className="font-mono text-ui-mute">{ref}</span>
                    {c.slice(ref.length + 1)}
                  </>
                ) : (
                  c
                )}
              </li>
            );
          })}
        </ol>
      )}
      {t.openPoints.length > 0 && (
        <>
          <h5 className="mt-2 text-meta font-semibold text-ui-ink">Open points ({t.openPoints.length})</h5>
          <ul className="mt-0.5 list-disc space-y-0.5 pl-4 text-meta text-ui-ink">
            {t.openPoints.map((p, i) => (
              <li key={i} className="break-words">
                {p}
              </li>
            ))}
          </ul>
        </>
      )}
    </RailSection>
  );
}

function ReposPanel({ build, session }: { build: StoryBuild; session: StoryBuildSession }): JSX.Element {
  const byId = new Map(build.repos.map((r) => [r.repoId, r] as const));
  return (
    <RailSection title={`Repositories (${session.repos.length})`} testId="story-session-repos">
      <ul className="space-y-1.5 text-meta">
        {session.repos.map((r) => {
          const row = byId.get(r.repoId);
          const changed = row?.filesChanged.length ?? 0;
          return (
            <li key={r.repoId} data-repo={r.fullName}>
              <div className="flex items-baseline justify-between gap-2">
                <span className="min-w-0 truncate font-medium text-ui-ink">{r.fullName}</span>
                <span className="shrink-0 text-ui-mute">
                  {row?.status === 'pushed' ? 'Pushed' : changed > 0 ? `${changed} file${changed === 1 ? '' : 's'} changed` : 'No changes yet'}
                </span>
              </div>
              <div className="break-all font-mono text-ui-mute">{r.path}</div>
              <div className="text-ui-mute">
                <span className="font-mono">{r.branch}</span> from <span className="font-mono">{r.baseSha.slice(0, 7)}</span>
              </div>
            </li>
          );
        })}
      </ul>
      {session.startDir != null && (
        <p className="mt-1.5 text-meta text-ui-mute">
          Starts in <span className="break-all font-mono">{session.startDir}</span>
        </p>
      )}
      {session.notes.length > 0 && <Notes notes={session.notes} />}
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

function ServicesPanel({ session }: { session: StoryBuildSession }): JSX.Element {
  const openSettings = useSettingsModal((s) => s.openSettings);
  const stacks = session.services?.stacks ?? [];
  return (
    <RailSection title="Services" testId="story-session-services">
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

function NetworkPanel({ build, session }: { build: StoryBuild; session: StoryBuildSession }): JSX.Element {
  const rows = useMemo(() => networkRows(session.network), [session.network]);
  const blocked = rows.filter((r) => !r.allowed).length;
  return (
    <RailSection
      title="Network"
      testId="story-session-network"
      end={blocked > 0 ? <span className="text-meta font-medium text-ui-warn">{blocked} blocked</span> : undefined}
    >
      {session.credentialLine != null && <p className="mb-1.5 text-meta text-ui-mute">{session.credentialLine}</p>}
      {rows.length === 0 ? (
        <p className="text-meta text-ui-mute">No requests yet.</p>
      ) : (
        <ul className="space-y-1.5">
          {rows.map((e) => (
            <NetworkRow key={e.key} build={build} entry={e} live={session.live} />
          ))}
        </ul>
      )}
    </RailSection>
  );
}

function NetworkRow({ build, entry, live }: { build: StoryBuild; entry: SandboxNetworkEntry; live: boolean }): JSX.Element {
  const allow = useStorySessionAllow(build.workspaceId, build.ident);
  const rule = networkAllowRule(entry);
  const err = allow.error instanceof Error ? allow.error.message : null;
  return (
    <li data-testid="story-session-network-row" data-allowed={entry.allowed} className="text-meta">
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
          <Button size="sm" variant="secondary" disabled={allow.isPending || allow.isSuccess} onClick={() => allow.mutate({ id: build.id, body: { rule, scope: 'session' } })}>
            Allow for this session
          </Button>
          <Button size="sm" variant="ghost" disabled={allow.isPending || allow.isSuccess} onClick={() => allow.mutate({ id: build.id, body: { rule, scope: 'workspace' } })}>
            Always allow
          </Button>
        </div>
      )}
      {allow.isSuccess && <div className="mt-0.5 text-ui-mute">Allowed. The next request goes through.</div>}
      {err != null && <div className="mt-0.5 text-ui-danger">{err}</div>}
    </li>
  );
}

function SpendPanel({ build, session }: { build: StoryBuild; session: StoryBuildSession }): JSX.Element {
  const costText = useRunCostText();
  const cost = costText(session.spend.costUsd, session.provider ?? build.provider ?? null);
  const tokens = session.spend.inputTokens + session.spend.outputTokens;
  return (
    <RailSection title="Spend" testId="story-session-spend">
      <p data-testid="story-session-spend-line" className="text-meta text-ui-mute">
        {cost != null && <span className="text-ui-ink">{cost} · </span>}
        {session.spend.turns} turn{session.spend.turns === 1 ? '' : 's'}
        {tokens > 0 && ` · ${tokens.toLocaleString('en-GB')} tokens`}
      </p>
      {session.runtimeNote != null && <p className="mt-1 text-meta text-ui-mute">{session.runtimeNote}</p>}
    </RailSection>
  );
}
