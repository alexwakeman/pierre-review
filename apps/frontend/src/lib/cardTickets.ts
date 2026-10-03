import type { ClaudeReviewTicket, JiraStatusCategory, PrTicketLinks, TicketAssignee } from '@pierre-review/shared';

// THE OPEN PRs CARD'S TICKET ROW — which tickets a card names, in what order, with what words and
// what link. Pure, so the merge is testable; the component only renders it.
//
// Two sources, both already on the board (never a per-card fetch):
//   1. `detected` — the batched `POST /api/pro/ticket-links` answer for this PR (Pro `issueLinks`):
//      the SAME detection the PR-detail chips use, the tracker's own link, and the Jira title when
//      the workspace has a token. Its order (title first, then branch) leads.
//   2. `stored` — the user stories on the PR's latest Claude review (the batched
//      `POST /api/claude-review/states` answer, local only). A Jira-read story carries its key,
//      title and link; it fills a title Jira did not give, and adds a ticket detection did not find
//      (a story the reader picked by hand).
//
// ⚠ A LINK IS NEVER GUESSED. A key with no stored link and no known Jira site (`jiraBrowsePrefix`)
// stays plain text. The component still passes every url through `safeExternalUrl`.
// ⚠ NOTHING KNOWN → [] → the card renders NO row (never an empty one).

export interface CardTicket {
  key: string;
  /** null = no title known; the row prints the key alone. */
  title: string | null;
  /** null = no link known; the row prints the key as plain text. */
  url: string | null;
  // ── The tracker's STORED extras, carried only from the detected link and only when KNOWN (absent
  // otherwise — a stored Claude story has none). The Open PRs stack header reads them. ──
  status?: string;
  statusCategory?: JiraStatusCategory;
  assignee?: TicketAssignee;
  issueType?: string;
}

const KEY_SHAPE = /^[A-Z][A-Z0-9]{1,9}-\d{1,7}$/;

const cleanTitle = (t: string | null | undefined): string | null => {
  const s = t?.replace(/\s+/g, ' ').trim() ?? '';
  return s === '' ? null : s;
};

export function cardTickets(
  detected: PrTicketLinks | null | undefined,
  stored: readonly ClaudeReviewTicket[] | null | undefined,
): CardTicket[] {
  const out: CardTicket[] = [];
  const byKey = new Map<string, CardTicket>();
  for (const t of detected?.tickets ?? []) {
    const key = t.key.trim().toUpperCase();
    if (key === '' || byKey.has(key)) continue;
    const row: CardTicket = { key, title: cleanTitle(t.title), url: t.url || null };
    const status = cleanTitle(t.status);
    if (status != null) row.status = status;
    if (t.statusCategory != null) row.statusCategory = t.statusCategory;
    if (t.assignee != null && t.assignee.name.trim() !== '') row.assignee = t.assignee;
    const issueType = cleanTitle(t.issueType);
    if (issueType != null) row.issueType = issueType;
    byKey.set(key, row);
    out.push(row);
  }
  for (const s of stored ?? []) {
    if (s.source !== 'jira') continue; // a typed story has no key to link
    const key = s.key?.trim().toUpperCase() ?? '';
    if (!KEY_SHAPE.test(key)) continue;
    const title = cleanTitle(s.title);
    const url = s.url?.trim() || null;
    const known = byKey.get(key);
    if (known != null) {
      // Jira's live title wins; the stored one fills a gap.
      known.title ??= title;
      known.url ??= url;
      continue;
    }
    const prefix = detected?.jiraBrowsePrefix ?? null;
    const row: CardTicket = { key, title, url: url ?? (prefix != null ? `${prefix}${key}` : null) };
    byKey.set(key, row);
    out.push(row);
  }
  return out;
}

/** "BMD-1043 · New Designs: Tidy up links" — or the key alone. */
export function cardTicketLabel(t: CardTicket): string {
  return t.title != null ? `${t.key} · ${t.title}` : t.key;
}
