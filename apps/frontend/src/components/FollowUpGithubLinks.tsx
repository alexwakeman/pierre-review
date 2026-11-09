// The two GitHub links a PR-LEVEL follow-up row carries (a Limn finding posted as a PR comment, so it
// has no thread): the finding's own comment, and the person's comment that answered it. Kept out of
// ClaudeReviewFollowUp.tsx, which renders model text and holds no link at all (its source guard).
// Every URL goes through `safeExternalUrl` (CLAUDE.md: never a data-derived URL straight into href).
import { ExternalLinkIcon } from './Icons.js';
import { safeExternalUrl } from '../lib/ui.js';

/** "PR comment" — the finding's own comment on GitHub; plain text without a safe link. */
export function PrCommentLink({ url }: { url: string | null }): JSX.Element {
  const href = safeExternalUrl(url);
  if (!href) return <span className="text-meta text-ui-mute">PR comment</span>;
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer noopener"
      className="hit inline-flex items-center gap-1 text-meta text-ui-ink hover:underline"
    >
      PR comment
      <ExternalLinkIcon size={11} />
    </a>
  );
}

/** "replied" / "commented", linked to that comment when its URL is safe. */
export function ReplyVerbLink({ url, verb }: { url: string | null; verb: string }): JSX.Element {
  const href = safeExternalUrl(url);
  if (!href) return <>{verb}</>;
  return (
    <a href={href} target="_blank" rel="noreferrer noopener" className="underline hover:text-ui-ink">
      {verb}
    </a>
  );
}
