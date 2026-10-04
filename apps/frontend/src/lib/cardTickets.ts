import type { JiraStatusCategory, PrTicketLinks, TicketAssignee } from '@pierre-review/shared';
import { ticketIdentOf } from './ticketReview.js';

// THE OPEN PRs CARD'S TICKET ROW — which tickets a card names, in what order, with what words and
// what link. Pure, so the merge is testable; the component only renders it.
//
// ONE source, already on the board (never a per-card fetch): `detected` — the batched
// `POST /api/pro/ticket-links` answer for this PR (Pro `issueLinks`): the SAME detection the
// PR-detail chips use, the tracker's own link, and the Jira title when the workspace has a token.
// Its order (title first, then branch) leads.
//
// ⚠ NOT the PR review's stored stories any more. A PR review carries no story now; how a ticket
// stands is the TICKET review's (`ident` → the batched `POST /api/ticket-reviews/states`).
// ⚠ NOTHING KNOWN → [] → the card renders NO row (never an empty one).

export interface CardTicket {
  key: string;
  /** null = no title known; the row prints the key alone. */
  title: string | null;
  /** null = no link known; the row prints the key as plain text. */
  url: string | null;
  /** The ticket review's ident ('jira:<apiRoot>#<KEY>'); absent for Linear or no usable link. */
  ident?: string;
  // ── The tracker's STORED extras, carried only when KNOWN (absent otherwise). The Open PRs stack
  // header reads them. ──
  status?: string;
  statusCategory?: JiraStatusCategory;
  assignee?: TicketAssignee;
  issueType?: string;
}

const cleanTitle = (t: string | null | undefined): string | null => {
  const s = t?.replace(/\s+/g, ' ').trim() ?? '';
  return s === '' ? null : s;
};

export function cardTickets(detected: PrTicketLinks | null | undefined): CardTicket[] {
  const out: CardTicket[] = [];
  const seen = new Set<string>();
  for (const t of detected?.tickets ?? []) {
    const key = t.key.trim().toUpperCase();
    if (key === '' || seen.has(key)) continue;
    const row: CardTicket = { key, title: cleanTitle(t.title), url: t.url || null };
    const ident = ticketIdentOf({ key, url: t.url || null, provider: t.provider });
    if (ident != null) row.ident = ident;
    const status = cleanTitle(t.status);
    if (status != null) row.status = status;
    if (t.statusCategory != null) row.statusCategory = t.statusCategory;
    if (t.assignee != null && t.assignee.name.trim() !== '') row.assignee = t.assignee;
    const issueType = cleanTitle(t.issueType);
    if (issueType != null) row.issueType = issueType;
    seen.add(key);
    out.push(row);
  }
  return out;
}

/** "BMD-1043 · New Designs: Tidy up links" — or the key alone. */
export function cardTicketLabel(t: CardTicket): string {
  return t.title != null ? `${t.key} · ${t.title}` : t.key;
}
