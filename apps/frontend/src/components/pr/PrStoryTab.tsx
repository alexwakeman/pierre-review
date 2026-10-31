import { useState } from 'react';
import { useOpenStory } from '../../lib/ticketTab.js';
import { StoryViewBody } from '../Ticket/StoryViewBody.js';
import { ArrowIcon } from '../Icons.js';
import { Button } from '../ui/Button.js';
import { cx, FOCUS_RING } from '../ui/cx.js';

// THE PR VIEW'S STORY TAB (`?prTab=story`; docs/FRONTEND.md § PrDetail → The Story tab): the story view
// of the PR's linked ticket, inside the PR — the SAME body the story tab and This Sprint's tray mount
// (`StoryViewBody`), never a copy, so its layout measures THIS pane (two columns full-screen on a wide
// screen, one in the drawer or on a phone) and its reads are the story view's own two DB reads, made
// when the tab is opened and not before. Listed only while the PR names a ticket Limn can open as a
// story (a `TicketRef.ident` — the "Open story" menu item's condition). Several stories: a switcher on
// top, the first picked. "Open story tab" opens the full story tab (`useOpenStory`, the one way in).

export interface PrStoryTicket {
  ident: string;
  key: string;
}

export function PrStoryTab({
  tickets,
  oneColumn = false,
}: {
  tickets: readonly PrStoryTicket[];
  /** The PR drawer: always one column. */
  oneColumn?: boolean;
}): JSX.Element | null {
  const [picked, setPicked] = useState<string | null>(null);
  const openStory = useOpenStory();
  const current = tickets.find((t) => t.ident === picked) ?? tickets[0];
  if (current == null) return null;
  return (
    <div className="space-y-3 px-5 py-2 max-md:px-3" data-testid="pr-story-tab">
      <div className="flex flex-wrap items-center gap-2">
        {tickets.length > 1 && (
          <div role="group" aria-label="Stories on this pull request" className="flex flex-wrap items-center gap-1" data-testid="pr-story-switcher">
            {tickets.map((t) => {
              const on = t.ident === current.ident;
              return (
                <button
                  key={t.ident}
                  type="button"
                  aria-pressed={on}
                  onClick={() => setPicked(t.ident)}
                  className={cx(
                    'hit inline-flex h-7 items-center rounded-ui px-2.5 font-mono text-meta font-medium touch:h-10 touch:px-3',
                    on ? 'bg-ui-sel text-ui-ink' : 'text-ui-mute hover:bg-ui-hover hover:text-ui-ink',
                    FOCUS_RING,
                  )}
                >
                  {t.key}
                </button>
              );
            })}
          </div>
        )}
        <Button
          variant="ghost"
          size="sm"
          icon={<ArrowIcon size={11} />}
          onClick={() => openStory({ ident: current.ident, key: current.key, title: null })}
        >
          Open story tab
        </Button>
      </div>
      {/* Keyed on the ticket, so switching stories starts the body afresh. */}
      <StoryViewBody key={current.ident} ident={current.ident} meta={{ key: current.key, title: null }} oneColumn={oneColumn} />
    </div>
  );
}
