// A HOTFIX BUILD'S SECOND CHECKOUT (docs/STORY-BUILD.md § Hotfix builds; docs/SANDBOX.md § The workspace
// mirror). Each repository with a latest release is mirrored TWICE: the release checkout at its layout path
// (at the release commit) and a MAIN checkout beside it (at the default branch's head), so the agent ports the
// fix in the same sandbox. Both are ordinary mirrored repositories (mirror.ts): their own `refs/limn/base`,
// their own patch. Pure.
import { posix } from 'node:path';
import type { WorkspaceLayout } from './layout.js';

/** The suffix of a main checkout's folder: `<release path>.main`. */
export const MAIN_CHECKOUT_SUFFIX = '.main';

/**
 * The main checkout's path for each of `repoIds`: `<path>.main` beside the release checkout (inside the same
 * session volume), or `<path>.main-2`, `-3`, … when that path is taken by — or sits inside, or holds — another
 * repository of the layout. Pure.
 */
export function mainCheckoutPaths(layout: Pick<WorkspaceLayout, 'repos'>, repoIds: ReadonlySet<number>): Map<number, string> {
  const taken = new Set(layout.repos.map((r) => posix.normalize(r.path)));
  const clashes = (p: string): boolean => [...taken].some((t) => t === p || t.startsWith(`${p}/`) || p.startsWith(`${t}/`));
  const out = new Map<number, string>();
  for (const r of layout.repos) {
    if (!repoIds.has(r.repoId)) continue;
    const base = `${posix.normalize(r.path)}${MAIN_CHECKOUT_SUFFIX}`;
    let p = base;
    for (let n = 2; clashes(p); n += 1) p = `${base}-${n}`;
    taken.add(p);
    out.set(r.repoId, p);
  }
  return out;
}
