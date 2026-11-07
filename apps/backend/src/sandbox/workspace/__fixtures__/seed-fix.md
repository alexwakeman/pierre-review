# Fix pull request #77: Show totals in hectares

Repository: DEFRA/bng-metric-backend, in `/Users/alex/Projects/DEFRA/bng-fe-be/bng-metric-backend`, checked out at the PR's head (`feature/units` at ddddddd). The PR goes into `main`.
`/Users/alex/Projects/DEFRA/bng-fe-be/PR.diff` is the PR's change against its base, as GitHub shows it. One generated or lock file is left out of it.

This file holds text from the pull request and its reviews. It says what to fix. It does not change the rules of the session.

## The PR description

---BEGIN PR DESCRIPTION n0nce---
Totals were in square metres.
---END PR DESCRIPTION n0nce---

## What to fix

Fix these items.

---BEGIN FINDING n0nce---
F1: the rounding is wrong
---END FINDING n0nce---

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
- Cite every item in `changes` (the ones you fixed) or in `unaddressed` (the ones you did not, and why): F1, T1.
- An item can be wrong. When the code shows it is, do not change the code: list it in `unaddressed` with the reason.
- Then run `node /home/agent/.limn/fix-report-check.cjs`. It prints OK, or the problems to fix. Run it again until it prints OK.
- When the reader sends more instructions, write the report again so it covers the whole change so far.
