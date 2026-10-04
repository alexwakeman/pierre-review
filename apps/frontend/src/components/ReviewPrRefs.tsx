// PR REFERENCES IN THE REVIEW TAB → THAT PR IN LIMN (the React half; the pure half is
// lib/reviewPrRefs.ts).
//
//   <ReviewPrRefsProvider>  one per Review tab. Resolves refs from data already on screen (the
//                           ticket's PRs, the PR being viewed) and sends the rest in ONE batched,
//                           DB-only `POST /api/prs/resolve` — keyed on the sorted ref set, so the
//                           pane re-asks only when its text gains a ref it has never asked about.
//   <PrRefLink>             one ref: a button opening the PR's tab, or its text when unresolved
//                           (or when it is the PR being viewed — that tab is already open).
//   <PrRefText>             plain text with its refs linked (model prose that is not markdown).
//   <Markdown prRefs>       markdown with its refs linked (Markdown.tsx, via the rehype plugin).
//
// Outside a provider every ref is plain text, so nothing else in the app changes.
import { createContext, useContext, useMemo, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '../api/client.js';
import { usePinnedTabs } from '../store/pinnedTabs.js';
import {
  buildPrRefIndex,
  queryKeyOf,
  refsToResolve,
  resolvePrRef,
  serverIndex,
  splitPrRefs,
  type KnownPr,
  type PrRefIndex,
} from '../lib/reviewPrRefs.js';

interface PrRefsValue {
  index: PrRefIndex;
  server: ReadonlyMap<string, KnownPr | null> | null;
  currentPrId: number;
}

const PrRefsContext = createContext<PrRefsValue | null>(null);

export function ReviewPrRefsProvider({
  currentPrId,
  currentRepoFullName,
  known,
  texts,
  ready = true,
  children,
}: {
  currentPrId: number;
  currentRepoFullName: string;
  // PRs already on screen (the ticket review's members, the PR being viewed).
  known: readonly KnownPr[];
  // Every text the pane links refs in (`reviewTexts`).
  texts: readonly string[];
  // False while a source of `known`/`texts` is still loading: the lookup waits so the pane sends
  // ONE batch over the settled set, not one per source as each arrives.
  ready?: boolean;
  children: ReactNode;
}): JSX.Element {
  const index = useMemo(() => buildPrRefIndex(currentRepoFullName, known), [currentRepoFullName, known]);
  const queries = useMemo(() => refsToResolve(texts, index), [texts, index]);
  const signature = queries.map(queryKeyOf).join(',');
  const { data } = useQuery({
    queryKey: ['pr-refs', signature],
    queryFn: () => api.resolvePrRefs(queries),
    enabled: ready && queries.length > 0,
    // DB-only and stable: a PR's id never changes. Refetch only when the ref set does.
    staleTime: Infinity,
  });
  const server = useMemo(() => (data != null ? serverIndex(data.refs) : null), [data]);
  const value = useMemo(() => ({ index, server, currentPrId }), [index, server, currentPrId]);
  return <PrRefsContext.Provider value={value}>{children}</PrRefsContext.Provider>;
}

const LINK = 'text-blue-600 hover:underline dark:text-blue-400';

/** One ref ("api#12"): opens that PR's tab in Limn; plain text when it names no known PR. */
export function PrRefLink({
  repo,
  number,
  children,
}: {
  repo: string | null;
  number: number;
  children: ReactNode;
}): JSX.Element {
  const ctx = useContext(PrRefsContext);
  const openPrDetailTab = usePinnedTabs((s) => s.openPrDetailTab);
  const pr = ctx != null ? resolvePrRef({ repo, number }, ctx.index, ctx.server) : null;
  if (pr == null || ctx == null || pr.prId === ctx.currentPrId) return <>{children}</>;
  return (
    <button
      type="button"
      onClick={() =>
        openPrDetailTab({
          id: pr.prId,
          number: pr.number,
          title: pr.title ?? `#${pr.number}`,
          repoFullName: pr.repoFullName,
          authorLogin: null,
          authorDisplayName: null,
          authorAvatarUrl: null,
        })
      }
      title={pr.title != null ? `${pr.repoFullName}#${pr.number}: ${pr.title}` : `Open ${pr.repoFullName}#${pr.number}`}
      className={`inline p-0 text-left ${LINK}`}
    >
      {children}
    </button>
  );
}

/** Plain text with every PR ref in it linked. Renders exactly `text` outside a provider. */
export function PrRefText({ text }: { text: string }): JSX.Element {
  const parts = useMemo(() => (text.includes('#') ? splitPrRefs(text) : [text]), [text]);
  return (
    <>
      {parts.map((p, i) =>
        typeof p === 'string' ? (
          p
        ) : (
          <PrRefLink key={i} repo={p.repo} number={p.number}>
            {text.slice(p.start, p.end)}
          </PrRefLink>
        ),
      )}
    </>
  );
}

/** A known member PR by id (the ticket review's "Done in api#88", "Post on web#4"). */
export function MemberPrLink({ member }: { member: { repo: string; number: number; label: string } }): JSX.Element {
  return (
    <PrRefLink repo={member.repo} number={member.number}>
      {member.label}
    </PrRefLink>
  );
}
