// Prints the sandbox image recipe as JSON, for CI's image publish step (.github/workflows/release.yml,
// docs/RELEASE.md § The sandbox image). The SAME function the app and build-release.mjs use
// (src/sandbox/runtime/image.ts), so the image CI pushes carries the recipe the release pins.
//
//   pnpm --filter @pierre-review/backend exec tsx scripts/sandbox-image.ts
//   → {"recipe":"…","localTag":"limn-sandbox:local-…","contextDir":"…","buildArgs":{…}}
import { imageRecipe } from '../src/sandbox/runtime/image.js';

const r = imageRecipe();
if (!r) {
  console.error('No sandbox image recipe: the Dockerfile is missing, or the Claude Code / Codex pins are not exact versions.');
  process.exit(1);
}
process.stdout.write(`${JSON.stringify(r)}\n`);
