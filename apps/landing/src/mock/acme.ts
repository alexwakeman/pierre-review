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
  /** Closed findings, under "Resolved or addressed (n)", each saying why (lib/teamReview.ts closedReason). */
  closed: [
    { sev: 'Major', tone: 'red', text: 'A partial refund closes the order.', by: 'You', reason: 'Priya’s review found it addressed · 3 Nov' },
    { sev: 'Minor', tone: 'amber', text: 'Refund amount is not logged.', by: 'Priya', reason: 'Resolved on GitHub' },
  ] as { sev: string; tone: Tone; text: string; by: string; reason: string }[],
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
    { pr: PRS.refunds, by: 'Your Limn', verdict: 'Request changes', tone: 'red', findings: '2 findings', when: '4 min ago', isNew: true },
    { pr: PRS.ledgerIndex, by: 'Priya’s Limn', verdict: 'Comment', tone: 'grey', findings: '1 finding', when: '1 hour ago', isNew: false, seen: 'Seen today 09:12' },
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
  busy: 'Setting up the sandbox…',
  ready: 'Ready to push',
  // The session's rows after the build turn (the agent runs the checks in the sandbox itself).
  session: ['⏺ Read(refunds/policy.py)', '⏺ Edit(refunds/policy.py)', '⏺ Bash(pytest tests/refunds)', '  ⎿  42 passed'],
  said: 'Fixed both items. Only payments is pushed, to the PR branch.',
  discard: 'Discard',
  push: 'Push',
  pushing: 'Pushing…',
  pushedTo: 'Pushed to',
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

/** Merge conflicts on #701. The last one waits for a choice. */
export const CONFLICTS = [
  { state: 'Applied', tone: 'green', file: 'ledger/post.py', note: 'took theirs' },
  { state: 'Both applied', tone: 'green', file: 'ledger/models.py', note: 'both' },
  { state: 'Needs a decision', tone: 'amber', file: 'api/routes.py', note: 'lines 40–52' },
] as { state: string; tone: Tone; file: string; note: string }[];

export const CONFLICT_WORDS = {
  choices: [
    { id: 'ours', label: 'Ours', state: 'Applied', note: 'took ours' },
    { id: 'theirs', label: 'Theirs', state: 'Applied', note: 'took theirs' },
    { id: 'both', label: 'Both', state: 'Both applied', note: 'both' },
  ],
  allDecided: 'Everything is decided.',
  commit: 'Commit and push',
  pushing: 'Pushing…',
  pushed: 'Pushed',
};

// ---- ship -----------------------------------------------------------------

export const TRUNKS = [
  { repo: REPOS.payments, state: 'Green', tone: 'green', why: 'Last run passed 12 min ago' },
  { repo: REPOS.web, state: 'Red', tone: 'red', why: `e2e-checkout since #${PRS.checkout.num} merged · 35 min` },
  { repo: REPOS.api, state: 'Green', tone: 'green', why: 'Last run passed 40 min ago' },
] as { repo: string; state: string; tone: Tone; why: string }[];

/** The merge verdict on #1190: blockers in order. "Update branch" clears the second. */
export const VERDICT = {
  blockers: [
    { id: 'approval', text: 'Needs 1 more approval', tone: 'red' },
    { id: 'behind', text: 'Branch is behind main', tone: 'amber' },
  ] as { id: string; text: string; tone: Tone }[],
  update: { idle: 'Update branch', busy: 'Updating…' },
};

/** Merge when ready (MergeWhenReadyControl.tsx): the button and the armed state. */
export const ARM = {
  button: 'Merge when ready',
  armed: 'Armed — merging when ready',
  cancel: 'Cancel auto-merge',
  first: { pr: PRS.ledgerIndex, why: 'Waiting for 1 check · then merges' },
  second: { pr: PRS.retry, idle: '2 approvals · 1 check running', armed: `Lands after #${PRS.ledgerIndex.num}, one at a time` },
};

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

/** Bots Monitoring: one row per review bot. Severity mix is critical/major/minor/nit, in %. */
export const BOTS = [
  { bot: 'CodeRabbit', threads: 132, used: '58%', open: 55, mix: [8, 36, 26, 30], high: '44%', topic: 'Correctness' },
  { bot: 'Greptile', threads: 125, used: '61%', open: 49, mix: [10, 44, 16, 30], high: '54%', topic: 'Correctness' },
  { bot: 'Copilot', threads: 41, used: '80%', open: 8, mix: [9, 42, 17, 32], high: '51%', topic: 'Error handling' },
  { bot: 'Cursor Bugbot', threads: 41, used: '59%', open: 17, mix: [7, 37, 19, 37], high: '44%', topic: 'Tests' },
];

export const BOT_SUMMARY = [
  { k: 'Findings', v: '502' },
  { k: 'High severity', v: '49%', d: '244 major or critical' },
  { k: 'Nits', v: '30%', d: '152 trivial or optional' },
  { k: 'Top topic', v: 'Correctness', d: '117 findings' },
];

/** The home page's short bots table: comments, share high, share acted on. */
export const BOT_WORTH = [
  { bot: 'CodeRabbit', comments: 412, high: 60, acted: '38%', actedN: 157 },
  { bot: 'Copilot', comments: 290, high: 35, acted: '22%', actedN: 64 },
  { bot: 'Limn', comments: 118, high: 75, acted: '71%', actedN: 84, ours: true },
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

export type SprintView = 'themes' | 'paths' | 'people';
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

/** This Sprint: one lane board, three views (sprintRailModel.ts SPRINT_RAIL_TABS). */
export const SPRINT = {
  name: 'Payments Sprint 24',
  meta: 'Oct 15 – Oct 28 · day 10 of 14',
  views: [
    { id: 'themes', label: 'Theme' },
    { id: 'paths', label: 'Critical path' },
    { id: 'people', label: 'People' },
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

// ---- the docs' Getting started: first run and Repos & workspaces ----------------

/** First run (Activity/FirstRunOnboarding.tsx): the repositories you have been active in. */
export const SETUP_REPOS = {
  title: 'Add the repos you work on',
  lead: 'Limn tracks the repos you care about — here’s what you’ve been working on.',
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
  rule: 'Every repo lives in exactly one workspace. Changing a repo’s workspace MOVES it — it leaves the one it’s in now.',
  workspaces: [
    { id: 'pay', name: 'Acme payments', isDefault: true },
    { id: 'web', name: 'Web', isDefault: false },
  ],
  repos: [
    { name: REPOS.payments, home: 'pay' },
    { name: REPOS.api, home: 'pay' },
    { name: REPOS.ledger, home: 'pay' },
    { name: 'acme/docs-site', home: 'pay' },
    { name: REPOS.web, home: 'web' },
    { name: 'acme/design-system', home: 'web' },
  ],
};

export type TrackerProvider = '' | 'jira' | 'github' | 'linear' | 'notion';

// ---- reviewing as a team (/teams) ---------------------------------------------

/**
 * Team claims ("Mark auto reviews on GitHub", docs/CLAUDE-REVIEW.md § Team claims): the status
 * lines each teammate's Limn posts on a commit, as the PR's checks list shows them
 * (components/CheckList.tsx: the "Limn" label, the state words "passed" / "running"). The lines'
 * own words are the backend's (review/claude-review/team-claim.ts). #1190 is Priya's pull request.
 */
export const TEAM = {
  claims: {
    pr: PRS.settings,
    sha: '3f9e2a1',
    checks: [
      { name: 'build', limn: false, state: 'passed', tone: 'green', note: null },
      { name: 'test-web', limn: false, state: 'passed', tone: 'green', note: null },
      { name: 'limn/review-claude', limn: true, state: 'passed', tone: 'green', note: 'sam reviewed · 2 comments' },
      { name: 'limn/review-codex', limn: true, state: 'running', tone: 'amber', note: 'dana is reviewing with Codex' },
    ] as { name: string; limn: boolean; state: string; tone: Tone; note: string | null }[],
    /** The "Limn" label's tooltip in CheckList.tsx. */
    limnTitle: 'Posted by Limn to mark an auto review. Not CI.',
    /** The Open PRs panel's cell for the provider a teammate holds (Activity/OpenPrsAiReview.tsx). */
    skip: 'Reviewed by @sam',
  },
  /**
   * #612 is dana's (the reader's) own pull request. "Where this PR stands" (TeamReviewLayout.tsx,
   * lib/teamReview.ts standingLine): newest review first. The author's own review is a Comment.
   */
  standing: {
    pr: PRS.refunds,
    // The PR's latest commit, always at the top (TeamReviewLayout.tsx HeadCommitLine).
    head: '8a8ec14',
    rows: [
      { name: 'Priya', verdict: 'Approve', tone: 'green', day: '3 Nov', sha: '1c4bd65', note: 'approval stands on GitHub' },
      { name: 'You', verdict: 'Comment', tone: 'grey', day: '3 Nov', sha: '8a8ec14', note: null },
    ] as { name: string; verdict: string; tone: Tone; day: string; sha: string; note: string | null }[],
  },
};
