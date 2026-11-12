import { and, desc, eq } from 'drizzle-orm';
import {
  acSectionText,
  findAcSection,
  isTrackerIdent,
  parseTicketIdent,
  trackerTicketRow,
  type TicketAcLocation,
} from '@pierre-review/shared';
import type { TrackerContext } from './context.js';

// WHERE A TICKET KEEPS ITS ACCEPTANCE CRITERIA — what the ticket update writes, and what the planning
// agent is told (docs/TRACKERS.md § The ticket update). DB only, over the STORED rows of the ticket in
// this account: the TEXT from the freshest row (`tracker_tickets` of any workspace — the same ticket —
// or this workspace's sprint list row); the LOCATION only from THIS workspace's freshest row (the AC
// field choice is per workspace). ONE rule, used by the plan seed (sandbox/workspace/ticket.ts),
// the panel's read (`GET /api/ticket-update/current`) and the write (./ticket-update.ts):
//
//   1. a Jira custom field (`customfield_<n>`) — or another tracker's own place that is not the body
//      (`<p>:sub_issues`, `notion:property`)                         ⇒ { kind: 'field' }
//   2. else an AC heading inside the stored description (shared `findAcSection`)
//                                                                     ⇒ { kind: 'description', heading }
//   3. else a GitHub / Linear / Notion body rule (`<p>:heading`, `<p>:task_list`): the reader cut the
//      criteria out of the stored description   ⇒ { kind: 'description', heading: 'Acceptance criteria' | null }
//   4. else                                                           ⇒ { kind: 'none' }
//
// ⚠ Never throws to its caller: a failure is "nothing known" (null).

const CUSTOM_FIELD_RE = /^customfield_\d{1,12}$/;
const OTHER_FIELD_RE = /^(github|linear|notion):(sub_issues|property)$/;
const BODY_RULE_RE = /^(github|linear|notion):(heading|task_list)$/;

export interface StoredTicketText {
  provider: string;
  /** Markdown, as stored. */
  description: string;
  /** Markdown, as stored: the field's text, else (criteria in the description) the section's body. */
  acceptanceCriteria: string;
  acLocation: TicketAcLocation;
  readAt: string | null;
}

interface Row {
  description: string | null;
  acceptanceCriteria: string | null;
  acFieldId: string | null;
  acFieldName: string | null;
  fetchedAt: Date | number | null;
}

const ms = (d: Date | number | null): number => (d == null ? -1 : new Date(d).getTime());

/** Pure: the location rule over one stored row's facts. */
export function acLocationOf(
  acFieldId: string | null,
  acFieldName: string | null,
  description: string,
): TicketAcLocation {
  if (acFieldId != null && (CUSTOM_FIELD_RE.test(acFieldId) || OTHER_FIELD_RE.test(acFieldId))) {
    return { kind: 'field', fieldId: acFieldId, fieldName: acFieldName };
  }
  const section = findAcSection(description);
  if (section != null) return { kind: 'description', heading: section.heading };
  if (acFieldId != null && BODY_RULE_RE.test(acFieldId)) {
    return { kind: 'description', heading: acFieldId.endsWith(':heading') ? 'Acceptance criteria' : null };
  }
  return { kind: 'none' };
}

/** The ticket's stored text and where its criteria live. null = no stored row in this account. */
export async function storedTicketText(
  ctx: TrackerContext,
  accountId: number,
  workspaceId: number,
  ident: string,
): Promise<StoredTicketText | null> {
  const parsed = parseTicketIdent(ident);
  if (!isTrackerIdent(parsed)) return null;
  const id = trackerTicketRow(parsed);
  try {
    const t = ctx.schema.trackerTickets;
    const rows = (await ctx.db
      .select({
        description: t.description,
        acceptanceCriteria: t.acceptanceCriteria,
        acFieldId: t.acFieldId,
        acFieldName: t.acFieldName,
        fetchedAt: t.fetchedAt,
        workspaceId: t.workspaceId,
      })
      .from(t)
      .where(and(eq(t.accountId, accountId), eq(t.provider, id.provider), eq(t.apiRoot, id.apiRoot), eq(t.issueKey, id.issueKey)))
      .orderBy(desc(t.fetchedAt), desc(t.id))
      .limit(20)
      .execute()) as Array<Row & { workspaceId: number }>;
    const s = ctx.schema.sprintTickets;
    const sprint: Row[] =
      s != null
        ? ((await ctx.db
            .select({
              description: s.description,
              acceptanceCriteria: s.acceptanceCriteria,
              acFieldId: s.acFieldId,
              acFieldName: s.acFieldName,
              fetchedAt: s.fetchedAt,
            })
            .from(s)
            .where(and(eq(s.accountId, accountId), eq(s.workspaceId, workspaceId), eq(s.ident, ident)))
            .limit(1)
            .execute()) as Row[])
        : [];
    const all: Row[] = [...rows, ...sprint];
    if (all.length === 0) return null;
    const freshest = (list: readonly Row[]): Row | null => [...list].sort((a, b) => ms(b.fetchedAt) - ms(a.fetchedAt))[0] ?? null;
    // The TEXT: the freshest row of any workspace (the same ticket). WHERE THE CRITERIA LIVE: only THIS
    // workspace's rows (its AC field choice, `jira_ac_fields`, is per workspace), its freshest one; with
    // none, the description alone decides.
    const best = freshest(all)!;
    const mine = freshest([...rows.filter((r) => r.workspaceId === workspaceId), ...sprint]);
    const description = best.description ?? '';
    const acLocation = acLocationOf(mine?.acFieldId ?? null, mine?.acFieldName ?? null, description);
    const named = mine ?? best;
    const acceptanceCriteria =
      acLocation.kind === 'description' && acLocation.heading != null
        ? acSectionText(description)
        : (named.acceptanceCriteria ?? best.acceptanceCriteria ?? '');
    return {
      provider: id.provider,
      description,
      acceptanceCriteria,
      acLocation,
      readAt: best.fetchedAt == null ? null : new Date(best.fetchedAt).toISOString(),
    };
  } catch (err) {
    const code = err instanceof Error && 'code' in err ? String((err as { code: unknown }).code) : 'unknown';
    ctx.log.warn({ accountId, workspaceId, code }, 'ticket update: stored ticket not read');
    return null;
  }
}
