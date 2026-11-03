import { BOT_WORTH, CI_FAILURE, CONFLICTS, COURTS, FINDINGS, FIX_DIFF, PENDING, PRS, STORY, TRUNKS, prLabel } from '../../mock/acme';
import { Btn, CheckRow, Chip, CourtBar, Diff, FindingRow, Group, HBar, Log, MiniTable, MockFrame, PrRow, Swap, Tabs } from './kit';

// The home page's mocks, one per feature. Words and numbers: src/mock/acme.ts.

const { refunds, settings, retry, webhooks, ledgerRename, ledgerIndex } = PRS;
const { waiting } = PENDING;

/** The hero: the Pending board, with #482's checks finishing into "Merge". */
export function PendingBoardMock(): JSX.Element {
  return (
    <MockFrame
      dots
      title={`Pending · ${PENDING.workspace}`}
      right={`you: ${PENDING.you}`}
      label="The Pending board: two pull requests are your turn, one is waiting on a reviewer, one is ready to merge"
    >
      <Tabs tabs={PENDING.tabs} />
      <Group first>Your turn · sorted by what to do next</Group>
      <PrRow
        open
        title={prLabel(refunds)}
        repo={refunds.repo}
        status={<Chip tone="amber">{STORY.chip}</Chip>}
        why={
          <>
            <Chip tone="red">2 major</Chip>
            <span>Your PR · Limn review posted 4 min ago · fix ready</span>
          </>
        }
      >
        <FindingRow chip={FINDINGS.storyMajor.sev} tone="red">
          <b>{FINDINGS.storyMajor.head}</b> {FINDINGS.storyMajor.text}
        </FindingRow>
        <FindingRow chip={FINDINGS.docsMajor.sev} tone="red">
          <b>{FINDINGS.docsMajor.head}</b> <code>amount</code> is a float; money is whole pence.
        </FindingRow>
        <div className="mk-end">
          <Btn>Open</Btn>
          <Btn tone="gold">Fix 2 items</Btn>
        </div>
      </PrRow>
      <PrRow
        title={prLabel(settings)}
        repo={settings.repo}
        status={<Chip tone="blue">Your review</Chip>}
        why={
          <>
            <span>Asked 26 working hours ago · +420 −88</span>
            <Chip>Large</Chip>
          </>
        }
      />
      <Group>Waiting on others</Group>
      <PrRow
        title={prLabel(webhooks)}
        repo={webhooks.repo}
        status={<Chip>{`With ${waiting.who} · ${waiting.hours}h`}</Chip>}
        why={
          <>
            <span>{`Over the ${waiting.target}h review target`}</span>
            <Btn>Nudge</Btn>
          </>
        }
      />
      <Group>Ready to merge</Group>
      <PrRow
        title={prLabel(retry)}
        repo={retry.repo}
        status={<Swap from={<Chip tone="amber">Checks running</Chip>} to={<Btn tone="go">Merge</Btn>} />}
        why="2 approvals · threads resolved"
      />
    </MockFrame>
  );
}

export function PendingListMock(): JSX.Element {
  return (
    <MockFrame label="Three pull requests: one waits for your review, one owes a reply, one is waiting on sam and over target">
      <PrRow title={prLabel(settings)} status={<Chip tone="blue">Your review</Chip>} why="Asked 26h ago" />
      <PrRow title={prLabel(ledgerRename)} status={<Chip tone="amber">Reply owed</Chip>} why="Priya replied to your thread" />
      <PrRow
        title={prLabel(webhooks)}
        status={<Chip>{`With ${waiting.who} · ${waiting.hours}h`}</Chip>}
        why={
          <>
            <span>{`Over the ${waiting.target}h review target`}</span>
            <Btn>Nudge</Btn>
          </>
        }
      />
    </MockFrame>
  );
}

export function ReviewMock(): JSX.Element {
  return (
    <MockFrame
      title={`#${refunds.num} · Limn review`}
      right={<Chip tone="green">Posted to GitHub</Chip>}
      label="A Limn review of pull request 612, posted to GitHub: one major, one minor and one nit finding, and the state of earlier threads"
    >
      {FINDINGS.review.map((f) => (
        <FindingRow key={f.sev} chip={f.sev} tone={f.tone}>
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
      <Group>Earlier threads</Group>
      <div className="mk-chips">
        <Chip tone="green">3 resolved</Chip>
        <Chip tone="blue">2 likely addressed?</Chip>
        <Chip>1 untouched</Chip>
      </div>
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

export function FixMock(): JSX.Element {
  return (
    <MockFrame
      title={`Fix 2 items · #${refunds.num}`}
      right={<Chip tone="green">Ready to push</Chip>}
      label="AI Fix's change for pull request 612: refunds/policy.py now refuses refunds older than the refund window. Discard or Push."
    >
      <Diff file={FIX_DIFF.file} lines={FIX_DIFF.lines} />
      <div className="mk-end">
        <Btn>Discard</Btn>
        <Btn tone="go">Push</Btn>
      </div>
    </MockFrame>
  );
}

export function CiMock(): JSX.Element {
  return (
    <MockFrame
      title={`${CI_FAILURE.check} · failed`}
      right={<Chip>Flaky</Chip>}
      label="A failed test-api check marked Flaky: the test lost its network connection, and the same check passed on this commit earlier. Re-run failed jobs."
    >
      <Log lines={CI_FAILURE.log} />
      <p className="mk-note">{CI_FAILURE.verdict}</p>
      <div className="mk-end">
        <Btn tone="go">Re-run failed jobs</Btn>
      </div>
    </MockFrame>
  );
}

export function ConflictsMock(): JSX.Element {
  return (
    <MockFrame
      title={`#${ledgerRename.num} · 3 conflicts`}
      right={<Chip tone="amber">1 left</Chip>}
      label="Three merge conflicts on pull request 701: two decided, one in api/routes.py still to decide between ours, theirs or both"
    >
      {CONFLICTS.map((c) => (
        <FindingRow key={c.file} chip={c.state} tone={c.tone}>
          <code>{c.file}</code> · {c.note}
        </FindingRow>
      ))}
      <div className="mk-end">
        <Btn>Ours</Btn>
        <Btn>Theirs</Btn>
        <Btn>Both</Btn>
      </div>
    </MockFrame>
  );
}

export function VerdictMock(): JSX.Element {
  return (
    <MockFrame
      title={prLabel(settings)}
      right={<Chip tone="red">Blocked</Chip>}
      label="Pull request 1190 is blocked: it needs one more approval, and its branch is behind main. It is 2 of 3 in a stack."
    >
      <div className="mk-chips" style={{ marginBottom: 8 }}>
        <Chip tone="blue">2 of 3 in stack</Chip>
        <Chip>Large</Chip>
      </div>
      <FindingRow chip="1" tone="red">
        Needs 1 more approval
      </FindingRow>
      <FindingRow chip="2" tone="amber">
        Branch is behind main
      </FindingRow>
      <div className="mk-end">
        <Btn>Update branch</Btn>
      </div>
    </MockFrame>
  );
}

export function MergeWhenReadyMock(): JSX.Element {
  return (
    <MockFrame label="Pull request 482 is armed and merges once one check passes; 476 lands after it, one at a time">
      <PrRow title={prLabel(retry)} status={<Chip tone="green">Armed</Chip>} why="Waiting for 1 check · then merges" />
      <PrRow title={prLabel(ledgerIndex)} status={<Chip>Next</Chip>} why={`Lands after #${retry.num}, one at a time`} />
    </MockFrame>
  );
}

export function TrunkMock(): JSX.Element {
  return (
    <MockFrame label="Main branches: acme/payments and acme/api are green; acme/web is red since pull request 1184 merged 35 minutes ago">
      {TRUNKS.map((t) => (
        <CheckRow key={t.repo} name={t.repo} state={t.state} tone={t.tone} note={t.why} />
      ))}
    </MockFrame>
  );
}

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
  return (
    <MockFrame label="Review bots compared: CodeRabbit 412 comments, 38% acted on; Copilot 290, 22%; Limn 118, 71%">
      <MiniTable
        className="stack"
        cols={[
          { key: 'bot', label: 'Bot' },
          { key: 'comments', label: 'Comments', num: true },
          { key: 'high', label: 'High' },
          { key: 'acted', label: 'Acted on', num: true },
        ]}
        rows={BOT_WORTH.map((b) => ({
          _key: b.bot,
          bot: b.bot,
          comments: b.comments,
          high: <HBar parts={[b.high]} colors={[b.ours ? 'var(--verdigris)' : 'var(--lapis)']} />,
          acted: b.acted,
        }))}
      />
    </MockFrame>
  );
}
