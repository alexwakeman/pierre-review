// THE PR DIFF, CAPPED for an AI Fix session's PR.diff (sandbox/session/fix.ts). A big PR's full
// unified diff can exceed the model's context window: noise files are stripped, then whole file-diffs
// are kept up to a char budget and the rest are NAMED.

// GitHub's PR .diff uses `diff --git a/<path> b/<path>` file headers — split on them so a whole
// file's hunks stay intact when we drop/omit it.
function splitDiffByFile(diff: string): { path: string; text: string }[] {
  if (diff.trim() === '') return [];
  return diff
    .split(/(?=^diff --git )/m)
    .filter((p) => p.trim() !== '')
    .map((text) => {
      const g = /^diff --git a\/.+? b\/(.+)$/m.exec(text);
      const plus = /^\+\+\+ b\/(.+)$/m.exec(text);
      return { path: (g?.[1] ?? plus?.[1] ?? 'unknown').trim(), text };
    });
}

// Lockfiles / generated / minified / vendored output — high churn, ~zero summary value.
const NOISE_RE =
  /(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|npm-shrinkwrap\.json|composer\.lock|Cargo\.lock|Gemfile\.lock|poetry\.lock|go\.sum|Podfile\.lock|flake\.lock)$|\.min\.(js|css)$|\.map$|\.snap$|(^|\/)(dist|build|out|vendor|node_modules)\//i;

export interface CappedDiff {
  diff: string;
  excludedFiles: string[]; // noise, stripped entirely
  omittedFiles: string[]; // real files that didn't fit the budget
}

// Strip noise, then greedily keep whole file-diffs (in diff order) until `budgetChars` is hit;
// name the rest. Always keeps at least the first non-noise file so a single huge file still yields
// something.
export function capDiff(diff: string, budgetChars: number): CappedDiff {
  const excludedFiles: string[] = [];
  const kept: { path: string; text: string }[] = [];
  for (const s of splitDiffByFile(diff)) {
    if (NOISE_RE.test(s.path)) excludedFiles.push(s.path);
    else kept.push(s);
  }
  const out: string[] = [];
  const omittedFiles: string[] = [];
  let used = 0;
  for (const s of kept) {
    if (out.length > 0 && used + s.text.length > budgetChars) {
      omittedFiles.push(s.path);
      continue;
    }
    out.push(s.text);
    used += s.text.length;
  }
  return { diff: out.join('\n').trim(), excludedFiles, omittedFiles };
}
