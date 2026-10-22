// T2 discovery — the workflow-file scan. Lists `.github/workflows/`, reads each file
// (count- and byte-capped), and STRING-SCANS for known bot actions, the bot's own login,
// and explicit config-path arguments. ⚠ Workflow files are ATTACKER-AUTHORED (repo content):
// string scan only, never parse-and-execute, never follow a path found inside one anywhere
// but into a read-only probe.
//
// The appSlug half (App-authored vs Actions-authored comments) reads the core
// `users.app_slug` column the app-attribution probe now persists; App-only bots with no
// workflow footprint fall back to T1 (ask the user).
import type { ProContext } from '../../contract.js';

const MAX_WORKFLOW_FILES = 30;
const MAX_WORKFLOW_BYTES = 100 * 1024;

// Known bot-action needles (substring match on `uses:` lines). Small and hand-verified —
// a generic vendor table is a non-goal.
const KNOWN_BOT_ACTIONS = [
  'coderabbitai/',
  'greptileai/',
  'reviewdog/',
  'deepsource',
  'sonarsource/',
  'codecov/',
  'github/copilot',
  'anthropics/claude-code-action',
];

const CONFIG_ARG_RE = /(--config[= ]\S+|config[-_]?path\s*[:=]\s*\S+)/gi;
const USES_RE = /^\s*(?:-\s*)?uses:\s*(\S+)/;

export interface WorkflowScan {
  workflowMatches: { path: string; matches: string[] }[];
  scannedFiles: number;
  truncated: boolean; // more workflow files existed than the cap
}

export async function scanWorkflows(
  ctx: ProContext,
  accountId: number,
  repo: { owner: string; name: string },
  botLogins: string[],
): Promise<WorkflowScan> {
  const dir = await ctx.github.listRepoDir(accountId, {
    owner: repo.owner,
    name: repo.name,
    path: '.github/workflows',
  });
  if (!dir.ok) return { workflowMatches: [], scannedFiles: 0, truncated: false };
  const files = dir.entries.filter(
    (e) => e.type === 'file' && (e.name.endsWith('.yml') || e.name.endsWith('.yaml')),
  );
  const capped = files.slice(0, MAX_WORKFLOW_FILES);
  const needles = [
    ...KNOWN_BOT_ACTIONS,
    ...botLogins.map((l) => l.toLowerCase()).filter((l) => l.length >= 4),
  ];
  const workflowMatches: { path: string; matches: string[] }[] = [];
  for (const file of capped) {
    if (file.size > MAX_WORKFLOW_BYTES) continue;
    const read = await ctx.github.readRepoFile(accountId, {
      owner: repo.owner,
      name: repo.name,
      path: file.path,
    });
    if (!read.ok) continue;
    const text = read.text.slice(0, MAX_WORKFLOW_BYTES);
    const matches: string[] = [];
    for (const line of text.split('\n')) {
      const lower = line.toLowerCase();
      const uses = USES_RE.exec(line);
      if (uses && needles.some((n) => uses[1]!.toLowerCase().includes(n))) {
        matches.push(line.trim());
        continue;
      }
      if (needles.some((n) => lower.includes(n)) && lower.includes('uses:')) {
        matches.push(line.trim());
        continue;
      }
      const cfg = line.match(CONFIG_ARG_RE);
      if (cfg && needles.some((n) => lower.includes(n))) {
        matches.push(line.trim());
      }
    }
    if (matches.length > 0) {
      workflowMatches.push({ path: file.path, matches: matches.slice(0, 10) });
    }
  }
  return {
    workflowMatches,
    scannedFiles: capped.length,
    truncated: files.length > MAX_WORKFLOW_FILES,
  };
}

// The bot's App slug off the global users table (persisted by sync/app-attribution.ts).
// ⚠ ctx.schema is Record<string, any> — `users.appSlug` is a greped fact.
export async function appSlugFor(ctx: ProContext, botUserId: number): Promise<string | null> {
  const usersT = ctx.schema.users;
  try {
    const { eq } = await import('drizzle-orm');
    const rows = (await ctx.db
      .select({ appSlug: usersT.appSlug })
      .from(usersT)
      .where(eq(usersT.id, botUserId))
      .limit(1)
      .execute()) as Array<{ appSlug: string | null }>;
    return rows[0]?.appSlug ?? null;
  } catch {
    return null;
  }
}
