// ---------------------------------------------------------------------------
// THE FICTIONAL ACME TEAM — the one source of every product mock on this site.
//
// Every HTML mock (components/mock/*) reads its words and numbers from here, so a
// pull request keeps the same number, title and repository wherever it appears:
// #612 is always "Partial refunds" in acme/payments, PAY-142 is always its story.
//
// The words on chips and buttons are the app's own labels ("Criteria 3/4",
// "Waiting on others", "Nudge", "Flaky", "Re-run failed jobs", "2 of 3 in stack",
// "Large"). Keep them exactly as the app spells them.
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
} satisfies Record<string, Pr>;

export const prLabel = (p: Pr): string => `#${p.num} ${p.title}`;

// ---- the story ------------------------------------------------------------

export const STORY = {
  key: 'PAY-142',
  title: 'Partial refunds',
  criteria: [
    { n: 1, text: 'Partial refund keeps the order open', status: 'Met', tone: 'green' },
    { n: 2, text: 'Customer gets one email', status: 'At risk', tone: 'amber' },
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
  review: [
    { sev: 'Major', tone: 'red', code: 'RefundPolicy.allows()', text: 'never reads paid_at.' },
    { sev: 'Minor', tone: 'amber', code: null, text: 'Retried refund sends a second email.' },
    { sev: 'Nit', tone: 'grey', code: 'policy.py', text: 'Unused import in' },
  ] as { sev: string; tone: Tone; code: string | null; text: string }[],
  docs: { source: 'Payments handbook', section: '§4.2', text: 'money in whole pence' },
} as const;

// ---- the Pending board ------------------------------------------------------

export const PENDING = {
  workspace: 'Acme payments',
  you: 'dana',
  tabs: [
    { label: 'Your turn', count: 2, on: true },
    { label: 'Waiting on others', count: 1 },
    { label: 'Ready to merge', count: 1 },
    { label: 'CI failing', count: 1 },
  ],
  waiting: { who: 'sam', hours: 6, target: 4 },
} as const;

// ---- fix ------------------------------------------------------------------

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

export const CONFLICTS = [
  { state: 'Done', tone: 'green', file: 'ledger/post.py', note: 'took theirs' },
  { state: 'Done', tone: 'green', file: 'ledger/models.py', note: 'both' },
  { state: 'Decide', tone: 'amber', file: 'api/routes.py', note: 'lines 40–52' },
] as { state: string; tone: Tone; file: string; note: string }[];

// ---- ship -----------------------------------------------------------------

export const TRUNKS = [
  { repo: REPOS.payments, state: 'Green', tone: 'green' },
  { repo: REPOS.web, state: 'Red', tone: 'red', why: `e2e-checkout since #${PRS.checkout.num} merged · 35 min` },
  { repo: REPOS.api, state: 'Green', tone: 'green' },
] as { repo: string; state: string; tone: Tone; why?: string }[];

// ---- reporting --------------------------------------------------------------

/** Chronology's three courts, in the pigments the whole site uses for them. */
export const COURTS = [
  { label: 'Waiting for a reviewer', short: 'Waiting for review', color: 'var(--lapis)', pct: 36, hours: '3.1h' },
  { label: 'Waiting for the author', short: 'With the author', color: 'var(--madder)', pct: 31, hours: '1.8h' },
  { label: 'Approved, waiting to merge', short: 'Waiting to land', color: 'var(--verdigris)', pct: 33, hours: '1.1h' },
];

export const BUDGETS = [
  { wait: 'First look', budget: 4, limit: 8, half: 5.5, most: 8.5, verdict: 'Past limit', tone: 'red' },
  { wait: 'Reply to review', budget: 8, limit: 16, half: 8.5, most: 12, verdict: 'Acceptable', tone: 'amber' },
  { wait: 'Approved to merged', budget: 1, limit: 4, half: 2.5, most: 17, verdict: 'Past limit', tone: 'red' },
  { wait: 'Opened to merged', budget: 8, limit: 16, half: 17, most: 24, verdict: 'Past limit', tone: 'red' },
] as { wait: string; budget: number; limit: number; half: number; most: number; verdict: string; tone: Tone }[];

/**
 * Chronology over time: the last 14 weeks with data (of 26), each week's share
 * of hours per court (reviewer / author / landing), and each wait's verdict
 * against its budget: g within, a acceptable, r past limit, n too few to judge.
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
    { k: 'Repository joined', n: 3 },
    { k: 'New bot', n: 4 },
    { k: 'New contributor', n: 6 },
    { k: 'Setting changed', n: 2 },
  ],
};

export const FLOW = {
  window: 'Day 9 of 14 of this sprint',
  sprint: [
    { k: 'Merged', v: '19', d: '13 fewer than the same point last sprint', tone: 'red' },
    { k: 'Time to merge', v: '2.5d', d: '26h faster', tone: 'green' },
    { k: 'Time to first review', v: '3.6h', d: 'no change', tone: 'grey' },
    { k: 'Checks green at merge', v: '84%', d: '10 pts lower', tone: 'red' },
  ] as { k: string; v: string; d: string; tone: Tone }[],
  now: [
    { k: 'Open pull requests', v: '33' },
    { k: 'Red checks now', v: '1' },
  ],
  /** Pull requests opened and merged per week, last 12 weeks. */
  opened: [18, 20, 24, 23, 25, 27, 30, 30, 34, 31, 33, 38],
  merged: [14, 13, 24, 25, 25, 24, 27, 29, 25, 31, 27, 20],
};

export const PERIOD = {
  name: 'Oct 1 – Oct 15',
  grain: 'sprint · 14 days',
  effort: [
    { k: 'PRs merged', total: 53, parts: [57, 43] },
    { k: 'Review comments', total: 635, parts: [26, 74] },
    { k: 'Approvals', total: 34, parts: [100, 0] },
  ],
  movers: [
    { k: 'Time to first review by a person', d: '+4.5h (+20%)', tone: 'red' },
    { k: 'Human review comments', d: '+24 (+18%)', tone: 'green' },
    { k: 'Merged PRs by people', d: '+4 (+15%)', tone: 'green' },
  ] as { k: string; d: string; tone: Tone }[],
  rows: [
    { k: 'Merged PRs', now: '53', prior: '48', change: '+5 (+10%)', next: '≈ 53 (44–63)' },
    { k: '…by people', now: '30', prior: '26', change: '+4 (+15%)', next: '≈ 30 (25–35)' },
    { k: 'Opened PRs', now: '57', prior: '60', change: '−3 (−5%)', next: '≈ 57 (47–67)' },
    { k: 'Automation share of merges', now: '43%', prior: '46%', change: '−2 pts', next: '≈ 43%' },
  ],
  summary: {
    happened: [
      'The team merged 53 pull requests. Half cleared in 77 working hours from opening to merge.',
      'The biggest move was time to first review by a person, up 20% on the previous sprint.',
    ],
    watch: [
      'Time to first review by a person is the number to hold. It is the part of the wait the team controls.',
      'Bot comments rise with pull-request volume. What matters is how many were acted on.',
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
  { bot: 'CodeRabbit', threads: 132, used: '58%', open: 55, mix: [8, 36, 26, 30], high: '44%' },
  { bot: 'Greptile', threads: 125, used: '61%', open: 49, mix: [10, 44, 16, 30], high: '54%' },
  { bot: 'Copilot', threads: 41, used: '80%', open: 8, mix: [9, 42, 17, 32], high: '51%' },
  { bot: 'Cursor Bugbot', threads: 41, used: '59%', open: 17, mix: [7, 37, 19, 37], high: '44%' },
];

export const BOT_SUMMARY = [
  { k: 'Findings', v: '502' },
  { k: 'High severity', v: '49%', d: '244 major or critical' },
  { k: 'Nits', v: '30%', d: '152 trivial or optional' },
  { k: 'Top topic', v: 'Correctness', d: '117 findings' },
];

/** The home page's short bots table: comments, share high, share acted on. */
export const BOT_WORTH = [
  { bot: 'CodeRabbit', comments: 412, high: 60, acted: '38%' },
  { bot: 'Copilot', comments: 290, high: 35, acted: '22%' },
  { bot: 'Limn', comments: 118, high: 75, acted: '71%', ours: true },
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

export const SPRINT = {
  name: 'Payments Sprint 24',
  meta: 'Oct 15 – Oct 28 · day 10 of 14',
  columns: ['Not started', 'In progress', 'Code review', 'Product review'],
  lanes: [
    {
      theme: 'Refunds',
      cards: [
        null,
        { key: 'PAY-150', title: 'Refund emails sent once', criteria: '1 of 3 criteria met', who: 'Sam Carter', path: 2 },
        { key: 'PAY-142', title: 'Partial refunds', criteria: '3 of 4 criteria met', who: 'Dana Wu', path: 1 },
        { key: 'PAY-139', title: 'Refund reasons in the export', criteria: '2 criteria', who: 'Priya Nair' },
      ],
    },
    {
      theme: 'Ledger',
      cards: [
        { key: 'PAY-158', title: 'Retire the nightly ledger job', criteria: '2 criteria', who: 'Tom Becker', path: 3, waiting: true },
        { key: 'PAY-146', title: 'Rename ledger tables', criteria: '1 of 3 criteria met', who: 'Priya Nair', path: 3 },
        { key: 'PAY-148', title: 'Index ledger by day', criteria: '3 of 3 criteria met', who: 'Wei Zhang' },
        null,
      ],
    },
  ] as {
    theme: string;
    cards: ({ key: string; title: string; criteria: string; who: string; path?: number; waiting?: boolean } | null)[];
  }[],
};
