import type { DocMeta } from '../../types';
import { Btn, DocLink, H2, Illustration, MiniTable, Note, Thread, Ui, Warning } from '../../kit';

export const meta: DocMeta = {
  title: 'Replies to findings',
  summary: 'When somebody replies to a finding, Limn reads the reply and says whether the finding still stands.',
};

function ReplyPicture(): JSX.Element {
  return (
    <Illustration
      label="A thread on refunds/policy.py. Limn's warning says the amount can be negative. Dana replies that the API already rejects negative amounts. The replies pass accepted the reply."
      caption="A person answers a Limn finding; the replies pass judges the answer without a full review."
      title="#612 Partial refunds"
      meta="Replies to the review"
    >
      <Thread
        file="refunds/policy.py:31"
        state="Reply accepted"
        tone="green"
        comments={[
          { who: 'Limn · priya', bot: true, text: 'Warning: amount can be negative here, which would pay the customer.' },
          { who: 'Dana Wu', when: '10:12', text: 'The API rejects negative amounts before this runs: see validate_refund().' },
        ]}
      />
      <p>
        <Btn>Check replies</Btn>
      </p>
    </Illustration>
  );
}

export default function Page(): JSX.Element {
  return (
    <>
      <p>
        When someone answers one of your Limn's findings on GitHub, that answer deserves a reply, not another full
        review. The replies pass reads just the replies to Limn's own findings, at the current commit, and decides
        for each one whether the finding still stands. It is short and cheap: a smaller model with a firm cost cap.
      </p>

      <H2 id="what-it-judges">What it judges</H2>
      <ReplyPicture />
      <p>
        Only replies by a person on a thread or comment of one of your Limn's posted findings, newer than that
        finding's last judgement. Your own replies count. Replies from bots, and anything Limn posted, do not. A
        thread that was resolved after the reply is still judged: resolving alone does not settle a point.
      </p>
      <p>
        Comments on other people's threads are a different pass, Check threads. See{' '}
        <DocLink to="#replies-or-check-threads">Replies pass or Check threads</DocLink> below.
      </p>

      <H2 id="the-outcomes">The outcomes</H2>
      <MiniTable
        cols={[
          { key: 'o', label: 'Outcome' },
          { key: 'm', label: 'What it means' },
          { key: 'n', label: 'What happens next' },
        ]}
        rows={[
          {
            _key: 'a',
            o: 'Reply accepted',
            m: 'The finding was wrong, or the reply settles it.',
            n: 'The finding is settled for good and never raised again.',
          },
          {
            _key: 'f',
            o: 'Fix later',
            m: 'The reply says it will be dealt with in later work, and that is reasonable.',
            n: 'Settled for this pull request. A blocker can never be deferred.',
          },
          {
            _key: 'b',
            o: 'Pushed back',
            m: 'The point still stands.',
            n: 'The thread stays open; the next full review raises it again.',
          },
        ]}
      />

      <H2 id="when-it-starts">When it starts</H2>
      <ul>
        <li>
          <b>By itself</b>, when auto review is on for the workspace: after 5 quiet minutes on the pull request, at most
          5 a day per pull request, within your spend budget. It never runs while a full review is running, because a
          full review checks the replies itself.
        </li>
        <li>
          <b>When you press it</b>: <Ui>Check replies</Ui> on the <Ui>AI Review</Ui> tab, shown while replies are
          waiting for a judgement. If none are, Limn says <Ui>Every reply already has a judgement.</Ui>
        </li>
      </ul>
      <p>
        After it runs, one line on the tab sums up the pass, and the pass is listed in Reviews on this PR. It is not a
        review: the next full review still follows up the latest full review.
      </p>

      <H2 id="what-it-posts">What it posts</H2>
      <p>A pass you start yourself posts nothing. Each reply it would make is a draft with a <Ui>Post reply</Ui> button.</p>
      <p>An automatic pass, with posting on for the workspace, may write:</p>
      <ul>
        <li>
          <b>One pushback per thread, ever</b>, in the model's own words, on an open thread. Limn never resolves a
          thread after pushing back. On a resolved thread it posts a <Ui>Still open:</Ui> reply instead.
        </li>
        <li>
          <b>A one-sentence acknowledgement, then a resolve</b>, for an accepted reply, where Limn is allowed to resolve:
          your own pull request, or another pull request with <Ui>Resolve Limn's threads once fixed</Ui> on. Otherwise
          nothing is posted and the finding is settled in Limn only.
        </li>
      </ul>
      <Warning>
        Both writes go to GitHub under your account, marked as Limn's. Each is recorded before it is written and never
        retried.
      </Warning>

      <H2 id="the-verdict">The verdict</H2>
      <p>The replies pass can change the review's verdict, through the same rules as a full review:</p>
      <ul>
        <li>A disputed blocker can turn the verdict into <Ui>Request changes</Ui>.</li>
        <li>
          Once nothing blocking is left, and nothing your workspace's approval rules forbid, it can approve. The
          approval is held, with a reason, if a teammate's Limn has since judged one of the settled points still open.
        </li>
      </ul>
      <p>
        A pass you start shows what it would do ("Would approve." or "Would request changes.") and changes nothing on
        GitHub. An automatic pass posts its verdict as one short review only when it rests on an automatic review and
        posting is on. See <DocLink to="ai-review/verdicts-and-posting">Verdicts and posting to GitHub</DocLink>.
      </p>

      <H2 id="replies-or-check-threads">Replies pass or Check threads</H2>
      <MiniTable
        cols={[
          { key: 'k', label: '' },
          { key: 'r', label: 'Replies pass' },
          { key: 'c', label: 'Check threads' },
        ]}
        rows={[
          { _key: 'w', k: 'Judges', r: "Replies on your Limn's own findings", c: "Everyone else's threads: people, review bots, teammates' Limn" },
          { _key: 's', k: 'Starts', r: 'A reply on a Limn finding; or Check replies', c: 'A new comment in an open thread; or Check threads' },
          { _key: 'c', k: 'Daily limit (automatic)', r: '5 per pull request', c: '30 per workspace' },
          { _key: 'p', k: 'Posts', r: 'Automatic only: one pushback per thread, or an acknowledgement and a resolve', c: 'Nothing' },
          { _key: 'v', k: 'Verdict', r: 'Can request changes or approve', c: 'Changes no verdict by itself' },
        ]}
      />
      <Note>
        See <DocLink to="ai-review/check-threads">Check threads</DocLink> and{' '}
        <DocLink to="ai-review/team-reviews">Reviewing as a team</DocLink> for how replies and pushback work when
        several teammates run Limn.
      </Note>
    </>
  );
}
