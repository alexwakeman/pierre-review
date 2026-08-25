import { useRef, useState } from 'react';
import type { ReactionContent, ReactionTargetKind } from '@pierre-review/shared';
import { REACTION_CONTENTS, REACTION_EMOJI } from '@pierre-review/shared';
import { useClickOutside } from '../hooks/useClickOutside.js';
import { SmileyIcon } from './Icons.js';
import {
  useReactionPending,
  useReactionState,
  useToggleReaction,
} from '../hooks/useReactions.js';

// Emoji reactions on one comment / review body / PR comment (CORE, free tier).
//
// ONE component for every surface. It is mounted twice in the tree — inside `CommentBlock`
// (which reaches all SEVEN ThreadCard mount sites at once: Threads tab, Feed, search results,
// attention cards, Pro themes drill-down, the diff's inline pill) and inside PrDetail's conversation
// list (PR comments + review bodies). There is deliberately no read-only variant: the write
// gate is GitHub's own `viewerCanReact`, so a second component would only be a second way to
// get the gate wrong, and an un-mounted variant is exactly how a feature ships unreachable.
//
// A thread as a whole is NOT reactable (`PullRequestReviewThread` is not in GitHub's
// `Reactable` interface), so this never appears on ThreadCard's header — only on the comments
// inside it.

const REACTION_LABEL: Record<ReactionContent, string> = {
  thumbs_up: 'Thumbs up',
  thumbs_down: 'Thumbs down',
  laugh: 'Laugh',
  hooray: 'Hooray',
  confused: 'Confused',
  heart: 'Heart',
  rocket: 'Rocket',
  eyes: 'Eyes',
};

export function ReactionBar({
  kind,
  id,
  className,
}: {
  kind: ReactionTargetKind;
  id: number;
  className?: string;
}): JSX.Element | null {
  const state = useReactionState(kind, id);
  const pending = useReactionPending(kind, id);
  const toggle = useToggleReaction(kind, id);
  const rootRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  useClickOutside(rootRef, () => setOpen(false), open);

  // `undefined` = we do not know yet (the batch has not landed, or it failed). Rendering a
  // placeholder here would put an empty box under every comment on screen — the shape of the
  // regression this codebase records twice. Render nothing and cost nothing.
  if (!state) return null;

  const groups = state.groups;
  // Nothing to show AND nothing the viewer may do: render NOTHING at all. A locked
  // conversation or an archived repo lands here, and so does every unreacted comment for a
  // token without write-ish access.
  if (groups.length === 0 && !state.viewerCanReact) return null;

  const react = (content: ReactionContent, add: boolean): void => {
    setOpen(false);
    toggle.mutate({ content, add });
  };

  return (
    // The returned tree's SHAPE is fixed: this wrapper and the button are always here, and only
    // the PANEL is conditional inside it. A shape that changed with `open` would make React
    // unmount and remount the trigger, detaching the node the panel anchors to — the bug that
    // once parked the user popover in the top-left corner.
    <div
      ref={rootRef}
      className={`relative flex flex-wrap items-center gap-1${className ? ` ${className}` : ''}`}
      // Reaction chips sit inside cards whose header/body can be click-to-open regions
      // (ThreadCard's `onOpenInPr`, the feed's card activation). They are <button>s, which
      // those handlers already skip via a closest() guard — this marker is the belt to that
      // brace for any future non-button affordance added here.
      data-noactivate
    >
      {groups.map((g) => {
        const label = REACTION_LABEL[g.content];
        return (
          <button
            key={g.content}
            type="button"
            disabled={pending || !state.viewerCanReact}
            aria-pressed={g.viewerHasReacted}
            title={
              state.viewerCanReact
                ? `${label} · ${g.count}${g.viewerHasReacted ? ' — click to remove yours' : ''}`
                : `${label} · ${g.count}`
            }
            onClick={(e) => {
              e.stopPropagation();
              react(g.content, !g.viewerHasReacted);
            }}
            className={`inline-flex items-center gap-1 rounded-full border px-1.5 py-0.5 text-[11px] leading-none transition-colors disabled:opacity-60 ${
              g.viewerHasReacted
                ? 'border-blue-400 bg-blue-50 text-blue-700 dark:border-blue-500 dark:bg-blue-950/40 dark:text-blue-300'
                : 'border-gray-200 text-gray-500 hover:border-gray-300 dark:border-gray-800 dark:text-gray-400 dark:hover:border-gray-700'
            }`}
          >
            <span aria-hidden>{REACTION_EMOJI[g.content]}</span>
            <span className="tabular-nums">{g.count}</span>
          </button>
        );
      })}

      {/* The add affordance exists ONLY when GitHub says the viewer may react. Removed from the
          tree rather than disabled: a permanently dead button on every comment of a locked
          conversation is noise that teaches the user nothing. */}
      {state.viewerCanReact && (
        <button
          type="button"
          disabled={pending}
          aria-haspopup="menu"
          aria-expanded={open}
          title="Add a reaction"
          onClick={(e) => {
            e.stopPropagation();
            setOpen((v) => !v);
          }}
          className={`inline-flex items-center gap-0.5 rounded-full border border-dashed px-1.5 py-1 text-[11px] leading-none transition-opacity disabled:opacity-40 ${
            groups.length === 0 ? 'opacity-40 hover:opacity-100' : ''
          } border-gray-300 text-gray-400 hover:text-gray-600 dark:border-gray-700 dark:text-gray-500 dark:hover:text-gray-200`}
        >
          <SmileyIcon />
          <span aria-hidden>+</span>
        </button>
      )}

      {open && (
        <div
          role="menu"
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              e.stopPropagation();
              setOpen(false);
            }
          }}
          className="absolute bottom-full left-0 z-30 mb-1 flex gap-0.5 rounded-md border border-gray-200 bg-white p-1 shadow-lg dark:border-gray-700 dark:bg-gray-900"
        >
          {/* All eight, always. A curated subset would leave a reaction added on github.com
              with no chip to render it under, i.e. silently dropping data GitHub is showing
              right next to ours. The BAR stays compact because only non-empty groups become
              chips. */}
          {REACTION_CONTENTS.map((content) => {
            const mine = groups.find((g) => g.content === content)?.viewerHasReacted === true;
            return (
              <button
                key={content}
                type="button"
                role="menuitem"
                title={mine ? `Remove ${REACTION_LABEL[content]}` : REACTION_LABEL[content]}
                onClick={(e) => {
                  e.stopPropagation();
                  react(content, !mine);
                }}
                className={`rounded px-1 py-0.5 text-sm leading-none hover:bg-gray-100 dark:hover:bg-gray-800 ${
                  mine ? 'bg-blue-50 dark:bg-blue-950/40' : ''
                }`}
              >
                <span aria-hidden>{REACTION_EMOJI[content]}</span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
