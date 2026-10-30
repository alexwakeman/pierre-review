// A small "new" tag for comments created since the user last viewed the PR.
// The left-edge highlight bar is applied via the `.comment-new` class on the
// comment block (see index.css).
export function NewTag(): JSX.Element {
  return (
    // An accent dot and the word, quietly (the redesign: no  tags, the accent marks "new").
    <span className="inline-flex items-center gap-1 text-meta text-ui-accent">
      <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-ui-accent" />
      New
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
