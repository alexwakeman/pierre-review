// WS1c — the layered reviewer classifier (CORE). Resolution order (first HARD hit wins; soft
// signals only accumulate into the MEDIUM band):
//
//   1. Known vendor login (reviewBotKind)               → vendor kind.        HIGH
//   2. githubType==='Bot' OR opt-in app attribution     → fingerprint tool ?? in_house. HIGH
//   3. Branded/marked fingerprint                       → fingerprint tool ?? in_house. HIGH
//   4. Behavioral score (+ allowlist login promotion)   → in_house.          MEDIUM (never auto-badges)
//   5. Opt-in AI tie-break (only if enabled AND medium) → may raise MEDIUM→HIGH.        ai_tiebreak
//   otherwise                                           → human (automated:false).
//
// ── IT DERIVES ONCE PER ACTOR AND WRITES THAT VERDICT TO EVERY ONE OF THE NAMED WORKSPACE ROWS ─
// A bot is a PER-WORKSPACE object, but the SIGNALS are not: a vendor login, `users.githubType`,
// app attribution and the branded-marker fingerprint are all properties of the ACTOR and give the
// same answer in every workspace. Deriving per workspace would multiply the work — and the BILLED
// Haiku tie-break — for an identical result, and would weaken the behavioural score by computing
// it on a thin slice. So `classifyReviewer` takes the actor's TARGET WORKSPACE LIST and `persist`
// fans one verdict out across it.
//
// ── IT GATES ON TWO PROVENANCE FLAGS THAT NOW SHARE ONE ROW ───────────────────────────────────
//   `workspace_reviewers.identity_source = 'manual'` ⇒ leave kind/label alone (a human named this
//                                                      vendor; re-deriving reverts the correction)
//   `workspace_reviewers.source          = 'manual'` ⇒ leave automated/role/confidence/reasons
//                                                      alone FOR THAT WORKSPACE (a human judged
//                                                      this row; the OTHER workspaces still update)
//
// ⚠ THEY USED TO LIVE ON TWO TABLES, AND THAT TABLE BOUNDARY WAS THE ENFORCEMENT. It is gone: both
// facts are columns of one `workspace_reviewers` row now, so the separation is CODE DISCIPLINE —
// a `set:` object narrowed per half, built fresh per workspace, honouring each flag independently.
// The failure it prevents is unchanged: gate identity on the judgement flag and a "not a bot" here
// blanks the vendor's brand colour; gate the judgement on the identity flag and naming a vendor
// freezes auto-detection. See §4.6 / §9.9 of the workspace contract, and the paired tests.
//
// ⚠ THE SHARED-`values`-OBJECT PATTERN IS GONE ON PURPOSE. One object used as both the INSERT
// values and the ON CONFLICT `set:` is correct only while a table holds ONE grain. With judgement,
// identity and price in a single row it would overwrite a human's vendor correction on every auto
// pass — the exact bug the two-table split was built to kill, reintroduced inside one row.
//
// `import type` only from shared.
import { and, eq, inArray, isNotNull } from 'drizzle-orm';
import type {
  AutomatedReviewerKind,
  ClassificationConfidence,
  ClassificationSource,
  ReviewBotKind,
  ReviewerClassification,
  ReviewerRole,
} from '@pierre-review/shared';
import { db, schema } from '../db/client.js';
import { matchesAutomatedLoginPattern, qualityCheckBot, reviewBotKind } from './bot-detection.js';
import type { ReviewFingerprint } from './review-fingerprint.js';
import type { BehavioralSignals } from './reviewer-behavior.js';
import { cheapComplete } from '../review/llm.js';

const { workspaceReviewers, reviewComments, pullRequests } = schema;

// The evidence the caller has already gathered (all optional — the resolver degrades to
// the hard login/type signals when a piece is missing).
export interface ReviewerEvidence {
  fingerprint?: ReviewFingerprint;
  behavioral?: BehavioralSignals;
  appAttributed?: boolean;
}

// Which HALF of the merged row this pass is allowed to write.
//
// It REPLACES the old empty-repo-list trick, which worked only because the two halves were two
// statements against two TABLES with only the second gated on `repoIds.length > 0`: passing `[]`
// wrote the identity and skipped the judgement. With one row and one per-workspace loop, an empty
// list means ZERO iterations and ZERO writes — so "Reset name" would clear `kind` and stop, the
// lazy pass only re-derives a MISSING row, and the brand colour would be gone for good. The two
// reset paths in the query layer therefore pass a REAL workspace id plus `only`.
export interface PersistOpts {
  only?: 'judgement' | 'identity';
}

// The classifier's own knobs. It EXTENDS PersistOpts so `classifyReviewer` takes a single options
// bag: a caller that only wants to name a half passes `{ only: … }`, a caller with per-account
// settings passes the allowlist / tie-break flags, and either is a legal `PersistOpts`.
export interface ClassifyOpts extends PersistOpts {
  // Per-account service-account login globs (Pro settings `bots.loginAllowlist`).
  allowlist?: string[];
  // Opt-in Haiku tie-break for the MEDIUM band (Pro settings `bots.aiTiebreak`).
  enableAiTiebreak?: boolean;
}

// Fallback display labels for the vendor kinds. The frontend's BOT_VENDOR_META is the
// source of truth for rendering; this is what lands in the persisted `label` column.
const VENDOR_LABELS: Record<ReviewBotKind, string> = {
  coderabbit: 'CodeRabbit',
  greptile: 'Greptile',
  copilot: 'Copilot',
  qodo: 'Qodo',
  sourcery: 'Sourcery',
  bito: 'Bito',
  ellipsis: 'Ellipsis',
  korbit: 'Korbit',
  baz: 'Baz',
  graphite: 'Graphite',
  cursor: 'Cursor',
  devin: 'Devin',
  entelligence: 'Entelligence',
  deepsource: 'DeepSource',
  github_code_quality: 'GitHub Code Quality',
  github_advanced_security: 'GitHub Advanced Security',
};

// Exported so the query layer (db/queries.ts) labels analytics/dedup groupings from the
// same source of truth as the persisted classification `label`.
export function labelFor(kind: AutomatedReviewerKind): string {
  if (kind === 'pierre') return 'Limn · Claude';
  if (kind === 'in_house') return 'In-house AI';
  if (kind === 'vendor') return 'Vendor';
  return VENDOR_LABELS[kind] ?? kind;
}

function describeMarkers(fp: ReviewFingerprint): string[] {
  if (fp.markers.length === 0) return ['matched an automated-review fingerprint'];
  const tool = fp.tool ?? 'in-house';
  return [`matched ${tool} fingerprint: ${fp.markers.join(', ')}`];
}

interface BehavioralVerdict {
  medium: boolean;
  reasons: string[];
}

function behavioralVerdict(
  sig: BehavioralSignals | undefined,
  allowlistMatch: boolean,
): BehavioralVerdict {
  // Require account-level evidence (≥3 reviews) before the behavioral band engages.
  if (!sig || sig.reviews < 3) return { medium: false, reasons: [] };
  const reasons: string[] = [];
  let score = 0;
  if (sig.medianPushToReviewMins != null && sig.medianPushToReviewMins < 2) {
    score++;
    reasons.push('reviews land within ~2 min of a push');
  }
  if (sig.reviewsPerPr != null && sig.reviewsPerPr <= 1.2) {
    score++;
    reasons.push('~1 review per PR');
  }
  if (sig.replyRate != null && sig.replyRate < 0.05) {
    score++;
    reasons.push('almost never replies in threads');
  }
  if (sig.commentsPerReview != null && sig.commentsPerReview >= 3) {
    score++;
    reasons.push('many inline comments per review');
  }
  if (allowlistMatch) {
    score++;
    reasons.push('login matches a service-account pattern');
  }
  return { medium: score >= 3, reasons };
}

// NOTE: the old `rowToClassification(row, login)` helper is GONE and is NOT to be reinstated now
// that one row does hold both halves. It built a `ReviewerClassification` out of one row, which
// reads as harmless again — and is exactly how a caller starts treating a row as a single
// undifferentiated verdict, losing the two provenance flags that make the halves independent. A
// caller that wants both facts reads both columns and states which flag governs the one it uses;
// the query layer does exactly that.

// The DEFAULT role for a login nobody has classified by hand: 'quality_check' for the known
// static-analysis / coverage automations, else 'review'.
//
// This is DERIVED, never carried in from the caller, and that is deliberate — see the landmine
// on persist() below.
export function defaultRoleFor(login: string): ReviewerRole {
  return qualityCheckBot(login) ? 'quality_check' : 'review';
}

// The narrowed ON CONFLICT `set:` — every column optional EXCEPT `updatedAt`, which is what makes
// "did this pass acquire anything to write?" a plain key count (see the `length === 1` guard).
//
// ⚠ THERE IS NO PRICE MEMBER, AND THERE MUST NEVER BE ONE. The price is the single column no
// classifier can regenerate; `setReviewerCost` (db/queries.ts) is the only writer in the codebase
// that names it, and this file does not name it at all. Typing the absence here makes a stray
// `Object.assign` a compile error rather than a silent wipe of money the user typed — and this
// runs lazily from listDetectedReviewers, so the wipe would happen just by opening the Bots tab.
type ReviewerSetValues = {
  // ── JUDGEMENT half (gated on the stored `source`) ──
  automated?: boolean;
  role?: ReviewerRole;
  confidence?: ClassificationConfidence;
  source?: ClassificationSource;
  reasonsJson?: string[];
  // ── IDENTITY half (gated on the stored `identity_source`) ──
  kind?: AutomatedReviewerKind | null;
  label?: string | null;
  updatedAt: Date;
};

// Write ONE derived verdict to each of `workspaceIds`' rows. Returns the classification as it now
// applies (with the derived role).
//
// LANDMINE 1 — ONE STATEMENT PER WORKSPACE, WITH A `set:` NARROWED PER HALF. The loop is not an
// oversight to be batched away: an account has few workspaces, and two workspaces may legitimately
// hold DIFFERENT provenance flags for the same actor (manual "not a bot" in one, untouched auto in
// the next). A single batched insert carries ONE `set:` object and physically cannot express that.
//
// LANDMINE 2 — the gate is a READ-THEN-NARROW, not an `onConflictDoUpdate … WHERE`. drizzle
// spells the conditional-update clause differently per dialect, and `db` is typed as
// node-postgres, so a `setWhere` here would compile and then behave differently (or not at all)
// on SQLite. Reading the two provenance flags first and simply not naming the columns a human
// owns is dialect-free.
//
// LANDMINE 3 — `role` is DERIVED from the local quality-check list rather than round-tripped
// through the ReviewerClassification the caller built. Anything in the `set:` OVERWRITES the
// stored column on every auto pass, so copying a stale in-memory role would re-write migration
// 0045's role fold from a stale default and put SonarQube straight back into the review-bot
// metrics. Deriving keeps the write idempotent AND self-healing for a login added to the list
// later. (The parameter is role-LESS on purpose, so a future step in the resolution order
// physically cannot hand one in.)
//
// LANDMINE 4 — THE PRICE COLUMN IS NAMED NOWHERE IN THIS FILE: not in a `set:`, not as a derived
// INSERT value, not as a seed read off a sibling workspace. Price is PER WORKSPACE, so there is no
// sibling that could be authoritative; a row this pass creates simply has no price until someone
// sets one, and because the column is never in the `set:`, a conflict leaves a stored price
// untouched. `ReviewerClassification` carries no cost field either, which makes the omission
// structural rather than a rule to remember. `setReviewerCost` is the one writer.
//
// LANDMINE 5 — the conflict target is the 3-COLUMN tuple
// `workspace_reviewers_account_workspace_author`. A stale target raises "no unique or exclusion
// constraint matching the ON CONFLICT specification" at RUNTIME, in both dialects, only when a row
// is actually written; it type-checks perfectly.
async function persist(
  accountId: number,
  workspaceIds: number[],
  c: Omit<ReviewerClassification, 'role'>,
  opts: PersistOpts = {},
): Promise<ReviewerClassification> {
  const now = new Date();
  const role = defaultRoleFor(c.login);

  for (const workspaceId of workspaceIds) {
    const existing = (
      await db
        .select({
          source: workspaceReviewers.source,
          identitySource: workspaceReviewers.identitySource,
        })
        .from(workspaceReviewers)
        .where(
          and(
            eq(workspaceReviewers.accountId, accountId),
            eq(workspaceReviewers.workspaceId, workspaceId),
            eq(workspaceReviewers.authorUserId, c.userId),
          ),
        )
        .limit(1)
        .execute()
    )[0];

    const set: ReviewerSetValues = { updatedAt: now };
    if (opts.only !== 'identity' && existing?.source !== 'manual') {
      set.automated = c.automated;
      set.role = role;
      set.confidence = c.confidence;
      set.source = c.source;
      set.reasonsJson = c.reasons;
    }
    if (opts.only !== 'judgement' && existing?.identitySource !== 'manual') {
      set.kind = c.kind;
      set.label = c.label;
    }
    // Nothing this pass is allowed to write — emit NO statement at all rather than an UPDATE that
    // only bumps `updated_at`, which would make a skipped row look freshly re-derived.
    if (Object.keys(set).length === 1) continue;

    await db
      .insert(workspaceReviewers)
      .values({
        accountId,
        workspaceId,
        authorUserId: c.userId,
        // The INSERT carries the FULL derived verdict regardless of `only`: `automated`,
        // `confidence` and `source` are NOT NULL, so a brand-new row needs them, and a new row has
        // no human opinion on either half to preserve. The price column is omitted ⇒ NULL.
        // `identity_source` is omitted too, taking its 'auto' default — on the UPDATE path it can
        // only be 'auto' already (a 'manual' identity never reaches the kind/label branch), so
        // writing it would be noise that also reads as if this path may set provenance.
        automated: c.automated,
        role,
        confidence: c.confidence,
        source: c.source,
        reasonsJson: c.reasons,
        kind: c.kind,
        label: c.label,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: [
          workspaceReviewers.accountId,
          workspaceReviewers.workspaceId,
          workspaceReviewers.authorUserId,
        ],
        set,
      })
      .execute();
  }
  return { ...c, role };
}

// Persist the "this is an ordinary human" judgement for an actor that only ever left issue
// comments — the population `classifyReviewer` is deliberately not run for (there are no reviews
// to score, so every signal it could read is absent).
//
// It exists because THE ROW IS THE BOT OBJECT: a (workspace, actor) pair with no row cannot be
// listed, and therefore cannot be corrected by hand either. Writing a low-confidence non-manual
// row makes the pair visible and leaves it fully re-derivable — the moment that person submits a
// real review, the next classification pass overwrites this.
//
// ⚠ TWO PROPERTIES THAT WERE EMERGENT UNDER TWO TABLES AND ARE NOW REQUIREMENTS:
//   (a) the values object contains NO `kind`/`label` AT ALL, so a human judgement can never rename
//       the vendor as a side effect. Under the merged row that omission is the ONLY thing stopping
//       it — there is no longer a table boundary doing the job. (A new row therefore comes up with
//       kind/label NULL, which is correct: a human has no vendor kind, and stamping one is a
//       claim.) The price column is likewise absent, so a price already recorded survives.
//   (b) it still narrows to the workspaces no human owns (`source = 'manual'`) by READING them
//       first, not by a `setWhere` — drizzle spells that clause differently per dialect while `db`
//       is pg-typed.
// Because the shared values object here names ONLY judgement columns and the manual rows are
// already filtered out, one batched statement is safe: every writable row takes identical values.
export async function persistHumanJudgement(
  accountId: number,
  workspaceIds: number[],
  userId: number,
  login: string,
): Promise<void> {
  if (workspaceIds.length === 0) return;
  const manualRows = await db
    .select({ workspaceId: workspaceReviewers.workspaceId })
    .from(workspaceReviewers)
    .where(
      and(
        eq(workspaceReviewers.accountId, accountId),
        eq(workspaceReviewers.authorUserId, userId),
        eq(workspaceReviewers.source, 'manual'),
        inArray(workspaceReviewers.workspaceId, workspaceIds),
      ),
    )
    .execute();
  const manual = new Set(manualRows.map((r) => r.workspaceId));
  const writable = workspaceIds.filter((id) => !manual.has(id));
  if (writable.length === 0) return;
  const values = {
    automated: false,
    role: defaultRoleFor(login),
    confidence: 'low' as const,
    source: 'fingerprint' as const,
    reasonsJson: ['commented on PRs but has not submitted a review'],
    updatedAt: new Date(),
  };
  await db
    .insert(workspaceReviewers)
    .values(writable.map((workspaceId) => ({ accountId, workspaceId, authorUserId: userId, ...values })))
    .onConflictDoUpdate({
      target: [
        workspaceReviewers.accountId,
        workspaceReviewers.workspaceId,
        workspaceReviewers.authorUserId,
      ],
      set: values,
    })
    .execute();
}

// One cheap single-shot completion over up to 3 sample comments. Only invoked from the
// MEDIUM band when `enableAiTiebreak` is set. Returns null (→ stay MEDIUM) when there
// are no samples or Claude auth is unavailable.
async function aiTiebreak(
  accountId: number,
  userId: number,
): Promise<'automated' | 'human' | null> {
  const rows = await db
    .select({ body: reviewComments.body })
    .from(reviewComments)
    .innerJoin(pullRequests, eq(reviewComments.prId, pullRequests.id))
    .where(
      and(
        eq(pullRequests.accountId, accountId),
        eq(reviewComments.authorId, userId),
        isNotNull(reviewComments.body),
      ),
    )
    .limit(3)
    .execute();
  const samples = rows
    .map((r) => (r.body ?? '').trim())
    .filter((s) => s.length > 0)
    .slice(0, 3);
  if (samples.length === 0) return null;
  try {
    const res = await cheapComplete({
      system:
        'You classify whether GitHub PR review comments were written by an automated code-review tool/bot or by a human. Answer with a single word: AUTOMATED or HUMAN.',
      prompt: samples.map((s, i) => `Comment ${i + 1}:\n${s}`).join('\n\n---\n\n'),
      maxTokens: 8,
    });
    const t = res.text.toLowerCase();
    if (t.includes('automat') || t.includes('bot')) return 'automated';
    if (t.includes('human')) return 'human';
    return null;
  } catch {
    return null;
  }
}

// `workspaceIds` is the set of WORKSPACE ROWS this verdict should be written to. It is REQUIRED
// and positional so no caller can "just classify" without saying where the answer lands: the row
// IS the bot object, and a verdict with no row is a verdict nobody can see or correct.
//
// ⚠ AN EMPTY LIST IS A NO-OP WITH NO CALLER, NOT A MECHANISM. It used to be the way to write the
// identity half alone (two statements, two tables, only the judgement gated on the list being
// non-empty). Under one row and one per-workspace loop it writes NOTHING, so the two reset paths
// pass a real workspace id plus `opts.only` instead — see PersistOpts.
//
// THERE IS NO "MANUAL OVERRIDE WINS" EARLY RETURN, and its absence is the point. A manual flag is
// per WORKSPACE and per HALF, so the derivation always runs and `persist` declines exactly the
// columns a human owns — which is what lets a manual "not a bot" in one workspace coexist with a
// fresh auto verdict in the next, and a manual vendor name coexist with a re-derived judgement in
// the same row. The value this function RETURNS is therefore the DERIVED verdict, not necessarily
// what is stored for any given workspace; read the row back if you need that.
export async function classifyReviewer(
  accountId: number,
  user: { id: number; githubLogin: string; githubType?: string | null; isBot: boolean },
  evidence: ReviewerEvidence,
  workspaceIds: number[],
  opts: ClassifyOpts = {},
): Promise<ReviewerClassification> {
  const login = user.githubLogin;
  const fp = evidence.fingerprint;

  // 1. Known vendor login.
  const vendor = reviewBotKind(login);
  if (vendor) {
    return persist(
      accountId,
      workspaceIds,
      {
        userId: user.id,
        login,
        automated: true,
        kind: vendor,
        label: labelFor(vendor),
        confidence: 'high',
        source: 'vendor_login',
        reasons: [`login "${login}" is a known ${labelFor(vendor)} review bot`],
      },
      opts,
    );
  }

  // 2. GitHub App / Bot typename, or opt-in app attribution.
  if (user.githubType === 'Bot' || evidence.appAttributed) {
    const kind: AutomatedReviewerKind = fp?.tool ?? 'in_house';
    const isBotType = user.githubType === 'Bot';
    const source: ClassificationSource = isBotType ? 'github_type' : 'app_attribution';
    const reasons = [
      isBotType ? 'GitHub reports this account as a Bot' : 'posted via a GitHub App',
    ];
    if (fp?.marked) reasons.push(...describeMarkers(fp));
    return persist(
      accountId,
      workspaceIds,
      {
        userId: user.id,
        login,
        automated: true,
        kind,
        label: kind === 'in_house' ? login : labelFor(kind),
        confidence: 'high',
        source,
        reasons,
      },
      opts,
    );
  }

  // 3. Branded/marked fingerprint.
  if (fp?.marked) {
    const kind: AutomatedReviewerKind = fp.tool ?? 'in_house';
    return persist(
      accountId,
      workspaceIds,
      {
        userId: user.id,
        login,
        automated: true,
        kind,
        label: labelFor(kind),
        confidence: 'high',
        source: 'fingerprint',
        reasons: describeMarkers(fp),
      },
      opts,
    );
  }

  // 4. Behavioral band (MEDIUM — never auto-badges; the UI asks "confirm?").
  const allowlistMatch = matchesAutomatedLoginPattern(login, opts.allowlist ?? []);
  const beh = behavioralVerdict(evidence.behavioral, allowlistMatch);
  if (beh.medium) {
    // 5. Opt-in AI tie-break — only from the medium band, only when enabled.
    if (opts.enableAiTiebreak) {
      const ai = await aiTiebreak(accountId, user.id);
      if (ai === 'automated') {
        return persist(
          accountId,
          workspaceIds,
          {
            userId: user.id,
            login,
            automated: true,
            kind: 'in_house',
            label: allowlistMatch ? login : 'In-house AI',
            confidence: 'high',
            source: 'ai_tiebreak',
            reasons: [...beh.reasons, 'AI tie-break: comments read as machine-generated'],
          },
          opts,
        );
      }
      if (ai === 'human') {
        return persist(
          accountId,
          workspaceIds,
          {
            userId: user.id,
            login,
            automated: false,
            kind: null,
            label: login,
            confidence: 'high',
            source: 'ai_tiebreak',
            reasons: [...beh.reasons, 'AI tie-break: comments read as human-written'],
          },
          opts,
        );
      }
      // ai === null → unavailable/ambiguous → fall through to the medium result.
    }
    return persist(
      accountId,
      workspaceIds,
      {
        userId: user.id,
        login,
        automated: true,
        kind: 'in_house',
        label: allowlistMatch ? login : 'In-house AI',
        confidence: 'medium',
        source: 'behavioral',
        reasons: beh.reasons,
      },
      opts,
    );
  }

  // Otherwise → human. Strong (HIGH) when we had enough behavioral evidence to look and
  // it didn't trip; LOW when there was nothing to go on.
  const hadEvidence = (evidence.behavioral?.reviews ?? 0) >= 3;
  return persist(
    accountId,
    workspaceIds,
    {
      userId: user.id,
      login,
      automated: false,
      kind: null,
      label: login,
      confidence: hadEvidence ? 'high' : 'low',
      source: evidence.behavioral ? 'behavioral' : 'fingerprint',
      reasons: hadEvidence
        ? ['no automation markers; reviewing behaviour looks human']
        : ['no automated-reviewer signals'],
    },
    opts,
  );
}
