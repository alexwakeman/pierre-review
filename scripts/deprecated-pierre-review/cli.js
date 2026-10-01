#!/usr/bin/env node
// `pierre-review` was renamed `limn-review`. This stub says so and runs the real CLI, which it
// depends on, with the same arguments. limn-review's own CLI prints the one-line rename notice
// (it recognises the `pierre-review` / `pierre` command name), so nothing is printed here.
await import('limn-review/dist/cli.js');
