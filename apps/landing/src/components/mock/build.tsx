import { useCallback, useEffect, useRef, useState, type CSSProperties } from 'react';
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
//    (Activity/CriteriaMap.tsx): criteria with their story-check status on the left, the pull requests
//    on the right, one line per link with the description's "how"; a link opens its files, a pull
//    request highlights its lines, an unclaimed criterion says so. LIVE. The lines are measured in
//    the browser only (the prerender shows the words); under 961px it stacks and drops the lines.
//  - LoopBodyMock mirrors the section the review loop adds to the pull request's description
//    (apps/backend/src/coding/story-build/loop/pr-body.ts loopBodySection).
// Every word comes from src/mock/acme.ts BUILD.
// ---------------------------------------------------------------------------

const { flow, ticket, check, loopBody } = BUILD;
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
  const met = ticket.criteria.filter((c) => c.status === 'Met').length;
  return (
    <MockFrame
      title={`Story check · ${ticket.key}`}
      right={<Chip tone="amber">{`${met} of ${ticket.criteria.length} met`}</Chip>}
      label={`The story check for ${ticket.key}: criteria 1 and 4 met in pull request 612, criterion 2 partly met because the retry path still sends two emails, criterion 3 not met and belongs in 612. One thing asked for outside the criteria: an audit log entry. One thing not asked for. The docs check finds criterion 3 matches the refund policy, and quotes it.`}
    >
      <Group first>Acceptance criteria</Group>
      {ticket.criteria.map((c, i) => (
        <FindingRow key={c.n} chip={c.status} tone={TONE[c.status as keyof typeof TONE] ?? 'grey'}>
          AC{c.n} {c.text} — {check.why[i]}
        </FindingRow>
      ))}
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
const prLabelOf = (id: string): string => MAP.prs.find((p) => p.id === id)?.label ?? id;

type MapLine = { key: string; pr: string; d: string };

export function CriteriaMapMock(): JSX.Element {
  const [open, setOpen] = useState<string | null>(null);
  const [hot, setHot] = useState<string | null>(null);
  const [lines, setLines] = useState<MapLine[]>([]);
  const box = useRef<HTMLDivElement>(null);
  const measure = useCallback(() => {
    const el = box.current;
    if (el == null) return;
    const o = el.getBoundingClientRect();
    if (getComputedStyle(el).display !== 'grid') {
      setLines([]);
      return;
    }
    const out: MapLine[] = [];
    const per = new Map<string, number>();
    const ports = [...el.querySelectorAll<HTMLElement>('[data-cm-link]')];
    for (const p of ports) {
      const pr = p.dataset.cmPr!;
      const target = el.querySelector<HTMLElement>(`[data-cm-prbox="${pr}"]`)?.getBoundingClientRect();
      const crit = p.closest<HTMLElement>('[data-cm-crit]')?.getBoundingClientRect();
      if (target == null || crit == null) continue;
      const all = ports.filter((q) => q.dataset.cmPr === pr).length;
      const k = per.get(pr) ?? 0;
      per.set(pr, k + 1);
      const r = p.getBoundingClientRect();
      const x1 = crit.right - o.left;
      const y1 = r.top + 10 - o.top;
      const x2 = target.left - o.left;
      const y2 = target.top - o.top + (all <= 1 ? target.height / 2 : target.height / 4 + ((target.height / 2) * k) / (all - 1));
      const dx = (x2 - x1) / 2;
      out.push({ key: p.dataset.cmLink!, pr, d: `M ${x1} ${y1} C ${x1 + dx} ${y1}, ${x2 - dx} ${y2}, ${x2} ${y2}` });
    }
    setLines(out);
  }, []);
  useEffect(() => {
    measure();
    const el = box.current;
    if (el == null || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [measure, open]);
  return (
    <MockFrame
      live
      title="How the code meets each criterion"
      meta={`${ticket.key} ${ticket.title}`}
      onReset={open != null ? () => setOpen(null) : null}
      label={`How the code in ${ticket.key} meets each criterion. Criterion 1, met: web 1196's form asks for an amount below the order total, and payments 612's RefundPolicy leaves the order open. Criterion 2, partly met: payments 612 sends the refund email, and the retry path sends it again. Criterion 3, not met: no pull request claims it. Criterion 4, met: payments 612 emits a refund event for the daily ledger. Click a link to see its files.`}
    >
      <div className="bd-cmap" ref={box}>
        <ol className="bd-cm-crit">
          {ticket.criteria.map((c) => {
            const links = MAP.links.filter((l) => l.n === c.n);
            return (
              <li key={c.n} data-cm-crit={c.n} className={links.length === 0 ? 'bd-cm-none' : undefined}>
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
                    return (
                      <span key={key} className={`bd-cm-link${hot === l.pr ? ' hot' : ''}`} data-cm-link={key} data-cm-pr={l.pr}>
                        <button type="button" aria-expanded={isOpen} onClick={() => setOpen(isOpen ? null : key)}>
                          <span className="bd-cm-pr">{prLabelOf(l.pr)}</span>
                          <span>{l.how}</span>
                          <span className="bd-cm-n">{l.files.length === 1 ? '1 file' : `${l.files.length} files`}</span>
                        </button>
                        {isOpen ? (
                          <span className="bd-cm-files">
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
        </ol>
        <span aria-hidden="true" />
        <ul className="bd-cm-prs">
          {MAP.prs.map((p) => {
            const n = new Set(MAP.links.filter((l) => l.pr === p.id).map((l) => l.n)).size;
            return (
              <li
                key={p.id}
                data-cm-prbox={p.id}
                className={hot === p.id ? 'hot' : undefined}
                onMouseEnter={() => setHot(p.id)}
                onMouseLeave={() => setHot(null)}
              >
                <span className="bd-cm-pr">{p.label}</span>
                <span>{p.title}</span>
                <span className="bd-cm-n">{n === 1 ? '1 criterion' : `${n} criteria`}</span>
              </li>
            );
          })}
        </ul>
        {lines.length > 0 ? (
          <svg className="bd-cm-lines" aria-hidden="true">
            {lines.map((l) => (
              <path key={l.key} d={l.d} className={hot == null ? undefined : hot === l.pr ? 'hot' : 'dim'} />
            ))}
          </svg>
        ) : null}
      </div>
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
