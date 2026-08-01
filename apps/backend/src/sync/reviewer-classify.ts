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
// ── IT DERIVES ONCE PER ACTOR AND WRITES THAT VERDICT TO EVERY ONE OF THAT ACTOR'S REPO ROWS ──
// A bot is a PER-REPO object, but the SIGNALS are not: a vendor login, `users.githubType`, app
// attribution and the branded-marker fingerprint are all properties of the ACTOR and give the
// same answer in every repo. Deriving per repo would multiply the work — and the BILLED Haiku
// tie-break — for an identical result, and would weaken the behavioural score by computing it on
// a thin per-repo slice. So `classifyReviewer` takes the actor's TARGET REPO LIST and `persist`
// fans one verdict out across it.
//
// ── IT GATES ON TWO PROVENANCE FLAGS ON TWO TABLES, AND ONE FLAG FOR BOTH RE-BREAKS IT ────────
//   `account_reviewers.identity_source = 'manual'`  ⇒ leave kind/label alone (a human named this
//                                                     vendor; re-deriving reverts the correction)
//   `repo_reviewers.source          = 'manual'`     ⇒ leave automated/role alone FOR THAT REPO
//     (a human judged this row; re-deriving reverts it — and the OTHER repos still update, which
//      is the whole point of the repo grain)
// They live on different tables now, so confusing them takes a genuine mistake rather than a
// slip. The failure they prevent is unchanged: gate identity on the row flag and a per-repo "not
// a bot" freezes the vendor identity account-wide; gate the judgement on the identity flag and
// naming a vendor freezes auto-detection on every one of its repos.
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

const { repoReviewers, accountReviewers, reviewComments, pullRequests } = schema;

// The evidence the caller has already gathered (all optional — the resolver degrades to
// the hard login/type signals when a piece is missing).
export interface ReviewerEvidence {
  fingerprint?: ReviewFingerprint;
  behavioral?: BehavioralSignals;
  appAttributed?: boolean;
}

export interface ClassifyOpts {
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

// NOTE: the old `rowToClassification(row, login)` helper is GONE. It built a
// `ReviewerClassification` out of ONE `bot_review_classification` row, which was only possible
// while identity and judgement shared a row. They no longer do — `kind`/`label` are on
// `account_reviewers`, `automated`/`role`/`confidence`/`source`/`reasons` on `repo_reviewers` —
// so a caller that wants both must read both, and the query layer does exactly that (and states
// which half it is reading at each call site). Reintroducing a one-row adapter would quietly
// reintroduce the assumption that a repo row knows who the actor is.

// The DEFAULT role for a login nobody has classified by hand: 'quality_check' for the known
// static-analysis / coverage automations, else 'review'.
//
// This is DERIVED, never carried in from the caller, and that is deliberate — see the landmine
// on persist() below.
export function defaultRoleFor(login: string): ReviewerRole {
  return qualityCheckBot(login) ? 'quality_check' : 'review';
}

// Write ONE derived verdict to BOTH grains: the actor's identity row and each of `repoIds`'
// judgement rows. Returns the classification as it now applies (with the derived role).
//
// LANDMINE 1 — TWO STATEMENTS AGAINST TWO TABLES, EACH GATED ON ITS OWN PROVENANCE FLAG. Identity
// (`kind`/`label`) is skipped when `account_reviewers.identity_source = 'manual'`; the judgement
// (`automated`/`role`) is skipped FOR THE REPOS whose `repo_reviewers.source = 'manual'`. Using
// one flag for both is the failure this shape exists to prevent — see the header comment. Note
// the asymmetry: an identity skip is all-or-nothing (one row), a judgement skip is PER REPO, so a
// human's "not a bot" on `web` survives while `api` and `infra` re-derive.
//
// LANDMINE 2 — the gate is a READ-THEN-NARROW, not an `onConflictDoUpdate … WHERE`. drizzle
// spells the conditional-update clause differently per dialect, and `db` is typed as
// node-postgres, so a `setWhere` here would compile and then behave differently (or not at all)
// on SQLite. Selecting the manual rows first and simply not writing them is dialect-free.
//
// LANDMINE 3 — `role` is DERIVED from the local quality-check list rather than round-tripped
// through the ReviewerClassification the caller built. The insert and the ON CONFLICT `set:`
// share ONE values object (they must agree), which means anything in it OVERWRITES the stored
// column on every auto pass. Copying a stale in-memory role would put SonarQube straight back
// into the review-bot metrics on the next pass — the exact miscount `role` exists to fix.
// Deriving keeps the write idempotent AND self-healing for a login added to the list later.
// (The parameter is role-LESS on purpose, so a future step in the resolution order physically
// cannot hand one in.)
//
// LANDMINE 4 — `monthly_cents` MUST STAY OUT of the identity `values`. That object is BOTH the
// insert and the ON CONFLICT `set:`, so naming the column here would wipe the user's price on
// every auto-classification pass — and this runs lazily from listDetectedReviewers, so it would
// happen just by opening the Bots tab. `ReviewerClassification` (the parameter type) carries no
// cost field, which makes the omission structural rather than a rule to remember.
//
// LANDMINE 5 — the judgement conflict target is the 3-COLUMN tuple
// `repo_reviewers_account_repo_author`, the identity target the 2-column
// `account_reviewers_account_author`. A stale target raises "no unique or exclusion constraint
// matching the ON CONFLICT specification" at RUNTIME; it type-checks perfectly.
async function persist(
  accountId: number,
  repoIds: number[],
  c: Omit<ReviewerClassification, 'role'>,
): Promise<ReviewerClassification> {
  const now = new Date();
  const role = defaultRoleFor(c.login);

  // ── IDENTITY (actor grain) ────────────────────────────────────────────────────────────────
  const idRow = (
    await db
      .select({ identitySource: accountReviewers.identitySource })
      .from(accountReviewers)
      .where(
        and(
          eq(accountReviewers.accountId, accountId),
          eq(accountReviewers.authorUserId, c.userId),
        ),
      )
      .limit(1)
      .execute()
  )[0];
  if (idRow?.identitySource !== 'manual') {
    const idValues = { kind: c.kind, label: c.label, updatedAt: now };
    await db
      .insert(accountReviewers)
      .values({ accountId, authorUserId: c.userId, ...idValues })
      .onConflictDoUpdate({
        target: [accountReviewers.accountId, accountReviewers.authorUserId],
        // `identity_source` is deliberately NOT in here: it takes its 'auto' default on insert,
        // and on update it can only be 'auto' already (a 'manual' row never reaches this branch),
        // so writing it would be noise that also looks like this path may set provenance.
        set: idValues,
      })
      .execute();
  }

  // ── JUDGEMENT (repo grain) ────────────────────────────────────────────────────────────────
  if (repoIds.length > 0) {
    const manualRows = await db
      .select({ repoId: repoReviewers.repoId })
      .from(repoReviewers)
      .where(
        and(
          eq(repoReviewers.accountId, accountId),
          eq(repoReviewers.authorUserId, c.userId),
          eq(repoReviewers.source, 'manual'),
          inArray(repoReviewers.repoId, repoIds),
        ),
      )
      .execute();
    const manual = new Set(manualRows.map((r) => r.repoId));
    const writable = repoIds.filter((id) => !manual.has(id));
    if (writable.length > 0) {
      const values = {
        automated: c.automated,
        role,
        confidence: c.confidence,
        source: c.source,
        reasonsJson: c.reasons,
        updatedAt: now,
      };
      await db
        .insert(repoReviewers)
        .values(writable.map((repoId) => ({ accountId, repoId, authorUserId: c.userId, ...values })))
        .onConflictDoUpdate({
          target: [repoReviewers.accountId, repoReviewers.repoId, repoReviewers.authorUserId],
          set: values,
        })
        .execute();
    }
  }
  return { ...c, role };
}

// Persist the "this is an ordinary human" judgement for an actor that only ever left issue
// comments — the population `classifyReviewer` is deliberately not run for (there are no reviews
// to score, so every signal it could read is absent).
//
// It exists because THE ROW IS THE BOT OBJECT: a (repo, actor) pair with no row cannot be listed,
// and therefore cannot be corrected by hand either. Writing a low-confidence non-manual row makes
// the pair visible and leaves it fully re-derivable — the moment that person submits a real
// review, the next classification pass overwrites this.
//
// Same two gates as persist(): it never touches a `source='manual'` repo row, and it writes NO
// identity at all (a human has no vendor kind to record, and stamping one would be a claim).
export async function persistHumanJudgement(
  accountId: number,
  repoIds: number[],
  userId: number,
  login: string,
): Promise<void> {
  if (repoIds.length === 0) return;
  const manualRows = await db
    .select({ repoId: repoReviewers.repoId })
    .from(repoReviewers)
    .where(
      and(
        eq(repoReviewers.accountId, accountId),
        eq(repoReviewers.authorUserId, userId),
        eq(repoReviewers.source, 'manual'),
        inArray(repoReviewers.repoId, repoIds),
      ),
    )
    .execute();
  const manual = new Set(manualRows.map((r) => r.repoId));
  const writable = repoIds.filter((id) => !manual.has(id));
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
    .insert(repoReviewers)
    .values(writable.map((repoId) => ({ accountId, repoId, authorUserId: userId, ...values })))
    .onConflictDoUpdate({
      target: [repoReviewers.accountId, repoReviewers.repoId, repoReviewers.authorUserId],
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

// `repoIds` is the set of REPO ROWS this verdict should be written to — the actor's in-scope
// pairs. It is REQUIRED and positional so no caller can "just classify" without saying where the
// answer lands: the row IS the bot object, and a verdict with no row is a verdict nobody can see
// or correct. An empty list is legal (the identity half still writes) but does nothing useful.
//
// THERE IS NO "MANUAL OVERRIDE WINS" EARLY RETURN ANY MORE, and its absence is the point. Under
// one table, one manual row shadowed the whole derivation for that actor. Now a manual row is
// per REPO and per GRAIN, so the derivation always runs and `persist` declines the rows a human
// owns — which is what lets a manual "not a bot" on `web` coexist with fresh auto verdicts on
// `api` and `infra`. The value this function RETURNS is therefore the DERIVED verdict, not
// necessarily what is stored for any given repo; read the rows back if you need that.
export async function classifyReviewer(
  accountId: number,
  user: { id: number; githubLogin: string; githubType?: string | null; isBot: boolean },
  evidence: ReviewerEvidence,
  repoIds: number[],
  opts: ClassifyOpts = {},
): Promise<ReviewerClassification> {
  const login = user.githubLogin;
  const fp = evidence.fingerprint;

  // 1. Known vendor login.
  const vendor = reviewBotKind(login);
  if (vendor) {
    return persist(accountId, repoIds, {
      userId: user.id,
      login,
      automated: true,
      kind: vendor,
      label: labelFor(vendor),
      confidence: 'high',
      source: 'vendor_login',
      reasons: [`login "${login}" is a known ${labelFor(vendor)} review bot`],
    });
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
    return persist(accountId, repoIds, {
      userId: user.id,
      login,
      automated: true,
      kind,
      label: kind === 'in_house' ? login : labelFor(kind),
      confidence: 'high',
      source,
      reasons,
    });
  }

  // 3. Branded/marked fingerprint.
  if (fp?.marked) {
    const kind: AutomatedReviewerKind = fp.tool ?? 'in_house';
    return persist(accountId, repoIds, {
      userId: user.id,
      login,
      automated: true,
      kind,
      label: labelFor(kind),
      confidence: 'high',
      source: 'fingerprint',
      reasons: describeMarkers(fp),
    });
  }

  // 4. Behavioral band (MEDIUM — never auto-badges; the UI asks "confirm?").
  const allowlistMatch = matchesAutomatedLoginPattern(login, opts.allowlist ?? []);
  const beh = behavioralVerdict(evidence.behavioral, allowlistMatch);
  if (beh.medium) {
    // 5. Opt-in AI tie-break — only from the medium band, only when enabled.
    if (opts.enableAiTiebreak) {
      const ai = await aiTiebreak(accountId, user.id);
      if (ai === 'automated') {
        return persist(accountId, repoIds, {
          userId: user.id,
          login,
          automated: true,
          kind: 'in_house',
          label: allowlistMatch ? login : 'In-house AI',
          confidence: 'high',
          source: 'ai_tiebreak',
          reasons: [...beh.reasons, 'AI tie-break: comments read as machine-generated'],
        });
      }
      if (ai === 'human') {
        return persist(accountId, repoIds, {
          userId: user.id,
          login,
          automated: false,
          kind: null,
          label: login,
          confidence: 'high',
          source: 'ai_tiebreak',
          reasons: [...beh.reasons, 'AI tie-break: comments read as human-written'],
        });
      }
      // ai === null → unavailable/ambiguous → fall through to the medium result.
    }
    return persist(accountId, repoIds, {
      userId: user.id,
      login,
      automated: true,
      kind: 'in_house',
      label: allowlistMatch ? login : 'In-house AI',
      confidence: 'medium',
      source: 'behavioral',
      reasons: beh.reasons,
    });
  }

  // Otherwise → human. Strong (HIGH) when we had enough behavioral evidence to look and
  // it didn't trip; LOW when there was nothing to go on.
  const hadEvidence = (evidence.behavioral?.reviews ?? 0) >= 3;
  return persist(accountId, repoIds, {
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
  });
}
