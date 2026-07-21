// WS1c — the layered reviewer classifier (CORE). Evaluated per (account, author) and
// cached in `bot_review_classification`. Resolution order (first HARD hit wins; soft
// signals only accumulate into the MEDIUM band):
//
//   1. Manual override (a source='manual' row)          → returned verbatim.  HIGH
//   2. Known vendor login (reviewBotKind)               → vendor kind.        HIGH
//   3. githubType==='Bot' OR opt-in app attribution     → fingerprint tool ?? in_house. HIGH
//   4. Branded/marked fingerprint                       → fingerprint tool ?? in_house. HIGH
//   5. Behavioral score (+ allowlist login promotion)   → in_house.          MEDIUM (never auto-badges)
//   6. Opt-in AI tie-break (only if enabled AND medium) → may raise MEDIUM→HIGH.        ai_tiebreak
//   otherwise                                           → human (automated:false).
//
// "Classify the account, not the review" — the resolver persists AUTO rows so a
// newly-seen review inherits the account's cached verdict, and a MANUAL row (the
// override route) is never overwritten by auto. `import type` only from shared.
import { and, eq, isNotNull } from 'drizzle-orm';
import type {
  AutomatedReviewerKind,
  ClassificationConfidence,
  ClassificationSource,
  ReviewBotKind,
  ReviewerClassification,
} from '@pierre-review/shared';
import { db, schema } from '../db/client.js';
import { matchesAutomatedLoginPattern, reviewBotKind } from './bot-detection.js';
import type { ReviewFingerprint } from './review-fingerprint.js';
import type { BehavioralSignals } from './reviewer-behavior.js';
import { cheapComplete } from '../review/llm.js';

const { botReviewClassification, reviewComments, pullRequests } = schema;

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
  if (kind === 'pierre') return 'Pierre · Claude';
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

// Exported so the query layer can build a ReviewerClassification from a cached row
// without re-running the resolver (single-sourced kind/confidence/source casts).
export function rowToClassification(
  row: typeof botReviewClassification.$inferSelect,
  login: string,
): ReviewerClassification {
  return {
    userId: row.authorUserId,
    login,
    automated: row.automated,
    kind: (row.kind as AutomatedReviewerKind | null) ?? null,
    label: row.label ?? login,
    confidence: row.confidence as ClassificationConfidence,
    source: row.source as ClassificationSource,
    reasons: row.reasonsJson ?? [],
  };
}

// Upsert the auto classification on (accountId, authorUserId) and return it. Only ever
// reached on a non-manual path (step 1 returns manual rows before we get here), so the
// plain upsert can't clobber a manual override.
async function persist(
  accountId: number,
  c: ReviewerClassification,
): Promise<ReviewerClassification> {
  const now = new Date();
  const values = {
    automated: c.automated,
    kind: c.kind,
    label: c.label,
    confidence: c.confidence,
    source: c.source,
    reasonsJson: c.reasons,
    updatedAt: now,
  };
  await db
    .insert(botReviewClassification)
    .values({ accountId, authorUserId: c.userId, ...values })
    .onConflictDoUpdate({
      target: [botReviewClassification.accountId, botReviewClassification.authorUserId],
      set: values,
    })
    .execute();
  return c;
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

export async function classifyReviewer(
  accountId: number,
  user: { id: number; githubLogin: string; githubType?: string | null; isBot: boolean },
  evidence: ReviewerEvidence,
  opts: ClassifyOpts = {},
): Promise<ReviewerClassification> {
  const login = user.githubLogin;

  // 1. Manual override always wins — return the stored row verbatim.
  const existing = (
    await db
      .select()
      .from(botReviewClassification)
      .where(
        and(
          eq(botReviewClassification.accountId, accountId),
          eq(botReviewClassification.authorUserId, user.id),
        ),
      )
      .limit(1)
      .execute()
  )[0];
  if (existing && existing.source === 'manual') {
    return rowToClassification(existing, login);
  }

  const fp = evidence.fingerprint;

  // 2. Known vendor login.
  const vendor = reviewBotKind(login);
  if (vendor) {
    return persist(accountId, {
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

  // 3. GitHub App / Bot typename, or opt-in app attribution.
  if (user.githubType === 'Bot' || evidence.appAttributed) {
    const kind: AutomatedReviewerKind = fp?.tool ?? 'in_house';
    const isBotType = user.githubType === 'Bot';
    const source: ClassificationSource = isBotType ? 'github_type' : 'app_attribution';
    const reasons = [
      isBotType ? 'GitHub reports this account as a Bot' : 'posted via a GitHub App',
    ];
    if (fp?.marked) reasons.push(...describeMarkers(fp));
    return persist(accountId, {
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

  // 4. Branded/marked fingerprint.
  if (fp?.marked) {
    const kind: AutomatedReviewerKind = fp.tool ?? 'in_house';
    return persist(accountId, {
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

  // 5. Behavioral band (MEDIUM — never auto-badges; the UI asks "confirm?").
  const allowlistMatch = matchesAutomatedLoginPattern(login, opts.allowlist ?? []);
  const beh = behavioralVerdict(evidence.behavioral, allowlistMatch);
  if (beh.medium) {
    // 6. Opt-in AI tie-break — only from the medium band, only when enabled.
    if (opts.enableAiTiebreak) {
      const ai = await aiTiebreak(accountId, user.id);
      if (ai === 'automated') {
        return persist(accountId, {
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
        return persist(accountId, {
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
    return persist(accountId, {
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
  return persist(accountId, {
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
