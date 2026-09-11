# Per-hunk suggestion fixtures

One JSON file per case for `validateConflictSuggestion` (`../../suggestion.ts`) — the validators
that stand between an attacker-authored conflict hunk, a model's answer, and a blob in somebody's
repository. `suggestion.test.ts` iterates this directory, so adding a case is adding a file.

```jsonc
{
  "name": "human-readable description",
  // "ok", or the exact ConflictSuggestionRefusal member the case must produce.
  "expected": "ok | unparseable | markers | context_duplicated | dropped_side_lines |
               dropped_common_lines | too_long | empty | not_text | cannot_reconcile",
  // Only read when "expected" is "ok" — the CODE-derived count the centre pane prints.
  "keptCommonLines": 2,
  "hunk": {
    "base":   ["const a = 1;"],
    "ours":   ["const a = 1;", "const c = 3;"],
    "theirs": ["const a = 1;", "const d = 4;"],
    // Both default to [] when absent. They are read-only in the prompt; check 6 is what stops
    // an answer smuggling them back inside the region.
    "contextBefore": ["function f() {"],
    "contextAfter":  ["}"]
  },
  // The RAW model answer, one array entry per line. Three placeholders are substituted with the
  // real fence markers before the validator sees it, so a fixture never hard-codes a nonce:
  //   "<<BEGIN>>"  → ---BEGIN RESOLVED <nonce>---
  //   "<<END>>"    → ---END RESOLVED <nonce>---
  //   "<<NONCE>>"  → the bare nonce (for the leakage case)
  // and one more for a byte JSON would otherwise hide inside a shell command:
  //   "<<NUL>>"    → a literal NUL
  "answer": ["<<BEGIN>>", "const a = 1;", "const c = 3;", "const d = 4;", "<<END>>"]
}
```

⚠ **The order of the checks is pinned by the test, not just by the code.** An answer that fails
two checks reports the EARLIER one — a fixture asserting `markers` on text that is also over
length is what stops somebody reordering them for tidiness.

⚠ **A fixture is not a substitute for reading the header of `suggestion.ts`.** Each check exists
for a stated reason, and the two that matter most are 7 and 8: 7 alone protects only what both
versions already agreed on, so a model emitting the base branch's version alone — deleting the
pull request's entire contribution — passes it. `dropped-side-lines-headline.json` is that case.
