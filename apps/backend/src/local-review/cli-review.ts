// `ensemble review` — the thin terminal client of a local branch review (docs/CLAUDE-REVIEW.md § Reviewing a local
// branch). It packages the branch in the working folder (snapshot.ts), asks the RUNNING Ensemble to review it
// (client.ts) and waits, then prints the result: text for a person, or `--json` (the MCP tools' projection,
// view.ts). Ctrl-C cancels the run. Exit status: 0 when the run succeeded, 1 otherwise (a refusal included).
import { AI_EFFORTS, type AiEffort } from '@pierre-review/shared';
import { ClientError, LocalReviewClient } from './client.js';
import { listText, reviewText, reviewView } from './view.js';

export interface ReviewCliOptions {
  json: boolean;
  includeUncommitted: boolean;
  ticket: string | null;
  base: string | null;
  provider: 'claude' | 'codex' | null;
  effort: AiEffort | null;
  story: boolean;
  list: boolean;
  /** Read an existing run instead of starting one. */
  id: number | null;
  help: boolean;
}

export const REVIEW_USAGE = `ensemble review — ask the running Ensemble to review the branch you are on, before you push

Usage:
  ensemble review [options]

Options:
  --json             Print the result as JSON (the same fields the MCP tools return)
  --no-uncommitted   Leave out uncommitted changes (by default, changes to tracked files are included;
                     untracked files never are)
  --ticket <KEY>     The ticket to check the acceptance criteria against (default: found in the
                     branch name or the commit subjects)
  --base <ref>       Compare against this ref (default: the upstream of a stacked branch, else
                     origin's default branch)
  --provider <p>     claude or codex, for this run only (default: Settings → AI → Review)
  --effort <level>   ${AI_EFFORTS.join(', ')}, for this run only
  --story            Check the acceptance criteria only (no code review)
  --list             List the reviews of this branch
  --id <n>           Show review <n> (waits while it runs)
  -h, --help         Show this help

Ensemble must be running (npx ensemble-review). Nothing is posted or pushed.
`;

/** Parse the arguments, or return a plain line. Pure. */
export function parseReviewArgs(argv: readonly string[]): ReviewCliOptions | string {
  const o: ReviewCliOptions = { json: false, includeUncommitted: true, ticket: null, base: null, provider: null, effort: null, story: false, list: false, id: null, help: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    const value = (): string | null => {
      const v = argv[i + 1];
      if (v === undefined || v.startsWith('--')) return null;
      i++;
      return v;
    };
    switch (arg) {
      case '--json':
        o.json = true;
        break;
      case '--no-uncommitted':
        o.includeUncommitted = false;
        break;
      case '--story':
        o.story = true;
        break;
      case '--list':
        o.list = true;
        break;
      case '--ticket': {
        const v = value();
        if (!v) return '--ticket needs a key, for example --ticket PAY-142';
        o.ticket = v;
        break;
      }
      case '--base': {
        const v = value();
        if (!v) return '--base needs a ref, for example --base origin/main';
        o.base = v;
        break;
      }
      case '--provider': {
        const v = value();
        if (v !== 'claude' && v !== 'codex') return '--provider must be claude or codex';
        o.provider = v;
        break;
      }
      case '--effort': {
        const v = value();
        if (!v || !(AI_EFFORTS as readonly string[]).includes(v)) return `--effort must be one of ${AI_EFFORTS.join(', ')}`;
        o.effort = v as AiEffort;
        break;
      }
      case '--id': {
        const v = value();
        const n = v && /^\d+$/.test(v) ? Number(v) : NaN;
        if (!Number.isSafeInteger(n) || n <= 0) return '--id needs a review id';
        o.id = n;
        break;
      }
      case '-h':
      case '--help':
        o.help = true;
        break;
      default:
        return `Unknown argument: ${arg}. Run \`ensemble review --help\` for usage.`;
    }
  }
  return o;
}

export interface ReviewCliIo {
  out(text: string): void;
  err(text: string): void;
  onInterrupt(handler: () => void): () => void;
}

const defaultIo: ReviewCliIo = {
  out: (t) => void process.stdout.write(`${t}\n`),
  err: (t) => void process.stderr.write(`${t}\n`),
  onInterrupt(handler) {
    process.once('SIGINT', handler);
    return () => process.removeListener('SIGINT', handler);
  },
};

/** Run the command; resolves to the exit status. */
export async function runReviewCli(argv: readonly string[], client: LocalReviewClient = new LocalReviewClient(), io: ReviewCliIo = defaultIo): Promise<number> {
  const o = parseReviewArgs(argv);
  if (typeof o === 'string') {
    io.err(o);
    return 1;
  }
  if (o.help) {
    io.out(REVIEW_USAGE);
    return 0;
  }
  try {
    if (o.list) {
      const l = await client.list({});
      io.out(o.json ? JSON.stringify(l, null, 2) : listText(l));
      return 0;
    }
    let id = o.id;
    if (id == null) {
      const res = await client.start({
        kind: o.story ? 'story' : 'review',
        includeUncommitted: o.includeUncommitted,
        ticket: o.ticket,
        base: o.base,
        provider: o.provider,
        effort: o.effort,
      });
      id = res.id;
      if (!o.json) {
        io.err(
          `${res.alreadyRunning ? 'A review of this branch is already running' : 'Reviewing'} ${res.repo} ${res.branch} at ${res.headSha.slice(0, 12)}${res.uncommittedChanges ? ' (with uncommitted changes)' : ''} — review ${res.id}. Ctrl-C stops it.`,
        );
        if (res.skippedFiltered.length > 0) {
          io.err(`Left at their committed version (they use a git filter, for example Git LFS): ${res.skippedFiltered.join(', ')}. Commit them to include them.`);
        }
        if (res.ignoredAnswers.length > 0) io.err(res.ignoredAnswers.join('\n'));
      }
    }
    const runId = id;
    let stopped: Promise<unknown> | null = null;
    const off = io.onInterrupt(() => {
      stopped ??= client.cancel(runId).catch(() => {});
    });
    try {
      let r = await client.get(runId, 50_000);
      while (r.status === 'running' && !stopped) r = await client.get(runId, 50_000);
      if (stopped) {
        // The cancel lands first, so the run read after it says how it ended.
        await stopped;
        r = await client.get(runId, 0);
      }
      io.out(o.json ? JSON.stringify(reviewView(r), null, 2) : reviewText(r));
      return r.status === 'succeeded' ? 0 : 1;
    } finally {
      off();
    }
  } catch (err) {
    io.err(err instanceof ClientError ? err.message : `ensemble review failed: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
}
