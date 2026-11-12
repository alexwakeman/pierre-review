// THE PLAN PANEL'S AND THE STACK VIEW'S PURE HALF ("Implement, plan first"; docs/STORY-BUILD.md § Plan
// first, docs/FRONTEND.md § The build tab). React-free so test/buildPlan.test.ts pins it: whether
// "Approve and start" may be pressed and the one line that says why not, the words for a decision, a
// criterion and a piece of evidence, the planned PRs in stack order with their "builds on" lines, and
// which planned PR may be pushed now. The plan itself is the server's (`StoryBuildSession.plan`); nothing
// here decides what the agent proposed.
import {
  acSectionText,
  buildPlanUnanswered,
  findAcSection,
  type BuildPlanContention,
  type BuildPlanCriterionStatus,
  type BuildPlanDataKind,
  type BuildPlanDecision,
  type BuildPlanEvidence,
  type BuildPlanPr,
  type BuildPlanRevision,
  type BuildPlanView,
  type StoryBuildPr,
  type StoryBuildPrCheck,
  type StoryBuildPrStatus,
  type StoryBuildSession,
  type TicketAcLocation,
} from '@pierre-review/shared';

const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;

// ── decisions ──────────────────────────────────────────────────────────────────────────────────

export const PLAN_DECISION_WORDS: Record<BuildPlanDecision, string> = {
  agree: 'Agree',
  keep_story: 'Keep the story',
};

/**
 * The decisions as the panel shows them: the server's, with the reader's presses still in flight laid
 * over them (`pending`: contention id → the decision sent, or null for a cleared one).
 */
export function decisionsWithPending(
  decisions: BuildPlanView['decisions'],
  pending: Readonly<Record<string, BuildPlanDecision | null>>,
): Record<string, BuildPlanDecision> {
  const out: Record<string, BuildPlanDecision> = {};
  for (const [id, d] of Object.entries(decisions)) out[id] = d.decision;
  for (const [id, d] of Object.entries(pending)) {
    if (d == null) delete out[id];
    else out[id] = d;
  }
  return out;
}

/** A press on a card's button: the chosen one again clears it; another one sets it. */
export function nextDecision(current: BuildPlanDecision | undefined, pressed: BuildPlanDecision): BuildPlanDecision | null {
  return current === pressed ? null : pressed;
}

// ── Approve and start ──────────────────────────────────────────────────────────────────────────

export interface ApproveState {
  /** The button is shown at all (there is a revision and the plan is not approved yet). */
  shown: boolean;
  enabled: boolean;
  /** The one line beside it when it cannot be pressed. */
  reason: string | null;
}

/**
 * "Approve and start": enabled only on a live session waiting for the reader (`plan_ready`) whose latest
 * revision has every point of contention answered. `decided` is the decisions as shown (with presses in
 * flight); absent ⇒ the server's.
 */
export function planApproveState(
  s: Pick<StoryBuildSession, 'phase' | 'live' | 'agentState' | 'plan'>,
  decided?: Readonly<Record<string, unknown>>,
): ApproveState {
  const plan = s.plan;
  if (plan == null || plan.latest == null || plan.approvedRevision != null) return { shown: false, enabled: false, reason: null };
  const open = buildPlanUnanswered(plan.latest, decided ?? plan.decisions);
  if (!s.live) return { shown: true, enabled: false, reason: 'Resume the session first.' };
  if (s.phase === 'planning' || s.phase === 'revising') return { shown: true, enabled: false, reason: 'The agent is revising the plan.' };
  if (s.phase !== 'plan_ready' || s.agentState === 'stopped') return { shown: true, enabled: false, reason: 'Wait for the agent.' };
  if (open > 0) return { shown: true, enabled: false, reason: `${plural(open, 'point')} still to answer.` };
  return { shown: true, enabled: true, reason: null };
}

/** The plan stage's one line above the panel (none once a usable revision waits for the reader). */
export function planStageLine(plan: Pick<BuildPlanView, 'status' | 'problem' | 'latest' | 'fillGaps' | 'withDocs'>): string | null {
  switch (plan.status) {
    case 'planning':
      return plan.latest == null
        ? plan.fillGaps
          ? 'The agent is reading the gaps, the code and the ticket to make a plan.'
          : `The agent is reading the ticket and the code${plan.withDocs ? ' and the docs' : ''} to make a plan.`
        : 'The agent is making a new plan.';
    case 'revising':
      return 'The agent is revising the plan.';
    case 'failed':
      return plan.problem != null && plan.problem !== '' ? `The plan did not pass Limn's checks: ${plan.problem.replace(/\.$/, '')}.` : "The plan did not pass Limn's checks.";
    case 'ready':
    case 'approved':
      return null;
  }
}

/** "Points to settle (2 of 3 answered)". */
export function contentionsHeading(contentions: readonly BuildPlanContention[], decided: Readonly<Record<string, unknown>>): string {
  const answered = contentions.filter((c) => decided[c.id] != null).length;
  return `Points to settle (${answered} of ${contentions.length} answered)`;
}

/** What Limn removed from the agent's plan, in one line; null when nothing. Counts only, never the claims. */
export function droppedLine(d: BuildPlanRevision['dropped']): string | null {
  if (d.contentions > 0) return `Limn left out ${plural(d.contentions, 'point')} it could not check.`;
  if (d.evidence > 0) return `Limn left out ${plural(d.evidence, 'piece', 'pieces')} of evidence it could not check.`;
  return null;
}

// ── criteria ───────────────────────────────────────────────────────────────────────────────────

export const CRITERION_STATUS_WORDS: Record<BuildPlanCriterionStatus, string> = {
  planned: 'Planned',
  met: 'Already met',
  not_planned: 'Not planned',
};

// ── evidence ───────────────────────────────────────────────────────────────────────────────────

const DATA_KIND_WORDS: Record<BuildPlanDataKind, string> = {
  fixture: 'Fixture',
  seed: 'Seed data',
  schema: 'Schema',
  migration: 'Migration',
  other: 'Data file',
};

export interface EvidenceLabel {
  /** The tag before the place: "Code", "Docs", "Data". */
  kind: 'Code' | 'Docs' | 'Data';
  /** Where it is, in one line. */
  where: string;
  /** A short second word ("Schema", "Lines moved"); null when none. */
  note: string | null;
}

const lineRange = (a: number, b: number): string => (a === b ? `${a}` : `${a}–${b}`);

export function evidenceLabel(e: BuildPlanEvidence): EvidenceLabel {
  switch (e.kind) {
    case 'code':
      return { kind: 'Code', where: `${e.fullName} · ${e.path}:${lineRange(e.startLine, e.endLine)}`, note: e.linesCorrected ? 'Lines moved' : null };
    case 'data_file':
      return {
        kind: 'Data',
        where: `${e.fullName} · ${e.path}:${lineRange(e.startLine, e.endLine)}`,
        note: [DATA_KIND_WORDS[e.what], e.linesCorrected ? 'lines moved' : null].filter((x) => x != null).join(', '),
      };
    case 'docs':
      return { kind: 'Docs', where: [e.docTitle, e.sectionTitle].filter((x) => x != null && x !== '').join(' › '), note: null };
    case 'data_run':
      return {
        kind: 'Data',
        where: `${e.service} in ${e.stack}`,
        note: e.exitCode == null ? 'Query run' : `Query run, exit ${e.exitCode}`,
      };
  }
}

/** The file's lines on GitHub at the session's base commit (a code or data-file evidence). Raw: the
 *  component passes it through `safeExternalUrl`. */
export function evidenceGithubUrl(e: BuildPlanEvidence): string | null {
  if (e.kind !== 'code' && e.kind !== 'data_file') return null;
  if (!/^[\w.-]+\/[\w.-]+$/.test(e.fullName) || !/^[0-9a-f]{7,64}$/i.test(e.baseSha)) return null;
  const path = e.path
    .split('/')
    .map((p) => encodeURIComponent(p))
    .join('/');
  return `https://github.com/${e.fullName}/blob/${e.baseSha}/${path}#L${e.startLine}${e.endLine !== e.startLine ? `-L${e.endLine}` : ''}`;
}

/** A host excerpt's lines with their numbers (the panel draws them as plain text). */
export function excerptLines(e: Extract<BuildPlanEvidence, { kind: 'code' | 'data_file' }>): Array<{ n: number; text: string }> {
  const lines = e.excerpt.replace(/\n$/, '').split('\n');
  return lines.map((text, i) => ({ n: e.startLine + i, text }));
}

// ── the stack (the plan's, and the planned PRs after Approve) ─────────────────────────────────────

export interface StackRow {
  key: string;
  /** 1-based position in the whole plan. */
  n: number;
  fullName: string;
  title: string;
  criteria: string[];
  /** "Builds on P1" (the PR before it in its repository), or null. */
  buildsOn: string | null;
  /** "After P2" for a dependency in another repository; null when none. */
  after: string | null;
}

type StackLike = Pick<BuildPlanPr, 'key' | 'repoId' | 'fullName' | 'stackIndex' | 'title' | 'criteria' | 'dependsOn'>;

/** The plan's PRs in order, each with its "builds on" (same repository) and "after" (another one) words. */
export function stackRows(stack: readonly StackLike[]): StackRow[] {
  const byKey = new Map(stack.map((p) => [p.key, p] as const));
  return stack.map((p, i) => {
    const prev = stack.find((q) => q.repoId === p.repoId && q.stackIndex === p.stackIndex - 1) ?? null;
    const others = p.dependsOn.filter((k) => k !== prev?.key && byKey.get(k)?.repoId !== p.repoId);
    return {
      key: p.key,
      n: i + 1,
      fullName: p.fullName,
      title: p.title,
      criteria: p.criteria,
      buildsOn: prev != null ? `Builds on ${prev.key}` : null,
      after: others.length > 0 ? `After ${others.join(', ')}` : null,
    };
  });
}

/** The PRs of a revision change more than one repository or stack PRs in one (the stack reason shows). */
export function isStacked(stack: readonly Pick<BuildPlanPr, 'stackIndex'>[]): boolean {
  return stack.some((p) => p.stackIndex > 1);
}

export const STORY_BUILD_PR_STATUS_WORDS: Record<StoryBuildPrStatus, string> = {
  planned: 'Not built yet',
  ready: 'Ready to push',
  empty: 'No changes',
  failed: 'Failed',
  pushed: 'Pushed',
};

export const PR_CHECK_WORDS: Record<StoryBuildPrCheck['result'], string> = {
  passed: 'Passed',
  failed: 'Failed',
  not_run: 'Not run',
};

export const PR_REPORTED_WORDS: Record<NonNullable<StoryBuildPr['reported']>, string> = {
  done: 'Done',
  partly: 'Partly done',
  not_done: 'Not done',
};

/** The planned PRs in plan order. */
export function prsInOrder(prs: readonly StoryBuildPr[]): StoryBuildPr[] {
  return [...prs].sort((a, b) => a.position - b.position);
}

/** The PR this one builds on in its repository (the one before it, skipping empty ones), or null. */
export function previousInRepo(pr: StoryBuildPr, prs: readonly StoryBuildPr[]): StoryBuildPr | null {
  const before = prs.filter((p) => p.repoId === pr.repoId && p.stackIndex < pr.stackIndex && p.status !== 'empty');
  return before.sort((a, b) => b.stackIndex - a.stackIndex)[0] ?? null;
}

export interface PrPushState {
  /** Push is shown (the PR has a change and is not pushed). */
  canPush: boolean;
  /** Why it cannot be pushed yet, in one line; null when it can, or when there is nothing to push. */
  reason: string | null;
}

/**
 * Whether one planned PR may be pushed now. The server checks the same (and more: the earlier PR still
 * open, the tree); this only hides Push until the PRs it builds on are pushed and names the one to push.
 */
export function prPushState(pr: StoryBuildPr, prs: readonly StoryBuildPr[]): PrPushState {
  if (pr.status !== 'ready') return { canPush: false, reason: null };
  const prev = previousInRepo(pr, prs);
  if (prev != null && prev.status !== 'pushed') return { canPush: false, reason: `Push ${prev.key} first.` };
  for (const k of pr.dependsOn) {
    const dep = prs.find((p) => p.key === k);
    if (dep == null || dep.repoId === pr.repoId || dep.status === 'pushed' || dep.status === 'empty') continue;
    return { canPush: false, reason: `Push ${dep.fullName}'s ${dep.key} first.` };
  }
  return { canPush: true, reason: null };
}

/** The PRs Push all would reach (ready, not pushed); the button shows with two or more. */
export function pushAllPrCount(prs: readonly StoryBuildPr[]): number {
  return prs.filter((p) => p.status === 'ready').length;
}

/** The repositories of the stack, in plan order, each with its PRs (the view groups by repository). */
export function prsByRepo(prs: readonly StoryBuildPr[]): Array<{ repoId: number; fullName: string; prs: StoryBuildPr[] }> {
  const out: Array<{ repoId: number; fullName: string; prs: StoryBuildPr[] }> = [];
  for (const p of prsInOrder(prs)) {
    let g = out.find((x) => x.repoId === p.repoId);
    if (g == null) {
      g = { repoId: p.repoId, fullName: p.fullName, prs: [] };
      out.push(g);
    }
    g.prs.push(p);
  }
  return out;
}

// ── THE TICKET REVIEW (components/StoryBuild/TicketUpdatePanel.tsx; docs/TRACKERS.md § The ticket update) ──
//
// Two boxes, Description and Acceptance criteria, each seeded with the plan's draft field, else the
// ticket's current text. When the ticket keeps its criteria IN THE DESCRIPTION, the criteria box shows
// the description's criteria section (and follows the description box until the reader edits it); the
// host splices a sent criteria text into that section.

// ticketReviewSeed / ticketUpdateBody MOVED to shared ticket-layout.ts (2026-11-12): the end-to-end build's
// host-side ticket update uses the SAME rule as the Update ticket button. Re-exported for the panel.
export { ticketReviewSeed, ticketUpdateBody } from '@pierre-review/shared';

/** The criteria box's label: where the update writes them. */
export function criteriaBoxLabel(loc: TicketAcLocation | null): string {
  if (loc?.kind === 'description') return 'Acceptance criteria (in the description)';
  return 'Acceptance criteria';
}

/** The one confirm line: names only the fields that change. */
export function ticketUpdateConfirm(body: { description: string | null; acceptanceCriteria: string | null }): string {
  const what = [body.description != null ? 'description' : null, body.acceptanceCriteria != null ? 'acceptance criteria' : null]
    .filter((x) => x != null)
    .join(' and ');
  return `Replace the ticket's ${what} in Jira?`;
}
