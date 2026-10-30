import { useState } from 'react';
import { useIsMutating } from '@tanstack/react-query';
import type { StoryBuild, StoryBuildDocsItem } from '@pierre-review/shared';
import { useFollowUpProvider } from '../../hooks/useModelPick.js';
import { storyBuildMutationKey, useStoryBuildDocsDecisions, useStoryBuildDocsRun } from '../../hooks/useStoryBuild.js';
import { TICKET_CRITERION_STATUS_CLASS } from '../../lib/claudeReviewFollowUp.js';
import { REVIEW_CHIP } from '../../lib/reviewStyles.js';
import { docsItemIncluded, docsPointsNotInPlan, storyBuildDocsGroups } from '../../lib/storyBuild.js';
import { StoryDocsRefLinks } from '../Activity/StoryDocsAlignment.js';
import { AiRunGate } from '../AiSetup.js';
import { ChevronIcon } from '../Icons.js';
import { InfoButton } from '../InfoModal.js';
import { Button } from '../ui/Button.js';
import { CheckboxBox } from '../ui/FormControls.js';
import { StoryBuildSection } from './StoryBuildSection.js';

// THE DOCS (the story wins — docs/STORY-BUILD.md § Docs consideration): what the workspace's reference
// library says about the plan, in three groups, every point with its checked citations (`DocLink` + the
// quote, the story docs check's own `StoryDocsRefLinks`):
//   Suggestions from the docs     a checkbox, TICKED by default (owner decision 6)
//   This story changes the docs   a checkbox, UNTICKED by default: "the story wins (acknowledged)"
//   Grounded in the docs          informational, collapsed with a count
// A tick is DB only (`PUT …/docs/decisions`); ticks the current plan has not seen go to the build as
// they are, and "Update plan" (the chat) folds them in.

const KIND_CHIP: Record<StoryBuildDocsItem['kind'], { word: string; tone: string }> = {
  suggestion: { word: 'Suggestion', tone: TICKET_CRITERION_STATUS_CLASS.partly_met },
  superseded: { word: 'Changed by the story', tone: TICKET_CRITERION_STATUS_CLASS.not_met },
  grounded: { word: 'Agrees', tone: TICKET_CRITERION_STATUS_CLASS.met },
};

export function BuildDocsSection({ build, editable }: { build: StoryBuild; editable: boolean }): JSX.Element | null {
  const ident = build.ident;
  const run = useStoryBuildDocsRun(build.workspaceId, ident);
  const decide = useStoryBuildDocsDecisions(build.workspaceId, ident);
  const busy = useIsMutating({ mutationKey: storyBuildMutationKey(ident) }) > 0;
  const provider = useFollowUpProvider(build.provider ?? null, 'story_docs');
  const [groundedOpen, setGroundedOpen] = useState(false);
  if (!build.wantDocs && build.docs == null && build.docsStatus === 'none') return null;
  const groups = storyBuildDocsGroups(build.docs);
  const pending = docsPointsNotInPlan(build);
  const toggle = (item: StoryBuildDocsItem, on: boolean): void => {
    decide.mutate({ id: build.id, decisions: { ...build.docsDecisions, [item.id]: on ? 'include' : 'ignore' } });
  };
  const canRun = editable && build.docsStatus !== 'running';
  return (
    <StoryBuildSection
      testId="story-build-docs"
      title="Docs"
      info={
        <InfoButton title="The docs and this story">
          <p>The AI read the parts of your reference library that touch this plan. Every point links to the passage it rests on.</p>
          <p>
            The story wins. Where it says something the docs do not, the point is listed as changed by the story. Leave it unticked to
            keep the story as it is.
          </p>
          <p>Ticked suggestions go to the build. Points the docs agree with are listed for reference.</p>
        </InfoButton>
      }
      end={
        canRun && build.docsStatus !== 'none' ? (
          <AiRunGate kind="story_docs" meter={false} followUp provider={provider}>
            <Button size="sm" data-ai-run disabled={busy} onClick={() => run.mutate({ id: build.id, force: true })}>
              Check the docs again
            </Button>
          </AiRunGate>
        ) : null
      }
    >
      {build.docsStatus === 'none' && editable && (
        <div className="flex flex-wrap items-center gap-2">
          <p className="text-meta text-ui-mute">The docs have not been checked against this plan.</p>
          <AiRunGate kind="story_docs" meter={false} followUp provider={provider}>
            <Button size="sm" data-ai-run data-testid="story-build-docs-run" disabled={busy} onClick={() => run.mutate({ id: build.id })}>
              Check against docs
            </Button>
          </AiRunGate>
        </div>
      )}
      {build.docsStatus === 'running' && <p className="text-meta text-ui-mute">Reading the docs…</p>}
      {build.docsStatus === 'failed' && <p className="text-meta text-ui-warn">Couldn&rsquo;t check the docs.</p>}
      {build.docsStatus === 'refused' && <p className="text-meta text-ui-mute">The library has nothing that touches this plan.</p>}
      {build.docs != null && (
        <>
          <p className="max-w-3xl text-body text-ui-ink">{build.docs.summary}</p>
          {build.docs.nothingGrounded && <p className="mt-1 text-meta text-ui-mute">No point had a passage to back it, so none is listed.</p>}
          {pending > 0 && build.status === 'plan_ready' && (
            <p data-testid="story-build-docs-pending" className="mt-2 text-meta text-ui-warn">
              {pending} docs point{pending === 1 ? ' isn’t' : 's aren’t'} in the plan yet: {pending === 1 ? 'it goes' : 'they go'} to the build as{' '}
              {pending === 1 ? 'it is' : 'they are'}. Update the plan below to fold {pending === 1 ? 'it' : 'them'} in.
            </p>
          )}
          {groups.suggestions.length > 0 && (
            <DocsGroup title={`Suggestions from the docs (${groups.suggestions.length})`}>
              {groups.suggestions.map((it) => (
                <DocsItemRow key={it.id} item={it} checked={docsItemIncluded(it, build.docsDecisions)} editable={editable} onToggle={toggle} />
              ))}
            </DocsGroup>
          )}
          {groups.superseded.length > 0 && (
            <DocsGroup title={`This story changes the docs (${groups.superseded.length})`} note="Unticked: the story wins (acknowledged).">
              {groups.superseded.map((it) => (
                <DocsItemRow key={it.id} item={it} checked={docsItemIncluded(it, build.docsDecisions)} editable={editable} onToggle={toggle} />
              ))}
            </DocsGroup>
          )}
          {groups.grounded.length > 0 && (
            <div className="mt-3">
              <button
                type="button"
                className="hit inline-flex items-center gap-1 text-meta font-medium text-ui-mute hover:text-ui-ink"
                aria-expanded={groundedOpen}
                onClick={() => setGroundedOpen((v) => !v)}
              >
                <ChevronIcon dir={groundedOpen ? 'down' : 'right'} />
                Grounded in the docs ({groups.grounded.length})
              </button>
              {groundedOpen && (
                <ul className="mt-1 space-y-2">
                  {groups.grounded.map((it) => (
                    <DocsItemRow key={it.id} item={it} checked={false} editable={false} onToggle={toggle} />
                  ))}
                </ul>
              )}
            </div>
          )}
        </>
      )}
    </StoryBuildSection>
  );
}

function DocsGroup({ title, note, children }: { title: string; note?: string; children: React.ReactNode }): JSX.Element {
  return (
    <div className="mt-3">
      <h4 className="text-meta font-medium text-ui-mute">{title}</h4>
      {note != null && <p className="text-meta text-ui-mute">{note}</p>}
      <ul className="mt-1 space-y-2">{children}</ul>
    </div>
  );
}

function DocsItemRow({
  item,
  checked,
  editable,
  onToggle,
}: {
  item: StoryBuildDocsItem;
  checked: boolean;
  editable: boolean;
  onToggle: (item: StoryBuildDocsItem, on: boolean) => void;
}): JSX.Element {
  const chip = KIND_CHIP[item.kind];
  const box = item.kind !== 'grounded';
  const body = (
    <span className="min-w-0 flex-1">
      <span className="flex flex-wrap items-baseline gap-1.5">
        <span className={`${REVIEW_CHIP} ${chip.tone}`}>{chip.word}</span>
        <span className="font-mono text-meta text-ui-mute">{item.about === 'story' ? 'The story' : item.about}</span>
      </span>
      <span className="mt-0.5 block text-body text-ui-ink">{item.note}</span>
      {item.suggestion != null && <span className="mt-0.5 block text-body font-medium text-ui-ink">{item.suggestion}</span>}
    </span>
  );
  return (
    <li data-testid="story-build-docs-item" data-kind={item.kind} className="rounded-ui bg-ui-surface px-3 py-2">
      {box ? (
        <label className={`flex items-start gap-2 ${editable ? 'cursor-pointer' : ''}`}>
          <CheckboxBox className="mt-1" checked={checked} disabled={!editable} onChange={(e) => onToggle(item, e.target.checked)} />
          {body}
        </label>
      ) : (
        <div className="flex items-start gap-2">{body}</div>
      )}
      <div className={box ? 'ml-6' : ''}>
        <StoryDocsRefLinks refs={item.refs} />
      </div>
    </li>
  );
}
