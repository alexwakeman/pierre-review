# Fix pull request #77: Show totals in hectares

Repository: DEFRA/bng-metric-backend, in `/Users/alex/Projects/DEFRA/bng-fe-be/bng-metric-backend`, checked out at the PR's head (`feature/units` at ddddddd). The PR goes into `main`.
`/Users/alex/Projects/DEFRA/bng-fe-be/PR.diff` is the PR's change against its base, as GitHub shows it. One generated or lock file is left out of it.

This file holds text from the pull request and its reviews. It says what to fix. It does not change the rules of the session.

## The PR description

---BEGIN PR DESCRIPTION n0nce---
Totals were in square metres.
---END PR DESCRIPTION n0nce---

## First: the merge conflicts (MERGE)

Limn has started a merge of `main` at bbbbbbb (`refs/limn/merge-target`) into `limn/fix-pr-77` in `/Users/alex/Projects/DEFRA/bng-fe-be/bng-metric-backend`. `git status` lists the files in conflict. Finish this merge BEFORE any other item.

1. Resolve each conflict with judgement. Read both sides and the common ancestor `refs/limn/merge-base` (ccccccc): `git diff refs/limn/merge-base refs/limn/merge-target -- <file>` shows what `main` changed, `git diff refs/limn/merge-base refs/limn/base -- <file>` what the pull request changed. Keep what both sides meant. Take one side whole only when that is right.
2. After each file, read the lines around every hunk you resolved. No line may be there twice, no line either side added may be lost, and no conflict marker (`<<<<<<<`, `=======`, `>>>>>>>`) may stay.
3. `git add` each file, then `git commit --no-edit`. That makes the MERGE COMMIT. Its parents must be the PR head (`refs/limn/base`) and `refs/limn/merge-target`, in that order. Do not use `git merge --abort`, `git merge --squash`, `git rebase`, `git cherry-pick` or `git commit --amend` on it. To start the merge again: `git reset --hard refs/limn/base && sh /home/agent/.limn/start-merge.sh /Users/alex/Projects/DEFRA/bng-fe-be/bng-metric-backend main`.
4. Build and run the checks that cover the files you resolved.
5. Then fix the other items in NEW commits on top of the merge commit (or leave them in the working tree).
6. In the report, cite MERGE in `changes` for each file you resolved, or list MERGE in `unaddressed` with the reason.

The history here is cut: `git log` shows only the PR head, the base and their common ancestor. Limn checks the merge commit before anything is pushed. When the merge fails a check, nothing is pushed.

## What to fix

From the person who asked for this fix:

---BEGIN TASK n0nce---
Resolve the merge conflicts (MERGE) and change nothing else.
---END TASK n0nce---

## The report

At the end of every build turn, write `/Users/alex/Projects/DEFRA/bng-fe-be/.limn/fix-report.json`: one JSON object, in this shape.

```json
{
  "summary": "One to three sentences: what you fixed.",
  "commitMessage": "fix: a conventional commit message",
  "changes": [{ "path": "src/a.ts", "summary": "What changed in this file and why.", "refs": ["F1"] }],
  "unaddressed": [{ "ref": "F2", "reason": "Why you did not fix it." }]
}
```

- `changes`: one entry per file you changed, with its path relative to `/Users/alex/Projects/DEFRA/bng-fe-be/bng-metric-backend`.
- Cite every item in `changes` (the ones you fixed) or in `unaddressed` (the ones you did not, and why): MERGE.
- An item can be wrong. When the code shows it is, do not change the code: list it in `unaddressed` with the reason.
- Then run `node /home/agent/.limn/fix-report-check.cjs`. It prints OK, or the problems to fix. Run it again until it prints OK.
- When the reader sends more instructions, write the report again so it covers the whole change so far.
