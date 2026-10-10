// A TICKET'S OWN CREATED / RESOLVED DATES — the one parse every adapter uses (docs/TRACKERS.md
// § Created and resolved dates). The POSITIVE-ANSWER rule, three states:
//   • undefined — the response did not carry the field (not asked, or a partial answer): the
//                 worker omits the key and the stored value stands;
//   • null      — the tracker said there is none (an unresolved ticket's `resolutiondate`);
//   • a Date    — the instant.
// An unparseable value is treated as NOT RECEIVED (undefined), never as "none": a format we cannot
// read must not clear a date we stored earlier.

/** `fields` = the record the date is a property of; `name` = the property. */
export function trackerDate(fields: Record<string, unknown> | null | undefined, name: string): Date | null | undefined {
  if (fields == null || !Object.prototype.hasOwnProperty.call(fields, name)) return undefined;
  const v = fields[name];
  if (v === null) return null;
  if (typeof v !== 'string' || v.trim() === '') return undefined;
  // Jira answers `2026-03-04T10:11:12.000+0000` — a `+hhmm` offset that `Date.parse` rejects on
  // some engines; normalise it to `+hh:mm` first.
  const iso = v.trim().replace(/([+-]\d{2})(\d{2})$/, '$1:$2');
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? new Date(ms) : undefined;
}

/** The two dates as a spread for a ticket write — undefined keys are left out. */
export function ticketDateFields(t: {
  issueCreatedAt?: Date | null;
  issueResolvedAt?: Date | null;
}): { issueCreatedAt?: Date | null; issueResolvedAt?: Date | null } {
  return {
    ...(t.issueCreatedAt !== undefined ? { issueCreatedAt: t.issueCreatedAt } : {}),
    ...(t.issueResolvedAt !== undefined ? { issueResolvedAt: t.issueResolvedAt } : {}),
  };
}
