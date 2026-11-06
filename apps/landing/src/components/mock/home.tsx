import { useState } from 'react';
import type { ReactNode } from 'react';
import {
  ACTIONS,
  ARM,
  BOT_WORTH,
  CI_FAILURE,
  CONFLICTS,
  CONFLICT_WORDS,
  COURTS,
  FINDINGS,
  FIX,
  FIX_DIFF,
  PENDING,
  PRS,
  PR_VIEW,
  STORY,
  TRUNKS,
  VERDICT,
  pendingTabCount,
  prLabel,
} from '../../mock/acme';
import type { PendingCardId, PendingTabId, PrTabId } from '../../mock/acme';
import {
  Act,
  CheckRow,
  Chip,
  CourtBar,
  Diff,
  FindingRow,
  Group,
  HBar,
  Log,
  MiniTable,
  MockFrame,
  MockTabs,
  PrRow,
  useAction,
} from './kit';

// The home page's mocks, one per feature. Words and numbers: src/mock/acme.ts.
// Each LIVE mock starts in the state the prerendered HTML shows; the app
// surface it mirrors is listed in apps/landing/README.md.

const { refunds, settings, ledgerRename } = PRS;

// ---- small shared pieces -------------------------------------------------------

/** A button that runs once: idle label → busy label → a done chip. */
function RunButton({
  words,
  tone,
  doneTone = 'green',
}: {
  words: { idle: string; busy: string; done: string };
  tone?: 'go' | 'gold';
  doneTone?: 'green' | 'grey';
}): JSX.Element {
  const a = useAction();
  if (a.phase === 'done') {
    return (
      <span role="status">
        <Chip tone={doneTone}>{words.done}</Chip>
      </span>
    );
  }
  return (
    <Act tone={tone} onClick={() => a.run()} disabled={a.phase === 'busy'}>
      {a.phase === 'busy' ? words.busy : words.idle}
    </Act>
  );
}

function ReviewFindings(): JSX.Element {
  return (
    <>
      {FINDINGS.review.map((f) => (
        <FindingRow key={f.sev} chip={f.sev} tone={f.tone}>
          <small className="mk-by">{f.by}</small>
          {f.sev === 'Nit' ? (
            <>
              {f.text} <code>{f.code}</code>.
            </>
          ) : f.code ? (
            <>
              <code>{f.code}</code> {f.text}
            </>
          ) : (
            f.text
          )}
        </FindingRow>
      ))}
    </>
  );
}

/** The AI Review tab's findings: "Open", then a collapsed "Resolved or addressed (n)" saying why. */
function ReviewFindingsByState({ onTouch }: { onTouch: () => void }): JSX.Element {
  const [showClosed, setShowClosed] = useState(false);
  return (
    <>
      <Group first>Open</Group>
      <ReviewFindings />
      <button type="button" className="mk-disc" aria-expanded={showClosed} onClick={() => {
          setShowClosed((o) => !o);
          onTouch();
        }}>
        Resolved or addressed ({FINDINGS.closed.length})
      </button>
      {showClosed
        ? FINDINGS.closed.map((f) => (
            <FindingRow key={f.text} chip={f.sev} tone={f.tone}>
              <small className="mk-by">
                {f.by} · {f.reason}
              </small>
              {f.text}
            </FindingRow>
          ))
        : null}
    </>
  );
}

// ---- the hero: the Pending board ------------------------------------------------

function PendingCardBody({ id }: { id: PendingCardId }): JSX.Element | null {
  const c = PENDING.cards[id];
  if (id === 'flaky') {
    return (
      <>
        <Log lines={CI_FAILURE.log} />
        <p className="mk-note">{CI_FAILURE.verdict}</p>
        <div className="mk-end">
          <RunButton words={ACTIONS.rerun} tone="go" />
        </div>
      </>
    );
  }
  if (id === 'land') {
    return (
      <div className="mk-end">
        <RunButton words={ACTIONS.merge} tone="go" />
      </div>
    );
  }
  if (id === 'waiting') {
    return (
      <div className="mk-end">
        <RunButton words={ACTIONS.nudge} doneTone="grey" />
      </div>
    );
  }
  return c.detail ? (
    <ul className="mk-lines">
      {c.detail.map((t) => (
        <li key={t}>{t}</li>
      ))}
    </ul>
  ) : null;
}

function PendingCards({
  tab,
  openId,
  setOpenId,
}: {
  tab: PendingTabId;
  openId: PendingCardId | null;
  setOpenId: (id: PendingCardId | null) => void;
}): JSX.Element {
  return (
    <>
      {/* My turn's one visible sentence, then its first group's heading (AttentionView.tsx,
          pendingTabs.ts myTurnSections). */}
      {tab === 'my_turn' ? (
        <>
          <p className="mk-muted mk-purpose">Pull requests where a person is waiting on you.</p>
          <p className="mk-muted mk-group">Waiting on you</p>
        </>
      ) : null}
      {PENDING.byTab[tab].map((id) => {
        const c = PENDING.cards[id];
        const open = openId === id;
        return (
          <PrRow
            key={id}
            open={open}
            onToggle={() => setOpenId(open ? null : id)}
            title={prLabel(c.pr)}
            repo={c.pr.repo}
            status={<Chip tone={c.tone}>{c.chip}</Chip>}
            why={
              <>
                {c.high ? <Chip tone="red">{c.high}</Chip> : null}
                <span>{c.why}</span>
                {c.size ? <Chip>{c.size}</Chip> : null}
              </>
            }
          >
            <PendingCardBody id={id} />
          </PrRow>
        );
      })}
      {/* AI reviews: the newest AI review on each PR, "New" since you last looked
          (Activity/PendingAiReviews.tsx). */}
      {tab === 'claude' ? (
        <>
          <p className="mk-muted mk-purpose">Latest AI review on each pull request</p>
          {PENDING.aiSeen.map((r) => (
            <PrRow
              key={r.pr.num}
              title={prLabel(r.pr)}
              repo={r.pr.repo}
              status={<Chip tone={r.tone}>{r.verdict}</Chip>}
              why={
                <>
                  {r.isNew ? <Chip tone="blue">New</Chip> : null}
                  <span>{`${r.by} · ${r.findings} · ${r.when}`}</span>
                </>
              }
            />
          ))}
        </>
      ) : null}
    </>
  );
}

/** The hero: the Pending board. Tabs switch the cards; a card opens its detail and its action. */
export function PendingBoardMock(): JSX.Element {
  const [tab, setTab] = useState<PendingTabId>('my_turn');
  const [openId, setOpenId] = useState<PendingCardId | null>('settings');
  // A new key per visit to a tab, so a finished action starts over when the reader comes back.
  const [round, setRound] = useState(0);
  const changed = tab !== 'my_turn' || openId !== 'settings' || round > 0;
  const go = (t: PendingTabId): void => {
    setTab(t);
    setOpenId(PENDING.byTab[t][0] ?? null);
    setRound((r) => r + 1);
  };
  return (
    <MockFrame
      live
      dots
      title={`Pending · ${PENDING.workspace}`}
      right={`you: ${PENDING.you}`}
      onReset={
        changed
          ? () => {
              setTab('my_turn');
              setOpenId('settings');
              setRound(0);
            }
          : null
      }
      label="The Pending board: tabs for My turn, AI reviews, Needs fixing, Ready to land and Waiting on others, each with its own pull requests"
    >
      <MockTabs
        label="Pending tabs"
        tabs={PENDING.tabs.map((t) => ({ ...t, count: pendingTabCount(t.id) }))}
        value={tab}
        onChange={go}
        boxed
      >
        <PendingCards key={round} tab={tab} openId={openId} setOpenId={setOpenId} />
      </MockTabs>
    </MockFrame>
  );
}

/**
 * Review chapter: My turn and Waiting on others, with a working Nudge. `initialTab`
 * 'waiting' opens on Waiting on others with its card open (the /teams page).
 */
export function PendingListMock({ initialTab = 'my_turn' }: { initialTab?: 'my_turn' | 'waiting' } = {}): JSX.Element {
  const initialOpen: PendingCardId | null = initialTab === 'waiting' ? 'waiting' : null;
  const [tab, setTab] = useState<PendingTabId>(initialTab);
  const [openId, setOpenId] = useState<PendingCardId | null>(initialOpen);
  const [round, setRound] = useState(0);
  return (
    <MockFrame
      live
      title="Pending"
      onReset={
        tab !== initialTab || openId !== initialOpen || round > 0
          ? () => {
              setTab(initialTab);
              setOpenId(initialOpen);
              setRound(0);
            }
          : null
      }
      label="Pending: one pull request waits for your review, one owes a reply; under Waiting on others, one is with sam and over target"
    >
      <MockTabs
        label="Pending tabs"
        tabs={PENDING.tabs
          .filter((t) => t.id === 'my_turn' || t.id === 'waiting')
          .map((t) => ({ ...t, count: pendingTabCount(t.id) }))}
        value={tab}
        onChange={(t) => {
          setTab(t);
          setOpenId(t === 'waiting' ? 'waiting' : null);
          setRound((r) => r + 1);
        }}
        boxed
      >
        <PendingCards key={round} tab={tab} openId={openId} setOpenId={setOpenId} />
      </MockTabs>
    </MockFrame>
  );
}

// ---- one pull request ----------------------------------------------------------

/** AI Fix: tick findings → Start fix → the diff → Push → Pushed. */
function FixFlow(): JSX.Element {
  const [ticked, setTicked] = useState<Record<string, boolean>>(() =>
    Object.fromEntries(FIX.items.map((i) => [i.id, i.on])),
  );
  const fix = useAction(900);
  const push = useAction();
  const n = Object.values(ticked).filter(Boolean).length;

  if (push.phase === 'done') {
    return (
      <div className="mk-done" role="status">
        <Chip tone="green">
          {FIX.pushedTo} {PR_VIEW.branch}
        </Chip>
        <p className="mk-note">
          {n} item{n === 1 ? '' : 's'} fixed in <code>{FIX_DIFF.file}</code>.
        </p>
      </div>
    );
  }
  if (fix.phase === 'done') {
    return (
      <>
        <div className="mk-chips" style={{ marginBottom: 8 }}>
          <Chip tone="green">{FIX.ready}</Chip>
        </div>
        <Diff file={FIX_DIFF.file} lines={FIX_DIFF.lines} />
        <div className="mk-end">
          <Act onClick={() => fix.reset()} disabled={push.phase === 'busy'}>
            {FIX.discard}
          </Act>
          <Act tone="go" onClick={() => push.run()} disabled={push.phase === 'busy'}>
            {push.phase === 'busy' ? FIX.pushing : FIX.push}
          </Act>
        </div>
      </>
    );
  }
  return (
    <>
      <div className="mk-picks">
        {FIX.items.map((i) => (
          <label key={i.id} className="mk-pick">
            <input
              type="checkbox"
              checked={ticked[i.id] ?? false}
              disabled={fix.phase === 'busy'}
              onChange={(e) => setTicked((t) => ({ ...t, [i.id]: e.target.checked }))}
            />
            <Chip tone={i.tone}>{i.sev}</Chip>
            <span>{i.text}</span>
          </label>
        ))}
      </div>
      <div className="mk-end">
        <Act tone="gold" onClick={() => fix.run()} disabled={n === 0 || fix.phase === 'busy'}>
          {fix.phase === 'busy' ? FIX.busy : FIX.start}
        </Act>
      </div>
    </>
  );
}

function PrPanel({ tab, onTouch }: { tab: PrTabId; onTouch: () => void }): JSX.Element {
  if (tab === 'overview') {
    return (
      <>
        {PR_VIEW.overview.map((r) => (
          <CheckRow key={r.name} name={r.name} state={r.state} tone={r.tone} />
        ))}
      </>
    );
  }
  if (tab === 'changes') {
    const t = PR_VIEW.changes.thread;
    return (
      <Diff
        file={PR_VIEW.changes.file}
        lines={PR_VIEW.changes.lines}
        after={
          <div className="mk-thread">
            <Chip tone="red">{t.sev}</Chip>
            <span>{t.text}</span>
            <Chip>{t.state}</Chip>
          </div>
        }
      />
    );
  }
  if (tab === 'ai_fix') return <FixFlow />;
  return <ReviewFindingsByState onTouch={onTouch} />;
}

/** Review chapter: one pull request with its detail tabs. Opens on AI Review. */
export function ReviewMock(): JSX.Element {
  const [tab, setTab] = useState<PrTabId>('claude_review');
  const [round, setRound] = useState(0);
  const [touched, setTouched] = useState(false);
  // A new key on Reset, so an opened disclosure closes again.
  const [gen, setGen] = useState(0);
  return (
    <MockFrame
      live
      title={prLabel(refunds)}
      right={<Chip tone="green">Posted to GitHub</Chip>}
      onReset={
        tab !== 'claude_review' || round > 0 || touched
          ? () => {
              setTab('claude_review');
              setRound(0);
              setGen((g) => g + 1);
              setTouched(false);
            }
          : null
      }
      label="Pull request 612 with its Overview, Changes, AI Review and AI Fix tabs. The AI review, posted to GitHub, has one major, one minor and one nit open, and two findings resolved or addressed"
    >
      <MockTabs
        label="Pull request tabs"
        tabs={PR_VIEW.tabs}
        value={tab}
        onChange={(t) => {
          setTab(t);
          setRound((r) => r + 1);
        }}
        boxed
      >
        <PrPanel key={`${gen}-${round}`} tab={tab} onTouch={() => setTouched(true)} />
      </MockTabs>
    </MockFrame>
  );
}

export function StoryCheckMock(): JSX.Element {
  return (
    <MockFrame
      title={`${STORY.key} ${STORY.title}`}
      right={<Chip tone="amber">{STORY.chip}</Chip>}
      label="The story check for PAY-142: criteria 1 and 4 met, 2 at risk, 3 not met, and one finding from the payments handbook"
    >
      {STORY.criteria.map((c) => (
        <FindingRow key={c.n} chip={c.status} tone={c.tone}>
          {c.n}. {c.text}
        </FindingRow>
      ))}
      <FindingRow chip="Docs" tone="red">
        {FINDINGS.docs.source} {FINDINGS.docs.section}: {FINDINGS.docs.text}
      </FindingRow>
    </MockFrame>
  );
}

// ---- fix -------------------------------------------------------------------------

/** Remount-on-reset wrapper: a live mock whose state lives in its children. */
function Resettable({
  label,
  title,
  right,
  children,
}: {
  label: string;
  title: ReactNode;
  right?: ReactNode;
  children: ReactNode;
}): JSX.Element {
  const [key, setKey] = useState(0);
  const [touched, setTouched] = useState(false);
  return (
    <MockFrame
      live
      title={title}
      right={right}
      label={label}
      onReset={
        touched
          ? () => {
              setKey((k) => k + 1);
              setTouched(false);
            }
          : null
      }
    >
      <div
        key={key}
        onClickCapture={(e) => {
          if ((e.target as HTMLElement).closest('button, input, select')) setTouched(true);
        }}
      >
        {children}
      </div>
    </MockFrame>
  );
}

export function FixMock(): JSX.Element {
  return (
    <Resettable
      title={`AI Fix · #${refunds.num}`}
      label="AI Fix on pull request 612: pick the findings, start the fix, read the diff, then push it"
    >
      <FixFlow />
    </Resettable>
  );
}

export function CiMock(): JSX.Element {
  return (
    <Resettable
      title={`${CI_FAILURE.check} · failed`}
      right={<Chip>Flaky</Chip>}
      label="A failed test-api check marked Flaky: the test lost its network connection, and the same check passed on this commit earlier. Re-run failed jobs."
    >
      <Log lines={CI_FAILURE.log} />
      <p className="mk-note">{CI_FAILURE.verdict}</p>
      <div className="mk-end">
        <RunButton words={ACTIONS.rerun} tone="go" />
      </div>
    </Resettable>
  );
}

function ConflictsBody(): JSX.Element {
  const [pick, setPick] = useState<(typeof CONFLICT_WORDS.choices)[number] | null>(null);
  const push = useAction();
  const rows = CONFLICTS.map((c, i) =>
    i === CONFLICTS.length - 1 && pick ? { ...c, state: pick.state, tone: 'green' as const, note: pick.note } : c,
  );
  return (
    <>
      <div className="mk-chips" style={{ marginBottom: 8 }}>
        <Chip tone={pick ? 'green' : 'amber'}>{pick ? CONFLICT_WORDS.allDecided : '1 left'}</Chip>
      </div>
      {rows.map((c) => (
        <FindingRow key={c.file} chip={c.state} tone={c.tone}>
          <code>{c.file}</code> · {c.note}
        </FindingRow>
      ))}
      <div className="mk-end">
        {pick ? (
          push.phase === 'done' ? (
            <span role="status">
              <Chip tone="green">{CONFLICT_WORDS.pushed}</Chip>
            </span>
          ) : (
            <Act tone="go" onClick={() => push.run()} disabled={push.phase === 'busy'}>
              {push.phase === 'busy' ? CONFLICT_WORDS.pushing : CONFLICT_WORDS.commit}
            </Act>
          )
        ) : (
          CONFLICT_WORDS.choices.map((c) => (
            <Act key={c.id} onClick={() => setPick(c)}>
              {c.label}
            </Act>
          ))
        )}
      </div>
    </>
  );
}

export function ConflictsMock(): JSX.Element {
  return (
    <Resettable
      title={`#${ledgerRename.num} · 3 conflicts`}
      label="Three merge conflicts on pull request 701: two decided, one in api/routes.py still to decide between ours, theirs or both"
    >
      <ConflictsBody />
    </Resettable>
  );
}

// ---- ship ------------------------------------------------------------------------

function VerdictBody(): JSX.Element {
  const update = useAction(900);
  const blockers = VERDICT.blockers.filter((b) => !(b.id === 'behind' && update.phase === 'done'));
  return (
    <>
      <div className="mk-chips" style={{ marginBottom: 8 }}>
        <Chip tone="red">Blocked</Chip>
        <Chip tone="blue">2 of 3 in stack</Chip>
        <Chip>Large</Chip>
      </div>
      {blockers.map((b, i) => (
        <FindingRow key={b.id} chip={String(i + 1)} tone={b.tone}>
          {b.text}
        </FindingRow>
      ))}
      {update.phase !== 'done' ? (
        <div className="mk-end">
          <Act onClick={() => update.run()} disabled={update.phase === 'busy'}>
            {update.phase === 'busy' ? VERDICT.update.busy : VERDICT.update.idle}
          </Act>
        </div>
      ) : null}
    </>
  );
}

export function VerdictMock(): JSX.Element {
  return (
    <Resettable
      title={prLabel(settings)}
      label="Pull request 1190 is blocked: it needs one more approval, and its branch is behind main. It is 2 of 3 in a stack."
    >
      <VerdictBody />
    </Resettable>
  );
}

function ArmBody(): JSX.Element {
  const [armed, setArmed] = useState(false);
  return (
    <>
      <PrRow title={prLabel(ARM.first.pr)} status={<Chip tone="green">Armed</Chip>} why={ARM.first.why} />
      <PrRow
        title={prLabel(ARM.second.pr)}
        status={armed ? <Chip tone="green">Armed</Chip> : <Act onClick={() => setArmed(true)}>{ARM.button}</Act>}
        why={
          armed ? (
            <>
              <span role="status">{ARM.armed}</span>
              <span>· {ARM.second.armed}</span>
              <Act onClick={() => setArmed(false)}>{ARM.cancel}</Act>
            </>
          ) : (
            ARM.second.idle
          )
        }
      />
    </>
  );
}

export function MergeWhenReadyMock(): JSX.Element {
  return (
    <Resettable
      title="Merge when ready"
      label="Pull request 476 is armed and merges once one check passes; 482 can be armed to land after it, one at a time"
    >
      <ArmBody />
    </Resettable>
  );
}

export function TrunkMock(): JSX.Element {
  const [open, setOpen] = useState<string | null>(TRUNKS.find((t) => t.tone === 'red')?.repo ?? null);
  return (
    <MockFrame
      live
      title="Main branches"
      label="Main branches: acme/payments and acme/api are green; acme/web is red since pull request 1184 merged 35 minutes ago"
    >
      {TRUNKS.map((t) => (
        <CheckRow
          key={t.repo}
          name={t.repo}
          state={t.state}
          tone={t.tone}
          note={t.why}
          open={open === t.repo}
          onToggle={() => setOpen(open === t.repo ? null : t.repo)}
        />
      ))}
    </MockFrame>
  );
}

// ---- see -------------------------------------------------------------------------

export function ChronologyMiniMock(): JSX.Element {
  return (
    <MockFrame label="The median pull request's working hours: 3.1 waiting for review, 1.8 with the author, 1.1 waiting to land. 86% of first reviews this sprint arrived within the 4-hour target.">
      <Group first>Median pull request · working hours</Group>
      <CourtBar segments={COURTS.map((c) => ({ label: c.short, color: c.color, pct: c.pct, value: c.hours }))} />
      <Group>Review target · 4 working hours</Group>
      <div className="mk-fig">
        <b>86%</b>
        <span>of first reviews this sprint arrived within it</span>
      </div>
    </MockFrame>
  );
}

export function BotsWorthMock(): JSX.Element {
  const [sel, setSel] = useState<string | null>(null);
  const b = BOT_WORTH.find((x) => x.bot === sel);
  return (
    <MockFrame
      live
      title="Review bots"
      label="Review bots compared: CodeRabbit 412 comments, 38% acted on; Copilot 290, 22%; Limn 118, 71%"
    >
      <MiniTable
        className="stack"
        selected={sel}
        onSelect={(k) => setSel(sel === k ? null : k)}
        cols={[
          { key: 'bot', label: 'Bot' },
          { key: 'comments', label: 'Comments', num: true },
          { key: 'high', label: 'High' },
          { key: 'acted', label: 'Acted on', num: true },
        ]}
        rows={BOT_WORTH.map((x) => ({
          _key: x.bot,
          bot: x.bot,
          comments: x.comments,
          high: <HBar parts={[x.high]} colors={[x.ours ? 'var(--verdigris)' : 'var(--lapis)']} />,
          acted: x.acted,
        }))}
      />
      {b ? (
        <p className="mk-detail" role="status">
          <b>{b.bot}</b>: {b.comments} comments, {b.high}% of them major or critical. Your team acted on {b.actedN}.
        </p>
      ) : null}
    </MockFrame>
  );
}
