# limn-review → ensemble-review

This package was renamed. Use:

```bash
npx ensemble-review
```

or `npm install -g ensemble-review` and run `ensemble`.

Installing this package still works: it pulls in `ensemble-review` and runs it. Your
data moves from `~/.limn` to `~/.ensemble` on first start (never over an existing
`~/.ensemble`). Settings named `LIMN_…` still work; their new names start
`ENSEMBLE_…`.

---

## Maintainers: publishing this stub (manual, once)

Publishing is otherwise CI-only. This stub is the one exception, and it is done
by hand, once, AFTER the first `ensemble-review` release is live on npm:

1. Set the version in `package.json` higher than the last `limn-review` on npm
   (`npm view limn-review version`; it starts as `0.0.0-stub` so it can never be
   published by mistake), and check `ensemble-review` is published
   (`npm view ensemble-review version`).
2. From this directory: `npm publish --access public`.
3. Mark every earlier version of the old name deprecated, so `npm install` prints
   the message:

   ```bash
   npm deprecate limn-review@"<VERSION" "Renamed to ensemble-review. Run: npx ensemble-review"
   ```

   where `VERSION` is the stub's own version, so the stub itself installs without
   the warning (or leave out the range to deprecate every version).

The release workflow never runs any of this.
