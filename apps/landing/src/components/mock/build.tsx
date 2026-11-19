import { useState, type CSSProperties } from 'react';
import { BUILD } from '../../mock/acme';
import { SITE_NAME } from '../../lib/site';
import { Chip, FindingRow, Group, MockFrame } from './kit';

// ---------------------------------------------------------------------------
// The /build page's mocks (pages/Build.tsx). Layout lives in pages/build.css, under `.lb.build`.
//
//  - TicketDesignMock mirrors apps/frontend/src/components/FlowDiagram.tsx as the story view's
//    "Ticket design" section draws it (Activity/StoryDesignSection.tsx): lane cards across the top
//    (what kind of thing, its name, New / Changed, its pull request), a dashed line down from each,
//    and one numbered step box per row, centred between its two lanes, with the step's word, its pull
//    request and what passes. Check = dotted line, Write = heavy line, Return = dashed line; the two
//    keys under it are the app's own words (LINE_KEY, lib/designGrid.ts CHANGE_KEY_LABEL). Under
//    961px the steps restack to one list and each says "from → to".
//  - TicketCheckMock mirrors the story check (TicketReviewParts.tsx): the criterion statuses, "Asked
//    for outside the criteria", "Not asked for", and a docs check point with its quote.
//  - CriteriaMapMock mirrors the story view's "How the code meets each criterion"
//    (Activity/CriteriaMap.tsx): ONE list, no lines. Each criterion with its story-check status, and
//    under it each pull request marked Merged or Open with the description's "how" on one line
//    (truncated at every width); a click opens the full "how" (the row drops its one-line copy) and the files. An unclaimed criterion
//    says so; a criterion only code outside the ticket does says where ("Already in acme/statements (no PR
//    on this ticket)"), as TicketCheckMock does. LIVE.
//  - LoopBodyMock mirrors the section the review loop adds to the pull request's description
//    (apps/backend/src/coding/story-build/loop/pr-body.ts loopBodySection).
// Every word comes from src/mock/acme.ts BUILD.
// ---------------------------------------------------------------------------

const { flow, ticket, check, loopBody, outsideCriterion: OUT } = BUILD;
const N = flow.lanes.length;
const centre = (id: string): number => {
  const i = flow.lanes.findIndex((l) => l.id === id);
  return ((i + 0.5) / N) * 100;
};
const kindOf = (id: string): string => flow.lanes.find((l) => l.id === id)?.kind ?? id;
const CHANGE_WORD = { new: 'New', changed: 'Changed', unchanged: null } as const;

function Step({ s }: { s: (typeof flow.steps)[number] }): JSX.Element {
  const a = centre(s.from);
  const b = centre(s.to);
  const self = s.from === s.to;
  const lo = Math.min(a, b);
  const hi = self ? Math.min(100, a + 100 / N) : Math.max(a, b);
  const dir = self ? 'self' : b > a ? 'to-r' : 'to-l';
  const style = { '--lo': `${lo}%`, '--hi': `${100 - hi}%` } as CSSProperties;
  const kind = s.word.toLowerCase();
  return (
    <li className={`bd-step ${dir} k-${kind}`} style={style}>
      <span className="seg a" aria-hidden="true" />
      <span className="bd-box">
        <span className="bd-top">
          <b className="bd-n">{s.n}</b>
          <b>{s.word}</b>
          <span className="bd-pr">{s.pr}</span>
        </span>
        <span className="bd-route">
          {self ? kindOf(s.from) : `${kindOf(s.from)} → ${kindOf(s.to)}`}
        </span>
        <span>{s.label}</span>
      </span>
      {self ? null : <span className="seg b" aria-hidden="true" />}
    </li>
  );
}

export function TicketDesignMock(): JSX.Element {
  const cols = { '--n': N } as CSSProperties;
  return (
    <MockFrame
      title="Ticket design"
      meta={`${ticket.key} ${ticket.title} · ${BUILD.prs.length} pull requests`}
      label={`The Ticket design of ${ticket.key}, across pull requests 612 and 1196. Six lanes, left to right: Refund form (new, web 1196), Refunds route, RefundPolicy and the orders and refunds tables (changed, payments 612), the daily ledger job and the email service (existing). Nine steps: the form calls the route with the amount and order id; the route checks the amount is above 0; it calls RefundPolicy; RefundPolicy reads the order and its refunds, writes a refund row, emits a refund event for the daily ledger and calls the email service; then the new total returns to the route and the form. No step checks the 30-day limit.`}
    >
      <div className="bd-flow" style={cols}>
        <ul className="bd-lanes">
          {flow.lanes.map((l) => (
            <li key={l.id} className={`bd-lane ch-${l.change}`}>
              <span className="bd-k">{l.kind}</span>
              <b>{l.label}</b>
              {CHANGE_WORD[l.change] || l.pr ? (
                <span className="bd-tags">
                  {CHANGE_WORD[l.change] ? <span className="bd-ch">{CHANGE_WORD[l.change]}</span> : null}
                  {l.pr ? <span className="bd-pr">{l.pr}</span> : null}
                </span>
              ) : null}
            </li>
          ))}
        </ul>
        <ol className="bd-steps">
          {flow.lanes.map((l) => (
            <span key={l.id} className="bd-line" aria-hidden="true" style={{ left: `${centre(l.id)}%` }} />
          ))}
          {flow.steps.map((s) => (
            <Step key={s.n} s={s} />
          ))}
        </ol>
        <div className="bd-keys">
          <span>
            <i className="kb new" /> New: added by the change
          </span>
          <span>
            <i className="kb changed" /> Changed: existing code it edits
          </span>
          <span>
            <i className="kb unchanged" /> Existing code it relies on
          </span>
          <span>
            <i className="kl check" /> Check: dotted line
          </span>
          <span>
            <i className="kl write" /> Write: heavy line, where data is kept
          </span>
          <span>
            <i className="kl return" /> Return: dashed line
          </span>
        </div>
      </div>
    </MockFrame>
  );
}

const TONE = { Met: 'green', 'Partly met': 'amber', 'Not met': 'red' } as const;

export function TicketCheckMock(): JSX.Element {
  const met = ticket.criteria.filter((c) => c.status === 'Met').length + 1;
  return (
    <MockFrame
      title={`Story check · ${ticket.key}`}
      right={<Chip tone="amber">{`${met} of ${ticket.criteria.length + 1} met, 1 already outside the ticket`}</Chip>}
      label={`The story check for ${ticket.key}: criteria 1 and 4 met in pull request 612, criterion 2 partly met because the retry path still sends two emails, criterion 3 not met and belongs in 612, criterion 5 met already in acme/statements, with no pull request on this ticket. One thing asked for outside the criteria: an audit log entry. One thing not asked for. The docs check finds criterion 3 matches the refund policy, and quotes it.`}
    >
      <Group first>Acceptance criteria</Group>
      {ticket.criteria.map((c, i) => (
        <FindingRow key={c.n} chip={c.status} tone={TONE[c.status as keyof typeof TONE] ?? 'grey'}>
          AC{c.n} {c.text} — {check.why[i]}
        </FindingRow>
      ))}
      <FindingRow chip={OUT.status} tone="green">
        AC{OUT.n} {OUT.text} — {OUT.words}
      </FindingRow>
      <Group>Asked for outside the criteria (1)</Group>
      <FindingRow chip="Missing" tone="amber">
        {check.missing}
      </FindingRow>
      <Group>Not asked for (1)</Group>
      <FindingRow chip={check.notAsked.pr}>{check.notAsked.text}</FindingRow>
      <Group>Docs check</Group>
      <FindingRow chip="Matches" tone="green">
        AC3 · Refund policy › Time limits: “Refunds are accepted within 30 days of payment.”
      </FindingRow>
    </MockFrame>
  );
}

const MAP = BUILD.criteriaMap;
const prOf = (id: string) => MAP.prs.find((p) => p.id === id);

export function CriteriaMapMock(): JSX.Element {
  const [open, setOpen] = useState<string | null>(null);
  return (
    <MockFrame
      live
      title="How the code meets each criterion"
      meta={`${ticket.key} ${ticket.title}`}
      onReset={open != null ? () => setOpen(null) : null}
      label={`How the code in ${ticket.key} meets each criterion. Criterion 1, met: web 1196, open, the form asks for an amount below the order total; payments 612, merged, RefundPolicy leaves the order open. Criterion 2, partly met: payments 612 sends the refund email, and the retry path sends it again. Criterion 3, not met: no pull request claims it. Criterion 4, met: payments 612 emits a refund event for the daily ledger. Criterion 5, met: already in acme/statements, with no pull request on this ticket. Click a line to read it in full and see its files.`}
    >
      <ol className="bd-cm-crit">
        {ticket.criteria.map((c) => {
          const links = MAP.links.filter((l) => l.n === c.n);
          return (
            <li key={c.n} className={links.length === 0 ? 'bd-cm-none' : undefined}>
              <span className="bd-cm-head">
                <Chip tone={TONE[c.status as keyof typeof TONE] ?? 'grey'}>{c.status}</Chip>
                <span className="bd-cm-ref">AC{c.n}</span>
                <span>{c.text}</span>
              </span>
              {links.length === 0 ? (
                <span className="bd-cm-empty">No pull request claims this.</span>
              ) : (
                links.map((l) => {
                  const key = `${c.n}:${l.pr}`;
                  const isOpen = open === key;
                  const pr = prOf(l.pr);
                  const merged = pr?.state === 'merged';
                  return (
                    <span key={key} className="bd-cm-link">
                      <button type="button" aria-expanded={isOpen} onClick={() => setOpen(isOpen ? null : key)}>
                        <span className={`bd-cm-state${merged ? ' merged' : ''}`}>{merged ? 'Merged' : 'Open'}</span>
                        <span className="bd-cm-pr">{pr?.label ?? l.pr}</span>
                        <span className="bd-cm-how">{isOpen ? null : l.how}</span>
                        <span className="bd-cm-n">{l.files.length === 1 ? '1 file' : `${l.files.length} files`}</span>
                      </button>
                      {isOpen ? (
                        <span className="bd-cm-files">
                          <span>{l.how}</span>
                          {l.files.map((f) => (
                            <code key={f}>{f}</code>
                          ))}
                        </span>
                      ) : null}
                    </span>
                  );
                })
              )}
            </li>
          );
        })}
        {/* Met by code outside the ticket: no pull request claims it, and the row says where it is. */}
        <li className="bd-cm-none">
          <span className="bd-cm-head">
            <Chip tone="green">{OUT.status}</Chip>
            <span className="bd-cm-ref">AC{OUT.n}</span>
            <span>{OUT.text}</span>
          </span>
          <span className="bd-cm-empty">{OUT.words}</span>
        </li>
      </ol>
    </MockFrame>
  );
}

export function LoopBodyMock(): JSX.Element {
  return (
    <MockFrame
      title={`${ticket.key}: ${ticket.title}`}
      meta="acme/payments · description"
      label={`The end of the pull request's description: Review in ${SITE_NAME}. ${loopBody.reviewed} ${loopBody.counts}. ${loopBody.criteria}`}
    >
      <div className="bd-md">
        <b>## Review in {SITE_NAME}</b>
        <span>{loopBody.reviewed}</span>
        <span>{loopBody.counts}</span>
        <span>{loopBody.criteria}</span>
      </div>
    </MockFrame>
  );
}
