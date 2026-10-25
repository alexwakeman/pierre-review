import { and, eq } from 'drizzle-orm';
import { GENERIC_REVIEWER_LABELS } from '@pierre-review/shared';
import type {
  AutomatedReviewerKind,
  BotSignalCard,
  DigestPrRef,
  WorkspaceInsightsResponse,
} from '@pierre-review/shared';
import type { ProContext } from '../contract.js';
import type { LlmClient } from '../llm/seam.js';
import { refreshSprintReport, storedSprintReport } from '../insights/sprint-report.js';
import { workspaceScope } from '../insights/workspace-request.js';
import { getComparisonWindow } from '../settings/store.js';
import { fitSections, toSlackMrkdwn } from './format.js';
import { escapeSlack, prLink, repoLink, slackLink, workspaceLink } from './links.js';
import { buildPendingBlocks } from './pending-blocks.js';
import { readTargetRow } from './targets.js';

const SECTION_MAX = 2900; // Slack section text hard limit is 3000 chars
// A summary that outgrows its budget is split at LINE boundaries (format.ts `fitSections`) and the
// last kept chunk ends with "…" — titles and authors roughly double a summary's length, and a hard
// cut could land inside a link. A line naming many PRs is listed one PR per line (format.ts
// `LIST_MIN_REFS`), so it can split too.
//
// The sprint summary is SHORT now: it follows the Pending sections, which carry the PRs.
const SPRINT_MAX_SECTIONS = 1;
// The block budget: header 1 + Pending 6 tabs × ≤2 sections (pending-blocks.ts) + dividers 2 +
// sprint 1 + bot 1 + footer 1 = 18, far under Slack's 50. The final `slice(0, SLACK_MAX_BLOCKS)`
// backstop is kept anyway, and keeps the footer: it drops body blocks, never the last one.
export const SLACK_MAX_BLOCKS = 48;

// For link-free text only (the bot block). Anything carrying `<url|text>` goes through
// `fitSections`, which never cuts inside a link.
const truncate = (s: string): string =>
  s.length > SECTION_MAX ? `${s.slice(0, SECTION_MAX - 1)}…` : s;

// ⚠ EVERY mrkdwn object is `verbatim: true`. Slack's default (false) auto-links bare URLs, turns
// channel names into links and parses some mentions — and PR titles, which are attacker-authored,
// now reach the message verbatim. Escaping (format.ts / links.ts) stops forged `<…>` markup; this
// stops Slack's own preprocessing. Explicit `<url|text>` links still render.
const mrkdwn = (text: string) => ({ type: 'mrkdwn', text, verbatim: true });
const section = (text: string) => ({ type: 'section', text: mrkdwn(text) });
const fmtDate = (iso: string): string => (iso ? iso.slice(0, 10) : '');

export interface SlackMessage {
  blocks: unknown[];
  text: string; // notification fallback
}

// Display label for an automated-reviewer kind. Falls back to the raw kind for the long tail.
//
// ⚠ THIS IS THE THIRD COPY OF THIS MAP AND IT IS THE ONE THAT ROTTED. Its siblings are
// `BOT_VENDOR_META` (apps/frontend/src/lib/ui.ts) and `labelFor` (apps/backend/src/sync/
// reviewer-classify.ts). Both were renamed Pierre→Limn and both rejected "In-house AI"; this
// copy sat in a Slack digest still emitting "Pierre · Claude" and "In-house AI", because a
// digest bullet is the one place nobody looks. The three UNBRANDED kinds now come from
// `GENERIC_REVIEWER_LABELS` in shared and cannot drift again. The branded ones below still
// can — change one, change all three.
const BOT_LABELS: Partial<Record<AutomatedReviewerKind, string>> = {
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
  ...GENERIC_REVIEWER_LABELS,
};
const vendorLabel = (kind: AutomatedReviewerKind): string => BOT_LABELS[kind] ?? kind;

// The deterministic "Review bots" signal-to-noise block (WS5). Reads the workspace's bot_signal
// card off the workspace Insights getter + THIS DELIVERY's `bot_digest` toggle. Returns [] (no
// block) when the toggle is off, no bot activity exists, or no card is present. NOT AI-gated —
// it's a pure DB read.
//
// SCOPE: `workspaceId` is the workspace this delivery is FOR (one row in
// `workspace_slack_targets`), passed down by the caller. It used to be the account's DEFAULT
// workspace and nothing else — the reduction docs/MIGRATIONS.md recorded — because the sweep had
// one webhook per account and no way to name a second. It now has one per workspace, so the
// scope is simply the target's own.
//
// ⚠ THE TOGGLE IS PER DELIVERY AS OF PLUGIN MIGRATION 0033, AND THE OLD COMMENT HERE WAS WRONG.
// It read: "the `bot_slack_digest` TOGGLE stays account-wide: it is a 'do I want this block at
// all' preference, not a per-team fact." That premise died in plugin 0030, when the digest itself
// became per-workspace — from that moment one account flag was deciding the CONTENT of N
// independently-scheduled messages about N different teams' bots, and a team with no bots got a
// section about somebody else's problem. The flag now lives on the row that IS the delivery, and
// the migration copied the account value onto every existing row so nobody lost the block.
//
// ⚠ IT IS RE-READ HERE RATHER THAN PASSED IN, even though both callers (the cron sweep and the
// "Send test" route) already hold the row. One extra indexed read per send buys the guarantee that
// the flag governing this block is the flag on the delivery being built — a parameter is how the
// two silently drift.
async function buildBotBlocks(
  ctx: ProContext,
  accountId: number,
  workspaceId: number,
): Promise<unknown[]> {
  const target = await readTargetRow(ctx, accountId, workspaceId);
  if (!(target?.botDigest ?? false)) return [];
  // THIS workspace's cadence, through the one resolver every request path uses. The population
  // widening that plugin 0030 performed was exactly this: a change to WHICH workspaces are
  // iterated, and nothing else about how a window is resolved.
  const window = await getComparisonWindow(ctx, accountId, workspaceId);
  // The workspace owns the judgement grain (who counts as an automated reviewer) AND, via the
  // watch-intersected repo ids, the data narrowing — so the card cannot be computed over one
  // workspace's repos through another's verdicts. Assembled by `workspaceScope`, never by hand.
  const insights = (await ctx.queries.getWorkspaceInsights(
    accountId,
    { fromMs: window.fromMs, toMs: window.toMs },
    await workspaceScope(ctx, accountId, workspaceId),
  )) as WorkspaceInsightsResponse;
  const card = insights.cards.find((c): c is BotSignalCard => c.kind === 'bot_signal');
  if (!card || card.totalThreads === 0) return [];

  const pct = card.actedOnPct == null ? '—' : `${Math.round(card.actedOnPct)}%`;
  const oldest = card.oldestUntouchedDays == null ? '' : ` (oldest ${card.oldestUntouchedDays}d)`;
  const headline = `*Review bots* — ${card.totalThreads} comments · ${pct} acted on · ${card.totalUntouched} untouched${oldest}`;
  const vendorLines = card.vendors
    .map((v) => {
      const vpct = v.threads === 0 ? '—' : `${Math.round((v.actedOn / v.threads) * 100)}%`;
      return `• ${vendorLabel(v.kind)}: ${v.threads} · ${vpct} acted on · ${v.untouched} untouched`;
    })
    .join('\n');
  const text = vendorLines ? `${headline}\n${vendorLines}` : headline;
  return [section(truncate(text))];
}

// Assemble the Slack Block Kit message for ONE WORKSPACE: the workspace's TEAM Pending tabs
// (pending-blocks.ts), then a short AI sprint summary, then the optional bot block. Returns null
// when there is nothing to say.
//
// EVERY LINK IN THE MESSAGE POINTS INTO LIMN — the footer (the workspace), each Pending tab, each
// repo and every PR. Titles and authors are read on THIS send; nothing about them reaches a payload
// hash, so they never re-bill.
//
// ── THE COST STORY. READ THIS BEFORE CHANGING WHAT THIS FUNCTION GENERATES ───────────────────
//
//   • THE PENDING SECTIONS ARE FREE. One call to the host's board fold (`getPendingBoard`), with
//     the route's two live extras off — no GitHub call, no model. ⚠ It is LIVE state and must
//     never enter a payload hash, or every send re-bills.
//   • THE SPRINT REPORT MULTIPLIES, AND IT IS THE ONLY THING THAT DOES. `refreshSprintReport` is
//     keyed by (account, WORKSPACE) — its own throttle, row and payload hash. N workspaces ⇒ up to
//     N Haiku calls per send, $0 for any workspace whose insights have not changed. The bound on N
//     is `SLACK_TARGET_WORKSPACE_CAP` (12), enforced at the write (slack/targets.ts) and disclosed
//     in the Settings copy.
//   • THE PER-REPO AI DIGESTS ARE GONE from Slack. The Pending sections name the PRs now, and the
//     digests' 40-block budget was what crowded them out.
//   • THE BOT BLOCK IS DETERMINISTIC (pure DB reads) and costs nothing per workspace.
export async function buildSlackReport(
  ctx: ProContext,
  llm: LlmClient,
  accountId: number,
  workspaceId: number,
  // False when the scheduled send found the Claude spend budget reached: the sprint summary is the
  // stored one, never regenerated. A reader's "Send now" leaves it undefined (a click is not gated).
  opts: { modelAllowed?: boolean } = {},
): Promise<SlackMessage | null> {
  // The board first. Optional seam: an older host has none, and the message is then the sprint
  // summary and bot block alone. A failed read degrades the same way rather than losing the send.
  let pendingBlocks: unknown[] = [];
  if (ctx.queries.getPendingBoard != null) {
    try {
      const board = await ctx.queries.getPendingBoard(accountId, workspaceId);
      pendingBlocks = buildPendingBlocks(ctx, board, section);
    } catch (err) {
      ctx.log.warn({ err, accountId, workspaceId }, 'slack: pending board read failed');
    }
  }

  const sprint =
    opts.modelAllowed === false
      ? await storedSprintReport(ctx, accountId, workspaceId)
      : await refreshSprintReport(ctx, llm, accountId, workspaceId);
  const workspaceRepoIds = new Set((await workspaceScope(ctx, accountId, workspaceId)).repoIds);

  // The app deep links. `null` whenever the host published no `appWebUrl` (an older host), in
  // which case every link degrades to plain text rather than to a broken href — never to GitHub.
  const wsUrl = workspaceLink(ctx, workspaceId);
  const prUrl = (r: DigestPrRef): string | null =>
    r.prId == null ? null : prLink(ctx, workspaceId, r.prId);
  const repoUrl = (repoId: number): string | null => repoLink(ctx, workspaceId, repoId);
  const workspaceName = await workspaceNameFor(ctx, accountId, workspaceId);

  const body: unknown[] = [...pendingBlocks];
  const hasSprint = sprint != null && sprint.summary.trim() !== '';
  if (hasSprint) {
    if (body.length > 0) body.push({ type: 'divider' });
    // Narrowed to THIS workspace's repos. `enrichedPrRefs` resolves any `owner/name#N` across the
    // whole account, so a stray token naming another workspace's PR stays plain text and never
    // prints that PR's title into this team's channel.
    const sprintRefs = sprint.prRefs.filter((r) => workspaceRepoIds.has(r.repoId));
    const heading = `*Sprint summary* · ${fmtDate(sprint.sprint.from)} – ${fmtDate(sprint.sprint.to)}`;
    for (const chunk of fitSections(
      `${heading}\n${toSlackMrkdwn(sprint.summary, sprintRefs, { prUrl, repoUrl })}`,
      SECTION_MAX,
      SPRINT_MAX_SECTIONS,
    )) {
      body.push(section(chunk));
    }
  }

  // The bot signal-to-noise block is DETERMINISTIC (no AI) — it may be the only content, so the
  // empty-guard below accepts a bot-only message.
  const botBlocks = await buildBotBlocks(ctx, accountId, workspaceId);
  if (botBlocks.length > 0) {
    if (body.length > 0) body.push({ type: 'divider' });
    body.push(...botBlocks);
  }

  if (body.length === 0) return null;

  // What the message leads with — the header and the notification fallback say the same thing.
  const lead =
    pendingBlocks.length > 0 ? 'Pending' : hasSprint ? 'sprint summary' : 'review bots';
  const blocks: unknown[] = [
    {
      type: 'header',
      text: {
        type: 'plain_text',
        // The workspace is NAMED in the header: with several channels (or several messages in one
        // channel) it is the only thing telling a reader whose numbers they are looking at.
        text: `${workspaceName} · ${lead}`.slice(0, 150),
      },
    },
    ...body,
  ];

  // The footer link back into the app, for the workspace this message describes. Emitted only
  // when the host published a base URL; a `context` block keeps it visually subordinate.
  const footer =
    wsUrl == null
      ? null
      : {
          type: 'context',
          // `slackLink` escapes the (user-typed) workspace name, so a `|`, `>` or `<!here>` in it
          // can neither end the link early nor ping the channel.
          elements: [mrkdwn(slackLink(wsUrl, `Open ${workspaceName} in Limn`))],
        };
  // Backstop: never over Slack's limit, and never at the footer's expense.
  const room = SLACK_MAX_BLOCKS - (footer == null ? 0 : 1);
  const out = blocks.slice(0, room);
  if (footer != null) out.push(footer);

  // The notification fallback is parsed as mrkdwn too, so the name is escaped here as well.
  const name = escapeSlack(workspaceName);
  const text = `${name} · ${lead}`;
  return { blocks: out, text };
}

// The workspace's display name, for the header and the footer link. Falls back to a neutral label
// rather than an empty string: a message that says whose numbers these are is the whole point of
// naming it, and "Workspace 7" is at least an id somebody can look up.
async function workspaceNameFor(
  ctx: ProContext,
  accountId: number,
  workspaceId: number,
): Promise<string> {
  const wsT = ctx.schema.workspaces;
  const rows = (await ctx.db
    .select({ name: wsT.name })
    .from(wsT)
    .where(and(eq(wsT.id, workspaceId), eq(wsT.accountId, accountId)))
    .limit(1)
    .execute()) as Array<{ name: string }>;
  return rows[0]?.name ?? `Workspace ${workspaceId}`;
}
