// The current Limn version: the npm package's version, read from apps/backend/package.json when
// the site is built (vite.config.ts defines __LIMN_VERSION__). The release workflow bumps that
// file, and deploy-site rebuilds the site after every release, so the docs show what
// `npx limn-review` installs today.
export const LIMN_VERSION: string = __LIMN_VERSION__;
