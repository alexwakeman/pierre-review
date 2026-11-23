## Summary

- Retry the webhook sender three times with jittered backoff.
- Log the final failure with the delivery id.

## Test plan

- [x] `pnpm test` passes
- [x] Manual 502 from the stub server retries

🤖 Generated with [Claude Code](https://claude.com/claude-code)
