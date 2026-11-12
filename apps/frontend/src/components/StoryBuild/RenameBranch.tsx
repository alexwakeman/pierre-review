import { useEffect, useId, useState } from 'react';
import { STORY_BUILD_BRANCH_MAX, storyBuildFreeBranch } from '@pierre-review/shared';
import { PullRequestIcon } from '../Icons.js';
import { Button } from '../ui/Button.js';

// THE RENAME AFTER BRANCH_EXISTS (docs/STORY-BUILD.md § Push): the branch Limn tried is on GitHub
// already, so Push again would only be refused again. In its place: a new name, prefilled with the first
// free `<branch>-vN` (shared `storyBuildFreeBranch`, never one of the build's own branches), and Push.
// The host checks the name like every push target and still refuses one that exists; never forced.

export function RenameBranch({
  branch,
  taken,
  draft,
  disabled,
  actionId,
  onPush,
  buttonLabel,
}: {
  /** The branch the last push tried. */
  branch: string;
  /** Every branch this build names, and the names already tried: the suggestion avoids them. */
  taken: readonly string[];
  draft: boolean;
  disabled: boolean;
  /** `data-story-build-action` of the Push button. */
  actionId: string;
  onPush: (branch: string) => void;
  /** The button's words (the review loop's Continue); absent ⇒ Push / Push as draft. */
  buttonLabel?: string;
}): JSX.Element {
  const inputId = useId();
  const suggestion = storyBuildFreeBranch(branch, taken);
  const [name, setName] = useState(suggestion);
  // A refused name joins `taken`: offer the next free one.
  useEffect(() => setName(suggestion), [suggestion]);
  const value = name.trim();
  return (
    <div data-testid="story-build-rename" className="mt-3 flex flex-wrap items-center gap-2" data-noactivate>
      <label htmlFor={inputId} className="text-meta text-ui-ink">
        New branch
      </label>
      <input
        id={inputId}
        type="text"
        data-testid="story-build-rename-input"
        className="min-w-0 flex-1 basis-56 rounded-ui bg-ui-raise px-2 py-1 font-mono text-meta text-ui-ink"
        value={name}
        maxLength={STORY_BUILD_BRANCH_MAX}
        spellCheck={false}
        autoComplete="off"
        disabled={disabled}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && value !== '' && !disabled) onPush(value);
        }}
      />
      <Button
        variant="primary"
        size="sm"
        icon={<PullRequestIcon size={12} />}
        disabled={disabled || value === ''}
        data-story-build-action={actionId}
        onClick={() => onPush(value)}
      >
        {buttonLabel ?? (draft ? 'Push as draft' : 'Push')}
      </Button>
    </div>
  );
}
