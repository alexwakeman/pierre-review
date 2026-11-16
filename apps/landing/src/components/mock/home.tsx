import { Fragment, useState } from 'react';
import type { ReactNode } from 'react';
import {
  ACTIONS,
  CI_FAILURE,
  FINDINGS,
  FIX,
  FIX_DIFF,
  PENDING,
  PRS,
  PR_VIEW,
  pendingTabCount,
  prLabel,
} from '../../mock/acme';
import type { PendingCardId, PendingTabId, PrTabId } from '../../mock/acme';
import {
  Act,
  CheckRow,
  Chip,
  Diff,
  FindingRow,
  Group,
  Log,
  MockFrame,
  MockTabs,
  PrRow,
  useAction,
} from './kit';

// The product mocks used by /ensemble-review and the docs (Review, Fix, Pending). Words and numbers: src/mock/acme.ts.
// Each LIVE mock starts in the state the prerendered HTML shows; the app
// surface it mirrors is listed in apps/landing/README.md.

const { refunds } = PRS;

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

/** The AI Review tab's findings: "Open", then a collapsed "Resolved or addressed (n)" saying why and,
 *  for an earlier finding the latest review judged, how in one line (there is no "Previous review"). */
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
              {f.how != null ? (
                <>
                  <br />
                  <b>{f.how}</b>
                </>
              ) : null}
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
      {/* AI reviews: the newest AI review on each PR, "New" since you last looked, then one block
          per earlier visit (Activity/PendingAiReviews.tsx). */}
      {tab === 'claude' ? (
        <>
          <p className="mk-muted mk-purpose">Latest AI review on each pull request</p>
          {PENDING.aiSeen.map((r, i) => (
            <Fragment key={r.pr.num}>
              {r.seen != null && r.seen !== PENDING.aiSeen[i - 1]?.seen ? (
                <p className="mk-muted mk-purpose">{r.seen}</p>
              ) : null}
              <PrRow
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
            </Fragment>
          ))}
        </>
      ) : null}
    </>
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

/** AI Fix: tick findings → Start fix → (Push when done: Pushed) or the diff → Push → Pushed. */
function FixFlow(): JSX.Element {
  const [ticked, setTicked] = useState<Record<string, boolean>>(() =>
    Object.fromEntries(FIX.items.map((i) => [i.id, i.on])),
  );
  // "Push when done" is ticked by default, as in the app (components/AiFixTab.tsx).
  const [pushWhenDone, setPushWhenDone] = useState(true);
  const fix = useAction(900);
  const push = useAction();
  const n = Object.values(ticked).filter(Boolean).length;

  if (push.phase === 'done' || (fix.phase === 'done' && pushWhenDone)) {
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
        <Log lines={FIX.session} />
        <p className="mk-note">{FIX.said}</p>
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
        <label className="mk-pick">
          <input type="checkbox" checked={pushWhenDone} disabled={fix.phase === 'busy'} onChange={(e) => setPushWhenDone(e.target.checked)} />
          <span>{FIX.pushWhenDone}</span>
        </label>
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
      label="AI Fix on pull request 612: pick the findings, start the fix in a sandbox, watch it run the tests, read the diff, then push it"
    >
      <FixFlow />
    </Resettable>
  );
}




// ---- ship ------------------------------------------------------------------------






// ---- see -------------------------------------------------------------------------


