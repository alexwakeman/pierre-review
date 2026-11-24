# AI vendor detection fixtures

Inputs for `packages/shared/src/ai-vendor-detect.ts`, run by `apps/backend/src/shared-ai-vendor-detect.test.ts`
(docs/AI-ADOPTION-REPORT.md § Detection). Every marker the detector reads has at least one POSITIVE
here; every near-miss we know of has a NEGATIVE.

- `commits.json` / `prs.json`: `{ name, provenance, input, expect }`. `input` is an
  `AiCommitSignalInput` / `AiPrSignalInput`; a `messageFile` / `bodyTextFile` / `bodyFile` key reads
  that field from a text file beside it. `expect` is the EXACT signal list (`[]` for a negative).
- `provenance`: `observed` = the shape was seen on real public PRs or commits (search results, this
  repository's own history), with names and ids replaced; `documented` = the tool's documented
  default; `unconfirmed` = a SPECIFIC phrase kept without a real-world sighting (the method slide's
  undercount covers a tool that never writes it).

Names, logins and ids here are made up. Never paste a real person's name or email.
