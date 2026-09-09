# Blast-radius fixtures

Hand-annotated pull requests used to keep `blastSignalsFor` honest. Every case here was taken
from, or modelled on, a real pull request in the corpus the feature was calibrated against
(1,405 measurable open PRs across 22 repositories) — the distribution and the arm fire counts in
`db/blast-radius.ts`'s header come from that same corpus.

Each `*.json` file is one case:

```jsonc
{
  "name": "human-readable description",
  "why": "what this case is defending — the rule that breaks if it regresses",
  "pr": {
    "additions": 41,
    "deletions": 17,
    "changedFiles": 2,
    // null models "no per-file breakdown stored" (18.5% of the real corpus)
    "files": [{ "path": "src/foo.ts", "additions": 30, "deletions": 11 }]
  },
  // null = the fold must return null (UNKNOWN). Otherwise a partial signal vector: every key
  // present here is asserted, keys omitted are not — so a case can pin one rule without
  // restating the whole vector.
  "expected": { "codeFiles": 1, "testFiles": 1, "surfaces": [], "truncated": false }
}
```

⚠ `expected: null` and `expected: {...}` are different assertions, and the difference is the
whole safety rule: `null` is UNKNOWN and renders NOTHING, which is never the same as "low".

To add a real case, pull the file list with:

```bash
gh api graphql -f query='{ repository(owner:"OWNER", name:"NAME") {
  pullRequest(number: N) { additions deletions changedFiles
    files(first: 100) { nodes { path additions deletions } } } } }'
```
