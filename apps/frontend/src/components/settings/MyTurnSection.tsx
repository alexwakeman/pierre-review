import { MY_TURN_OLDER_DAYS } from '@pierre-review/shared';
import { useMe } from '../../hooks/useTriage.js';
import { useSetMyTurnSettings } from '../../hooks/useMyTurnSettings.js';
import { InfoButton } from '../InfoModal.js';
import { CheckInput, SectionShell } from './ui.js';

// SETTINGS → PENDING → MY TURN — CORE / free, every install. ACCOUNT-grained (one account is one
// reader), stored on the account row and carried by /api/me.
//
// ONE SWITCH: "Also show new PRs nobody asked you about". Everything else about My Turn is fixed
// (docs/BACKEND.md § My Turn): its groups, their order, and the ranking every other tab uses. The
// switch saves as soon as it changes — there is nothing else on the section to batch it with.
//
// ⚠ THE HEADING ID IS LOAD-BEARING. Pending's "Customise" link opens Settings with
// `focus: 'my-turn'`, and the modal scrolls to and focuses this heading.

export const MY_TURN_SECTION_HEADING_ID = 'settings-my-turn-heading';

export function MyTurnSection(): JSX.Element {
  const { data: me } = useMe();
  const save = useSetMyTurnSettings();
  // While a save is in flight, show what the reader just chose.
  const on = save.isPending ? (save.variables?.showNewPrs ?? false) : (me?.myTurnSettings?.showNewPrs ?? false);

  return (
    <SectionShell
      title="My Turn"
      headingId={MY_TURN_SECTION_HEADING_ID}
      desc="Applies to every workspace."
      info={
        <InfoButton title="My Turn">
          <p>
            My turn lists pull requests where a person is waiting on you, in three groups: Waiting
            on you (review requests, mentions and replies to you), Re-review (someone pushed after
            your review or comment) and Your PRs (approved, ready to land, failing, conflicting, or
            with an unanswered thread).
          </p>
          <p>
            An item that has waited more than {MY_TURN_OLDER_DAYS} days moves to a closed “Older”
            group at the end of the list. It still counts.
          </p>
          <p>Draft PRs never show. Muted repositories never appear in My turn and never notify you.</p>
        </InfoButton>
      }
    >
      <label className="flex cursor-pointer items-start gap-2 text-body">
        <CheckInput
          className="mt-0.5"
          checked={on}
          disabled={me == null || save.isPending}
          onChange={(e) => save.mutate({ showNewPrs: e.target.checked })}
        />
        <span>
          <span className="font-medium text-ui-ink">Also show new PRs nobody asked you about</span>
          <span className="mt-0.5 block text-meta text-ui-mute">
            Open PRs in your repositories that nobody asked you about.
          </span>
        </span>
      </label>
      {save.isError && (
        <p className="text-meta text-ui-danger" role="alert">
          {save.error?.message ?? 'Couldn’t save your My Turn setting.'}
        </p>
      )}
    </SectionShell>
  );
}
