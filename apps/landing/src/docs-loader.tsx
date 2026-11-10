import { useEffect, useState } from 'react';

// The docs live in their OWN chunk, so the home page and the other marketing pages never load
// them. main.tsx loads the chunk BEFORE the first render when the address is under /docs (so the
// client's fresh render matches the prerendered page, with no flash); a client-side hop to /docs
// from another page loads it here. The prerender (entry-server.tsx) sets it synchronously.

type DocsModule = typeof import('./docs/DocsApp');

let loaded: DocsModule | null = null;

export function setDocsModule(m: DocsModule): void {
  loaded = m;
}

export function loadDocs(): Promise<DocsModule> {
  return import('./docs/DocsApp').then((m) => {
    loaded = m;
    return m;
  });
}

export function DocsRoute({ path }: { path: string }): JSX.Element {
  const [mod, setMod] = useState<DocsModule | null>(loaded);
  useEffect(() => {
    if (!mod) void loadDocs().then(setMod);
  }, [mod]);
  if (!mod) return <div className="lb docs" aria-busy="true" style={{ minHeight: '100vh' }} />;
  return <mod.DocsApp path={path} />;
}
