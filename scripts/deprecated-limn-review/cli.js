#!/usr/bin/env node
// `limn-review` was renamed `ensemble-review`. This stub says so and runs the real CLI, which it
// depends on, with the same arguments. ensemble-review's own CLI prints the one-line rename notice
// (it recognises the `limn` / `limn-review` command name), so nothing is printed here.
await import('ensemble-review/dist/cli.js');
