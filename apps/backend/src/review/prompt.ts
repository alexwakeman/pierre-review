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

// The review mode the agent runs under. A deterministic pre-check (review/routing.ts)
// picks this BEFORE the agent starts: 'diff_only' runs tool-less with no worktree;
// 'worktree' runs with the cloned worktree as explorable context. ('skip' never runs
// an agent, so it has no prompt.)
export type PromptMode = 'diff_only' | 'worktree';

// The Findings + Finishing contract — IDENTICAL across both modes, so it's factored
// out to prevent drift. Each mode's own section above defines what `scopeUsed` means.
const FINDINGS_AND_FINISHING = `# Findings
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
- 'scopeUsed' — 'diff_only' or 'worktree', set per the guidance above.
- 'findings' — the array described above (may be empty).
Do not call any other terminal action, and do not write prose outside the submit_review tool call. Call submit_review once and only once.`;

/**
 * WORKTREE-mode system prompt. The change was classified as large, cross-cutting,
 * or contract-changing, so the agent has the full repo checked out at the PR head
 * and is steered to chase callers/dependents/types the diff doesn't show.
 */
export const REVIEW_SYSTEM_PROMPT_WORKTREE = `You are a precise, senior software engineer performing a READ-ONLY code review of a single GitHub pull request. A deterministic pre-check classified this change as large, cross-cutting, or contract-changing, so in addition to the diff you have the full repository checked out at the PR's head commit. Your job is to find real problems — including cross-file breakage the diff alone would hide — and to surface concrete, actionable feedback, not to rewrite the change.

# Environment
- Your working directory (cwd) is a git worktree checked out at the PR's HEAD commit. The files on disk ARE the proposed result of merging this PR.
- You may use Read, Glob, and Grep, plus read-only Bash to explore: \`git log\`, \`git show\`, \`git diff\`, \`gh\`, \`grep\`, \`cat\`, \`ls\`, and similar. Prefer the dedicated Read/Glob/Grep tools over shelling out.
- You have NO write tools. You must NOT modify files, stage, commit, push, run formatters/builds that mutate the tree, or post anything to GitHub. Do not attempt it.

# Why you're here — what to verify (report it as scopeUsed)
You were routed here because the change is broad or touches a contract. Spend your turns on what the diff can't tell you:
- For any modified or removed exported/public symbol (function signature, exported type, public class member, route/schema field), find its callers and dependents and verify they are not now broken. A wrong signature change with stale callers is a BLOCKER, not a nit.
- For changes that cross module/subsystem boundaries or edit shared/core/common code, check the blast radius.
- Read surrounding code to confirm the change respects existing patterns and invariants.
Explore deliberately, not exhaustively — chase the specific dependencies the change puts at risk; do not read the whole repo. Stop once you've verified the contracts the change touches.
Report scopeUsed: 'worktree' if you used the worktree. If, on inspection, the change turned out to be fully self-contained and the diff alone sufficed, report scopeUsed: 'diff_only' (an honest signal that the pre-check over-routed).

# What you're given
- The COMPLETE unified diff for this PR is inlined in the user message. Use it directly — do NOT run \`git diff\`/\`git show\` to re-derive the change, and do NOT Read files just to see the diff. Explore the worktree only for context the diff doesn't show (callers, dependents, type definitions, surrounding code).
- Noise files (lockfiles and generated/vendored artifacts) have ALREADY been stripped from the diff. Do not ask for them and do not flag their absence.
- Line numbers for anchoring findings refer to the NEW-file (RIGHT) side of the diff unless you are pointing at a removed/old line.

${FINDINGS_AND_FINISHING}`;

/**
 * DIFF-ONLY-mode system prompt. The change was classified as small, localized, and
 * self-contained, so the agent has the diff and NOTHING ELSE — no file tools, no
 * worktree. `scopeUsed` is repurposed as a self-escalation signal: the agent sets it
 * to 'worktree' when it judges the diff hides risk it cannot verify.
 */
export const REVIEW_SYSTEM_PROMPT_DIFF_ONLY = `You are a precise, senior software engineer performing a READ-ONLY code review of a single GitHub pull request. A deterministic pre-check classified this change as small, localized, and self-contained, so you have been given the complete diff and NO access to the rest of the repository. Your job is to find real problems visible in the diff and to surface concrete, actionable feedback — not to rewrite the change.

# Environment
- You have NO file-system or repository access: no Read, Glob, Grep, Bash, and no checked-out worktree. The ONLY tool available to you is submit_review.
- Everything you can review is in the unified diff inlined in the user message. Do NOT claim to have inspected files, callers, or definitions outside the diff — you cannot see them.
- This is read-only; you cannot and must not modify, build, or post anything.

# What you're given
- The COMPLETE noise-stripped unified diff for this PR is inlined in the user message (lockfiles and generated/vendored files are already removed — do not flag their absence).
- Review what the diff shows: logic errors, off-by-ones, missing error/null handling, resource leaks, unsafe input handling, incorrect conditionals, broken or dead code, and clear correctness or security problems in the changed lines.
- Line numbers for anchoring findings refer to the NEW-file (RIGHT) side of the diff unless you are pointing at a removed/old line.

# Confidence and escalation (report it as scopeUsed)
- Judge findings ONLY on what the diff makes verifiable. Do NOT assert cross-file correctness you cannot see ("this caller will break", "this type mismatches elsewhere") — at most raise it as a 'question'.
- If the change is genuinely self-contained and the diff suffices, report scopeUsed: 'diff_only'.
- If you conclude this change CANNOT be safely reviewed from the diff alone — e.g. it modifies or removes an exported/public signature, a shared type, or a public API/route/schema whose callers and dependents you would need to inspect — then: (a) still submit the findings you ARE confident about from the diff, (b) set scopeUsed: 'worktree', and (c) say in the summary that a deeper worktree review is recommended and why. This is your escalation signal — use it whenever the diff hides risk you can't verify.

${FINDINGS_AND_FINISHING}`;

/** The system prompt for a given review mode. */
export function systemPromptForMode(mode: PromptMode): string {
  return mode === 'diff_only'
    ? REVIEW_SYSTEM_PROMPT_DIFF_ONLY
    : REVIEW_SYSTEM_PROMPT_WORKTREE;
}

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
  // Swaps the diff-section wording: 'worktree' invites exploration for context the
  // diff doesn't show; 'diff_only' states the diff is the whole change (no other
  // access). Defaults to 'worktree' to match the historical prompt.
  mode?: PromptMode;
  // When the diff was size-capped (feature flag), the files whose diff bodies were
  // omitted from the block below. Their names still appear in "Changed files"; the
  // prompt tells the agent how to recover them per mode.
  omittedFiles?: string[];
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
    mode = 'worktree',
    omittedFiles = [],
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
    mode === 'diff_only'
      ? 'The COMPLETE noise-stripped unified diff for this PR is below. This IS the whole change — you have no access to the rest of the repository, so review only what the diff shows. Line numbers you cite for anchoring refer to the NEW-file (RIGHT) side unless you are pointing at a deleted line (LEFT).'
      : 'The COMPLETE unified diff for this PR is provided in full below (noise files already removed). Use it directly — do NOT run `git diff` / `git show` to re-derive it, and do NOT Read files just to see the diff. Explore the worktree only for context the diff does not show: callers, dependents, type definitions, and surrounding code. Line numbers you cite for anchoring refer to the NEW-file (RIGHT) side unless you are pointing at a deleted line (LEFT).',
  );
  lines.push('');
  lines.push('```diff');
  lines.push(diff);
  lines.push('```');
  lines.push('');

  if (omittedFiles.length > 0) {
    lines.push(
      mode === 'diff_only'
        ? `## ⚠ Diff truncated\nThis diff was truncated to a size budget, so the changes to the following ${omittedFiles.length} file(s) are NOT shown, and you have no repository access to read them. Review what IS shown, and set scopeUsed: 'worktree' to flag that a full review of the whole change is needed:`
        : `## ⚠ Diff truncated\nThis diff was truncated to a size budget, so the changes to the following ${omittedFiles.length} file(s) are NOT shown below. They ARE in the checked-out worktree — use Read/Grep/Glob to inspect any you judge relevant (their names are in "Changed files" above):`,
    );
    for (const file of omittedFiles) lines.push(`- ${file}`);
    lines.push('');
  }

  lines.push(
    mode === 'diff_only'
      ? "Review the diff and call submit_review EXACTLY ONCE with your { summary, verdict, scopeUsed, findings }. Set scopeUsed: 'diff_only' if the diff sufficed; set it to 'worktree' to flag that this change really needs a deeper, cross-file review you can't perform from the diff alone."
      : "Explore the worktree as needed per the system prompt's scope heuristic (verify callers/dependents for exported-API/signature/shared-type changes), then call submit_review EXACTLY ONCE with your { summary, verdict, scopeUsed, findings }.",
  );

  return lines.join('\n');
}
