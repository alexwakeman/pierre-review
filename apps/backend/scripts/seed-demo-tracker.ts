// THE DEMO'S ISSUE TRACKER — a fictional Jira site (acme.atlassian.net) behind the Platform
// workspace, read through the REAL tracker code: the PR ticket worker, the sprint list read, the
// ghost-chain lookups, then the sprint briefs, themes and critical paths.
//
// WHY THROUGH THE REAL CODE. Every stored row here carries a hash of the text it was made from
// (a brief is "current" only while its text hash matches; themes and paths key on an input hash).
// Hand-written rows would read as stale the moment a fold changed. So the Jira site is FAKED at the
// transport seam (`JiraTransport`: a function that answers the URLs the reader asks for) and the
// three model passes are FAKED at their own seams (the brief store, the themes `complete`, the paths
// `runner`) with answers written here and run through the product's own validators. Nothing leaves
// the process and no model is called.
//
// Everything is fictional: the Acme team, its tickets and its code.
import { currentSprintStart } from './seed-periods.js';

const ROOT = 'https://acme.atlassian.net';
const DAY = 86_400_000;
const BOARD_ID = 12;
const SPRINT_NAME = 'Platform Sprint 24';

type StatusKey = 'todo' | 'progress' | 'review' | 'qa' | 'done';
const STATUSES: Record<StatusKey, { id: string; name: string; category: 'new' | 'indeterminate' | 'done' }> = {
  todo: { id: '10000', name: 'To Do', category: 'new' },
  progress: { id: '3', name: 'In Progress', category: 'indeterminate' },
  review: { id: '10101', name: 'In Review', category: 'indeterminate' },
  qa: { id: '10102', name: 'Ready for QA', category: 'indeterminate' },
  done: { id: '10001', name: 'Done', category: 'done' },
};

const PEOPLE: Record<string, { name: string; id: string }> = {
  morgan: { name: 'Morgan Diaz', id: 'acct-morgan' },
  priya: { name: 'Priya Nair', id: 'acct-priya' },
  lena: { name: 'Lena Fischer', id: 'acct-lena' },
  tom: { name: 'Tom Becker', id: 'acct-tom' },
  sam: { name: 'Sam Carter', id: 'acct-sam' },
  wei: { name: 'Wei Zhang', id: 'acct-wei' },
};

interface DemoTicket {
  key: string;
  summary: string;
  type: 'Story' | 'Task' | 'Bug';
  status: StatusKey;
  assignee: keyof typeof PEOPLE | null;
  /** Jira wiki markup. */
  description: string;
  /** Jira wiki markup bullets — the "Acceptance Criteria" custom field. */
  ac: string | null;
  /** "is blocked by" links (the other ticket's key). */
  blockedBy?: string[];
  epic: 'PLAT-280' | 'INFRA-200' | null;
  components: string[];
  createdDaysAgo: number;
  updatedDaysAgo: number;
  resolvedDaysAgo?: number;
  inSprint: boolean;
  /** The pull requests that carry this key (their branch names are set to match). */
  prs: Array<{ id: number; branch: string }>;
}

const EPICS = {
  'PLAT-280': 'Sync engine reliability',
  'INFRA-200': 'Queue-backed sync infrastructure',
} as const;

export const DEMO_TICKETS: DemoTicket[] = [
  {
    key: 'PLAT-292',
    summary: 'Write each pull request in one transaction during sync',
    type: 'Story',
    status: 'review',
    assignee: 'priya',
    description:
      'Today the sync writes a pull request, its threads and its events in separate statements. A crash between them leaves a pull request with half its threads, and the next sync does not repair it.\n\nh3. What we want\nOne transaction per pull request: either everything about it lands, or nothing does. The reviewer-request webhook in PLAT-301 writes through the same path, so this goes first.',
    ac: '* A pull request, its review threads and its events are written in one transaction.\n* A failure part-way through leaves the previous copy of that pull request untouched.\n* The sync of a repository with 400 open pull requests is no slower than today.',
    epic: 'PLAT-280',
    components: ['Sync'],
    createdDaysAgo: 19,
    updatedDaysAgo: 1,
    inSprint: true,
    prs: [{ id: 113, branch: 'PLAT-292-upsert-transaction-boundaries' }],
  },
  {
    key: 'PLAT-301',
    summary: 'Handle review-request webhooks',
    type: 'Story',
    status: 'progress',
    assignee: 'sam',
    description:
      'When someone is asked to review, GitHub sends a webhook. We ignore it and wait for the next poll, so "waiting on review" is up to five minutes late.\n\nThe handler writes through the per-PR upsert, so it must land after PLAT-292.',
    ac: '* A review-request webhook updates the requested reviewers within ten seconds.\n* A removed request is removed from the pull request.\n* A webhook for a repository we do not track is ignored and logged once.',
    epic: 'PLAT-280',
    components: ['Sync', 'Webhooks'],
    createdDaysAgo: 15,
    updatedDaysAgo: 1,
    inSprint: true,
    prs: [{ id: 105, branch: 'PLAT-301-review-request-webhooks' }],
  },
  {
    key: 'PLAT-305',
    summary: 'Stream sync progress to the browser',
    type: 'Story',
    status: 'review',
    assignee: 'sam',
    description:
      'A first sync of a large repository takes minutes and the page shows a spinner. Send progress events over server-sent events so the page can say which phase it is in and how far along.',
    ac: '* The sync sends a progress event at least every two seconds while it runs.\n* Each event names the phase (pull requests, threads, checks) and a count.\n* Closing the tab stops the stream without stopping the sync.',
    epic: 'PLAT-280',
    components: ['Sync', 'Web'],
    createdDaysAgo: 14,
    updatedDaysAgo: 2,
    inSprint: true,
    prs: [{ id: 111, branch: 'PLAT-305-sse-sync-progress' }],
  },
  {
    key: 'PLAT-288',
    summary: 'Move the sync scheduler onto a job queue',
    type: 'Story',
    status: 'progress',
    assignee: 'sam',
    description:
      'The scheduler is a cron loop inside the API process. Two API replicas both run it, and a slow repository delays every repository behind it.\n\nMove each repository sync onto the SQS queue so workers pull jobs and a slow job only holds one worker.',
    ac: '* Each repository sync is one queue message.\n* Two API replicas never sync the same repository at the same time.\n* A job that fails three times lands in the dead-letter queue with its error.',
    blockedBy: ['INFRA-199'],
    epic: 'INFRA-200',
    components: ['Sync', 'Infrastructure'],
    createdDaysAgo: 30,
    updatedDaysAgo: 3,
    inSprint: true,
    prs: [{ id: 141, branch: 'PLAT-288-sync-job-queue' }],
  },
  {
    key: 'PLAT-296',
    summary: 'Backfill merged-by on historical pull requests',
    type: 'Task',
    status: 'done',
    assignee: 'morgan',
    description: 'Pull requests synced before we stored merged-by show "merged" with no person. Backfill the field for the last 90 days.',
    ac: '* Every pull request merged in the last 90 days has a merged-by person.\n* The backfill can be run twice without changing anything the second time.',
    epic: 'PLAT-280',
    components: ['Sync'],
    createdDaysAgo: 12,
    updatedDaysAgo: 2,
    resolvedDaysAgo: 2,
    inSprint: true,
    prs: [{ id: 106, branch: 'PLAT-296-backfill-merged-by' }],
  },
  {
    key: 'PLAT-297',
    summary: 'Cache changed-file paths per commit',
    type: 'Task',
    status: 'review',
    assignee: 'wei',
    description: 'We ask GitHub for the changed files of the same commit on every sync. Store them once per commit and reuse them.',
    ac: '* The changed files of a commit are fetched once.\n* A force-pushed branch fetches the new commits only.',
    epic: 'PLAT-280',
    components: ['Sync'],
    createdDaysAgo: 10,
    updatedDaysAgo: 4,
    inSprint: true,
    prs: [{ id: 104, branch: 'PLAT-297-cache-commit-paths' }],
  },
  {
    key: 'PLAT-315',
    summary: 'Index events by repository and time',
    type: 'Task',
    status: 'done',
    assignee: 'wei',
    description: 'The feed query scans the events table. Add an index on (repo_id, occurred_at) and check the plan.',
    ac: '* The feed query uses the new index.\n* The migration runs in under a minute on a copy of production.',
    epic: 'PLAT-280',
    components: ['Database'],
    createdDaysAgo: 11,
    updatedDaysAgo: 9,
    resolvedDaysAgo: 9,
    inSprint: true,
    prs: [{ id: 125, branch: 'PLAT-315-events-repo-time-index' }],
  },
  {
    key: 'PLAT-310',
    summary: 'Retry GitHub calls within the rate-limit budget',
    type: 'Story',
    status: 'todo',
    assignee: 'morgan',
    description:
      'When the GitHub budget runs low the sync fails the repository and shows it in red. It should wait for the budget to refill and carry on.\n\nUse the numbers from the audit in PLAT-275 to pick the wait.',
    ac: '* A sync that runs out of budget waits and resumes instead of failing.\n* The repository shows "paused" with the time it will resume.\n* No retry is sent while the budget is empty.',
    epic: 'PLAT-280',
    components: ['Sync', 'GitHub'],
    createdDaysAgo: 9,
    updatedDaysAgo: 5,
    inSprint: true,
    prs: [],
  },
  {
    key: 'PLAT-312',
    summary: 'Report sync health on the health endpoint',
    type: 'Story',
    status: 'todo',
    assignee: null,
    description:
      'Ops wants one URL to check. Add the age of the oldest unfinished sync and the number of repositories in error to /api/health.\n\nIt needs the progress events from PLAT-305 to know which syncs are still running.',
    ac: '* /api/health reports the age of the oldest running sync.\n* It reports how many repositories are in error.\n* It answers in under 50 ms.',
    epic: 'PLAT-280',
    components: ['Sync', 'Ops'],
    createdDaysAgo: 8,
    updatedDaysAgo: 6,
    inSprint: true,
    prs: [],
  },
  {
    key: 'PLAT-318',
    summary: 'Retire the cron sync path',
    type: 'Task',
    status: 'todo',
    assignee: 'tom',
    description:
      'Once PLAT-288 ships, remove the cron loop it replaces, its config flags and its tests. Keep the one-off sync command working.',
    ac: '* No cron loop starts with the API process.\n* The sync:once command still syncs one repository.',
    epic: 'INFRA-200',
    components: ['Sync'],
    createdDaysAgo: 6,
    updatedDaysAgo: 6,
    inSprint: true,
    prs: [],
  },
  {
    key: 'INFRA-231',
    summary: 'Right-size the EKS worker node group',
    type: 'Story',
    status: 'review',
    assignee: 'wei',
    description:
      'The worker node group runs six large nodes around the clock. Night-time load needs two. Set autoscaling bounds so it scales between two and eight.',
    ac: '* The worker node group scales between 2 and 8 nodes.\n* terraform plan shows no change outside the node group.\n* The scale-down does not evict pods without a disruption budget.',
    epic: 'INFRA-200',
    components: ['Infrastructure'],
    createdDaysAgo: 7,
    updatedDaysAgo: 1,
    inSprint: true,
    prs: [{ id: 114, branch: 'INFRA-231-eks-autoscaling-limits' }],
  },
  {
    key: 'INFRA-244',
    summary: 'Alarm on queue depth and dead-letter age',
    type: 'Story',
    status: 'review',
    assignee: 'sam',
    description:
      'When the sync queue from PLAT-288 backs up, nobody knows until users complain. Add CloudWatch alarms on queue depth and on the age of the oldest dead-letter message, routed to the on-call channel.',
    ac: '* An alarm fires when the queue holds more than 500 messages for 10 minutes.\n* An alarm fires when a dead-letter message is older than one hour.\n* Both alarms post to the on-call channel.',
    blockedBy: ['PLAT-288'],
    epic: 'INFRA-200',
    components: ['Infrastructure', 'Ops'],
    createdDaysAgo: 9,
    updatedDaysAgo: 2,
    inSprint: true,
    prs: [{ id: 116, branch: 'INFRA-244-cloudwatch-queue-alarms' }],
  },
  {
    key: 'INFRA-260',
    summary: 'Move Terraform remote state to S3 with DynamoDB locking',
    type: 'Story',
    status: 'progress',
    assignee: 'wei',
    description:
      'Terraform state lives on one engineer\'s laptop backup. Move it to an S3 bucket with versioning, and lock it with a DynamoDB table so two applies cannot run at once.',
    ac: '* State for every stack lives in the versioned S3 bucket.\n* A second apply while one runs waits for the lock.\n* The old local state files are archived, not deleted.',
    epic: 'INFRA-200',
    components: ['Infrastructure'],
    createdDaysAgo: 34,
    updatedDaysAgo: 3,
    inSprint: true,
    prs: [
      { id: 131, branch: 'INFRA-260-state-locking-dynamodb' },
      { id: 142, branch: 'INFRA-260-remote-state-migration' },
    ],
  },
  {
    key: 'INFRA-248',
    summary: 'Split Helm ingress values per environment',
    type: 'Task',
    status: 'qa',
    assignee: 'lena',
    description: 'Staging and production share one ingress values file with conditionals. Split it into one file per environment.',
    ac: '* Each environment has its own ingress values file.\n* A staging deploy renders exactly the same ingress as before.',
    epic: 'INFRA-200',
    components: ['Infrastructure'],
    createdDaysAgo: 10,
    updatedDaysAgo: 3,
    inSprint: true,
    prs: [{ id: 115, branch: 'INFRA-248-helm-ingress-per-env' }],
  },
  {
    key: 'INFRA-252',
    summary: 'Pin the node AMI and roll the node groups',
    type: 'Task',
    status: 'done',
    assignee: 'lena',
    description: 'Node groups pick up the latest AMI on every scale-out, so two nodes in one group can run different kernels. Pin the AMI and roll each group once.',
    ac: '* Every node group runs the pinned AMI.\n* Rolling a group drains one node at a time.',
    epic: 'INFRA-200',
    components: ['Infrastructure'],
    createdDaysAgo: 12,
    updatedDaysAgo: 8,
    resolvedDaysAgo: 8,
    inSprint: true,
    prs: [{ id: 130, branch: 'INFRA-252-pin-node-ami' }],
  },
  // ── GHOSTS: tickets the sprint's text names, outside the sprint ──
  {
    key: 'INFRA-199',
    summary: 'Provision the SQS sync queue and its dead-letter queue',
    type: 'Story',
    status: 'done',
    assignee: 'lena',
    description: 'Create the sync queue and a dead-letter queue with a three-receive redrive policy. Uses the VPC endpoints from INFRA-180 so workers never leave the VPC.',
    ac: '* The sync queue and its dead-letter queue exist in every environment.\n* Workers reach SQS through the VPC endpoint.',
    epic: 'INFRA-200',
    components: ['Infrastructure'],
    createdDaysAgo: 40,
    updatedDaysAgo: 18,
    resolvedDaysAgo: 18,
    inSprint: false,
    prs: [],
  },
  {
    key: 'INFRA-180',
    summary: 'Add VPC endpoints for SQS and S3',
    type: 'Task',
    status: 'done',
    assignee: 'lena',
    description: 'Add interface endpoints for SQS and a gateway endpoint for S3 in each VPC.',
    ac: null,
    epic: 'INFRA-200',
    components: ['Infrastructure'],
    createdDaysAgo: 55,
    updatedDaysAgo: 31,
    resolvedDaysAgo: 31,
    inSprint: false,
    prs: [],
  },
  {
    key: 'PLAT-275',
    summary: 'Audit GitHub API usage per sync phase',
    type: 'Task',
    status: 'todo',
    assignee: null,
    description: 'Measure how many GraphQL points and REST calls each sync phase spends on a typical repository, so the retry work has numbers to start from.',
    ac: null,
    epic: 'PLAT-280',
    components: ['Sync', 'GitHub'],
    createdDaysAgo: 26,
    updatedDaysAgo: 20,
    inSprint: false,
    prs: [],
  },
];

/** Every ticket's key → the demo ticket. */
const BY_KEY = new Map(DEMO_TICKETS.map((t) => [t.key, t]));

/** The idents the rest of the seed refers to. */
export const ticketIdent = (key: string): string => `jira:${ROOT}#${key}`;

// ── THE BRIEFS (what the Haiku pass would write) ──────────────────────────────────────────────

interface DemoBrief {
  summary: string;
  oneLiner: string;
  criteria?: string[];
  references: Array<{ ticketKey: string; relation: string; quote: string; why: string }>;
  links?: Array<{ ticketKey: string; why: string }>;
}

const BRIEFS: Record<string, DemoBrief> = {
  'PLAT-292': {
    summary: 'Wrap the write of one pull request, its threads and its events in a single transaction, so a crash never leaves a pull request half-written.',
    oneLiner: 'One transaction per pull request, so a crash never half-writes one',
    references: [],
  },
  'PLAT-301': {
    summary: 'Update requested reviewers from GitHub’s review-request webhook instead of waiting for the next poll. It writes through the per-PR upsert, so it follows that change.',
    oneLiner: 'Show review requests within seconds, from GitHub’s webhook',
    references: [
      { ticketKey: 'PLAT-292', relation: 'depends_on', quote: 'it must land after PLAT-292', why: 'The handler writes through the one-transaction upsert that PLAT-292 builds.' },
    ],
  },
  'PLAT-305': {
    summary: 'Send sync progress to the page over server-sent events, naming the phase and a count, so a long first sync shows where it is.',
    oneLiner: 'Live sync progress in the page instead of a spinner',
    references: [],
  },
  'PLAT-288': {
    summary: 'Replace the in-process cron loop with one queue message per repository sync, so replicas never double-sync and a slow repository holds one worker only.',
    oneLiner: 'One queue job per repository sync, pulled by workers',
    references: [],
    links: [{ ticketKey: 'INFRA-199', why: 'The workers pull from the queue and dead-letter queue that INFRA-199 creates.' }],
  },
  'PLAT-296': {
    summary: 'Fill in who merged each pull request for the last 90 days of history, safely re-runnable.',
    oneLiner: 'Fill in merged-by for the last 90 days of pull requests',
    references: [],
  },
  'PLAT-297': {
    summary: 'Fetch each commit’s changed files once and reuse them on later syncs, refetching only new commits after a force-push.',
    oneLiner: 'Fetch each commit’s changed files once and reuse them',
    references: [],
  },
  'PLAT-315': {
    summary: 'Add an index on events by repository and time so the feed query stops scanning the table.',
    oneLiner: 'Index events by repository and time for the feed query',
    references: [],
  },
  'PLAT-310': {
    summary: 'When the GitHub budget runs low, pause the sync and resume when it refills, showing the repository as paused rather than failed.',
    oneLiner: 'Pause and resume syncs when the GitHub budget runs low',
    references: [
      { ticketKey: 'PLAT-275', relation: 'context', quote: 'Use the numbers from the audit in PLAT-275', why: 'The audit says how much each phase spends, which sets the wait.' },
    ],
  },
  'PLAT-312': {
    summary: 'Add the age of the oldest running sync and the count of repositories in error to the health endpoint, for ops to poll.',
    oneLiner: 'Sync health on /api/health for ops',
    references: [
      { ticketKey: 'PLAT-305', relation: 'depends_on', quote: 'It needs the progress events from PLAT-305', why: 'Only the progress events say which syncs are still running.' },
    ],
  },
  'PLAT-318': {
    summary: 'Delete the cron sync loop, its flags and its tests once the queue replaces it, keeping the one-off sync command.',
    oneLiner: 'Remove the old cron sync once the queue is live',
    references: [
      { ticketKey: 'PLAT-288', relation: 'depends_on', quote: 'Once PLAT-288 ships, remove the cron loop it replaces', why: 'The cron loop can only go once the queue does its job.' },
    ],
  },
  'INFRA-231': {
    summary: 'Let the worker node group scale between two and eight nodes instead of running six all day, without evicting unprotected pods.',
    oneLiner: 'Scale the worker nodes between two and eight',
    references: [],
  },
  'INFRA-244': {
    summary: 'Alarm the on-call channel when the sync queue backs up or a dead-letter message gets old.',
    oneLiner: 'Page on-call when the sync queue backs up',
    references: [
      { ticketKey: 'PLAT-288', relation: 'builds_on', quote: 'When the sync queue from PLAT-288 backs up', why: 'The alarms watch the queue that PLAT-288 puts the syncs on.' },
    ],
    links: [{ ticketKey: 'PLAT-288', why: 'There is no queue depth to alarm on until the syncs run on the queue.' }],
  },
  'INFRA-260': {
    summary: 'Move Terraform state into a versioned S3 bucket with a DynamoDB lock, so state is safe and two applies cannot collide.',
    oneLiner: 'Terraform state in S3 with a lock, off the laptop',
    references: [],
  },
  'INFRA-248': {
    summary: 'Give each environment its own Helm ingress values file, with staging rendering exactly as before.',
    oneLiner: 'One ingress values file per environment',
    references: [],
  },
  'INFRA-252': {
    summary: 'Pin one AMI for every node group and roll each group once, one node at a time.',
    oneLiner: 'Pin the node AMI so every node runs the same kernel',
    references: [],
  },
  'INFRA-199': {
    summary: 'Create the sync queue and its dead-letter queue, reached through the VPC endpoint.',
    oneLiner: 'The sync queue and its dead-letter queue',
    references: [
      { ticketKey: 'INFRA-180', relation: 'depends_on', quote: 'Uses the VPC endpoints from INFRA-180', why: 'Workers reach SQS through those endpoints.' },
    ],
  },
  'INFRA-180': {
    summary: 'Add SQS and S3 endpoints inside each VPC.',
    oneLiner: 'SQS and S3 endpoints inside each VPC',
    criteria: ['Each VPC has an SQS interface endpoint.', 'Each VPC has an S3 gateway endpoint.'],
    references: [],
  },
  'PLAT-275': {
    summary: 'Measure the GitHub calls and points each sync phase spends on a typical repository.',
    oneLiner: 'Measure what each sync phase spends against GitHub',
    criteria: ['Each sync phase has a measured GraphQL point cost.', 'Each sync phase has a measured REST call count.'],
    references: [],
  },
};

// ── THE FAKE JIRA ─────────────────────────────────────────────────────────────────────────────

const FIELD_AC = 'customfield_10100';
const FIELD_SPRINT = 'customfield_10020';
const FIELD_EPIC = 'customfield_10014';
const NAMES = {
  summary: 'Summary',
  description: 'Description',
  status: 'Status',
  issuetype: 'Issue Type',
  assignee: 'Assignee',
  [FIELD_AC]: 'Acceptance Criteria',
  [FIELD_SPRINT]: 'Sprint',
  [FIELD_EPIC]: 'Epic Link',
};
const SCHEMA = {
  summary: { type: 'string', system: 'summary' },
  description: { type: 'string', system: 'description' },
  [FIELD_AC]: { type: 'string', custom: 'com.atlassian.jira.plugin.system.customfieldtypes:textarea', customId: 10100 },
  [FIELD_SPRINT]: { type: 'array', items: 'json', custom: 'com.pyxis.greenhopper.jira:gh-sprint', customId: 10020 },
  [FIELD_EPIC]: { type: 'any', custom: 'com.pyxis.greenhopper.jira:gh-epic-link', customId: 10014 },
};

function issueJson(t: DemoTicket, now: number, sprint: { startsAt: number; endsAt: number }): Record<string, unknown> {
  const st = STATUSES[t.status];
  const iso = (daysAgo: number) => new Date(now - daysAgo * DAY).toISOString().replace('Z', '+0000');
  const person = t.assignee != null ? PEOPLE[t.assignee]! : null;
  return {
    id: String(10_000 + Number(t.key.split('-')[1])),
    key: t.key,
    fields: {
      summary: t.summary,
      description: t.description,
      issuetype: { id: t.type === 'Story' ? '10001' : t.type === 'Bug' ? '10004' : '10002', name: t.type },
      status: { id: st.id, name: st.name, statusCategory: { key: st.category } },
      assignee: person != null ? { accountId: person.id, displayName: person.name, avatarUrls: {} } : null,
      project: { key: t.key.split('-')[0] },
      components: t.components.map((name) => ({ name })),
      created: iso(t.createdDaysAgo),
      updated: iso(t.updatedDaysAgo),
      resolutiondate: t.resolvedDaysAgo != null ? iso(t.resolvedDaysAgo) : null,
      issuelinks: (t.blockedBy ?? []).map((k) => {
        const o = BY_KEY.get(k)!;
        const ost = STATUSES[o.status];
        return {
          type: { name: 'Blocks', inward: 'is blocked by', outward: 'blocks' },
          inwardIssue: { key: k, fields: { summary: o.summary, status: { id: ost.id, name: ost.name, statusCategory: { key: ost.category } } } },
        };
      }),
      [FIELD_AC]: t.ac,
      [FIELD_EPIC]: t.epic,
      [FIELD_SPRINT]: t.inSprint
        ? [
            {
              id: 24,
              name: SPRINT_NAME,
              state: 'active',
              boardId: BOARD_ID,
              startDate: new Date(sprint.startsAt).toISOString(),
              endDate: new Date(sprint.endsAt).toISOString(),
            },
          ]
        : [],
      parent: t.epic != null ? { key: t.epic, fields: { summary: EPICS[t.epic], issuetype: { name: 'Epic', hierarchyLevel: 1 } } } : undefined,
    },
  };
}

/** A JiraTransport answering the handful of URLs the reader asks for, from DEMO_TICKETS. */
function fakeJiraTransport(now: number, sprint: { startsAt: number; endsAt: number }) {
  const json = (body: unknown) => ({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
  return async (url: URL): Promise<{ status: number; contentType: string; body: string }> => {
    const p = url.pathname;
    let m: RegExpMatchArray | null;
    if ((m = p.match(/^\/rest\/api\/2\/issue\/([A-Z0-9-]+)$/))) {
      const t = BY_KEY.get(decodeURIComponent(m[1]!));
      if (t == null) return { status: 404, contentType: 'application/json', body: '{}' };
      return json({ ...issueJson(t, now, sprint), names: NAMES, schema: SCHEMA });
    }
    if (p === '/rest/api/2/field') {
      return json([
        { id: FIELD_AC, name: 'Acceptance Criteria', custom: true, schema: SCHEMA[FIELD_AC] },
        { id: FIELD_SPRINT, name: 'Sprint', custom: true, schema: SCHEMA[FIELD_SPRINT] },
      ]);
    }
    if (p === '/rest/api/3/search/jql' || p === '/rest/api/2/search') {
      const jql = url.searchParams.get('jql') ?? '';
      const keyList = /key in \(([^)]*)\)/i.exec(jql);
      let hits: DemoTicket[];
      if (keyList) {
        const keys = keyList[1]!.split(',').map((k) => k.replace(/["\s]/g, ''));
        hits = keys.map((k) => BY_KEY.get(k)).filter((t): t is DemoTicket => t != null);
      } else if (/openSprints\(\)/.test(jql)) {
        hits = DEMO_TICKETS.filter((t) => t.inSprint);
      } else {
        hits = [];
      }
      return json({ issues: hits.map((t) => issueJson(t, now, sprint)), names: NAMES, schema: SCHEMA, isLast: true, startAt: 0, total: hits.length });
    }
    if (p === `/rest/agile/1.0/board/${BOARD_ID}/configuration`) {
      const col = (name: string, k: StatusKey) => ({ name, statuses: [{ id: STATUSES[k].id }] });
      return json({
        columnConfig: {
          columns: [col('To Do', 'todo'), col('In Progress', 'progress'), col('In Review', 'review'), col('QA', 'qa'), col('Done', 'done')],
        },
      });
    }
    if (p === '/rest/api/2/status') {
      return json(Object.values(STATUSES).map((s) => ({ id: s.id, name: s.name, statusCategory: { key: s.category } })));
    }
    return { status: 404, contentType: 'application/json', body: '{}' };
  };
}

// ── THE SEED ──────────────────────────────────────────────────────────────────────────────────

export interface TrackerSeedCtx {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  schema: any;
  now: Date;
  workspaceId: number;
}

const quietLog = { info: () => {}, warn: (o: unknown, m?: string) => console.warn('  ⚠', m ?? '', JSON.stringify(o).slice(0, 300)), error: (o: unknown, m?: string) => console.warn('  ✗', m ?? '', JSON.stringify(o).slice(0, 300)) };
/** What a model pass needs from its context — with a credential that is never used. */
export const fakeAgentCtx = {
  log: quietLog,
  llm: { detectAuth: () => ({ status: 'ok' as const, method: 'api_key' as const }) },
  recordAiUsage: async () => {},
};

export async function seedDemoTracker(c: TrackerSeedCtx): Promise<{ sprintTickets: number; ghosts: number; briefs: number; themes: number; paths: number }> {
  const { db, schema, now, workspaceId } = c;
  const { eq } = await import('drizzle-orm');
  const nowMs = now.getTime();
  const startsAt = currentSprintStart(now);
  const sprint = { startsAt, endsAt: startsAt + 14 * DAY };
  const transport = fakeJiraTransport(nowMs, sprint) as never;

  // 1. Branch names that carry the ticket keys (detection reads title + branch).
  for (const t of DEMO_TICKETS) {
    for (const pr of t.prs) {
      await db.update(schema.pullRequests).set({ headRefName: pr.branch }).where(eq(schema.pullRequests.id, pr.id)).execute();
    }
  }

  // 2. The workspace's tracker: Jira Cloud, the two project keys, an API token (stored as typed —
  //    no ENCRYPTION_KEY locally; nothing ever sends it anywhere).
  const { buildTrackerContext } = await import('../src/tracker/runtime.js');
  const { writeWorkspaceTracker } = await import('../src/tracker/settings.js');
  const ctx = buildTrackerContext(quietLog as never);
  await writeWorkspaceTracker(ctx, 1, workspaceId, {
    issue: { provider: 'jira', baseUrl: ROOT, projectKeys: ['PLAT', 'INFRA'], matchScope: 'title_branch' },
    jira: { email: 'morgan.diaz@acme.example', token: 'demo-token-not-real' },
  } as never);

  // 3. The PR ticket worker: open PRs and the merged ones, read through the fake site.
  const { syncPrTickets } = await import('../src/tracker/worker.js');
  const prIds = DEMO_TICKETS.flatMap((t) => t.prs.map((p) => p.id));
  const prs = (await db.select({ id: schema.pullRequests.id, state: schema.pullRequests.state }).from(schema.pullRequests).execute()) as Array<{ id: number; state: string }>;
  const stateOf = new Map(prs.map((p) => [p.id, p.state]));
  const open = prIds.filter((id) => stateOf.get(id) === 'open');
  const merged = prIds.filter((id) => stateOf.get(id) !== 'open');
  await syncPrTickets(ctx, 1, open, { transport, mergedPrIds: merged, budget: 200, bypassBackoff: true });

  // 4. The sprint list read (+ the referenced tickets, depth 1). The tab's view stamp first: the
  //    read updates the row the view inserts.
  const { noteSprintViewed } = await import('../src/db/sprint-store.js');
  await noteSprintViewed(1, workspaceId, now);
  const { readWorkspaceSprint, expandSprintGhosts } = await import('../src/tracker/sprint/read.js');
  const read = await readWorkspaceSprint(ctx, 1, workspaceId, { transport });
  if (!read.ok) throw new Error(`demo sprint read failed: ${read.code}`);

  // 5. The briefs, round by round (a ghost's brief can name the next hop of its chain).
  const { sprintBriefTodo } = await import('../src/db/sprint-graph.js');
  const { storeSprintBrief } = await import('../src/db/sprint-briefs.js');
  const { validateSprintBrief } = await import('../src/review/sprint-briefs/validate.js');
  let briefs = 0;
  for (let round = 0; round < 4; round++) {
    const todo = await sprintBriefTodo(1, workspaceId, 60);
    for (const t of todo) {
      const key = t.ident.slice(t.ident.indexOf('#') + 1);
      const b = BRIEFS[key];
      if (b == null) throw new Error(`no demo brief for ${key}`);
      const answer = { ...b, criteria: b.criteria ?? t.input.criteria };
      const v = validateSprintBrief(
        JSON.stringify(answer),
        { title: t.input.title, description: t.input.description, criteria: t.input.criteria },
        t.input.criteria.length > 0,
        t.input.links.map((l) => l.key),
      );
      if (!v.ok) throw new Error(`demo brief for ${key} refused: ${v.reason}`);
      if (v.references.length !== b.references.length) throw new Error(`demo brief for ${key}: a reference failed its quote check`);
      await storeSprintBrief(1, workspaceId, t.ident, t.input.textHash, {
        summary: v.summary,
        oneLiner: v.oneLiner,
        criteria: v.criteria,
        criteriaDerived: t.input.derived,
        references: v.references,
        linkReasons: v.linkReasons,
        costUsd: 0.0009,
        inputTokens: 1450,
        outputTokens: 210,
      }, new Date(nowMs - 3 * 3_600_000));
      briefs++;
    }
    const stored = await expandSprintGhosts(ctx, 1, workspaceId, { transport });
    if (todo.length === 0 && stored === 0) break;
  }

  // 6. Themes (one Haiku answer in the product, here a written one through the real pass).
  const { runSprintThemePass } = await import('../src/review/sprint-themes/manager.js');
  const THEMES = [
    { name: 'Sync correctness', summary: 'Making every sync write whole pull requests, faster, and catching review requests as they happen.' },
    { name: 'Queue-based scheduling', summary: 'Moving repository syncs onto the job queue, alarming when it backs up, and removing the old cron loop.' },
    { name: 'Sync visibility', summary: 'Showing people and ops what a sync is doing, and pausing politely when GitHub runs out of budget.' },
    { name: 'Cluster and state hygiene', summary: 'Cheaper node groups, pinned images, per-environment ingress, and Terraform state that cannot be lost.' },
  ];
  const THEME_OF: Record<string, number> = {
    'PLAT-292': 1, 'PLAT-301': 1, 'PLAT-296': 1, 'PLAT-297': 1, 'PLAT-315': 1,
    'PLAT-288': 2, 'PLAT-318': 2, 'INFRA-244': 2,
    'PLAT-305': 3, 'PLAT-312': 3, 'PLAT-310': 3,
    'INFRA-231': 4, 'INFRA-260': 4, 'INFRA-248': 4, 'INFRA-252': 4,
  };
  const themeAnswer = JSON.stringify({
    themes: THEMES,
    tickets: Object.entries(THEME_OF).map(([key, theme]) => ({ key, theme })),
  });
  const themes = await runSprintThemePass(fakeAgentCtx as never, 1, workspaceId, {
    aiEnabled: true,
    entitled: async () => true,
    complete: async () => ({ text: themeAnswer, usage: { inputTokens: 3100, outputTokens: 420 } }),
  });
  if (themes.state !== 'done') throw new Error(`demo themes: ${themes.state}`);

  // 7. Critical paths + call-outs (the Sonnet sprint builder's one tool call, written here).
  const { runSprintPathsPass } = await import('../src/review/sprint-paths/manager.js');
  const accepted = {
    paths: [
      {
        title: 'Queue first, then what watches it',
        advice: 'Three tickets wait on the queue move: the alarms, the cron removal and the health report, so get its pull request reviewed this week.',
        risk: 'high',
        tickets: ['PLAT-288', 'INFRA-244', 'PLAT-318'],
      },
      {
        title: 'Upsert change before the webhook',
        advice: 'The webhook handler writes through the new upsert and conflicts with main, so rebase it only after the upsert change merges.',
        risk: 'medium',
        tickets: ['PLAT-292', 'PLAT-301'],
      },
      {
        title: 'Progress events feed the health report',
        advice: 'The health report needs the progress events, and nobody owns the health ticket yet.',
        risk: 'medium',
        tickets: ['PLAT-305', 'PLAT-312'],
      },
    ],
    callouts: [
      {
        title: 'Node group change has red checks',
        advice: 'The autoscaling change fails its plan step, and it is the only infrastructure ticket in review.',
        tickets: ['INFRA-231'],
      },
      {
        title: 'State move open for a month',
        advice: 'One of its two pull requests merged weeks ago and the other has gone quiet, so decide whether it still fits this sprint.',
        tickets: ['INFRA-260'],
      },
    ],
  };
  const paths = await runSprintPathsPass(fakeAgentCtx as never, 1, workspaceId, {
    aiEnabled: true,
    entitled: async () => true,
    applyAuthEnv: async () => false,
    runner: (async () => ({
      accepted,
      lastRefusal: null,
      subtype: 'success',
      runtimeMissing: false,
      error: null,
      costUsd: 0.38,
      inputTokens: 14_200,
      outputTokens: 1_650,
    })) as never,
  });
  if (paths.state !== 'done') throw new Error(`demo paths: ${paths.state} ${paths.failure ?? ''}`);

  const ghosts = DEMO_TICKETS.filter((t) => !t.inSprint).length;
  return { sprintTickets: read.stored, ghosts, briefs, themes: themes.themes, paths: paths.paths };
}
