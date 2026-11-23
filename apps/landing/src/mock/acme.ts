// ---------------------------------------------------------------------------
// THE FICTIONAL ACME TEAM — the one source of every product mock on this site.
//
// Every HTML mock (components/mock/*) reads its words and numbers from here, so a
// pull request keeps the same number, title and repository wherever it appears:
// #612 is always "Partial refunds" in acme/payments, PAY-142 is always its story.
//
// The words on chips, tabs and buttons are the app's own labels ("Criteria 3/4",
// "Waiting on others", "Nudge", "Flaky", "Re-run failed jobs", "2 of 3 in stack",
// "Large"). Keep them exactly as the app spells them.
//
// THE MOCKS ARE CLICKABLE, so this file also holds the states they move through
// (a fix that becomes "Pushed", a re-run that becomes "Re-run requested."). Each
// mock's FIRST state is the one the prerendered HTML shows. When the app changes a
// label, a tab or a flow that a mock shows, change it here and in the mock in the
// same commit (apps/landing/README.md, "The mocks mirror the app").
// ---------------------------------------------------------------------------

export type Tone = 'red' | 'amber' | 'green' | 'blue' | 'grey' | 'gold';

export const REPOS = {
  payments: 'acme/payments',
  web: 'acme/web',
  api: 'acme/api',
  ledger: 'acme/ledger',
} as const;

export type Pr = { num: number; title: string; repo: string };

export const PRS = {
  refunds: { num: 612, title: 'Partial refunds', repo: REPOS.payments },
  settings: { num: 1190, title: 'Settings split', repo: REPOS.web },
  retry: { num: 482, title: 'Retry budget', repo: REPOS.payments },
  webhooks: { num: 488, title: 'Webhook timeouts', repo: REPOS.api },
  ledgerRename: { num: 701, title: 'Rename ledger', repo: REPOS.ledger },
  ledgerIndex: { num: 476, title: 'Ledger index', repo: REPOS.payments },
  checkout: { num: 1184, title: 'Checkout redesign', repo: REPOS.web },
  idempotency: { num: 493, title: 'Idempotency keys', repo: REPOS.api },
  payouts: { num: 470, title: 'Payout batching', repo: REPOS.payments },
} satisfies Record<string, Pr>;

export const prLabel = (p: Pr): string => `#${p.num} ${p.title}`;

// ---- the story ------------------------------------------------------------

export const STORY = {
  key: 'PAY-142',
  title: 'Partial refunds',
  criteria: [
    { n: 1, text: 'Partial refund keeps the order open', status: 'Met', tone: 'green' },
    { n: 2, text: 'Customer gets one email', status: 'Partly met', tone: 'amber' },
    { n: 3, text: 'No refunds after 30 days', status: 'Not met', tone: 'red' },
    { n: 4, text: 'Refund reaches the daily ledger', status: 'Met', tone: 'green' },
  ] as { n: number; text: string; status: string; tone: Tone }[],
  /** The chip on the pull request's row. */
  chip: 'Criteria 3/4',
} as const;

/** What the story check and the docs check said about #612. */
export const FINDINGS = {
  storyMajor: {
    sev: 'Major',
    head: 'Criterion 3 not met.',
    text: 'Refunds older than 30 days still go through.',
  },
  docsMajor: {
    sev: 'Major',
    head: 'Handbook §4.2.',
    text: 'amount is a float; money is whole pence.',
  },
  /** The AI Review tab's open findings. `by` is who raised it, as every row names it. */
  review: [
    { sev: 'Major', tone: 'red', code: 'RefundPolicy.allows()', text: 'never reads paid_at.', by: 'You and Priya' },
    { sev: 'Minor', tone: 'amber', code: null, text: 'Retried refund sends a second email.', by: 'You' },
    { sev: 'Nit', tone: 'grey', code: 'policy.py', text: 'Unused import in', by: 'You' },
  ] as { sev: string; tone: Tone; code: string | null; text: string; by: string }[],
  /** Closed findings, under "Resolved or addressed (n)", each saying why (lib/teamReview.ts closedReason)
   *  and, where the latest review judged it, how in one line (the app's EarlierFindingNote). */
  closed: [
    {
      sev: 'Major',
      tone: 'red',
      text: 'A partial refund closes the order.',
      by: 'You',
      reason: 'Priya’s review found it addressed · 3 Nov',
      how: 'The order now stays open until the full amount is refunded.',
    },
    { sev: 'Minor', tone: 'amber', text: 'Refund amount is not logged.', by: 'Priya', reason: 'Resolved on GitHub', how: null },
  ] as { sev: string; tone: Tone; text: string; by: string; reason: string; how: string | null }[],
  docs: { source: 'Payments handbook', section: '§4.2', text: 'money in whole pence' },
} as const;

// ---- the Pending board ------------------------------------------------------

/** The Pending board's tabs, as the app names them (Activity/pendingTabs.ts TAB_LABEL). */
export type PendingTabId = 'my_turn' | 'claude' | 'fixing' | 'land' | 'waiting';
export type PendingCardId = 'settings' | 'reply' | 'flaky' | 'land' | 'waiting';

export type PendingCard = {
  pr: Pr;
  chip: string;
  tone: Tone;
  why: string;
  size?: string;
  high?: string;
  detail?: string[];
};

export const PENDING = {
  workspace: 'Acme payments',
  you: 'dana',
  tabs: [
    { id: 'my_turn', label: 'My turn' },
    { id: 'claude', label: 'AI reviews' },
    { id: 'fixing', label: 'Needs fixing' },
    { id: 'land', label: 'Ready to land' },
    { id: 'waiting', label: 'Waiting on others' },
  ] as { id: PendingTabId; label: string }[],
  waiting: { who: 'sam', hours: 6, target: 4 },
  /** One card per pull request. `why` is the line under the title; `detail` shows when it is opened. */
  cards: {
    settings: {
      pr: PRS.settings,
      chip: 'Your review',
      tone: 'blue',
      why: 'Asked 26 working hours ago · +420 −88',
      size: 'Large',
      detail: ['Priya asked for your review.', '2 of 3 in stack: #1189 lands first.'],
    },
    reply: {
      pr: PRS.ledgerRename,
      chip: 'Reply owed',
      tone: 'amber',
      why: 'Priya replied to your thread',
      detail: ['“Kept the old table name as a view until the nightly job is retired.”'],
    },
    flaky: {
      pr: PRS.webhooks,
      chip: 'CI failing',
      tone: 'red',
      why: 'test-api failed · Flaky',
    },
    land: {
      pr: PRS.retry,
      chip: 'Ready',
      tone: 'green',
      why: '2 approvals · threads resolved · checks green',
    },
    waiting: {
      pr: PRS.idempotency,
      chip: 'With sam · 6h',
      tone: 'grey',
      why: 'Over the 4h review target',
    },
  } as Record<PendingCardId, PendingCard>,
  /** Which cards sit in which tab. A tab's count is its length. */
  byTab: {
    // My turn is "a person is waiting on you": both sit in its first group, Waiting on you.
    my_turn: ['settings', 'reply'],
    claude: [],
    fixing: ['flaky'],
    land: ['land'],
    waiting: ['waiting'],
  } as Record<PendingTabId, PendingCardId[]>,
  /** AI reviews: the newest AI review on each PR, theirs and their teammates', newest first
   *  (Activity/PendingAiReviews.tsx). Read-only rows; `isNew` = since the reader last opened the tab;
   *  `seen` = the visit that first showed it ("Seen today 09:12"), one block per visit. */
  aiSeen: [
    { pr: PRS.refunds, by: 'Your Ensemble', verdict: 'Request changes', tone: 'red', findings: '2 findings', when: '4 min ago', isNew: true },
    { pr: PRS.ledgerIndex, by: 'Priya’s Ensemble', verdict: 'Comment', tone: 'grey', findings: '1 finding', when: '1 hour ago', isNew: false, seen: 'Seen today 09:12' },
  ] as { pr: Pr; by: string; verdict: string; tone: Tone; findings: string; when: string; isNew: boolean; seen?: string }[],
};

/** A Pending tab's badge: its cards; AI reviews' badge is its rows marked New. */
export const pendingTabCount = (id: PendingTabId): number =>
  id === 'claude' ? PENDING.aiSeen.filter((r) => r.isNew).length : PENDING.byTab[id].length;

/** The words a button says before, while and after it works. The app's own. */
export const ACTIONS = {
  nudge: { idle: 'Nudge', busy: 'Nudging…', done: 'Nudged' },
  rerun: { idle: 'Re-run failed jobs', busy: 'Requesting…', done: 'Re-run requested.' },
  merge: { idle: 'Merge', busy: 'Merging…', done: 'Merged' },
  fixItems: { idle: 'Fix 2 items', busy: 'Fixing…', done: 'Ready to push' },
};

// ---- one pull request (#612), as its detail pane shows it ---------------------

export type PrTabId = 'overview' | 'changes' | 'claude_review' | 'ai_fix';

export const PR_VIEW = {
  pr: PRS.refunds,
  branch: 'dana/partial-refunds',
  /** The detail pane's tabs, in the app's order (PrDetail.tsx TAB_LABELS). A subset: the app's
   *  Activity and Threads tabs (between Overview and Changes) are not drawn here. */
  tabs: [
    { id: 'overview', label: 'Overview' },
    { id: 'changes', label: 'Changes' },
    // The count is every finding open now (PrDetail `useOpenAiReviewCount`): the major, minor and nit.
    { id: 'claude_review', label: 'AI Review', count: 3 },
    { id: 'ai_fix', label: 'AI Fix' },
  ] as { id: PrTabId; label: string; count?: number }[],
  /** The Overview in the app's order (ChecksTab.tsx): the AI review card, Checks, People
   *  (GitHub's review decision words, as the header's review pill says them), About. */
  overview: [
    { name: 'AI review', state: '1 major · 1 minor · 1 nit', tone: 'red' },
    { name: 'build', state: 'Passed', tone: 'green' },
    { name: 'test-api', state: 'Passed', tone: 'green' },
    { name: 'Reviews', state: 'Review required', tone: 'amber' },
    { name: 'PAY-142 Partial refunds', state: 'Criteria 3/4', tone: 'amber' },
  ] as { name: string; state: string; tone: Tone }[],
  /** The Changes tab: the file before the fix, with the review's thread on its line. */
  changes: {
    file: 'refunds/policy.py',
    lines: [
      { k: ' ', t: 'def allows(order):' },
      { k: '+', t: '    """True if this order can be refunded."""' },
      { k: '+', t: '    return order.status == "paid"' },
    ] as { k: '-' | '+' | ' '; t: string }[],
    thread: { sev: 'Major', text: 'RefundPolicy.allows() never reads paid_at.', state: 'Untouched' },
  },
};

// ---- fix ------------------------------------------------------------------

/** AI Fix: the findings it offers (two ticked, as "Fix 2 items" picks them), then its change. */
export const FIX = {
  items: [
    { id: 'c3', sev: 'Major', tone: 'red', text: 'Criterion 3 not met: refunds older than 30 days still go through.', on: true },
    { id: 'paid', sev: 'Major', tone: 'red', text: 'RefundPolicy.allows() never reads paid_at.', on: true },
    { id: 'email', sev: 'Minor', tone: 'amber', text: 'Retried refund sends a second email.', on: false },
  ] as { id: string; sev: string; tone: Tone; text: string; on: boolean }[],
  start: 'Start fix',
  // "Push when done" (ticked by default, as in the app): a clean fix on your own PR is pushed with no press.
  pushWhenDone: 'Push when done',
  busy: 'Setting up the sandbox…',
  ready: 'Ready to push',
  // The session's rows after the build turn (the agent runs the checks in the sandbox itself).
  session: ['⏺ Read(refunds/policy.py)', '⏺ Edit(refunds/policy.py)', '⏺ Bash(pytest tests/refunds)', '  ⎿  42 passed'],
  said: 'Fixed both items. Only payments is pushed, to the PR branch.',
  discard: 'Discard',
  push: 'Push',
  pushing: 'Pushing…',
  pushedTo: 'Pushed to',
  // The commit the push left (the app links it to GitHub) and the line an automatic push adds.
  pushedSha: '4f2c9a1',
  pushedAuto: 'Pushed automatically',
  // AI Fix's own review rounds (components/AiFix/FixLoopSection.tsx): Ensemble reviews the fix before the push.
  roundsTitle: 'Review rounds',
  rounds: ['Round 1 · Reviewed · 1 found · 1 fixed', 'Round 2 · Reviewed · 0 found'],
  roundsLine: 'Reviewed: nothing is open.',
};

export const FIX_DIFF = {
  file: 'refunds/policy.py',
  lines: [
    { k: '-', t: '    return order.status == "paid"' },
    { k: '+', t: '    if now() - order.paid_at > REFUND_WINDOW:' },
    { k: '+', t: '        return False' },
    { k: '+', t: '    return order.status == "paid"' },
  ] as { k: '-' | '+' | ' '; t: string }[],
};

export const CI_FAILURE = {
  check: 'test-api',
  log: ['ConnectionResetError: [Errno 104]', '  at tests/test_webhooks.py:88', 'Same check passed on this commit at 10:42.'],
  verdict: 'Not your change: the test lost its network connection.',
};



// ---- ship -----------------------------------------------------------------




// ---- reporting --------------------------------------------------------------

/** Chronology's three courts, in the pigments the whole site uses for them. */
export const COURTS = [
  { label: 'Waiting for a reviewer', short: 'Waiting for review', color: 'var(--lapis)', pct: 36, hours: '3.1h' },
  { label: 'Waiting for the author', short: 'With the author', color: 'var(--madder)', pct: 31, hours: '1.8h' },
  { label: 'Approved, waiting to merge', short: 'Waiting to land', color: 'var(--verdigris)', pct: 33, hours: '1.1h' },
];

export const BUDGETS = [
  { wait: 'First look', budget: 4, limit: 8, half: 5.5, most: 8.5, n: 41, verdict: 'Past limit', tone: 'red' },
  { wait: 'Reply to review', budget: 8, limit: 16, half: 8.5, most: 12, n: 33, verdict: 'Acceptable', tone: 'amber' },
  { wait: 'Approved to merged', budget: 1, limit: 4, half: 2.5, most: 17, n: 30, verdict: 'Past limit', tone: 'red' },
  { wait: 'Opened to merged', budget: 8, limit: 16, half: 17, most: 24, n: 30, verdict: 'Past limit', tone: 'red' },
] as { wait: string; budget: number; limit: number; half: number; most: number; n: number; verdict: string; tone: Tone }[];

/**
 * Chronology over time: the last 14 weeks with data (of 26), each week's share
 * of hours per court (reviewer / author / landing), and each wait's verdict
 * against its budget: g within, a acceptable, r past limit, n too few to judge.
 * Each marker kind lists the weeks (by index) it happened in; the chips toggle them.
 */
export const OVER_TIME = {
  weeks: ['Jul 20', '', '', '', 'Aug 17', '', '', '', 'Sep 14', '', '', '', '', 'This week'],
  shares: [
    [40, 50, 10], [38, 52, 10], [20, 60, 20], [18, 58, 24], [26, 34, 40], [20, 50, 30], [17, 60, 23],
    [24, 52, 24], [21, 55, 24], [26, 50, 24], [28, 58, 14], [30, 55, 15], [41, 43, 16], [38, 20, 42],
  ],
  verdicts: [
    'nagrrrarrrraag'.split(''),
    'nagrargrrrrarn'.split(''),
    'nnrrrnrrrrrarr'.split(''),
    'nrrrrrrrrrrrrr'.split(''),
  ],
  markers: [
    { id: 'repo', k: 'Repository joined', color: '#8fb0ea', weeks: [0, 4, 9] },
    { id: 'bot', k: 'New bot', color: '#e3b866', weeks: [2, 5, 6, 11] },
    { id: 'person', k: 'New contributor', color: '#8fd2bf', weeks: [1, 3, 7, 8, 10, 12] },
    { id: 'setting', k: 'Setting changed', color: '#e79aa6', weeks: [9, 13] },
  ],
};

/** Flow metrics. Each tile opens the pull requests behind its figure. */
export const FLOW = {
  window: 'Day 9 of 14 of this sprint',
  sprint: [
    {
      k: 'Merged',
      v: '19',
      d: '13 fewer than the same point last sprint',
      tone: 'red',
      prs: [`#${PRS.ledgerIndex.num} ${PRS.ledgerIndex.title} · 1.2d`, `#${PRS.payouts.num} ${PRS.payouts.title} · 2.4d`, `#${PRS.checkout.num} ${PRS.checkout.title} · 6.0d`],
      more: 16,
    },
    {
      k: 'Time to merge',
      v: '2.5d',
      d: '26h faster',
      tone: 'green',
      prs: [`#${PRS.checkout.num} ${PRS.checkout.title} · 6.0d`, `#${PRS.payouts.num} ${PRS.payouts.title} · 2.4d`, `#${PRS.ledgerIndex.num} ${PRS.ledgerIndex.title} · 1.2d`],
      more: 16,
    },
    {
      k: 'Time to first review',
      v: '3.6h',
      d: 'no change',
      tone: 'grey',
      prs: [`#${PRS.webhooks.num} ${PRS.webhooks.title} · 9.5h`, `#${PRS.settings.num} ${PRS.settings.title} · 7.0h`, `#${PRS.retry.num} ${PRS.retry.title} · 1.1h`],
      more: 21,
    },
    {
      k: 'Checks green at merge',
      v: '84%',
      d: '10 pts lower',
      tone: 'red',
      prs: [`#${PRS.checkout.num} ${PRS.checkout.title} · failed first`, `#${PRS.payouts.num} ${PRS.payouts.title} · failed first`, `#${PRS.ledgerIndex.num} ${PRS.ledgerIndex.title} · green`],
      more: 16,
    },
  ] as { k: string; v: string; d: string; tone: Tone; prs: string[]; more: number }[],
  now: [
    { k: 'Open pull requests', v: '33' },
    { k: 'Red checks now', v: '1' },
  ],
  /** Pull requests opened and merged per week, last 12 weeks. */
  opened: [18, 20, 24, 23, 25, 27, 30, 30, 34, 31, 33, 38],
  merged: [14, 13, 24, 25, 25, 24, 27, 29, 25, 31, 27, 20],
};

export type PeriodGrain = 'sprint' | 'month';

type Period = {
  /** The bands, oldest first, and the period being projected (null at month grain). */
  bands: string[];
  next: string | null;
  /** The selected (newest) period, for Effort vs automation. */
  name: string;
  effort: { k: string; total: string; parts: number[] }[];
  series: { k: string; color: string; values: number[]; projection: number | null }[];
};

/** Period reports, at both grains: every period of the last 12 weeks / 6 months on one chart. */
export const PERIODS: Record<PeriodGrain, Period> = {
  sprint: {
    bands: ['Aug 6', 'Aug 20', 'Sep 3', 'Sep 17', 'Oct 1', 'Oct 15'],
    next: 'Oct 29',
    name: 'Oct 15 – Oct 29',
    effort: [
      { k: 'PRs merged', total: '53', parts: [57, 43] },
      { k: 'Review comments', total: '635', parts: [26, 74] },
      { k: 'Approvals', total: '34', parts: [100, 0] },
    ],
    series: [
      { k: 'Merged PRs', color: '#4fae95', values: [41, 44, 43, 47, 48, 53], projection: 55 },
      { k: 'Bot review comments', color: '#d98a4e', values: [380, 410, 470, 455, 520, 470], projection: 515 },
    ],
  },
  month: {
    bands: ['Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep'],
    next: null,
    name: 'September 2026',
    effort: [
      { k: 'PRs merged', total: '96', parts: [57, 43] },
      { k: 'Review comments', total: '1,140', parts: [27, 73] },
      { k: 'Approvals', total: '63', parts: [100, 0] },
    ],
    series: [
      { k: 'Merged PRs', color: '#4fae95', values: [78, 84, 80, 91, 88, 96], projection: null },
      { k: 'Bot review comments', color: '#d98a4e', values: [820, 900, 980, 1010, 1060, 1140], projection: null },
    ],
  },
};

/** Where the work is happening: opened by people / automation, lines changed, reach. */
export const WHERE = [
  { repo: REPOS.payments, people: 9, bots: 5, lines: '3.3k', linesPct: 100, low: 0, med: 4, high: 2 },
  { repo: REPOS.web, people: 8, bots: 3, lines: '2.1k', linesPct: 64, low: 2, med: 0, high: 3 },
  { repo: REPOS.api, people: 6, bots: 3, lines: '1.5k', linesPct: 45, low: 3, med: 1, high: 1 },
  { repo: REPOS.ledger, people: 3, bots: 2, lines: null, linesPct: 0, low: 0, med: 1, high: 0 },
];

/** Bots Monitoring: one row per review bot. Severity mix is critical/major/minor/nit, in %;
 * firstReview is the median time to the bot's first review (BotRoiPanel's "First review" column). */
export const BOTS = [
  { bot: 'CodeRabbit', threads: 132, used: '58%', open: 55, mix: [8, 36, 26, 30], firstReview: '6m', topic: 'Correctness' },
  { bot: 'Greptile', threads: 125, used: '61%', open: 49, mix: [10, 44, 16, 30], firstReview: '9m', topic: 'Correctness' },
  { bot: 'Copilot', threads: 41, used: '80%', open: 8, mix: [9, 42, 17, 32], firstReview: '3m', topic: 'Error handling' },
  { bot: 'Cursor Bugbot', threads: 41, used: '59%', open: 17, mix: [7, 37, 19, 37], firstReview: '14m', topic: 'Tests' },
];

export const BOT_SUMMARY = [
  { k: 'Findings', v: '502' },
  { k: 'High severity', v: '49%', d: '244 major or critical' },
  { k: 'Nits', v: '30%', d: '152 trivial or optional' },
  { k: 'Top topic', v: 'Correctness', d: '117 findings' },
];


export const BENCH = {
  bot: 'CodeRabbit',
  live: 'live in 3 of 4 repositories',
  cost: [
    { k: 'Cost', v: 'US$30.00 a month', src: 'Price you entered' },
    { k: 'Per merged PR', v: 'US$0.51', src: 'From your own data' },
    { k: 'Per comment your team used', v: 'US$0.45', src: 'From your own data' },
  ],
  line: 'Your team used 52% of what it said. Teams with similar repos used 74%.',
  repos: [
    { repo: REPOS.api, band: 'Band 3 of 10', acted: '25%' },
    { repo: REPOS.payments, band: 'Band 7 of 10', acted: '59%' },
    { repo: REPOS.web, band: 'Band 6 of 10', acted: '52%' },
  ],
};

export type SprintView = 'themes' | 'paths' | 'people' | 'releases';
export type SprintCard = {
  key: string;
  title: string;
  criteria: string;
  who: string;
  theme: string;
  /** Status column index into SPRINT.columns. */
  col: number;
  path?: number;
  waiting?: boolean;
};

/** This Sprint: one lane board, three views, and the Releases tab (sprintRailModel.ts SPRINT_RAIL_TABS). */
export const SPRINT = {
  name: 'Payments Sprint 24',
  meta: 'Oct 15 – Oct 28 · day 10 of 14',
  views: [
    { id: 'themes', label: 'Theme' },
    { id: 'paths', label: 'Critical path' },
    { id: 'people', label: 'People' },
    { id: 'releases', label: 'Releases' },
  ] as { id: SprintView; label: string }[],
  columns: ['Not started', 'In progress', 'Code review', 'Product review'],
  cards: [
    { key: 'PAY-150', title: 'Refund emails sent once', criteria: '1 of 3 criteria met', who: 'Sam Carter', theme: 'Refunds', col: 1, path: 2 },
    { key: 'PAY-142', title: 'Partial refunds', criteria: '3 of 4 criteria met', who: 'Dana Wu', theme: 'Refunds', col: 2, path: 1 },
    { key: 'PAY-139', title: 'Refund reasons in the export', criteria: '2 criteria', who: 'Priya Nair', theme: 'Refunds', col: 3 },
    { key: 'PAY-158', title: 'Retire the nightly ledger job', criteria: '2 criteria', who: 'Tom Becker', theme: 'Ledger', col: 0, path: 3, waiting: true },
    { key: 'PAY-146', title: 'Rename ledger tables', criteria: '1 of 3 criteria met', who: 'Priya Nair', theme: 'Ledger', col: 1, path: 3 },
    { key: 'PAY-148', title: 'Index ledger by day', criteria: '3 of 3 criteria met', who: 'Wei Zhang', theme: 'Ledger', col: 2 },
  ] as SprintCard[],
};

/** A ticket card's mark (Sprint/releaseTicketsModel.ts `ticketMark`); `anchor` = the candidate ticket (★). */
export type ReleaseMark = 'ok' | 'blocked' | 'held' | 'missing' | 'anchor';

export interface ReleaseMockCard {
  kind: 'ticket';
  key: string;
  /** '' = not in the tracker's data (a dashed card). */
  title: string;
  mark: ReleaseMark;
  /** The tracker's status beside the title; absent when not read. */
  status?: string;
  /** The latest tag per repository (`repoTagWords`). */
  tags: string[];
  /** `ticketCardLine`: what it waits on, or what was done. */
  line: string;
  /** "Show PAY-150" beside a held card's line. */
  holder?: string;
  /** Opened in place: the facts, then each PR (`ticketCardPrLines`). */
  detail?: { facts: string; prs: string[] };
}

export interface ReleaseMockNoTicket {
  kind: 'no_ticket';
  line: string;
  prs: string[];
  /** Listed only with "Show bot PRs" ticked. */
  bots?: string[];
}

/** This Sprint → Releases (Sprint/ReleasesView.tsx; the words of Sprint/releaseTicketsModel.ts). Release suffix
 *  `-rc`. A strip per repository released from this workspace (its candidate, the candidate's commit, Release…),
 *  then ONE list of ticket cards, newest tag first, opened on the candidate ticket (★) with one either side;
 *  "Holding the release" and "Not in a tag yet" above it; PRs with no ticket as narrow rows between the cards. */
export const SPRINT_RELEASES = {
  latest: 'Latest release: 14 Oct',
  /** The dialog opened from the candidate ticket's Release… (Sprint/ReleaseDialog.tsx). */
  dialog: 'Tags acme/payments v3.2.0-rc and acme/web v1.8.2-rc, publishes the notes and comments on 3 tickets.',
  showLater: 'Show 3 later tickets',
  showEarlier: 'Show 3 earlier tickets',
  /** The candidate ticket's candidates (`CandidateBlock`): one Release… for all. */
  candidates: [
    { name: REPOS.payments, text: 'v3.2.0 → v3.2.0-rc', sha: '9f8e7d6', day: '15 Oct' },
    { name: REPOS.web, text: 'v1.8.2 → v1.8.2-rc', sha: '3e2d1c0', day: '13 Oct', latest: 'Latest v1.9.1' },
  ] as Array<{ name: string; text: string; sha: string; day: string; latest?: string }>,
  showBots: 'Show bot PRs',
  showNoTicket: 'Show PRs with no ticket',
  /** Only the repositories with NO candidate get a line above the list. */
  repos: [
    { name: REPOS.ledger, candidate: false, text: 'No tag since v0.8.0-rc can be released' },
    { name: REPOS.api, candidate: false, text: 'Checking…', progress: { share: 0.44, line: "Reading main's history: 2,380 of 5,400 commits" } },
    // Released from merged pull requests (no version tags): its release tags carry the date.
    { name: 'acme/docs-site', candidate: false, text: 'Nothing merged since 2026.10.02-rc' },
  ] as Array<{
    name: string;
    candidate: boolean;
    text: string;
    progress?: { share: number; line: string };
  }>,
  notTagged: [
    { kind: 'ticket', key: 'PAY-160', title: 'Split refunds', mark: 'blocked', status: 'In Development', tags: ['acme/payments: open PR'], line: 'Open PR: acme/payments #631' },
  ] as ReleaseMockCard[],
  holding: [
    {
      kind: 'ticket',
      key: 'PAY-150',
      title: 'Saved cards on mobile',
      mark: 'blocked',
      status: 'In review',
      tags: ['acme/web v1.9.0'],
      line: 'Holds back acme/web',
      detail: { facts: 'Type: Story · Assignee: Wei Zhang · Jira status read 4 min ago', prs: ['web #622 “PAY-150: saved cards” merged 15 Oct · wei · in v1.9.0'] },
    },
    {
      kind: 'ticket',
      key: 'PAY-146',
      title: 'Rename ledger tables',
      mark: 'blocked',
      status: 'Done',
      tags: ['acme/ledger v0.9.0'],
      line: 'Holds back acme/ledger · open PR: acme/payments #611',
    },
  ] as ReleaseMockCard[],
  list: [
    { kind: 'ticket', key: 'PAY-152', title: 'Card form labels', mark: 'held', status: 'Done', tags: ['acme/web v1.9.1'], line: 'Waits on PAY-150: In review', holder: 'PAY-150' },
    {
      kind: 'no_ticket',
      line: '2 PRs with no ticket · 1 by bots',
      prs: ['payments #605 “Tidy the refund logs” merged 14 Oct · sam · in v3.2.0'],
      bots: ['payments #606 “Bump stripe from 14.2 to 14.3” merged 14 Oct · dependabot · in v3.2.0'],
    },
    {
      kind: 'ticket',
      key: 'PAY-134',
      title: 'Payout dates in the export',
      mark: 'anchor',
      status: 'Done',
      tags: ['acme/payments v3.2.0', 'acme/web v1.8.1'],
      line: '2 PRs, last merged 15 Oct by alex',
      detail: {
        facts: 'Type: Story · Assignee: Robin Lee · Jira status read 4 min ago',
        prs: ['payments #612 “PAY-134: export payout dates” merged 15 Oct · alex · in v3.2.0', 'web #598 “PAY-134: payout date column” merged 9 Oct · sam · in v1.8.1'],
      },
    },
    { kind: 'ticket', key: 'PAY-120', title: '', mark: 'missing', tags: ['acme/payments v3.2.0'], line: 'Not found in Jira — check it by hand' },
  ] as Array<ReleaseMockCard | ReleaseMockNoTicket>,
};

// ---- the docs' Getting started: first run and Repos & workspaces ----------------

/** First run (Activity/FirstRunOnboarding.tsx): the repositories you have been active in. */
export const SETUP_REPOS = {
  title: 'Add the repos you work on',
  lead: 'Ensemble tracks the repos you care about — here’s what you’ve been working on.',
  suggestions: [
    { name: REPOS.payments, desc: 'Card and bank payments', stars: 24, prs: 11, on: true },
    { name: REPOS.api, desc: 'Public API and webhooks', stars: 12, prs: 7, on: true },
    { name: REPOS.web, desc: 'Customer web app', stars: 41, prs: 9, on: true },
    { name: REPOS.ledger, desc: 'Double-entry ledger', stars: 5, prs: 3, on: true },
    { name: 'acme/docs-site', desc: 'Public developer documentation', stars: 41, prs: 3, on: true },
    { name: 'acme/analytics-etl', desc: 'Nightly warehouse loads', stars: 5, prs: 2, on: false },
  ],
  search: 'Search repos to add…',
  or: 'or add any repo by name',
};

/** Repos & workspaces (Activity/WorkspaceManager.tsx). */
export const SETUP_WORKSPACES = {
  title: 'Repos & workspaces',
  rule: 'A repo is Maintained in one workspace at most, and can be External in any number of others.',
  workspaces: [
    { id: 'pay', name: 'Acme payments', isDefault: true },
    { id: 'web', name: 'Web', isDefault: false },
  ],
  repos: [
    { name: REPOS.payments, home: 'pay' },
    { name: REPOS.api, home: 'pay' },
    { name: REPOS.ledger, home: 'pay' },
    { name: 'acme/docs-site', home: 'pay' },
    // An EXTERNAL repo (docs/DATA-MODEL.md § External repos): the platform team's, changed by Acme.
    { name: 'acme/platform-config', home: 'pay', external: true, alsoExternalIn: ['web'] },
    { name: REPOS.web, home: 'web' },
    { name: 'acme/design-system', home: 'web' },
  ] as Array<{ name: string; home: string; external?: boolean; alsoExternalIn?: string[] }>,
};

export type TrackerProvider = '' | 'jira' | 'github' | 'linear' | 'notion';

// ---- reviewing as a team (/teams) ---------------------------------------------

/**
 * Team claims (always on, docs/CLAUDE-REVIEW.md § Team claims): the status
 * lines each teammate's Ensemble posts on a commit, as the PR's checks list shows them
 * (components/CheckList.tsx: the "Ensemble" label, the state words "passed" / "running"). The lines'
 * own words are the backend's (review/claude-review/team-claim.ts). #1190 is Priya's pull request.
 */
export const TEAM = {
  claims: {
    pr: PRS.settings,
    sha: '3f9e2a1',
    checks: [
      { name: 'build', limn: false, state: 'passed', tone: 'green', note: null },
      { name: 'test-web', limn: false, state: 'passed', tone: 'green', note: null },
      { name: 'ensemble/review-claude', limn: true, state: 'passed', tone: 'green', note: 'sam reviewed · 2 comments' },
      { name: 'ensemble/review-codex', limn: true, state: 'running', tone: 'amber', note: 'dana is reviewing with Codex' },
      // The story check's own line (review/ticket-review/story-claim.ts): one for the team, whichever model.
      { name: 'ensemble/story-check', limn: true, state: 'passed', tone: 'green', note: 'sam checked the story · 1 gap' },
    ] as { name: string; limn: boolean; state: string; tone: Tone; note: string | null }[],
    /** The "Ensemble" label's tooltip in CheckList.tsx. */
    limnTitle: 'Posted by Ensemble to mark an auto review. Not CI.',
    /** The Open PRs panel's cell for the provider a teammate holds (Activity/OpenPrsAiReview.tsx). */
    skip: 'Reviewed by @sam',
  },
  /**
   * #612 is dana's (the reader's) own pull request. "Latest review by each person" (TeamReviewLayout.tsx,
   * lib/teamReview.ts standingRow): one row per person, newest first, in the columns of "Reviews on
   * this PR" — who · day and 24-hour time · commit · their newest review's outcome. The
   * author's own review is a Comment.
   */
  standing: {
    pr: PRS.refunds,
    // The PR's latest commit, always at the top (TeamReviewLayout.tsx HeadCommitLine).
    head: '8a8ec14',
    rows: [
      { name: 'Priya', verdict: 'Approve', day: '3 Nov 14:20', sha: '1c4bd65' },
      { name: 'You', verdict: 'Comment', day: '3 Nov 11:05', sha: '8a8ec14' },
    ] as { name: string; verdict: string; day: string; sha: string }[],
  },
};

// ---- the build page (/build) ------------------------------------------------

/**
 * PAY-142 as the /build page shows it: the ticket across TWO pull requests (#612 in acme/payments and
 * #1196 in acme/web), its "Ticket design" and its story check.
 *
 * `flow` has the shape of the app's stored `FlowDiagram` (packages/shared sequence-diagrams.ts):
 * lanes from FLOW_LANES, step kinds from FLOW_STEP_KINDS (shown by FLOW_STEP_WORD), each lane and step
 * tagged with the pull request that does it. The PR chips are `prBadgeTexts` for two repositories
 * ("payments #612", "web #1196"). The flow agrees with the story check below: there is NO step that
 * checks the 30 days (criterion 3 Not met), and the amount check does not say whole pence (the
 * handbook finding).
 */
export const BUILD = {
  ticket: STORY,
  prs: [PRS.refunds, { num: 1196, title: 'Refund form', repo: REPOS.web }] as Pr[],
  flow: {
    lanes: [
      { id: 'form', kind: 'Screen', label: 'Refund form', change: 'new', pr: 'web #1196' },
      { id: 'route', kind: 'API route', label: 'Refunds route', change: 'changed', pr: 'payments #612' },
      { id: 'policy', kind: 'Service', label: 'RefundPolicy', change: 'changed', pr: 'payments #612' },
      { id: 'tables', kind: 'Database', label: 'orders, refunds tables', change: 'changed', pr: 'payments #612' },
      { id: 'ledger', kind: 'Queue / job', label: 'Daily ledger job', change: 'unchanged', pr: null },
      { id: 'mail', kind: 'Outside API', label: 'Email service', change: 'unchanged', pr: null },
    ] as { id: string; kind: string; label: string; change: 'new' | 'changed' | 'unchanged'; pr: string | null }[],
    steps: [
      { n: 1, from: 'form', to: 'route', word: 'Call', label: 'refund amount and order id', pr: 'web #1196' },
      { n: 2, from: 'route', to: 'route', word: 'Check', label: 'amount is above 0', pr: 'payments #612' },
      { n: 3, from: 'route', to: 'policy', word: 'Call', label: 'the refund request', pr: 'payments #612' },
      { n: 4, from: 'policy', to: 'tables', word: 'Read', label: 'the order and its refunds so far', pr: 'payments #612' },
      { n: 5, from: 'policy', to: 'tables', word: 'Write', label: 'a refund row; the order stays open', pr: 'payments #612' },
      { n: 6, from: 'policy', to: 'ledger', word: 'Emit', label: 'refund event for the daily ledger', pr: 'payments #612' },
      { n: 7, from: 'policy', to: 'mail', word: 'Call', label: 'the refund email', pr: 'payments #612' },
      { n: 8, from: 'policy', to: 'route', word: 'Return', label: 'the new refund total', pr: 'payments #612' },
      { n: 9, from: 'route', to: 'form', word: 'Return', label: 'refund total and order status', pr: 'payments #612' },
    ] as { n: number; from: string; to: string; word: string; label: string; pr: string }[],
  },
  /** The story check's words for the same ticket (shared TICKET_CRITERION_STATUS_LABEL, STORY_MISSING_HEADING). */
  check: {
    why: [
      'Done in #612',
      'Code in #612, the retry path still sends two',
      'Belongs in #612',
      'Done in #612',
    ],
    missing: 'An audit log entry for each partial refund',
    notAsked: { pr: 'web #1196', text: 'A refunds filter on the orders list' },
  },
  /**
   * A criterion of the build page's ticket that CODE OUTSIDE THE TICKET already does (docs/CLAUDE-REVIEW.md §
   * Ticket review → OUTSIDE THE TICKET): met, with no pull request on the ticket, labelled apart in the
   * app's own words (shared `criterionOutsideWords`). Shown by TicketCheckMock and CriteriaMapMock.
   */
  outsideCriterion: {
    n: 5,
    text: 'Refunds show on the monthly statement',
    status: 'Met',
    words: 'Already in acme/statements (no PR on this ticket)',
  },
  /**
   * "How the code meets each criterion" for the same ticket (the story view's criteria map,
   * apps/frontend/src/components/Activity/CriteriaMap.tsx): one link per (criterion, pull request) a
   * pull request's description says it moves forward, with how and the files, each pull request
   * merged or open. Criterion 3 has none, as the story check and the design agree.
   */
  criteriaMap: {
    prs: [
      { id: 'pay', label: 'payments#612', title: 'Partial refunds in RefundPolicy', state: 'merged' },
      { id: 'web', label: 'web#1196', title: 'Refund form', state: 'open' },
    ],
    links: [
      { n: 1, pr: 'web', how: 'The form asks for an amount below the order total.', files: ['web/src/refunds/RefundForm.tsx'] },
      { n: 1, pr: 'pay', how: 'RefundPolicy writes a refund row and leaves the order open.', files: ['src/refunds/policy.ts', 'src/refunds/repo.ts'] },
      { n: 2, pr: 'pay', how: 'Sends the refund email once per refund; the retry path sends it again.', files: ['src/refunds/policy.ts', 'src/mail/refund-email.ts'] },
      { n: 4, pr: 'pay', how: 'Emits a refund event that the daily ledger job reads.', files: ['src/refunds/events.ts'] },
    ] as { n: number; pr: 'pay' | 'web'; how: string; files: string[] }[],
  },
  /** The "Review in Ensemble" section the review loop ends a pull request's description with (loop/pr-body.ts). */
  loopBody: {
    reviewed: 'Reviewed 3 times by Claude and Codex before this pull request opened.',
    counts: 'Fixed: 3 · Answered: 1 · Pushed back and accepted: 1 · Still open: 0',
    criteria: 'Acceptance criteria: 2 met, 0 not applicable, 0 not met.',
  },
};

// ---- Open pull requests (Everything else): one workspace, grouped by ticket ---------
// The words are the app's own (Activity/OpenPrsRows.tsx): the lead status is mergeVerdict's
// label, capitalised, with its detail; "Changes requested" / "Approved"; "CI failing" /
// "CI passing" / "CI running"; "2 untouched" / "1 open thread"; "Can it land", "Checks",
// "Reviews", "Threads", "Tickets", "Pull request", "AI review". Every PR keeps the number
// and title it has elsewhere on the site.

/** The lead status: the "Can it land" icon and its tone. */
export type OpenPrLead = 'blocked' | 'conflicts' | 'ready' | 'draft' | 'neutral';

export interface OpenPr {
  pr: Pr;
  author: string;
  /** The row's age ("2h"), and the drawer's Opened / Updated. */
  age: string;
  opened: string;
  updated: string;
  lead: OpenPrLead;
  /** mergeVerdict's label, capitalised, and its detail line. */
  land: string;
  landDetail: string | null;
  ci: 'failing' | 'passing' | 'running' | null;
  review: 'changes' | 'approved' | null;
  /** Open threads (untouched + replied + likely addressed), untouched, resolved. */
  threads: { open: number; untouched: number; resolved: number };
  ai: { verdict: string; tone: Tone; findings: string | null } | 'reviewing' | null;
  size: { files: number; add: number; del: number };
  reach: 'Low' | 'Medium' | 'High';
  draft?: boolean;
}

export interface OpenPrGroup {
  ticket: { key: string; title: string } | null;
  /** More tickets that share this group's PRs: one group, each ticket on its own line, each PR once. */
  more?: Array<{ key: string; title: string }>;
  prs: OpenPr[];
}

export const OPEN_PRS: { workspace: string; groups: OpenPrGroup[]; firstOpen: number } = {
  workspace: 'Acme payments',
  firstOpen: PRS.refunds.num,
  groups: [
    {
      ticket: { key: STORY.key, title: STORY.title },
      prs: [
        {
          pr: PRS.refunds,
          author: 'dana',
          age: '2h',
          opened: '3 days ago',
          updated: '2 hours ago',
          lead: 'blocked',
          land: 'Blocked',
          landDetail: 'required checks or reviews aren’t satisfied',
          ci: 'failing',
          review: 'changes',
          threads: { open: 3, untouched: 2, resolved: 1 },
          ai: { verdict: 'Request changes', tone: 'red', findings: '1 blocker · 1 major' },
          size: { files: 14, add: 412, del: 88 },
          reach: 'High',
        },
        {
          pr: PRS.ledgerIndex,
          author: 'priya',
          age: '1d',
          opened: '2 days ago',
          updated: 'yesterday',
          lead: 'ready',
          land: 'Ready to merge',
          landDetail: null,
          ci: 'passing',
          review: 'approved',
          threads: { open: 0, untouched: 0, resolved: 2 },
          ai: { verdict: 'Approve', tone: 'green', findings: '1 nit' },
          size: { files: 3, add: 46, del: 12 },
          reach: 'Low',
        },
      ],
    },
    {
      ticket: { key: 'WEB-88', title: 'Settings redesign' },
      more: [{ key: 'WEB-91', title: 'Saved payment methods' }],
      prs: [
        {
          pr: PRS.checkout,
          author: 'sam',
          age: '5h',
          opened: '4 days ago',
          updated: '5 hours ago',
          lead: 'conflicts',
          land: 'Conflicts',
          landDetail: 'resolve the conflicts with the base branch',
          ci: 'passing',
          review: 'approved',
          threads: { open: 1, untouched: 0, resolved: 3 },
          ai: { verdict: 'Comment', tone: 'grey', findings: '2 minor' },
          size: { files: 9, add: 230, del: 141 },
          reach: 'Medium',
        },
        {
          pr: PRS.settings,
          author: 'leo',
          age: '3d',
          opened: '3 days ago',
          updated: '3 days ago',
          lead: 'draft',
          land: 'Draft',
          landDetail: 'mark it ready for review to merge',
          ci: 'running',
          review: null,
          threads: { open: 0, untouched: 0, resolved: 0 },
          ai: null,
          size: { files: 6, add: 158, del: 40 },
          reach: 'Medium',
          draft: true,
        },
      ],
    },
    {
      ticket: { key: 'API-31', title: 'Webhook reliability' },
      prs: [
        {
          pr: PRS.webhooks,
          author: 'dana',
          age: '40m',
          opened: '40 minutes ago',
          updated: '40 minutes ago',
          lead: 'blocked',
          land: 'Blocked',
          landDetail: 'required checks or reviews aren’t satisfied',
          ci: 'running',
          review: null,
          threads: { open: 0, untouched: 0, resolved: 0 },
          ai: 'reviewing',
          size: { files: 4, add: 97, del: 23 },
          reach: 'Medium',
        },
        {
          pr: PRS.idempotency,
          author: 'priya',
          age: '2d',
          opened: '5 days ago',
          updated: '2 days ago',
          lead: 'neutral',
          land: 'Behind base',
          landDetail: '3 commits behind — update the branch first',
          ci: 'passing',
          review: 'approved',
          threads: { open: 0, untouched: 0, resolved: 4 },
          ai: { verdict: 'Approve', tone: 'green', findings: null },
          size: { files: 5, add: 120, del: 31 },
          reach: 'Low',
        },
      ],
    },
    {
      ticket: null,
      prs: [
        {
          pr: PRS.payouts,
          author: 'sam',
          age: '6d',
          opened: '6 days ago',
          updated: '6 days ago',
          lead: 'neutral',
          land: 'Checks failing',
          landDetail: 'some non-required checks are failing — GitHub will still merge it',
          ci: 'failing',
          review: null,
          threads: { open: 2, untouched: 2, resolved: 0 },
          ai: { verdict: 'Comment', tone: 'grey', findings: '1 major · 1 minor' },
          size: { files: 7, add: 188, del: 64 },
          reach: 'Medium',
        },
      ],
    },
  ],
};
