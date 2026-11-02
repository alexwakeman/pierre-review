import { useState } from 'react';
import { DOCS_OFFER_FOLDER_NAMES, DOCS_OFFER_MIN_FILES, DOCS_OFFER_MIN_WORDS, DOCS_OFFER_SNOOZE_DAYS, type RepoDocsOffers } from '@pierre-review/shared';
import { useAiCapabilities } from '../../hooks/useAiCapabilities.js';
import { useRunCostText } from '../../hooks/useAiBudget.js';
import { useAddDocsOffers, useDismissDocsOffers } from '../../hooks/useReferenceDocs.js';
import { addableOffers, chosenOffers, offerFiles, offerHeading, offerLabel, offersAddProblem } from '../../lib/docsOffers.js';
import { AiRunGate } from '../AiSetup.js';
import { BookIcon } from '../Icons.js';
import { InfoButton } from '../InfoModal.js';
import { Button, CheckboxBox, cx, FOCUS_RING, TEXT_LINK } from '../ui/index.js';

// THE DOCS OFFER (docs/REFERENCE-DOCS.md § Docs offered from your repositories): the docs folders the
// server found in the workspace's repositories, with a checkbox each, Add and Not now. On the Docs page
// and as a card on Pending — both read the list from a response the page already holds, so NOTHING
// HERE FETCHES ON MOUNT. ⚠ NOTHING IS BUILT UNTIL ADD: building a document runs the AI, so Add sits
// behind `AiRunGate kind="docs_build"`, and its cost line is the per-build cap through `useRunCostText`.
// A too-large folder has no checkbox: it points at the add-documents wizard (`onChoosePart`). "Not now"
// hides the card for DOCS_OFFER_SNOOZE_DAYS (the server's `decided_at`); the wizard's "From your
// repositories" lists the same folders at any time.

export function DocsOfferCard({
  workspaceId,
  offers,
  onChoosePart,
  className,
}: {
  workspaceId: number;
  offers: RepoDocsOffers;
  /** Open the add-documents wizard on this repository (the Docs page), or go to Docs (Pending). */
  onChoosePart?: (repoFullName: string) => void;
  className?: string;
}): JSX.Element | null {
  const ai = useAiCapabilities();
  const costText = useRunCostText();
  const add = useAddDocsOffers(workspaceId);
  const dismiss = useDismissDocsOffers(workspaceId);
  const [unticked, setUnticked] = useState<ReadonlySet<number>>(() => new Set());
  const [problem, setProblem] = useState<string | null>(null);
  if (!ai.enabled || offers.offers.length === 0) return null;
  const addable = addableOffers(offers.offers);
  const chosen = chosenOffers(offers.offers, unticked);
  const cost = costText(offers.budgetUsd, ai.provider);
  const toggle = (id: number, on: boolean): void =>
    setUnticked((prev) => {
      const next = new Set(prev);
      if (on) next.delete(id);
      else next.add(id);
      return next;
    });
  return (
    <section
      className={cx('rounded-ui border border-ai-border bg-ai-surface px-3 py-2.5', className)}
      aria-label="Docs from your repositories"
      data-testid="docs-offer"
    >
      <div className="flex items-start gap-3">
        <BookIcon size={14} className="mt-0.5 shrink-0 text-ai-signal" />
        <div className="min-w-0 flex-1">
          <h3 className="flex items-center gap-1 text-body font-medium text-ui-ink">
            {offerHeading(offers.offers)}
            <InfoButton title="Docs from your repositories">
              <p>
                Limn looked for docs folders in this workspace’s repositories: a folder named{' '}
                {DOCS_OFFER_FOLDER_NAMES.join(', ')}, or any folder with five or more documents, holding at least{' '}
                {DOCS_OFFER_MIN_FILES} documents and about {DOCS_OFFER_MIN_WORDS.toLocaleString('en')} words. A README alone
                never counts.
              </p>
              <p>
                Nothing is added until you press Add. Each folder becomes one document in Docs, kept up to date with the
                repository. Not now hides this card for {DOCS_OFFER_SNOOZE_DAYS} days. You can add these folders any time
                from Docs: + → From your repositories.
              </p>
            </InfoButton>
          </h3>
          {addable.length > 0 && (
            <p className="text-meta text-ui-mute">
              Building {addable.length === 1 ? 'it' : 'them'} uses {ai.providerName}.
              {cost != null && ` Up to ${cost} each.`}
            </p>
          )}
          <ul className="mt-2 space-y-1">
            {offers.offers.map((o) =>
              o.tooLarge ? (
                <li key={o.id} className="flex flex-wrap items-baseline gap-x-2 pl-6 text-body">
                  <span className="text-ui-ink">{offerLabel(o)}</span>
                  <span className="text-meta text-ui-faint">{offerFiles(o)} · too large to add in one go</span>
                  {onChoosePart && (
                    <button type="button" className={cx('rounded-ui text-meta', TEXT_LINK, FOCUS_RING)} onClick={() => onChoosePart(o.repoFullName)}>
                      Choose part of it
                    </button>
                  )}
                </li>
              ) : (
                <li key={o.id}>
                  <label className="flex cursor-pointer items-center gap-2 text-body">
                    <CheckboxBox checked={!unticked.has(o.id)} onChange={(e) => toggle(o.id, e.currentTarget.checked)} />
                    <span className="min-w-0 truncate text-ui-ink">{offerLabel(o)}</span>
                    <span className="shrink-0 text-meta text-ui-faint">{offerFiles(o)}</span>
                  </label>
                </li>
              ),
            )}
          </ul>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            {addable.length > 0 && (
              <AiRunGate kind="docs_build" meter={false}>
                <Button
                  size="sm"
                  variant="primary"
                  disabled={chosen.length === 0}
                  busy={add.isPending}
                  busyLabel="Adding…"
                  onClick={() => {
                    setProblem(null);
                    add.mutate(chosen, { onSuccess: (res) => setProblem(offersAddProblem(res)) });
                  }}
                >
                  Add
                </Button>
              </AiRunGate>
            )}
            <Button size="sm" variant="secondary" disabled={add.isPending} onClick={() => dismiss.mutate(offers.offers.map((o) => o.id))}>
              Not now
            </Button>
          </div>
          {(problem != null || add.isError) && (
            <p className="mt-1 text-meta text-ui-danger">{problem ?? add.error?.message ?? 'Could not add the folders.'}</p>
          )}
        </div>
      </div>
    </section>
  );
}
