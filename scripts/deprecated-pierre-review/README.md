# pierre-review → limn-review

This package was renamed. Use:

```bash
npx limn-review
```

or `npm install -g limn-review` and run `limn`.

Installing this package still works: it pulls in `limn-review` and runs it. Your
data moves from `~/.pierre-review` to `~/.limn` on first start (never over an
existing `~/.limn`).

---

## Maintainers: publishing this stub (manual, once)

Publishing is otherwise CI-only. This stub is the one exception, and it is done
by hand, once, AFTER the first `limn-review` release is live on npm:

1. Check the version in `package.json` is higher than the last `pierre-review`
   on npm (`npm view pierre-review version`), and that `limn-review` is
   published (`npm view limn-review version`).
2. From this directory: `npm publish --access public`.
3. Mark every version of the old name deprecated, so `npm install` prints the
   message:

   ```bash
   npm deprecate pierre-review "Renamed to limn-review. Run: npx limn-review"
   ```

   (`npm deprecate pierre-review@"<0.2.0" "…"` limits it to the versions before
   the stub, if the stub itself should install without the warning.)

The release workflow never runs any of this.
