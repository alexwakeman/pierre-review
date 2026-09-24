// CLAUDE REVIEW FOLLOW-UP + USER-STORY COLUMNS, through the REAL migrator on a throwaway sqlite DB
// (the my-turn-dismissals.test.ts pattern).
//
// WHAT THIS PINS: migration 0070 is REGISTERED in the sqlite journal and actually adds the four
// columns (an unregistered file SILENTLY SKIPS — the boot looks perfect and every write of these
// columns fails), and the three JSON columns round-trip deep-equal through drizzle's json mode.
// The plugin-side persist round-trip (packages/pro/test/claude-review-persist.test.ts) runs over
// the same real client but is not in CI; this one is.
//
// DATABASE_URL is set BEFORE importing config/client (they open the connection at module load),
// and EVERY import below is dynamic for the same reason.
import { rmSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type {
  ClaudeReviewFollowUpRecord,
  ClaudeReviewTicket,
  ClaudeTicketAssessment,
} from '@pierre-review/shared';

const DB_PATH = '/tmp/pierre-claude-review-follow-up-columns-test.sqlite';
process.env.DATABASE_URL = DB_PATH;
process.env.DISABLE_SCHEDULER = 'true';
process.env.DEPLOYMENT_MODE = 'local';

/* eslint-disable @typescript-eslint/no-explicit-any */
let db: any;
let schema: any;
let closeDb: (() => Promise<void>) | undefined;
let prId = 0;

beforeAll(async () => {
  for (const s of ['', '-shm', '-wal']) rmSync(DB_PATH + s, { force: true });
  const { runMigrations } = await import('./run-migrations.js');
  const client = await import('./client.js');
  db = client.db;
  schema = client.schema;
  closeDb = client.closeDb;
  await runMigrations();

  const { repos, pullRequests } = schema;
  const [repo] = await db
    .insert(repos)
    .values({ accountId: 1, owner: 'acme', name: 'follow-up', githubNodeId: 'R_follow_up' })
    .returning()
    .execute();
  const [pr] = await db
    .insert(pullRequests)
    .values({
      githubNodeId: 'PR_follow_up',
      accountId: 1,
      repoId: repo.id,
      number: 1,
      title: 'fixture',
      state: 'open',
      isDraft: false,
      openedAt: new Date(),
      updatedAt: new Date(),
    })
    .returning()
    .execute();
  prId = pr.id;
});

afterAll(async () => {
  await closeDb?.();
  for (const s of ['', '-shm', '-wal']) rmSync(DB_PATH + s, { force: true });
});

describe('claude_reviews ticket / ticket_assessment / follow_up + findings.prior_finding_id', () => {
  it('round-trips all four columns (and accepts the new model id)', async () => {
    const { claudeReviews, claudeReviewFindings } = schema;
    const { eq } = await import('drizzle-orm');

    const ticket: ClaudeReviewTicket = {
      title: 'Reset password',
      description: 'From the sign-in page.',
      acceptanceCriteria: '- link sent\n- link expires',
      criteria: ['link sent', 'link expires'],
    };
    const ticketAssessment: ClaudeTicketAssessment = {
      alignment: 'partly_aligned',
      summary: 'Expiry missing.',
      criteria: [
        { ref: 'AC1', index: 0, text: 'link sent', status: 'met', explanation: 'Yes.', path: 'a.ts', line: 3 },
        { ref: 'AC2', index: 1, text: 'link expires', status: 'not_checked', explanation: null, path: null, line: null },
      ],
      missing: [],
      notRequested: [{ title: 'Extra flag', explanation: null, path: 'b.ts', line: null }],
    };

    const [earlier] = await db
      .insert(claudeReviews)
      .values({ accountId: 1, prId, headSha: 'aaa', status: 'succeeded', model: 'claude-opus-4-8' })
      .returning()
      .execute();
    const [priorFinding] = await db
      .insert(claudeReviewFindings)
      .values({ reviewId: earlier.id, path: 'a.ts', line: 3, severity: 'warning', title: 't', body: 'b' })
      .returning()
      .execute();

    const followUp: ClaudeReviewFollowUpRecord = {
      priorReviewId: earlier.id,
      priorHeadSha: 'aaa',
      headMoved: true,
      changesSinceShown: false,
      items: [
        {
          ref: 'P1',
          priorFindingId: priorFinding.id,
          sent: true,
          carried: false,
          status: 'not_addressed',
          explanation: 'Still there.',
          path: 'a.ts',
          line: 3,
          side: 'RIGHT',
          severity: 'warning',
          title: 't',
        },
      ],
    };
    const [review] = await db
      .insert(claudeReviews)
      .values({
        accountId: 1,
        prId,
        headSha: 'bbb',
        status: 'succeeded',
        model: 'claude-opus-5-5',
        ticket,
        ticketAssessment,
        followUp,
      })
      .returning()
      .execute();
    await db
      .insert(claudeReviewFindings)
      .values({
        reviewId: review.id,
        path: 'a.ts',
        severity: 'warning',
        title: 't',
        body: 'Raised in the last review and not addressed yet.',
        priorFindingId: priorFinding.id,
      })
      .execute();

    const [back] = await db.select().from(claudeReviews).where(eq(claudeReviews.id, review.id)).execute();
    expect(back.model).toBe('claude-opus-5-5');
    expect(back.ticket).toEqual(ticket);
    expect(back.ticketAssessment).toEqual(ticketAssessment);
    expect(back.followUp).toEqual(followUp);

    const [f] = await db
      .select()
      .from(claudeReviewFindings)
      .where(eq(claudeReviewFindings.reviewId, review.id))
      .execute();
    expect(f.priorFindingId).toBe(priorFinding.id);

    // An older row, written without the new columns, reads them back as null.
    const [old] = await db.select().from(claudeReviews).where(eq(claudeReviews.id, earlier.id)).execute();
    expect(old.ticket).toBeNull();
    expect(old.ticketAssessment).toBeNull();
    expect(old.followUp).toBeNull();
    expect(priorFinding.priorFindingId).toBeNull();
  });
});
