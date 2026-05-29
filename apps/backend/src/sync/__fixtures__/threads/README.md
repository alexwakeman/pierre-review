# Thread-state fixtures

Hand-annotated review threads used to keep `deriveThreadState` honest.

Each `*.json` file is one case:

```jsonc
{
  "name": "human-readable description",
  "expected": "resolved | likely_addressed | replied_unresolved | untouched",
  "thread": {
    "isResolved": false,
    "path": "src/foo.ts",
    "comments": [
      { "author": { "login": "reviewer" }, "createdAt": "2026-01-01T10:00:00Z" }
    ]
  },
  "commits": [
    { "oid": "abc", "committedDate": "2026-01-01T11:00:00Z" }
  ],
  // SHA -> changed paths
  "commitFiles": { "abc": ["src/foo.ts"] }
}
```

To add real cases, pull threads via:

```bash
gh api graphql -f query='{ repository(owner:"OWNER", name:"NAME") {
  pullRequest(number: N) { reviewThreads(first:50) { nodes {
    isResolved path line comments(first:50){ nodes { author{login} createdAt } }
  } } } } }'
```

Annotate the expected state by eye against github.com, drop a JSON file here, and
the test below will assert it.
