// `pierre status` — a one-command terminal view of the cross-repo "my turn" queue.
//
// LOCAL-only. Loaded lazily by cli.ts AFTER flags→env mapping, so its static imports
// (which open the DB at load time) see the right DATABASE_URL. Renders the same
// getMyTurn() the SPA uses, with OSC-8 clickable links and an optional --watch repaint.
import { ensureLocalAccount, LOCAL_ACCOUNT_ID } from './auth/account.js';
import { closeDb } from './db/client.js';
import { getMyTurn, listRepos } from './db/queries.js';
import { runMigrations } from './db/run-migrations.js';
import type { Logger } from './sync/sync-repo.js';
import type { MyTurnResponse, User } from '@pierre-review/shared';

// ── tiny ANSI helpers (degrade gracefully when not a TTY) ──────────────────────
const useColor = process.stdout.isTTY && process.env.NO_COLOR === undefined;
const paint = (code: string, s: string): string =>
  useColor ? `\x1b[${code}m${s}\x1b[0m` : s;
const dim = (s: string): string => paint('2', s);
const bold = (s: string): string => paint('1', s);
const cyan = (s: string): string => paint('36', s);
const green = (s: string): string => paint('32', s);

// OSC-8 hyperlink; falls back to `label (url)` when the target isn't a TTY.
function link(url: string, label: string): string {
  if (!process.stdout.isTTY) return `${label} (${url})`;
  return `\x1b]8;;${url}\x1b\\${label}\x1b]8;;\x1b\\`;
}

const termWidth = (): number => process.stdout.columns ?? 100;

// Strip C0 control bytes (ESC, BEL, …) from REMOTE-controlled text (PR titles, paths,
// comment excerpts) before it reaches the terminal — an ESC embedded in a PR title could
// otherwise inject escape sequences into the very terminal we're emitting OSC-8 links to.
// Note the excerpt's whitespace collapse does NOT catch these: \s excludes ESC/BEL.
function sanitize(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '');
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  if (max <= 1) return '…';
  return s.slice(0, max - 1) + '…';
}

// Compact relative age from an ISO timestamp (e.g. "3h", "2d", "5w").
function relativeAge(iso: string): string {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return '';
  const secs = Math.max(0, Math.floor((Date.now() - then) / 1000));
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h`;
  const days = Math.floor(hrs / 24);
  if (days < 7) return `${days}d`;
  const weeks = Math.floor(days / 7);
  if (weeks < 5) return `${weeks}w`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months}mo`;
  return `${Math.floor(days / 365)}y`;
}

// A quiet logger for the on-demand sync — swallow the chatty info stream, surface
// only warnings/errors so `--sync` stays terse.
const syncLogger: Logger = {
  info: () => {},
  warn: (m, ...a) => console.warn(dim(String(m)), ...a),
  error: (m, ...a) => console.error(String(m), ...a),
};

interface Rendered {
  output: string;
  keys: Set<string>;
}

// Build the full status screen as one string. `prevKeys` (the item keys from the
// previous --watch tick, or null on the first paint / one-shot) drives the "new since
// last tick" bullet.
function render(
  data: MyTurnResponse,
  prevKeys: Set<string> | null,
  repoCount: number,
): Rendered {
  const usersById = new Map<number, User>();
  for (const u of data.users) usersById.set(u.id, u);
  const loginOf = (id: number | null): string | null =>
    id == null ? null : (usersById.get(id)?.githubLogin ?? null);

  const keys = new Set<string>();
  const lines: string[] = [];

  const total =
    data.awaitingReview.length +
    data.threadsAwaiting.length +
    data.approvedPrs.length +
    data.yourPrs.length +
    data.watchedRepoPrs.length;

  lines.push('');
  lines.push(`  ${bold(cyan('pierre status'))}${dim('  ·  your turn across all repos')}`);
  lines.push('');

  if (total === 0) {
    lines.push(`  ${green('All clear — nothing needs your attention.')}`);
    if (repoCount === 0) {
      lines.push(`  ${dim('No repos watched yet — run `pierre` to add some.')}`);
    }
    lines.push('');
    return { output: lines.join('\n') + '\n', keys };
  }

  const section = (title: string, count: number): void => {
    lines.push(`  ${bold(title)}  ${dim(String(count))}`);
  };

  // One PR/thread row: bullet · dim(repo#n) · linked title · dim(suffix) · dim(age).
  const row = (
    key: string,
    rawRef: string,
    rawUrl: string,
    rawTitle: string,
    ageIso: string,
    rawSuffix: string | null,
  ): void => {
    // Every remote-controlled string is sanitized here — the one choke point all rows pass.
    const ref = sanitize(rawRef);
    const url = sanitize(rawUrl);
    const title = sanitize(rawTitle);
    const suffix = rawSuffix == null ? null : sanitize(rawSuffix);
    keys.add(key);
    const isNew = prevKeys != null && !prevKeys.has(key);
    const bullet = isNew ? green('●') : dim('·');
    const age = relativeAge(ageIso);
    // Rough visible budget so a long title doesn't wrap the terminal.
    const fixed =
      4 + ref.length + 1 + (suffix ? suffix.length + 1 : 0) + (age ? age.length + 2 : 0);
    const shownTitle = truncate(title, Math.max(12, termWidth() - fixed));
    let line = `  ${bullet} ${dim(ref)} ${link(url, shownTitle)}`;
    if (suffix) line += ` ${dim(suffix)}`;
    if (age) line += `  ${dim(age)}`;
    lines.push(line);
  };

  // 1. PRs where your review is requested.
  if (data.awaitingReview.length > 0) {
    section('Review requested of you', data.awaitingReview.length);
    for (const it of data.awaitingReview) {
      const author = loginOf(it.authorId);
      row(
        `review:${it.prId}`,
        `${it.repoFullName}#${it.number}`,
        it.githubUrl,
        it.title,
        it.openedAt,
        author ? `by @${author}` : null,
      );
    }
    lines.push('');
  }

  // 2. Review threads you opened that got a reply and aren't resolved.
  if (data.threadsAwaiting.length > 0) {
    section('Threads awaiting your reply', data.threadsAwaiting.length);
    for (const it of data.threadsAwaiting) {
      const label = it.line != null ? `${it.path}:${it.line}` : it.path;
      const replier = loginOf(it.lastReplyAuthorId);
      row(
        `thread:${it.threadId}`,
        `${it.repoFullName}#${it.prNumber}`,
        it.githubUrl,
        label,
        it.lastReplyAt,
        replier ? `↩ @${replier}` : null,
      );
      const excerpt = sanitize((it.lastReplyExcerpt ?? '').replace(/\s+/g, ' ').trim());
      if (excerpt) {
        lines.push(`      ${dim(truncate(excerpt, Math.max(12, termWidth() - 8)))}`);
      }
    }
    lines.push('');
  }

  // 3. Your open PRs with a standing approval — likely ready to merge.
  if (data.approvedPrs.length > 0) {
    section('Approved — ready to merge', data.approvedPrs.length);
    for (const it of data.approvedPrs) {
      row(
        `approved:${it.prId}`,
        `${it.repoFullName}#${it.number}`,
        it.githubUrl,
        it.title,
        it.openedAt,
        `✓ ${it.approvals} approval${it.approvals === 1 ? '' : 's'}`,
      );
    }
    lines.push('');
  }

  // 4. Your open PRs with new activity since you last looked.
  if (data.yourPrs.length > 0) {
    section('Your PRs — new activity', data.yourPrs.length);
    for (const it of data.yourPrs) {
      row(
        `yours:${it.prId}`,
        `${it.repoFullName}#${it.number}`,
        it.githubUrl,
        it.title,
        it.openedAt,
        null,
      );
      if (it.summary) lines.push(`      ${dim(sanitize(it.summary))}`);
    }
    lines.push('');
  }

  // 5. New open PRs by others in repos you've Watched.
  if (data.watchedRepoPrs.length > 0) {
    section('New in watched repos', data.watchedRepoPrs.length);
    for (const it of data.watchedRepoPrs) {
      const author = loginOf(it.authorId);
      row(
        `watched:${it.prId}`,
        `${it.repoFullName}#${it.number}`,
        it.githubUrl,
        it.title,
        it.openedAt,
        author ? `by @${author}` : null,
      );
    }
    lines.push('');
  }

  return { output: lines.join('\n') + '\n', keys };
}

const SYNC_MIN_INTERVAL_MS = 5 * 60 * 1000;

export async function runStatus(opts: {
  watch: boolean;
  sync: boolean;
  intervalSeconds: number;
}): Promise<void> {
  await runMigrations();

  const account = await ensureLocalAccount();
  if (!account?.githubLogin) {
    console.warn(
      dim(
        "Couldn't resolve your GitHub identity (`gh api user`) — the queue may be empty.",
      ),
    );
  }

  let lastSyncAt = 0;
  const maybeSync = async (): Promise<void> => {
    if (!opts.sync) return;
    if (Date.now() - lastSyncAt < SYNC_MIN_INTERVAL_MS) return;
    process.stdout.write(dim('Syncing latest from GitHub… '));
    try {
      const { syncAllRepos } = await import('./sync/sync-manager.js');
      await syncAllRepos(syncLogger);
      lastSyncAt = Date.now();
      process.stdout.write(dim('done\n'));
    } catch (err) {
      process.stdout.write('\n');
      console.warn(dim(`Sync failed: ${(err as Error).message}`));
    }
  };

  let prevKeys: Set<string> | null = null;
  const paint = async (isWatch: boolean): Promise<void> => {
    await maybeSync();
    const data = await getMyTurn(LOCAL_ACCOUNT_ID);
    const repoCount = (await listRepos(LOCAL_ACCOUNT_ID)).length;
    const { output, keys } = render(data, prevKeys, repoCount);
    prevKeys = keys;
    if (isWatch && process.stdout.isTTY) process.stdout.write('\x1b[2J\x1b[H');
    process.stdout.write(output);
    if (isWatch) {
      const clock = new Date().toTimeString().slice(0, 8);
      process.stdout.write(
        `\n${dim(`Updated ${clock} · every ${opts.intervalSeconds}s · Ctrl-C to quit`)}\n`,
      );
    }
  };

  if (!opts.watch) {
    try {
      await paint(false);
    } catch (err) {
      console.error('status failed:', err);
      process.exitCode = 1;
    } finally {
      await closeDb();
    }
    return;
  }

  // ── watch mode ────────────────────────────────────────────────────────────
  let stopped = false;
  process.on('SIGINT', () => {
    stopped = true;
    void closeDb().finally(() => process.exit(0));
  });

  const tick = async (): Promise<void> => {
    if (stopped) return;
    try {
      await paint(true);
    } catch (err) {
      // Keep watching — surface the error but don't tear down the loop.
      process.stdout.write(`\n${dim(`(refresh failed: ${(err as Error).message})`)}\n`);
    }
    if (!stopped) setTimeout(() => void tick(), opts.intervalSeconds * 1000);
  };
  await tick();

  // Block until SIGINT (the pending timer already keeps the process alive).
  await new Promise<void>(() => {});
}
