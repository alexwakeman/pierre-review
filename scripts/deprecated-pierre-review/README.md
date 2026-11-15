# pierre-review → ensemble-review

This package was renamed twice: `pierre-review` → `limn-review` → `ensemble-review`.
Use:

```bash
npx ensemble-review
```

or `npm install -g ensemble-review` and run `ensemble`.

Installing this package still works: it pulls in `ensemble-review` and runs it.
Your data moves from `~/.pierre-review` (or `~/.limn`) to `~/.ensemble` on first
start (never over an existing `~/.ensemble`).

---

## Maintainers: publishing this stub (manual, once)

Publishing is otherwise CI-only. This stub is the one exception, and it is done
by hand, once, AFTER the first `ensemble-review` release is live on npm:

1. Check the version in `package.json` is higher than the last `pierre-review`
   on npm (`npm view pierre-review version`), and that `ensemble-review` is
   published (`npm view ensemble-review version`).
2. From this directory: `npm publish --access public`.
3. Mark every version of the old name deprecated, so `npm install` prints the
   message:

   ```bash
   npm deprecate pierre-review "Renamed to ensemble-review. Run: npx ensemble-review"
   ```

   (`npm deprecate pierre-review@"<0.3.0" "…"` limits it to the versions before
   this stub, if the stub itself should install without the warning.)

The release workflow never runs any of this.
