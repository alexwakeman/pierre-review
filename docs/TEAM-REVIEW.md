# Limn on a team: how shared reviews work

**Status:** the design reference for every multi-user behaviour. Checked against the code on
2026-11-05 (Limn 1.0.3). **Keep it true:** any change to claims, auto review, auto-posting, verdicts,
withdrawals, teammate reviews, thread judgements, replies, pushback, resolving or still-open points
updates this file in the same commit. Engineering detail (names, tables, markers) lives in
[CLAUDE-REVIEW.md](CLAUDE-REVIEW.md); this file says what happens and why, in plain words.

---

## 1. The idea in one page

Every person runs their own Limn on their own machine, signed in to GitHub as themselves. There is
no Limn server and no shared account. **GitHub is the only meeting place**: each Limn reads what
the others wrote there, and writes back only as its own person.

```mermaid
flowchart LR
  subgraph A[Alex's machine]
    LA[Alex's Limn]
  end
  subgraph R[Robin's machine]
    LR[Robin's Limn]
  end
  GH[(GitHub: the PR<br/>reviews, comments, replies,<br/>status lines, hidden markers)]
  LA -- "writes as Alex" --> GH
  LR -- "writes as Robin" --> GH
  GH -- "reads on every sync" --> LA
  GH -- "reads on every sync" --> LR
```

Three rules follow from that and explain most of what is below:

1. **A Limn only knows what reached GitHub.** A review someone "kept in Limn" is invisible to the team.
2. **Every write is a person's write.** A Limn post is that person's review or comment on GitHub, so
   GitHub's own rules apply to it (an author cannot approve their own PR; branch rules decide what a
   push dismisses).
3. **Each Limn decides alone, from what it reads.** Nothing coordinates two machines except the
   status lines and markers they leave on GitHub, so every rule is written to be safe when two Limns
   act at nearly the same moment, and safe when a teammate runs an older version.

What travels between Limns:

| Signal on GitHub | What it tells another Limn |
|---|---|
| A **status line** on the PR's latest commit, one per model ("alex is reviewing with Claude", "alex reviewed · 3 comments", "Cleared by alex…") | Who is reviewing this commit with which model, and whether it is done. Never CI. |
| A **posted review** with a hidden marker at the end | That it is a Limn review; the commit it read; the model(s); the verdict sent; the Limn version; its judgement of earlier threads; whether the poster lets a teammate's Limn lift their "changes requested". |
| **Finding comments** with a severity word ("**Warning**") and a hidden marker | A Limn finding, raised by that person's Limn. Every Limn treats it as a bot ("Limn · alex"), never as the person. |
| **"Still open:" replies** with a hidden marker | Which commit it was said at, and whether this thread has already been reopened once. |

What never travels: costs, settings, drafts, reviews kept in Limn, chat, and anything about the
reader's machine. (Code and diffs do go to the model provider the person chose; that is not shared
with teammates.)

---

## 2. Who is who

| Word | Meaning |
|---|---|
| **Author** | The person who opened the PR. GitHub never lets them approve it or request changes on it. |
| **Reviewer** | Anyone else on the team looking at the PR. |
| **Reader** | Whoever is looking at Limn right now. Each person is the reader on their own machine. |
| **Your Limn / Robin's Limn** | The Limn running for that person, posting as them. |
| **Model** | Claude or Codex. Each person signs in to their own; usage limits are per person. |
| **Pair** | A review where Claude and Codex both review blind and Limn merges them into one post. The default when both are signed in. |
| **Auto review** | A review Limn starts by itself. Off per workspace until switched on. |
| **Posting** | Sending a review to GitHub. Automatic runs post by default (the "Post to GitHub" setting); a run you start posts only with "Review and post". |

---

## 3. Sharing the review burden

**The rule: one review per model per commit, across the whole team.** If Robin's Limn reviews a
commit with Claude, nobody else's Limn reviews that commit with Claude. Another model is still
welcome: if Robin used Claude, Alex's Limn reviews with Codex only. If Robin ran both, Alex's runs
nothing. A new commit starts the race again.

This applies to **automatic** reviews only. A review you start yourself never checks or posts a
claim. Claims are **on by default**.

### When an automatic review starts

| Event | What Limn does |
|---|---|
| A person opens a PR (after auto review was switched on) | Reviews it on the next one-minute tick. |
| New commits | Reviews at once if nothing ran in the last 5 minutes; otherwise waits for 5 quiet minutes, never more than 20 minutes after the first push. A run in progress is never cancelled. |
| A reply on one of your Limn's posted findings | A short "replies pass" (§ 7), after 5 quiet minutes. At most 5 a day per PR. |
| Another new comment in an unresolved thread, by a person or a review bot | A light "Check threads" pass. At most 30 a day per workspace. |
| A thread is resolved, CI finishes, a deploy or coverage bot comments, your own Limn posts | **Nothing.** Resolving adds no comment, so it starts nothing. |

Limits: 20 automatic reviews a day per workspace by default (a pair counts once; a skip because a
teammate has the commit counts nothing). A failed run is retried only when the error is temporary,
at most 3 tries per commit (after 1 hour, then 4 hours, or when the usage limit resets).

### How a claim works

```mermaid
stateDiagram-v2
  [*] --> Free
  Free --> Reviewing: a Limn posts "alex is reviewing with Claude"
  Reviewing --> Reviewing: renewed every 8 minutes while it runs
  Reviewing --> Reviewed: "alex reviewed · 3 comments" (findings posted)
  Reviewing --> Free: "alex reviewed · kept in Limn" (none of its findings posted)
  Reviewing --> Free: "Cleared by alex: review didn't finish · free to claim"
  Reviewing --> Free: no renewal for 25 minutes (the lease ends)
  Reviewing --> Free: someone presses Clear (a confirm for a teammate's claim)
  Reviewing --> Reviewed: Alex's review is already on GitHub for this commit and model
  Free --> [*]: a new commit starts a new race
```

- **Who wins a race:** each Limn posts its line, then reads the lines again. Of the claims that are
  still live (renewed in the last 25 minutes), the **earliest** wins. The loser stands down and shows
  the winner's name.
- **"Reviewed" means done:** the line turns to "reviewed" only after the review is posted. If a
  Limn's review reached GitHub but its final line never did (a crash, an old version), every other
  Limn treats that posted review as the "reviewed" line as soon as it syncs it, instead of waiting
  out the 25 minutes.
- **Free again:** a failure, a Stop, a skipped run ("Cleared by alex: auto review skipped · daily
  auto-review limit reached"), a review whose findings were not posted ("· kept in Limn"), the Clear
  button on a live claim, or a lease that ran out (another Limn then posts "Cleared by alex: bob's
  claim expired"). Every free line except "kept in Limn" starts "Cleared by", which older Limns also
  read as free. Limn never posts a red line.
- **⚠ "Kept in Limn" means none of that model's findings were posted**, not that nothing reached
  GitHub: an approval with only nits (nits are not posted), a reason-only comment, or findings all
  credited to the other half of a pair also read "kept in Limn". The commit is then free, and a
  teammate's Limn reviews it again (gap 12).
- **Status lines are the one write Limn retries**: releasing a line, or a final line that failed, is
  retried up to 5 times. Everything else is written once.
- **The author never holds a commit for the reviewers.** Because the author cannot approve, their
  Limn's lines are ignored by everyone else's Limn. It does not work the other way: the author's own
  Limn still steps aside for a reviewer's claim (their review would only be a comment on their own PR).
- **If a claim cannot be read or written** (no write access, GitHub error), the review runs without
  a line. Claims never block a review outright.

### Pairs and usage limits

| Situation | What your Limn does |
|---|---|
| Robin has Claude on this commit | Runs Codex alone and claims Codex. |
| Robin has Codex | Runs Claude alone; your review says "Codex didn't finish: a teammate's Limn is reviewing with Codex". |
| Robin has both | Runs nothing: "Robin Dunn reviewed this commit with Claude · posted on GitHub". |
| Robin has Claude, and your Codex is at its usage limit | Runs nothing. A model at its limit is dropped before any claim. |
| Your Claude is at its limit, nobody has the commit | Runs Codex alone. With a pair, "Run auto reviews now" runs a locked model only when every model is locked; with one model, a press runs it anyway. |

### What you see when your Limn steps aside

- AI Review tab: "Robin Dunn is reviewing this commit with Claude", or "…reviewed this commit with
  Claude · 4 comments" (or "· not posted on GitHub" / "· posted on GitHub").
- Open PRs column: "Being reviewed by @robin" / "Reviewed by @robin".
- No run is recorded, no daily allowance is spent. Your Limn looks again when the lease could end,
  every 30 minutes after a "reviewed", or at once on a new commit or when Robin's review syncs.

---

## 4. Author and reviewer

```mermaid
flowchart TB
  subgraph Author["Author's Limn on their own PR"]
    A1[Reviews as normal] --> A2[Posts as a comment only:<br/>GitHub forbids self-approval]
    A2 --> A3["Shows 'Not approved: your own pull request.'<br/>in Limn only"]
    A1 --> A4[Resolves its own threads once fixed<br/>'Addressed in abc1234.']
    A1 --> A5[Optional: Auto AI Fix, off by default;<br/>pushes only if 'Push automatically' is on]
  end
  subgraph Reviewer["Reviewer's Limn on the same PR"]
    R1[Follows up on the author's own review<br/>if it is the latest one] --> R2[Raises only what is new;<br/>never re-posts the author's points]
    R2 --> R3[May approve or request changes,<br/>within the reader's settings]
  end
```

| | Author's Limn (own PR) | Reviewer's Limn |
|---|---|---|
| Can approve or request changes | **Never.** Always a comment. | Yes, within the settings (§ 5). |
| Holds the commit against others | **No** — other Limns ignore its lines. | Yes. |
| Steps aside for others | Yes, for a reviewer's claim on the same model. | Yes, for another reviewer's claim. |
| Resolves its own threads when fixed | Yes, on by default ("Resolve my Limn threads when addressed"), after any run. | Only with the workspace's "Resolve Limn's threads once fixed" (off by default), on automatic runs. |
| Auto AI Fix | Optional, off by default; at most 3 per PR a day; pushes only if "Push automatically" is on. | Never on someone else's PR. |
| Writes on the other's threads | Never resolves a teammate's thread. May post "Still open:" on any open point, its own PR included (decision D2). | Never resolves a teammate's thread. May post one "Still open:" reply per thread per commit and reopen a thread once, ever (§ 6). |

How the two Limns read each other:

- **A teammate's posted review is imported** into your Limn as their review — read-only, attributed
  to them. Findings show who raised them ("You", "Robin", "You and Robin"); the same point found by
  both shows once. You cannot reword or ignore their finding; the one write offered is **Post
  reminder**, which posts the point again as you.
- **The reviewer follows up on the author's own review** when it is the latest review: the author's
  points are checked like earlier findings, and nothing they raised is posted again.
- **A teammate's review is followed up** while their "changes requested" still stands on GitHub.
- **Own PR** means the PR's author login is yours. PRs opened by bots get no auto review and no
  automatic posting (a "Review and post" you press still posts). Drafts get no auto review, no
  automatic posting and no still-open writes; "Resolve my Limn threads" does act on your own drafts.
- **⚠ The author's own threads may stay open.** When a reviewer's Limn has the commit, the author's
  Limn steps aside, so no author run happens and "Resolve my Limn threads" never fires; the
  reviewer's Limn never resolves a teammate's thread (gap 13).
- **Teammates' Limn posts wake your Limn.** A teammate's Limn findings count as review-bot comments,
  so a new teammate review can start a Check threads pass on every other Limn (within the 30 a day).

---

## 5. Verdicts and approvals

Automatic posts use the reader's settings. With **"Approve or request changes for me"** on (the
default), the posted verdict is chosen like this:

```mermaid
flowchart TD
  S[Run finished] --> B{Any open blocker?}
  B -- yes --> RC[Request changes]
  B -- no --> W{Open warning?}
  W -- yes --> C[Comment]
  W -- no --> M{Did the model approve?<br/>pair: both, unless set to relaxed}
  M -- no --> C
  M -- yes --> L{Open nits/questions allowed by<br/>'Approve with open findings'?}
  L -- no --> C
  L -- yes --> AP[Approve]
  RC --> G{Gates}
  AP --> G
  G -- "own PR · your own review still stands ·<br/>couldn't read GitHub · impact not allowed (approve only) ·<br/>GitHub refused" --> C
  G -- clear --> SEND[Sent as chosen]
```

- **Your own standing review wins.** If you approved or requested changes by hand, Limn never
  overrides it; it posts a comment. Limn's own earlier automatic verdict does not count as yours.
- **Impact:** an approval can be limited by the PR's impact level (all levels allowed by default;
  unknown impact counts as High). Requesting changes is never limited by impact.
- **One post per run**, recorded before writing, never retried. If GitHub refuses the verdict, the
  same review goes once more as a plain comment.
- **What is posted by default:** blockers, warnings, questions, CI failures, story gaps and
  SonarCloud results. Nits are not. Nothing already on GitHub is posted again.
- **The replies pass can change the verdict** (§ 7): a disputed blocker can turn into "request
  changes"; once everything is settled it can approve, through the same gates.
- **Which PRs:** by default "mine" — your own PRs, PRs you are or were asked to review, or PRs you
  already reviewed or commented on. A request to a GitHub team does not count.

### The "Not approved" line

When the verdict is not an approval, the review ends with one line saying why. The first match wins:

| Situation | Line |
|---|---|
| Blockers or warnings open | "Not approved: 2 warnings are still open." |
| A model asked for changes | "Not approved: Codex asked for changes. <its first sentence>" |
| A model only commented | "Not approved: Claude left a comment, not an approval. No findings are open." (or "A nit is still open." / "1 earlier point is still open.") |
| Pair, neither approved | "Not approved: neither Claude nor Codex approved. No findings are open." |
| Leftovers not allowed | "Not approved: a question is still open." |
| Gates | "your own pull request." · "your own review on GitHub still stands." · "the earlier request for changes still stands." · "High impact." · "couldn't read the earlier reviews on GitHub." · "GitHub refused it." |

The own-PR, own-review, couldn't-read and refused reasons show in Limn only. If a review has nothing
else to post, the line goes out alone as one short comment, at most once per PR and commit — but
never while you still have an open review request on the PR (any review would answer the request).

**A review may not claim an open point it never recorded.** If Limn records nothing as still open,
any sentence in the summary claiming one is removed before posting.

### When Limn takes its approval back

```mermaid
sequenceDiagram
  participant R as Robin's Limn
  participant GH as GitHub
  participant A as Alex (author)
  R->>GH: Approve at commit A
  A->>GH: Push commit B
  Note over GH: The repo's own rule decides:<br/>"dismiss stale approvals" on → GitHub dismisses it<br/>off → the approval stands
  R->>GH: Auto review of B finds 2 warnings
  R->>GH: Dismiss its own approval:<br/>"Limn withdrew its approval: 2 warnings found at B."
  R->>GH: Comment review with the 2 warnings
```

- **A push alone never makes Limn withdraw anything** (since 1.0.1). Each repo's own branch rule or
  ruleset decides, per branch, and GitHub does the dismissing.
- **A later review that does not approve** withdraws Limn's earlier automatic approval first, once,
  only on the posting path (an automatic run with posting on, or "Review and post"). A run at the
  same commit never withdraws.
- **Never touched:** an approval you gave by hand, one you sent with the Post button, or anyone
  else's approval.
- **How Limn reads a dismissal:** a reviewer's newest verdict-type review decides their standing,
  and a dismissed one counts as nothing. "Changes requested → approved → approval dismissed" reads
  as no verdict, matching GitHub's "review required" (since 1.0.2).

### Lifting "changes requested"

- **Your own Limn's block** is lifted by your next run that finds no blocker: an approval replaces
  it, or it is dismissed with "Claude's blocking findings are fixed." No setting needed.
- **A teammate's Limn block** is lifted only with consent from both people (both off by default).
  Consent rides each post made after ticking; a post sent with the Post button never carries it.

| Robin ticks | Alex ticks | Then |
|---|---|---|
| "Let a teammate's Limn dismiss my Limn's 'changes requested' once every point is fixed" | "Dismiss a teammate's Limn 'changes requested' once every point is fixed" | When Alex's run at the PR's latest commit finds every point behind Robin's block fixed and no blocker of its own, Alex's Limn posts its review, then dismisses Robin's block: "Limn (alex) checked all 3 points are addressed at 70cc9b5." Once, never retried. |

Never dismissed by this: any approval, a review typed by hand, a review sent with the Post button.

---

## 6. Threads: checking earlier comments

### What Limn knows about a thread

| State | Meaning |
|---|---|
| Resolved | GitHub says so. |
| Likely addressed | A commit touched the file after the last comment, or GitHub marked it outdated. **A guess**, and shown as one. |
| Replied | Someone other than the opener replied, with no later change. |
| Untouched | No reply, no later change. |

Once a Limn review has judged a thread, its card shows that judgement instead: two pills for a
comment ("Holds up / Partly / Doesn't hold" and "Addressed / Partly addressed / Open"), or one
outcome pill for a Limn finding ("Not addressed"). Newest judgement wins. A Limn's own "Still open:"
reply never counts as a reply.

### How a later review judges earlier comments

- **Your own Limn's findings** get a follow-up: addressed, partly addressed, not addressed, no longer
  applies, reply accepted, reply disputed — or "not checked", carried to the next review. Limn never
  invents "addressed". Partly / not addressed / disputed are raised again, linked to the original.
- **Everyone else's comments** (a teammate's Limn, a person, another review bot) get two answers:
  is the point valid, and is it addressed. Resolved threads are judged too — resolving is only a click.
- The posted review's hidden marker carries its judgements of **Limn findings** (addressed, not
  addressed, no longer applies, still open) and "still open" on any other thread — at most 50. Whether
  a person's point "holds up" is never shared; teammates see only the "Still open:" replies.

### Still-open points: every open point has a place

A review that thinks an earlier point is still open must say **where**, on GitHub, so the author can act.

```mermaid
flowchart TD
  J[A posted review judges an earlier thread<br/>valid and not addressed] --> T{Thread state?}
  T -- unresolved --> R1["Reply once per commit:<br/>'Still open: <reason>'"]
  T -- resolved, never reopened --> R2["Reply 'Still open: <reason>'<br/>then reopen the thread (once, ever)"]
  T -- resolved again after one reopen --> S{Severity}
  S -- warning or blocker --> N["Start ONE new thread that links<br/>the earlier one (once, ever)"]
  S -- nit, question, or a person's comment --> X[Leave it]
```

- Written only when the review is posted (automatic with posting on, or "Review and post"), and only
  if the PR has not moved past the reviewed commit. Never on another review bot's thread.
- "Once" is known to every Limn: the hidden marker on the reply records the commit and the reopen.
  Every write is recorded before it happens and never retried.
- A point already answered by a pushback (§ 7) is skipped — the pushback said it.
- **What the author sees:** a "Robin's Limn: still open" pill on the thread, a "Still open (N)" list
  in the Overview's AI review card, and a My Turn card "Robin's Limn: still open on src/x.ts" while the
  thread is unresolved, until they reply, push or resolve. (Needs AI on in the author's Limn. A
  continuation thread gets no card — gap 8.)

### Resolving

Limn resolves **only its own reader's Limn findings**, never a teammate's or a person's thread:

| Setting | Default | When | Reply |
|---|---|---|---|
| "Resolve my Limn threads when addressed" | On | Your own PR, after any of your runs | "Addressed in abc1234." / "No longer applies as of abc1234." — "_Resolved by Limn's Claude review._" |
| "Resolve Limn's threads once fixed" | Off | Any PR, automatic runs with posting on | Same wording, with the automatic-post footer |

---

## 7. Replies and pushback

When the author answers one of your Limn's findings, your Limn judges the reply without waiting for a
full review: the **replies pass**. It starts after 5 quiet minutes (automatic, at most 5 a day per
PR, within the spend budget) or when you press "Check replies". It is cheap (a smaller model, a hard
cost cap) and never runs while a full review is running.

```mermaid
flowchart TD
  P[Author replies to a Limn finding] --> Q[Replies pass judges the reply]
  Q -- "accepted: the finding was wrong,<br/>or a reasonable follow-up" --> RS{Resolving allowed here?}
  RS -- yes --> AC["Acknowledge in one sentence, then resolve"]
  RS -- no --> NONE["Nothing posted; settled in Limn"]
  Q -- "disputed (a blocker can never be deferred)" --> PB["One pushback, ever, per thread,<br/>in the model's words. Thread stays open"]
  PB --> P2[Author replies again] --> Q2[Next pass may accept;<br/>a second dispute posts nothing]
```

- **What counts as a person's answer:** a reply with text by a person, without any Limn marker.
- **An accepted reply settles the finding for good**: it is never raised again. Its acknowledgement
  goes out only as the resolve reply, so on a teammate's PR with "Resolve Limn's threads once fixed"
  off (the default) nothing is posted. The acknowledgement and pushback are the model's own sentence;
  the fallbacks are "Thanks for explaining. That makes sense." and "Thanks for the reply. I still
  think this needs changing in this pull request."
- **Pushback** goes only on automatic runs with posting on, on an unresolved thread, from your
  account, once per thread ever. Limn never resolves after a pushback. Manual runs show a draft with
  "Post reply" instead.

---

## 8. Whose turn is it?

| Thing | Waits on | Ends when |
|---|---|---|
| An unanswered review thread | **The PR author** — never the person who opened it | The author replies, pushes a fix, or resolves |
| A still-open point | The PR author | Same, judged at the current commit |
| An outstanding review request | The requested reviewer | They review |
| A Limn finding, reminder or "Still open:" reply | Nobody — stored as "Limn · alex", never as the person | — |
| A Limn pushback, acknowledgement or resolve reply | ⚠ Stored as the person today, so it can count as their reply (gap 1) | — |

The Slack digest and the Pending board word threads this way: "Comment on src/x.ts waiting on the
author"; "Alex's comment on package.json has no reply · waiting on Robin".

---

## 9. Worked examples

All names and times are illustrative; every step follows the current rules.

### 9.1 Two reviewers share a new PR
1. 09:00 Carol opens PR #12. Alex and Bob both have auto review on (Claude + Codex).
2. 09:01 Alex's Limn finds no lines, posts "alex is reviewing with Claude" and "…with Codex", and starts.
3. 09:03 Bob's Limn sees both live claims and steps aside: "Alex is reviewing this commit with Claude". No allowance spent.
4. 09:14 Alex's pair posts one review; lines become "alex reviewed · 3 comments" / "· 2 comments".
5. 09:15 Bob's Limn imports Alex's review. Bob's AI Review tab shows Alex's review with each finding marked "Alex".

### 9.2 A race splits the pair
1. 10:00 Dana pushes commit B. Alex's Limn and Bob's Limn both treat it as due.
2. 10:01:10.2 Alex claims Claude; 10:01:10.8 Bob claims Claude. Alex's line is earlier: Bob stands down on Claude.
3. Bob's Limn claims Codex before Alex's Codex half does, and runs Codex alone.
4. Alex's review says "Codex didn't finish: a teammate's Limn is reviewing with Codex". The commit gets one Claude review (Alex) and one Codex review (Bob). Nothing is duplicated.

### 9.3 A laptop closes mid-review
1. 15:00 Bob's Limn claims commit C; 15:08 renews; 15:10 Bob closes his laptop.
2. 15:02 Alex's Limn steps aside, and checks again at 15:25:30 — Bob's 15:08 renewal is still live.
3. 15:34 Bob's lease has run out. Alex's Limn claims and reviews.
4. If instead Bob's review had reached GitHub but his final line had not, Alex's Limn would treat it as reviewed as soon as it synced it — no 25-minute wait.

### 9.4 The author reviews first, then a reviewer
1. 10:00 Carol opens #10; her own Limn reviews and posts a comment with 2 warnings, ending "Not approved: 2 warnings are still open." (Had it wanted to approve, "Not approved: your own pull request." would show in her Limn only.)
2. Alex's Limn ignores Carol's claim (she is the author) and reviews, following up on Carol's 2 warnings. It finds one new nit, which is not posted; on each of Carol's two open warning threads it replies "**Still open:** …".
3. Carol pushes a fix. Alex's Limn claims the new commit first; Carol's Limn steps aside, so it never runs and her two threads stay open on GitHub (gap 13).
4. Alex's run judges both warnings addressed; with no blocker or warning open and the impact allowed, Alex's Limn approves. Carol resolves her threads herself.

### 9.5 Your PR, a teammate on Claude, your Codex at its limit
1. Robin's Limn reviews your commit with Claude and posts.
2. Your Limn would run Codex, but Codex is at its usage limit until Monday. It runs nothing.
3. You see Robin's review in your AI Review tab. When the limit lifts, your Limn looks again within 30 minutes and runs Codex on the current commit, since Claude still reads as reviewed by Robin.

### 9.6 Approval, push, and GitHub's rule
1. Robin's Limn approves your PR at commit A.
2. You push commit B. Your repo keeps approvals after a push, so the approval stands. (In a repo that dismisses stale approvals, GitHub dismisses it.)
3. Robin's Limn reviews B and finds 2 warnings. It withdraws its own approval ("Limn withdrew its approval: 2 warnings found at B."), then posts a comment with the warnings.
4. Your header shows Robin's standing as dismissed, which counts as nothing, and GitHub's "review required".

### 9.7 Pushback, then agreement
1. Alex's Limn posts a warning on Bob's PR: "this can be null".
2. Bob replies: "Can't be null; upstream validates."
3. Five quiet minutes later Alex's replies pass disputes it and posts one pushback from Alex's account. The thread stays open.
4. Bob replies with a link to the upstream check. The next pass accepts. If Alex's workspace has "Resolve Limn's threads once fixed" on, Alex's Limn posts a one-sentence acknowledgement and resolves the thread; with it off (the default) nothing is posted and the finding is settled in Alex's Limn.
5. Had it disputed again, Limn would post nothing more; the point would be raised again in the next full review.

### 9.8 Resolved too early: reopen once, then a new thread
1. Robin's Limn posts a warning on Bob's PR. Bob resolves it without fixing anything.
2. Alex's automatic review (posting on) at commit H1 judges it valid and not addressed: it replies "**Still open:** the null check is still missing in parse()" and reopens the thread.
3. Bob resolves it again.
4. Robin's review at H2 sees the thread was reopened once already. It is a warning, so it starts one new thread that links the old one. Alex's Limn sees that and does nothing more.
5. Between steps 2 and 3, while the thread was open, Bob's My Turn showed "Alex's Limn: still open on src/parse.ts". The new thread from step 4 is an ordinary open finding; it raises no still-open card (gap 8).

### 9.9 A teammate's block is lifted
1. Carol's Limn requests changes on Bob's PR (1 blocker, 1 warning). Carol has ticked "Let a teammate's Limn dismiss my Limn's 'changes requested'…".
2. Bob fixes both. Alex has ticked "Dismiss a teammate's Limn 'changes requested'…".
3. Alex's run at Bob's latest commit judges both points fixed and finds no blocker. It posts Alex's review, then dismisses Carol's block: "Limn (alex) checked all 2 points are addressed at 70cc9b5."
4. Without Carol's tick, her block stays; Alex's approval could still go out.

### 9.10 A person's question
1. Carol asks a question on Bob's PR. Alex's posted review judges it valid and not addressed and replies "**Still open:** …".
2. The thread still reads as untouched (a Limn reply is not a reply). Bob gets "Alex's Limn: still open" in My Turn.
3. If Bob resolves it and it is reopened once and resolved again, it is left alone: a person's comment has no severity, so no new thread.

---

## 10. What Limn never does

- Approve or request changes on the reader's own PR.
- Override a review the reader gave by hand, or anything sent with the Post button.
- Withdraw an approval because of a push alone.
- Dismiss anyone's approval to lift a block; dismiss a review typed by hand.
- Edit or delete a teammate's comment, or resolve a teammate's or a person's thread.
- Reopen a thread more than once, or post more than one pushback per thread.
- Retry a GitHub write that failed — except its own status lines (up to 5 tries) and a refused
  verdict, which is sent once more as a plain comment.
- Treat its findings, reminders or "Still open:" replies as a person's reply (pushbacks and
  resolve replies still can — gap 1).
- Count its `limn/` status lines as CI.
- Show a teammate anything that was kept in Limn.

---

## 11. Settings that shape team behaviour

All are per workspace, in Settings → Auto review, except where noted.

| Setting | Default | Effect |
|---|---|---|
| Review new PRs automatically | Off | Reviews PRs a person opens after it is switched on. |
| Auto reviews a day | 20 | Daily cap (1–500). |
| Auto reviews use | Claude + Codex when both signed in | One merged review. |
| When Claude and Codex disagree | Strict | Strict: both must approve. Relaxed: one approves, neither asks for changes. |
| Mark auto reviews on GitHub (claims) | On | Status lines; the team shares the work per model. |
| When an auto review finishes | Post to GitHub | Or keep it in Limn (invisible to teammates). |
| Which PRs | Mine | Or every PR. |
| What to post | Blockers, warnings, questions, CI failures, story gaps, SonarCloud | Nits and "not asked for" off. |
| Approve or request changes for me | On | Off means every post is a comment. |
| Approve at High / Medium / Low impact | All on | An unticked level gets a comment. |
| Approve with open findings | Nits and questions | Or nits only, or nothing. |
| Resolve Limn's threads once fixed | Off | Any PR, automatic runs with posting on. |
| Resolve my Limn threads when addressed | On | Your own PRs, any run. |
| Let a teammate's Limn dismiss my Limn's "changes requested"… | Off | Consent on the blocked side. |
| Dismiss a teammate's Limn "changes requested"… | Off | The lifting side. |
| Auto AI Fix on your own PRs / Push automatically | Off / Off | Fix after an auto review; push only if allowed. |

---

## 12. Mixed versions

Every rule is written so an older Limn on the team stays safe, but older Limns behave as they did:

| A teammate on… | Still does |
|---|---|
| before 1.0.1 | Withdraws its own automatic approval on every push while its "Withdraw Limn's approval when new commits are pushed" setting is on — the default (0.1.182–1.0.0); waits out the 25-minute lease even when a review is already posted. |
| before 1.0.2 | Shows a reviewer as "requested changes" after their later approval was dismissed. |
| before 1.0.3 | Writes no "Still open:" replies, never reopens, may claim an open point it never recorded. Reads a new "still open" judgement as "not addressed". |
| before 0.1.181 | Writes no thread judgements or lift consent. |
| before 0.1.175 | Shows no teammates' reviews at all, and lets the PR author's claim hold the commit. |
| before 0.1.174 | Reads a teammate's "kept in Limn" line as reviewed and stands down. |

The Limn version rides every posted review's marker but nothing acts on it yet.

---

## 13. Known gaps and open decisions

Confirmed in the code on 2026-11-05. Each is a candidate for the next change; update this list when one is settled.

| # | Gap | Effect |
|---|---|---|
| 1 | Pushbacks, acknowledgements and resolve replies are stored as the person, not as their Limn. | In My Turn they can count as that person's reply: on the poster's machine they end the thread card; on a third person's machine they can raise a "reply in a thread you commented in" card. |
| 2 | A **resolved** thread whose reply Limn disputes gets nothing on GitHub (pushback skips resolved threads; still-open skips disputed points). | The disagreement shows only in the reviewer's Limn. Breaks "every open point has a place". |
| 3 | Two Limns acting at the same commit before either has synced the other. | Could both reply "Still open" or both reopen once. |
| 4 | Manual reviews never claim. | A teammate's manual review does not stop your automatic one. |
| 5 | A very late "Cleared by…" from a crashed run is posted without reading first. | Could free a commit a teammate has since finished (inferred, not tested). |
| 6 | The Clear button for a teammate's claim relies on memory. | Missing after a restart until the next read. |
| 7 | Approval withdrawal runs only on the posting path. | With "keep it in Limn", a later failing review does not withdraw an earlier automatic approval. |
| 8 | The continuation thread (after one reopen) is not tracked as a finding. | Later runs keep following the original thread, and the author gets no still-open card for it. |
| 9 | Two teammates pointing their Slack digest at one channel. | Both post (inferred). |
| 10 | The Limn version in the marker is never used. | No warning that a teammate is on an old version. |
| 11 | A `limn/` status line made a required check in branch protection. | An unfinished line would block merges. Do not make them required. |
| 12 | "Kept in Limn" is written whenever none of a model's findings were posted — even when an approval or a reason-only comment did reach GitHub. | The commit reads free, so teammates review it again. |
| 13 | On the author's own PR, a reviewer's claim makes the author's Limn step aside, and only the author's Limn may resolve its own threads. | The author's fixed Limn threads stay open until the author resolves them by hand. |
| **D1** | **Open decision:** should a still-open warning or blocker stop an approval? | Today a review can approve and still mark an earlier point open. |
| **D2** | **Open decision:** should still-open replies and reopens happen on the reader's own PR? | Today they do. |
