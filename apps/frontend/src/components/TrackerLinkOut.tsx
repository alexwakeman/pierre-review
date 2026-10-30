import { TRACKER_PROVIDER_LABEL, type TrackerProvider } from '@pierre-review/shared';
import { safeExternalUrl } from '../lib/ui.js';
import { ExternalLinkIcon } from './Icons.js';

/**
 * "Open in Jira" / "Open in Linear" / "Open in GitHub": a small link out to a ticket in its own
 * tracker, for the places that show a ticket WITHOUT linking its key (the story view, where the key
 * is plain text, and the sprint card's story popover). The url is third-party data, so it goes
 * through `safeExternalUrl`; no usable url renders nothing.
 */
export function TrackerLinkOut({
  url,
  provider,
  className = '',
}: {
  url: string | null | undefined;
  /** Absent on a stored row written before providers existed — those are Jira. */
  provider: TrackerProvider | null | undefined;
  className?: string;
}): JSX.Element | null {
  const href = safeExternalUrl(url ?? null);
  if (href == null) return null;
  const name = TRACKER_PROVIDER_LABEL[provider ?? 'jira'];
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer noopener"
      data-testid="tracker-link-out"
      className={`inline-flex items-center gap-1 whitespace-nowrap rounded-ui text-meta font-medium text-ui-accent hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-ui-accent ${className}`}
    >
      Open in {name}
      <ExternalLinkIcon size={11} />
    </a>
  );
}
