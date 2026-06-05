/**
 * The inline review "skill": the reviewer system prompt, the per-run user
 * prompt builder, and the noise-file matcher used to strip lockfiles and
 * generated/vendored artifacts from the diff before the agent ever sees them.
 *
 * Keeping this self-contained (no runtime deps) makes it cheap to unit-test the
 * matcher and to eyeball the prompts.
 */

/**
 * Globs for files whose diffs are noise to a human reviewer: lockfiles plus the
 * usual generated / vendored / build artifacts. We strip these from the diff so
 * the agent spends its budget on real code, not a 4000-line lockfile churn.
 *
 * Only the three glob shapes used below are supported by `isNoiseFile`
 * (exact basename, `*.ext` suffix, `**​/segment/**` path-segment). Keep new
 * entries within those shapes.
 */
export const NOISE_GLOBS: string[] = [
  // Lockfiles (exact basenames).
  'package-lock.json',
  'pnpm-lock.yaml',
  'yarn.lock',
  'npm-shrinkwrap.json',
  'Cargo.lock',
  'poetry.lock',
  'Gemfile.lock',
  'composer.lock',
  'go.sum',
  // Generic lock + minified + sourcemap suffixes.
  '*.lock',
  '*.min.js',
  '*.min.css',
  '*.map',
  // Snapshot artifacts.
  '*.snap',
  // Generated / vendored / build trees (path-segment matches).
  '**/dist/**',
  '**/build/**',
  '**/node_modules/**',
  '**/__snapshots__/**',
];

/** Normalize to forward slashes and drop a leading `./`. */
function normalizePath(path: string): string {
  let p = path.replace(/\\/g, '/');
  if (p.startsWith('./')) p = p.slice(2);
  return p;
}

/** Last path segment (basename), independent of the platform separator. */
function basename(path: string): string {
  const p = normalizePath(path);
  const idx = p.lastIndexOf('/');
  return idx === -1 ? p : p.slice(idx + 1);
}

/**
 * Does a single glob (in one of our three supported shapes) match `path`?
 *
 *  - `'package-lock.json'`  exact basename match against any path component-tail.
 *  - `'*.lock'`             suffix match on the basename only.
 *  - `'**​/dist/**'`         true if `dist` appears as a path segment.
 *
 * Anything else is treated as an exact basename match. This is deliberately
 * small and conservative — we do NOT pull a glob dependency.
 */
function matchesGlob(glob: string, fullPath: string, base: string): boolean {
  // `**/segment/**` → path-segment containment.
  const segMatch = /^\*\*\/(.+)\/\*\*$/.exec(glob);
  if (segMatch) {
    const segment = segMatch[1];
    if (!segment) return false;
    const needle = `/${segment}/`;
    return fullPath === segment || fullPath.startsWith(`${segment}/`) || fullPath.includes(needle);
  }

  // `*.ext` → suffix match on the basename.
  if (glob.startsWith('*.')) {
    const suffix = glob.slice(1); // keep the leading dot, e.g. '.lock'
    return base.length > suffix.length && base.endsWith(suffix);
  }

  // Otherwise: exact basename match.
  return base === glob;
}

/**
 * True if `path` looks like a lockfile / generated / vendored artifact that
 * should be hidden from the reviewer. Matches against both the full path and
 * its basename as appropriate (see `matchesGlob`).
 */
export function isNoiseFile(path: string): boolean {
  const full = normalizePath(path);
  const base = basename(full);
  for (const glob of NOISE_GLOBS) {
    if (matchesGlob(glob, full, base)) return true;
  }
  return false;
}

/**
 * The reviewer system prompt. Casts Claude as a precise, senior reviewer doing
 * a strictly READ-ONLY review of a single GitHub PR, and pins down the output
 * contract (the one-shot `submit_review` tool call).
 */
export const REVIEW_SYSTEM_PROMPT = `You are a precise, senior software engineer performing a READ-ONLY code review of a single GitHub pull request. Your job is to find real problems and to surface concrete, actionable feedback — not to rewrite the change.

# Environment
- Your working directory (cwd) is a git worktree checked out at the PR's HEAD commit. The files on disk ARE the proposed result of merging this PR.
- You may use Read, Glob, and Grep, plus read-only Bash to explore: \`git log\`, \`git show\`, \`git diff\`, \`gh\`, \`grep\`, \`cat\`, \`ls\`, and similar. Prefer the dedicated Read/Glob/Grep tools over shelling out.
- You have NO write tools. You must NOT modify files, stage, commit, push, run formatters/builds that mutate the tree, or post anything to GitHub. Do not attempt it.

# Scope (report it as scopeUsed)
Decide how far to look using this heuristic:
- If the change is small, localized, and self-contained, review the DIFF ONLY and report scopeUsed: 'diff_only'.
- If the change is large or cross-cutting, OR it changes an exported API, a public/exported function signature, or a shared type, then explore the worktree to check for contract violations and side effects in callers and dependents, and report scopeUsed: 'worktree'.
When in doubt about whether something exported is used elsewhere, look — a wrong signature change with stale callers is a blocker, not a nit.

# What you're given
- Noise files (lockfiles and generated/vendored artifacts) have ALREADY been stripped from the diff. Do not ask for them and do not flag their absence.
- Line numbers for anchoring findings refer to the NEW-file (RIGHT) side of the diff unless you are pointing at a removed/old line.

# Findings
Produce concrete, actionable findings. For each finding:
- Anchor it to a file 'path'. When you can, include a 'line' number.
  - Use side: 'RIGHT' for a line on the new side (the default — the post-merge file).
  - Use side: 'LEFT' only when you are pointing at a deleted/old line.
  - Omit 'line' entirely for a file-level or general observation.
- Assign a 'severity':
  - 'blocker' — must fix before merge: correctness bugs, security holes, data loss, broken contracts.
  - 'warning' — should fix: likely bugs, missing edge cases, risky patterns, missing tests for risky code.
  - 'nit' — minor/style; keep these SPARSE. Do not pad the review with nits.
  - 'question' — something genuinely needs clarification from the author.
  - 'praise' — call out notably good or careful work, sparingly.
- Be specific. Reference the actual symbol/line and say what's wrong and (briefly) what to do instead. Avoid vague "consider refactoring" comments.

# Finishing
When you are done, call the submit_review tool EXACTLY ONCE with:
  { summary, verdict, scopeUsed, findings }
- 'summary' — a short, plain-English wrap-up of the change and your overall read.
- 'verdict' — your suggested overall outcome: 'APPROVE' | 'REQUEST_CHANGES' | 'COMMENT'.
- 'scopeUsed' — 'diff_only' or 'worktree', per the heuristic above.
- 'findings' — the array described above (may be empty).
Do not call any other terminal action, and do not write prose outside the submit_review tool call. Call submit_review once and only once.`;

const BODY_CHAR_LIMIT = 4000;

/** Trim a PR body to roughly `BODY_CHAR_LIMIT` chars, with an ellipsis marker. */
function trimBody(body: string): string {
  const trimmed = body.trim();
  if (trimmed.length <= BODY_CHAR_LIMIT) return trimmed;
  return `${trimmed.slice(0, BODY_CHAR_LIMIT)}\n…(truncated)`;
}

/**
 * Build the per-run user prompt: PR metadata, the changed-file list, a note
 * about any noise files that were stripped, and the (already noise-stripped)
 * unified diff in a fenced block. Ends by pointing the model at the system
 * prompt's scope heuristic and the one-shot submit_review contract.
 */
export function buildUserPrompt(input: {
  repoFullName: string;
  prNumber: number;
  title: string;
  body: string | null;
  headSha: string;
  baseRef: string | null;
  changedFiles: string[];
  excludedFiles: string[];
  diff: string;
}): string {
  const {
    repoFullName,
    prNumber,
    title,
    body,
    headSha,
    baseRef,
    changedFiles,
    excludedFiles,
    diff,
  } = input;

  const lines: string[] = [];

  lines.push(`# Reviewing ${repoFullName} PR #${prNumber}`);
  lines.push('');
  lines.push(`Title: ${title}`);
  lines.push(`Head SHA: ${headSha}`);
  lines.push(`Base ref: ${baseRef ?? '(unknown)'}`);
  lines.push('');

  const trimmedBody = body && body.trim().length > 0 ? trimBody(body) : null;
  if (trimmedBody) {
    lines.push('## PR description');
    lines.push('');
    lines.push(trimmedBody);
    lines.push('');
  } else {
    lines.push('## PR description');
    lines.push('');
    lines.push('(no description provided)');
    lines.push('');
  }

  lines.push('## Changed files');
  lines.push('');
  if (changedFiles.length > 0) {
    for (const file of changedFiles) lines.push(`- ${file}`);
  } else {
    lines.push('- (none)');
  }
  lines.push('');

  if (excludedFiles.length > 0) {
    lines.push('## Excluded (noise) files');
    lines.push('');
    lines.push(
      `The following lockfile/generated files were stripped from the diff below and are NOT shown — do not review them:`,
    );
    for (const file of excludedFiles) lines.push(`- ${file}`);
    lines.push('');
  }

  lines.push('## Diff');
  lines.push('');
  lines.push(
    'This unified diff has already had noise files removed. Line numbers you cite for anchoring refer to the NEW-file (RIGHT) side unless you are pointing at a deleted line (LEFT).',
  );
  lines.push('');
  lines.push('```diff');
  lines.push(diff);
  lines.push('```');
  lines.push('');

  lines.push(
    'Explore the worktree as needed per the system prompt\'s scope heuristic (diff-only for small/self-contained changes; the worktree for large/cross-cutting changes or exported-API/signature/shared-type changes), then call submit_review EXACTLY ONCE with your { summary, verdict, scopeUsed, findings }.',
  );

  return lines.join('\n');
}
