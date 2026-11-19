// WHAT THE CLIENTS SHOW (`ensemble mcp` tool results, `ensemble review` and its --json): ONE projection of a run,
// plain JSON an agent reads — file, line, severity, title, body; the criteria and their verdicts — and ONE text
// rendering of the same for a person. Pure.
import type { LocalReview, LocalReviewListResponse } from '@pierre-review/shared';

export interface LocalReviewView {
  id: number;
  status: LocalReview['status'];
  repo: string;
  branch: string;
  head: string;
  uncommittedChanges: boolean;
  failure?: string;
  summary?: string | null;
  verdict?: string | null;
  reviewers?: string[];
  findings?: Array<{ id: number; file: string; line: number | null; severity: string; title: string; body: string; suggestion?: string; raisedBy: string[] }>;
  earlierFindings?: Array<{ id: number; status: string; explanation: string | null }>;
  ticket?: { key: string; title: string; url: string | null } | null;
  ticketNote?: string;
  storyCheck?: {
    status: string;
    failure?: string;
    summary: string | null;
    open: number;
    criteria: Array<{ ref: string; status: string; open: boolean; text: string; explanation: string | null; cannotMeet?: string; notApplicable?: true }>;
  };
  /** What to do next (an agent reads this). */
  next: string;
}

const verdictWords: Record<string, string> = { APPROVE: 'approve', REQUEST_CHANGES: 'request changes', COMMENT: 'comment' };

/** The projection (see the header). */
export function reviewView(r: LocalReview): LocalReviewView {
  const v: LocalReviewView = {
    id: r.id,
    status: r.status,
    repo: r.repo,
    branch: r.branch,
    head: r.headSha.slice(0, 12),
    uncommittedChanges: r.uncommittedChanges,
    next: '',
  };
  if (r.failureReason && r.status !== 'succeeded') v.failure = r.failureReason;
  if (r.review) {
    v.summary = r.review.summary;
    v.verdict = r.review.verdict ? (verdictWords[r.review.verdict] ?? r.review.verdict.toLowerCase()) : null;
    v.reviewers = r.review.reviewers.map((x) => `${x.provider}${x.model ? ` (${x.model}${x.effort ? `, ${x.effort}` : ''})` : ''}: ${x.status}${x.failureReason ? ` — ${x.failureReason}` : ''}`);
    v.findings = r.review.findings.map((f) => ({
      id: f.id,
      file: f.file,
      line: f.line,
      severity: f.severity,
      title: f.title,
      body: f.body,
      ...(f.suggestion ? { suggestion: f.suggestion } : {}),
      raisedBy: f.raisedBy,
    }));
    if (r.review.followUp.length > 0) v.earlierFindings = r.review.followUp.map((x) => ({ id: x.findingId, status: x.status, explanation: x.explanation }));
  }
  if (r.ticket) v.ticket = r.ticket;
  if (r.ticketNote) v.ticketNote = r.ticketNote;
  if (r.storyCheck) {
    v.storyCheck = {
      status: r.storyCheck.status,
      ...(r.storyCheck.failureReason ? { failure: r.storyCheck.failureReason } : {}),
      summary: r.storyCheck.summary,
      open: r.storyCheck.open,
      criteria: r.storyCheck.criteria.map((c) => ({
        ref: c.ref,
        status: c.status,
        open: c.open,
        text: c.text,
        explanation: c.explanation,
        ...(c.cannotMeet ? { cannotMeet: c.cannotMeet } : {}),
        ...(c.notApplicable ? { notApplicable: true as const } : {}),
      })),
    };
  }
  v.next = nextStep(r);
  return v;
}

/** Why the story check did not finish (a failed or cancelled check), or null. */
function storyCheckNotDone(r: LocalReview): string | null {
  const s = r.storyCheck;
  if (!s || s.status === 'succeeded' || s.status === 'running') return null;
  return `The story check did not finish${s.failureReason ? `: ${s.failureReason.replace(/\.$/, '')}` : ''}.`;
}

/** The next step for an AGENT (the MCP tools, --json). */
function nextStep(r: LocalReview): string {
  if (r.status === 'running') return `Still running. Call get_local_review with id ${r.id} again (it waits up to 50 seconds).`;
  if (r.status !== 'succeeded') return 'Start a new review when ready.';
  const findings = r.review?.findings.filter((f) => f.severity !== 'nit').length ?? 0;
  const open = r.storyCheck?.open ?? 0;
  const notDone = storyCheckNotDone(r);
  if (findings === 0 && open === 0) return notDone ? `${notDone} The acceptance criteria were not checked: run check_story to check them.` : 'Nothing to fix.';
  return `${notDone ? `${notDone} ` : ''}Fix what applies, then review again with answers: F<id> for each finding (fixed / answered / pushed_back) and AC<n> or M<n> for each open criterion (fixed / not_applicable / cannot_meet, with the reason).`;
}

/** The next step for a PERSON (the CLI's text: it takes no answers and has no get_local_review). */
function nextStepForPerson(r: LocalReview): string {
  if (r.status === 'running') return `Still running. Run ensemble review --id ${r.id} to wait for it.`;
  if (r.status !== 'succeeded') return 'Run ensemble review again when ready.';
  const findings = r.review?.findings.filter((f) => f.severity !== 'nit').length ?? 0;
  const open = r.storyCheck?.open ?? 0;
  const notDone = storyCheckNotDone(r);
  if (findings === 0 && open === 0) return notDone ? `${notDone} Run ensemble review --story to check the acceptance criteria.` : 'Nothing to fix.';
  return `${notDone ? `${notDone} ` : ''}Fix what applies, then run ensemble review again.`;
}

/** The text a person reads (the CLI without --json). */
export function reviewText(r: LocalReview): string {
  const v = reviewView(r);
  const out: string[] = [];
  out.push(`Local review ${v.id} of ${v.repo} ${v.branch} at ${v.head}${v.uncommittedChanges ? ' (with uncommitted changes)' : ''}: ${v.status}`);
  if (v.failure) out.push(v.failure);
  if (v.reviewers && v.reviewers.length > 0) out.push(`Reviewed by ${v.reviewers.join('; ')}`);
  if (v.summary) out.push('', v.summary);
  if (v.verdict) out.push(`Verdict: ${v.verdict}`);
  if (v.findings) {
    out.push('', v.findings.length === 0 ? 'No findings.' : `${v.findings.length} ${v.findings.length === 1 ? 'finding' : 'findings'}:`);
    for (const f of v.findings) {
      out.push(`  F${f.id} [${f.severity}] ${f.file}${f.line != null ? `:${f.line}` : ''} — ${f.title}`);
      for (const l of f.body.split('\n').slice(0, 6)) out.push(`      ${l}`);
    }
  }
  if (v.earlierFindings && v.earlierFindings.length > 0) {
    out.push('', 'Earlier findings:');
    for (const e of v.earlierFindings) out.push(`  F${e.id}: ${e.status.replace(/_/g, ' ')}${e.explanation ? ` — ${e.explanation}` : ''}`);
  }
  if (v.ticket) out.push('', `Ticket ${v.ticket.key}: ${v.ticket.title}`);
  if (v.ticketNote) out.push('', v.ticketNote);
  if (v.storyCheck) {
    const s = v.storyCheck;
    out.push(`Story check: ${s.status}${s.failure ? ` — ${s.failure}` : ''}${s.status === 'succeeded' ? ` (${s.open} open)` : ''}`);
    for (const c of s.criteria) {
      const mark = c.open ? 'OPEN' : 'ok  ';
      out.push(`  ${mark} ${c.ref} ${c.status.replace(/_/g, ' ')}${c.notApplicable ? ' (not applicable, accepted)' : ''} — ${c.text}`);
      if (c.cannotMeet) out.push(`       Cannot meet: ${c.cannotMeet}`);
    }
  }
  out.push('', nextStepForPerson(r));
  return out.join('\n');
}

/** A list, as text. */
export function listText(l: LocalReviewListResponse): string {
  if (l.reviews.length === 0) return `No local reviews of ${l.repo}${l.branch ? ` ${l.branch}` : ''} yet.`;
  return [
    `Local reviews of ${l.repo}${l.branch ? ` ${l.branch}` : ''}:`,
    ...l.reviews.map(
      (r) =>
        `  ${r.id}  ${r.createdAt.slice(0, 16).replace('T', ' ')}  ${r.kind === 'story' ? 'story check' : 'review'}  ${r.status}  ${r.headSha.slice(0, 12)}  ${r.findings} findings${r.openCriteria != null ? `, ${r.openCriteria} open criteria` : ''}`,
    ),
  ].join('\n');
}
