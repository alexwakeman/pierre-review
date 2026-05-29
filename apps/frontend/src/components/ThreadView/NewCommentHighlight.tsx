// A small "new" tag for comments created since the user last viewed the PR.
// The left-edge highlight bar is applied via the `.comment-new` class on the
// comment block (see index.css).
export function NewTag(): JSX.Element {
  return (
    <span className="rounded bg-sky-500/20 px-1 text-[10px] font-semibold uppercase text-sky-500">
      new
    </span>
  );
}

/** Was this comment created after the user last viewed the PR? */
export function isNewComment(
  createdAt: string,
  viewedSince: string | null | undefined,
): boolean {
  if (!viewedSince) return false;
  return Date.parse(createdAt) > Date.parse(viewedSince);
}
