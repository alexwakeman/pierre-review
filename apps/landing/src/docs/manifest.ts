import type { PageEntry, PageModule, SectionEntry, Writer } from './types';
import { docRoute } from './routes';

// ---------------------------------------------------------------------------
// THE DOCS MANIFEST — the one list of sections and pages, in reading order.
//
// The sidebar, the docs home, prev/next, search, the prerendered routes and the sitemap all read
// this. A page's title and summary live in its own file (`export const meta`); this file says
// which section it is in, its order, and who writes it.
//
// To add a page: create pages/<section>/<slug>.tsx (copy a neighbour), then add `{ slug }` to its
// section below. To remove a feature's page: delete the file AND its line here, and grep for
// DocLinks to it (the docs test fails on a broken link). See CONTRIBUTING.md.
//
// The sections mirror the app: Getting started, then the app's sidebar destinations in sidebar
// order, the pull request view (one page per tab), the AI features, merging, Settings (one page
// per Settings tab), one page per integration vendor, security, and the reference pages.
// APP_COVERAGE below maps every sidebar destination, pull request tab and Settings tab in the app
// to its page; the docs test reads the app's source and fails when one is missing.
// ---------------------------------------------------------------------------

interface SectionDef {
  id: string;
  title: string;
  group: string;
  writer: Writer;
  blurb: string;
  pages: ReadonlyArray<{ slug: string; writer?: Writer }>;
}

const SECTION_DEFS: readonly SectionDef[] = [
  {
    id: 'getting-started',
    title: 'Getting started',
    group: 'Start here',
    writer: 'W1',
    blurb: 'Install Limn, add your repositories and find your way around.',
    pages: [
      { slug: 'introduction' },
      { slug: 'install-and-run' },
      { slug: 'add-repositories' },
      { slug: 'workspaces' },
      { slug: 'find-your-way-around' },
      { slug: 'keyboard-shortcuts' },
      { slug: 'repository-pages' },
    ],
  },
  {
    id: 'open-pull-requests',
    title: 'Open pull requests',
    group: 'The app',
    writer: 'W1',
    blurb: 'Every open pull request in the workspace, with what each one needs.',
    pages: [
      { slug: 'overview' },
      { slug: 'trunk-strip' },
      { slug: 'ai-review-column' },
    ],
  },
  {
    id: 'pending',
    title: 'Pending',
    group: 'The app',
    writer: 'W1',
    blurb: 'Everything waiting on you or your workspace, ranked most actionable first.',
    pages: [
      { slug: 'overview' },
      { slug: 'my-turn' },
      { slug: 'ai-reviews' },
      { slug: 'needs-fixing' },
      { slug: 'waiting-on-review' },
      { slug: 'unanswered-threads' },
      { slug: 'ready-to-land' },
      { slug: 'dependencies' },
      { slug: 'waiting-on-others' },
      { slug: 'notifications' },
    ],
  },
  {
    id: 'this-sprint',
    title: 'This Sprint',
    group: 'The app',
    writer: 'W3',
    blurb: 'The tracker\'s current sprint: themes, critical path, people and what merged.',
    pages: [
      { slug: 'overview' },
      { slug: 'theme' },
      { slug: 'critical-path' },
      { slug: 'people' },
      { slug: 'story-view' },
      { slug: 'ask-about-the-sprint' },
    ],
  },
  {
    id: 'timeline',
    title: 'Timeline',
    group: 'The app',
    writer: 'W1',
    blurb: 'Every pull request over time, on one board.',
    pages: [
      { slug: 'overview' },
      { slug: 'filters' },
      { slug: 'focus-a-pull-request' },
      { slug: 'thread-states' },
    ],
  },
  {
    id: 'docs-library',
    title: 'Docs library',
    group: 'The app',
    writer: 'W3',
    blurb: 'Reference documents for the workspace, and a chat that answers from them.',
    pages: [
      { slug: 'overview' },
      { slug: 'add-documents' },
      { slug: 'read-and-ask' },
      { slug: 'search' },
      { slug: 'docs-in-reviews' },
    ],
  },
  {
    id: 'feed',
    title: 'Feed',
    group: 'The app',
    writer: 'W1',
    blurb: 'One stream of activity across every repository in the workspace.',
    pages: [
      { slug: 'overview' },
      { slug: 'people-and-bots' },
    ],
  },
  {
    id: 'reports',
    title: 'Reports',
    group: 'The app',
    writer: 'W4',
    blurb: 'Flow metrics, Chronology, stories and AI usage for the workspace.',
    pages: [
      { slug: 'overview' },
      { slug: 'reporting-window' },
      { slug: 'chronology' },
      { slug: 'stories' },
      { slug: 'ai-usage' },
    ],
  },
  {
    id: 'bots-monitoring',
    title: 'Bots Monitoring',
    group: 'The app',
    writer: 'W4',
    blurb: 'Measure and triage the review bots in the workspace.',
    pages: [
      { slug: 'overview' },
      { slug: 'roi' },
      { slug: 'themes' },
      { slug: 'benchmark' },
      { slug: 'severity-scoring' },
    ],
  },
  {
    id: 'pull-request',
    title: 'The pull request view',
    group: 'The app',
    writer: 'W1',
    blurb: 'One pull request, tab by tab.',
    pages: [
      { slug: 'overview' },
      { slug: 'overview-tab' },
      { slug: 'activity' },
      { slug: 'threads' },
      { slug: 'changes' },
      { slug: 'bot-activity' },
      { slug: 'ai-review-tab' },
      { slug: 'ai-fix-tab' },
      { slug: 'ticket' },
      { slug: 'blast-radius' },
    ],
  },
  {
    id: 'ai-review',
    title: 'AI review',
    group: 'AI features',
    writer: 'W2',
    blurb: 'Reviews by Claude, Codex or both, on your own subscription.',
    pages: [
      { slug: 'overview' },
      { slug: 'run-a-review' },
      { slug: 'claude-and-codex' },
      { slug: 'auto-review' },
      { slug: 'follow-ups' },
      { slug: 'replies-pass' },
      { slug: 'check-threads' },
      { slug: 'verdicts-and-posting' },
      { slug: 'team-reviews' },
      { slug: 'ci-review' },
      { slug: 'design-diagrams' },
      { slug: 'review-chat' },
    ],
  },
  {
    id: 'story-checks',
    title: 'Story checks',
    group: 'AI features',
    writer: 'W3',
    blurb: 'Check a pull request against its ticket and your docs.',
    pages: [
      { slug: 'overview' },
      { slug: 'acceptance-criteria' },
      { slug: 'ticket-comments' },
      { slug: 'check-against-docs' },
    ],
  },
  {
    id: 'ai-fix',
    title: 'AI Fix',
    group: 'AI features',
    writer: 'W2',
    blurb: 'An agent that fixes findings, failing checks and merge conflicts, in a sandbox.',
    pages: [
      { slug: 'overview' },
      { slug: 'what-to-fix' },
      { slug: 'plan-first' },
      { slug: 'resolve-merge-conflicts' },
      { slug: 'push-and-auto-fix' },
    ],
  },
  {
    id: 'implement-story',
    title: 'Implement story',
    group: 'AI features',
    writer: 'W2',
    blurb: 'Build a ticket from its story, in a sandbox, and push it as a pull request.',
    pages: [
      { slug: 'overview' },
      { slug: 'plan' },
      { slug: 'fill-gaps' },
      { slug: 'push' },
    ],
  },
  {
    id: 'merging',
    title: 'Merging',
    group: 'Workflows',
    writer: 'W4',
    blurb: 'Can it land, merge when ready, merge queues, conflicts and CI logs.',
    pages: [
      { slug: 'can-it-land' },
      { slug: 'merge-when-ready' },
      { slug: 'merge-queues' },
      { slug: 'resolve-conflicts' },
      { slug: 'ci-logs' },
      { slug: 'dependency-automation' },
    ],
  },
  {
    id: 'settings',
    title: 'Settings',
    group: 'Settings',
    writer: 'W5',
    blurb: 'Every Settings tab, and how Limn uses your AI subscription.',
    pages: [
      { slug: 'appearance' },
      { slug: 'pull-requests' },
      { slug: 'pending' },
      { slug: 'features' },
      { slug: 'dependencies' },
      { slug: 'ai' },
      { slug: 'ai-review' },
      { slug: 'docs' },
      { slug: 'sandbox' },
      { slug: 'reports-and-sprint' },
      { slug: 'integrations' },
      { slug: 'bots' },
      { slug: 'ai-usage-and-spend' },
      { slug: 'how-providers-treat-your-work' },
    ],
  },
  {
    id: 'integrations',
    title: 'Integrations',
    group: 'Integrations',
    writer: 'W5',
    blurb: 'One page for each service Limn connects to.',
    pages: [
      { slug: 'github', writer: 'W4' },
      { slug: 'claude', writer: 'W5' },
      { slug: 'codex', writer: 'W5' },
      { slug: 'jira', writer: 'W3' },
      { slug: 'github-issues', writer: 'W3' },
      { slug: 'linear', writer: 'W3' },
      { slug: 'notion', writer: 'W3' },
      { slug: 'confluence', writer: 'W3' },
      { slug: 'sonarcloud', writer: 'W4' },
      { slug: 'slack', writer: 'W4' },
      { slug: 'sandbox-runtimes', writer: 'W2' },
    ],
  },
  {
    id: 'security',
    title: 'Security and running locally',
    group: 'Running Limn',
    writer: 'W5',
    blurb: 'What runs where, what is stored, and how Limn protects your code.',
    pages: [
      { slug: 'runs-on-your-machine' },
      { slug: 'data-and-storage' },
      { slug: 'github-access' },
      { slug: 'ai-and-the-sandbox' },
      { slug: 'browser-and-network' },
      { slug: 'export-and-delete' },
    ],
  },
  {
    id: 'licence',
    title: 'Licence',
    group: 'Reference',
    writer: 'W5',
    blurb: 'The Limn License in plain English.',
    pages: [
      { slug: 'licence' },
    ],
  },
  {
    id: 'faq',
    title: 'FAQ',
    group: 'Reference',
    writer: 'W5',
    blurb: 'Short answers to common questions.',
    pages: [
      { slug: 'faq' },
    ],
  },
  {
    id: 'troubleshooting',
    title: 'Troubleshooting',
    group: 'Reference',
    writer: 'W5',
    blurb: 'What to do when something does not work.',
    pages: [
      { slug: 'troubleshooting' },
    ],
  },
  {
    id: 'changelog',
    title: 'Changelog',
    group: 'Reference',
    writer: 'auto',
    blurb: 'What changed in each release.',
    pages: [
      { slug: 'changelog' },
    ],
  },
];

/** Every page module, read at build time. Keys look like `./pages/<section>/<slug>.tsx`. */
const MODULES = import.meta.glob<PageModule>('./pages/*/*.tsx', { eager: true });

function moduleFor(section: string, slug: string): PageModule {
  const mod = MODULES[`./pages/${section}/${slug}.tsx`];
  if (!mod) throw new Error(`docs manifest: no page file for ${section}/${slug} (pages/${section}/${slug}.tsx)`);
  return mod;
}

export const SECTIONS: readonly SectionEntry[] = SECTION_DEFS.map((s) => ({
  id: s.id,
  title: s.title,
  group: s.group,
  blurb: s.blurb,
  pages: s.pages.map(({ slug, writer }): PageEntry => {
    const mod = moduleFor(s.id, slug);
    const key = `${s.id}/${slug}`;
    return { key, section: s.id, slug, writer: writer ?? s.writer, route: docRoute(key), meta: mod.meta, Body: mod.default };
  }),
}));

/** Every page, in reading order (prev/next follow it). */
export const PAGES: readonly PageEntry[] = SECTIONS.flatMap((s) => s.pages);

/** The page files on disk, as `<section>/<slug>` (the docs test compares them with PAGES). */
export const PAGE_FILES: readonly string[] = Object.keys(MODULES).map((k) =>
  k.replace(/^\.\/pages\//, '').replace(/\.tsx$/, ''),
);

const BY_ROUTE = new Map(PAGES.map((p) => [p.route, p]));
const BY_KEY = new Map(PAGES.map((p) => [p.key, p]));

export function pageForPath(path: string): PageEntry | null {
  return BY_ROUTE.get(path) ?? null;
}

export function pageForKey(key: string): PageEntry | null {
  return BY_KEY.get(key) ?? null;
}

export function sectionFor(id: string): SectionEntry | null {
  return SECTIONS.find((s) => s.id === id) ?? null;
}

/** The pages either side of this one, in reading order. */
export function neighbours(key: string): { prev: PageEntry | null; next: PageEntry | null } {
  const i = PAGES.findIndex((p) => p.key === key);
  return { prev: i > 0 ? PAGES[i - 1]! : null, next: i >= 0 && i < PAGES.length - 1 ? PAGES[i + 1]! : null };
}

/** The sidebar headings, in order, each with its sections. */
export const GROUPS: ReadonlyArray<{ title: string; sections: SectionEntry[] }> = SECTIONS.reduce<
  Array<{ title: string; sections: SectionEntry[] }>
>((acc, s) => {
  const last = acc[acc.length - 1];
  if (last && last.title === s.group) last.sections.push(s);
  else acc.push({ title: s.group, sections: [s] });
  return acc;
}, []);

// ---- the app, mapped to its pages ------------------------------------------------------------
//
// ⚠ KEEP IN STEP WITH THE APP. The docs test reads the ids from the frontend source
// (components/shell/nav.ts DESTINATIONS, PrDetail.tsx TAB_LABELS, settings/settingsTabs.ts,
// Activity/pendingTabs.ts TAB_LABEL, Activity/InsightsView.tsx, Activity/BotsView.tsx) and fails
// when an id has no page here. A NEW destination, tab or Settings tab needs its page.

export const APP_COVERAGE = {
  /** The sidebar's destinations. */
  destinations: {
    'open-prs': 'open-pull-requests/overview',
    attention: 'pending/overview',
    sprint: 'this-sprint/overview',
    timeline: 'timeline/overview',
    docs: 'docs-library/overview',
    feed: 'feed/overview',
    insights: 'reports/overview',
    bots: 'bots-monitoring/overview',
  },
  /** The pull request view's tabs. */
  prTabs: {
    overview: 'pull-request/overview-tab',
    activity: 'pull-request/activity',
    threads: 'pull-request/threads',
    changes: 'pull-request/changes',
    bot_activity: 'pull-request/bot-activity',
    claude_review: 'pull-request/ai-review-tab',
    ai_fix: 'pull-request/ai-fix-tab',
    story: 'pull-request/ticket',
  },
  /** The Settings tabs. */
  settingsTabs: {
    appearance: 'settings/appearance',
    'pull-requests': 'settings/pull-requests',
    pending: 'settings/pending',
    features: 'settings/features',
    dependencies: 'settings/dependencies',
    ai: 'settings/ai',
    'ai-review': 'settings/ai-review',
    docs: 'settings/docs',
    sandbox: 'settings/sandbox',
    reports: 'settings/reports-and-sprint',
    integrations: 'settings/integrations',
    bots: 'settings/bots',
  },
  /** The Pending board's tabs. */
  pendingTabs: {
    my_turn: 'pending/my-turn',
    claude: 'pending/ai-reviews',
    fixing: 'pending/needs-fixing',
    review: 'pending/waiting-on-review',
    threads: 'pending/unanswered-threads',
    land: 'pending/ready-to-land',
    deps: 'pending/dependencies',
    waiting: 'pending/waiting-on-others',
  },
  /** The Reports tabs. */
  reportsTabs: {
    overview: 'reports/overview',
    bottlenecks: 'reports/chronology',
    stories: 'reports/stories',
    'ai-usage': 'reports/ai-usage',
  },
  /** The Bots Monitoring tabs. */
  botsTabs: {
    roi: 'bots-monitoring/roi',
    themes: 'bots-monitoring/themes',
    benchmark: 'bots-monitoring/benchmark',
  },
} as const satisfies Record<string, Record<string, string>>;
