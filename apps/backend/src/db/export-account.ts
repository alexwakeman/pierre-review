import { eq, inArray } from 'drizzle-orm';
import { db, schema } from './client.js';

// ---------------------------------------------------------------------------
// Right of access + data portability (UK/EU GDPR Arts. 15 and 20).
//
// One JSON document containing everything the server holds for one account, in a
// "commonly used, machine-readable format" as Art. 20 requires. Deliberately built from
// explicit column lists rather than `select()` so that:
//
//   • the sealed GitHub token can NEVER appear in the output. `accounts.accessTokenEnc` is
//     encrypted, but an export is a file a user emails around and drops in cloud storage —
//     shipping even a sealed credential in it would be a self-inflicted key-exposure risk,
//     and it is not personal data the subject needs. Same for `stripeCustomerId` beyond the
//     fact a subscription exists.
//   • adding a column to a table cannot silently widen the export.
//
// Scope note: the export includes the third-party GitHub activity synced into this account
// (other people's comments and logins). That is correct — it is the data held in connection
// with this account, and the subject is entitled to see what is there — but it means an
// export can contain other people's personal data, which is why the download is
// same-origin-only, behind the session, and rate-limited like every other route.
// ---------------------------------------------------------------------------

const {
  accounts,
  repos,
  pullRequests,
  reviews,
  reviewThreads,
  reviewComments,
  prComments,
  events,
  workspaces,
  workspaceRepos,
  workspaceExternalRepos,
  workspaceReviewers,
  aiUsage,
  benchmarkContributions,
  autoMergeRequests,
} = schema;

/** Cap per collection. An export must not be a way to ask the server to build a 2 GB string;
 *  the caps are far above a normal account and the response records where one bit. */
const EXPORT_ROW_CAP = 50_000;

interface Truncation {
  collection: string;
  cap: number;
}

export interface AccountExport {
  meta: {
    generatedAt: string;
    format: 'pierre-account-export';
    formatVersion: 1;
    /** Which collections hit the row cap (empty in the normal case). */
    truncated: Truncation[];
    notes: string[];
  };
  account: Record<string, unknown>;
  repositories: Record<string, unknown>[];
  /**
   * The account's workspaces, each with the repo ids that belong to it. Replaces the old `teams`
   * collection: a repo now sits in exactly one workspace, so `repoIds` is a partition of
   * `repositories` rather than an arbitrary many-to-many slice.
   */
  workspaces: Record<string, unknown>[];
  pullRequests: Record<string, unknown>[];
  reviews: Record<string, unknown>[];
  reviewThreads: Record<string, unknown>[];
  reviewComments: Record<string, unknown>[];
  prComments: Record<string, unknown>[];
  events: Record<string, unknown>[];
  aiUsage: Record<string, unknown>[];
  /**
   * THE BOT OBJECT — one row per (workspace, automated reviewer), replacing the old
   * `repoReviewers` + `accountReviewers` pair now that judgement, identity and price share a key.
   *
   * IT IS IN THE EXPORT DELIBERATELY, and this comment is the record of that decision. Art. 15
   * covers it three times over: `automated`/`role` are classification DECISIONS made about the
   * subject's data (some of them by the subject — `source: 'manual'`), `kind`/`label` are a vendor
   * name the subject may have typed, and `monthlyCents` is a PRICE the subject entered by hand and
   * that nothing else in the system can regenerate. It is the one collection here that is not a
   * cache of GitHub. There is no credential on the table, so nothing is withheld from it.
   * (Contrast `branchCommits`, which is absent from this export with no decision recorded
   * anywhere — an omission, not a choice. This one is a choice.)
   */
  workspaceReviewers: Record<string, unknown>[];
  benchmarkContributions: Record<string, unknown>[];
  /** Armed / recently-resolved "merge when ready" intents (auto_merge_requests). */
  autoMergeRequests: Record<string, unknown>[];
  /**
   * Each workspace's issue tracker (core `workspace_trackers`, migration 0088 / pg 0075) — the
   * provider, base URL, project keys and match scope the user TYPED, and the Jira email. ⚠ The API
   * TOKEN IS WITHHELD (`hasToken` only), exactly like the GitHub token on `account`: a credential,
   * sealed or not, never leaves in an export. The stored tickets are not exported: they are a cache
   * of the customer's tracker, regenerable from it.
   */
  workspaceTrackers: Record<string, unknown>[];
  /**
   * Each workspace's SonarCloud settings (core `workspace_sonar`, migration 0114 / pg 0101): the
   * organization and project-key overrides the user TYPED. ⚠ THE TOKEN IS WITHHELD (`hasToken`
   * only), like every credential here. The snapshots are not exported: a cache of SonarCloud's
   * analysis, regenerable from it.
   */
  workspaceSonar: Record<string, unknown>[];
  /**
   * The reference library (core `reference_docs`, migration 0116 / pg 0103): each document's
   * metadata, summary, topics and section list. The text itself lives as markdown files under the
   * data directory, built from the user's own upload, and is not repeated here.
   */
  referenceDocs: Record<string, unknown>[];
  /** The docs chat: the questions the user typed and the answers (`reference_doc_chat_messages`). */
  referenceDocChatMessages: Record<string, unknown>[];
  /** Wiki documents' pages (core `reference_doc_wiki_pages`, migration 0140): ids, titles, versions. */
  referenceDocWikiPages: Record<string, unknown>[];
  /** Each workspace's wiki credential (migration 0140): site and email. ⚠ THE TOKEN IS WITHHELD. */
  workspaceWikiCredentials: Record<string, unknown>[];
  /** The image-description cache (core `reference_doc_figure_descriptions`, migration 0143). */
  referenceDocFigureDescriptions: Record<string, unknown>[];
  /** Docs folders found in the repositories and the reader's answer to each (core
   *  `reference_doc_repo_offers`, migration 0155): folder, counts, offered / declined / added. */
  referenceDocRepoOffers: Record<string, unknown>[];
  /**
   * Related repos (core `repo_relations`, migration 0131): the pairs the user chose, both directions,
   * per workspace.
   */
  repoRelations: Record<string, unknown>[];
  /** Sandbox "Always allow" hosts (core `sandbox_allowed_hosts`, migration 0173): per workspace. */
  sandboxAllowedHosts: Record<string, unknown>[];
  /** Sandbox workspace settings (core `sandbox_workspace_settings`, migrations 0174 + 0175): per workspace. */
  sandboxWorkspaceSettings: Record<string, unknown>[];
  /**
   * This Sprint's "needs code" judgements (core `sprint_code_judgements`, migration 0132): a model's
   * yes/no and one short reason per not-started ticket, per workspace.
   */
  sprintCodeJudgements: Record<string, unknown>[];
  /**
   * "Implement story" sessions (core `story_builds`, migration 0149): the ticket, the plan the reader
   * steered, the chat they typed, the docs decisions they made, spend. The frozen prompt seed is NOT
   * exported (it is the ticket's own text re-assembled, regenerable from the tracker).
   */
  storyBuilds: Record<string, unknown>[];
  /**
   * Each session's repositories (`story_build_repos`): base, branch, change report, tests, the push —
   * and the PATCH, which is the reader's own work, cut at STORY_BUILD_EXPORT_PATCH_MAX characters
   * (`patchTruncated` says so).
   */
  storyBuildRepos: Record<string, unknown>[];
  /** Plan first (0179): every plan revision, the reader's decisions and replies (`story_build_plans`). */
  storyBuildPlans: Record<string, unknown>[];
  /** Plan first: the planned pull requests and their pushes; the patch cut as `storyBuildRepos`'s. */
  storyBuildPrs: Record<string, unknown>[];
  /** The review loop (0186): every review run, its findings with the agent's answers, the story checks,
   *  the agent's criterion answers and every GitHub write the loop claimed. */
  storyBuildReviews: Record<string, unknown>[];
  storyBuildReviewFindings: Record<string, unknown>[];
  storyBuildStoryChecks: Record<string, unknown>[];
  storyBuildAcResponses: Record<string, unknown>[];
  storyBuildLoopPushes: Record<string, unknown>[];
}

/** A stored story-build patch is exported up to this many characters. */
const STORY_BUILD_EXPORT_PATCH_MAX = 256 * 1024;

/** Build the full export document for one account. Returns null if the account is gone. */
export async function exportAccountData(accountId: number): Promise<AccountExport | null> {
  const truncated: Truncation[] = [];
  const capped = <T>(collection: string, rows: T[]): T[] => {
    if (rows.length > EXPORT_ROW_CAP) {
      truncated.push({ collection, cap: EXPORT_ROW_CAP });
      return rows.slice(0, EXPORT_ROW_CAP);
    }
    return rows;
  };

  const accountRows = await db
    .select({
      id: accounts.id,
      githubUserId: accounts.githubUserId,
      githubLogin: accounts.githubLogin,
      displayName: accounts.displayName,
      avatarUrl: accounts.avatarUrl,
      isLocal: accounts.isLocal,
      plan: accounts.plan,
      // Deliberately NOT exported: accessTokenEnc (a credential, even sealed) and
      // stripeCustomerId (Stripe's own identifier — request billing data from Stripe).
      hasStoredGithubToken: accounts.accessTokenEnc,
      aiCreditAllowance: accounts.aiCreditAllowance,
      benchmarkOptIn: accounts.benchmarkOptIn,
      largePrCodeLocThreshold: accounts.largePrCodeLocThreshold,
      blastRadiusConfig: accounts.blastRadiusConfig,
      myTurnSettings: accounts.myTurnSettings,
      featureSettings: accounts.featureSettings,
      featuresExistingInstall: accounts.featuresExistingInstall,
      reviewSuggestionDismissedAt: accounts.reviewSuggestionDismissedAt,
      aiBudgetSettings: accounts.aiBudgetSettings,
      aiBudgetReading: accounts.aiBudgetReading,
      lastLoginAt: accounts.lastLoginAt,
      lastActiveAt: accounts.lastActiveAt,
      createdAt: accounts.createdAt,
    })
    .from(accounts)
    .where(eq(accounts.id, accountId))
    .limit(1)
    .execute();
  const account = accountRows[0];
  if (!account) return null;

  const repoRows = await db
    .select()
    .from(repos)
    .where(eq(repos.accountId, accountId))
    .execute();

  const prRows = capped(
    'pullRequests',
    await db.select().from(pullRequests).where(eq(pullRequests.accountId, accountId)).execute(),
  );
  const prIds = prRows.map((p) => p.id);

  // The child tables reach their account through prId. An account with no PRs short-circuits
  // to empty arrays rather than issuing an `IN ()`.
  const childRows = async <T>(
    fn: (ids: number[]) => Promise<T[]>,
  ): Promise<T[]> => (prIds.length === 0 ? [] : fn(prIds));

  // The tracker rows — explicit columns, the token reduced to its presence below.
  const trackerRows = await db
    .select({
      workspaceId: schema.workspaceTrackers.workspaceId,
      provider: schema.workspaceTrackers.provider,
      baseUrl: schema.workspaceTrackers.baseUrl,
      projectKeys: schema.workspaceTrackers.projectKeys,
      matchScope: schema.workspaceTrackers.matchScope,
      email: schema.workspaceTrackers.authEmail,
      hasToken: schema.workspaceTrackers.authToken,
      // The Notion property mapping (not a secret).
      notionConfig: schema.workspaceTrackers.notionConfig,
      updatedAt: schema.workspaceTrackers.updatedAt,
    })
    .from(schema.workspaceTrackers)
    .where(eq(schema.workspaceTrackers.accountId, accountId))
    .execute();

  // The SonarCloud rows — explicit columns, the token reduced to its presence below.
  const sonarRows = await db
    .select({
      workspaceId: schema.workspaceSonar.workspaceId,
      organization: schema.workspaceSonar.organization,
      projectKeys: schema.workspaceSonar.projectKeys,
      hasToken: schema.workspaceSonar.authToken,
      updatedAt: schema.workspaceSonar.updatedAt,
    })
    .from(schema.workspaceSonar)
    .where(eq(schema.workspaceSonar.accountId, accountId))
    .execute();

  // The reference library's metadata and the docs chat.
  const referenceDocRows = await db
    .select({
      id: schema.referenceDocs.id,
      workspaceId: schema.referenceDocs.workspaceId,
      slug: schema.referenceDocs.slug,
      title: schema.referenceDocs.title,
      sourceKind: schema.referenceDocs.sourceKind,
      sourceName: schema.referenceDocs.sourceName,
      sourceUrl: schema.referenceDocs.sourceUrl,
      byteSize: schema.referenceDocs.byteSize,
      status: schema.referenceDocs.status,
      summary: schema.referenceDocs.summary,
      topics: schema.referenceDocs.topics,
      sections: schema.referenceDocs.sections,
      wiki: schema.referenceDocs.wiki,
      createdAt: schema.referenceDocs.createdAt,
      builtAt: schema.referenceDocs.builtAt,
    })
    .from(schema.referenceDocs)
    .where(eq(schema.referenceDocs.accountId, accountId))
    .execute();
  // Wiki sources (migration 0140): the pages of each wiki document, and the wiki credential WITHOUT its token.
  const wikiPageRows = await db
    .select({
      docId: schema.referenceDocWikiPages.docId,
      pageId: schema.referenceDocWikiPages.pageId,
      title: schema.referenceDocWikiPages.title,
      version: schema.referenceDocWikiPages.version,
      lastEditedAt: schema.referenceDocWikiPages.lastEditedAt,
      lastFetchedAt: schema.referenceDocWikiPages.lastFetchedAt,
    })
    .from(schema.referenceDocWikiPages)
    .where(eq(schema.referenceDocWikiPages.accountId, accountId))
    .execute();
  const wikiCredentialRows = await db
    .select({
      workspaceId: schema.workspaceWikiCredentials.workspaceId,
      provider: schema.workspaceWikiCredentials.provider,
      siteUrl: schema.workspaceWikiCredentials.siteUrl,
      email: schema.workspaceWikiCredentials.authEmail,
      hasToken: schema.workspaceWikiCredentials.authToken,
      updatedAt: schema.workspaceWikiCredentials.updatedAt,
    })
    .from(schema.workspaceWikiCredentials)
    .where(eq(schema.workspaceWikiCredentials.accountId, accountId))
    .execute();
  const figureRows = await db
    .select({
      imageHash: schema.referenceDocFigureDescriptions.imageHash,
      description: schema.referenceDocFigureDescriptions.description,
      model: schema.referenceDocFigureDescriptions.model,
      createdAt: schema.referenceDocFigureDescriptions.createdAt,
    })
    .from(schema.referenceDocFigureDescriptions)
    .where(eq(schema.referenceDocFigureDescriptions.accountId, accountId))
    .execute();
  const repoOfferRows = await db
    .select({
      workspaceId: schema.referenceDocRepoOffers.workspaceId,
      repoId: schema.referenceDocRepoOffers.repoId,
      path: schema.referenceDocRepoOffers.path,
      docCount: schema.referenceDocRepoOffers.docCount,
      wordEstimate: schema.referenceDocRepoOffers.wordEstimate,
      tooLarge: schema.referenceDocRepoOffers.tooLarge,
      state: schema.referenceDocRepoOffers.state,
      docId: schema.referenceDocRepoOffers.docId,
      detectedAt: schema.referenceDocRepoOffers.detectedAt,
      decidedAt: schema.referenceDocRepoOffers.decidedAt,
    })
    .from(schema.referenceDocRepoOffers)
    .where(eq(schema.referenceDocRepoOffers.accountId, accountId))
    .execute();
  const docChatRows = await db
    .select({
      workspaceId: schema.referenceDocChatMessages.workspaceId,
      conversationId: schema.referenceDocChatMessages.conversationId,
      role: schema.referenceDocChatMessages.role,
      content: schema.referenceDocChatMessages.content,
      createdAt: schema.referenceDocChatMessages.createdAt,
    })
    .from(schema.referenceDocChatMessages)
    .where(eq(schema.referenceDocChatMessages.accountId, accountId))
    .execute();

  // Related repos — the pairs the user chose (both directions as stored).
  const repoRelationRows = await db
    .select({
      workspaceId: schema.repoRelations.workspaceId,
      repoId: schema.repoRelations.repoId,
      relatedRepoId: schema.repoRelations.relatedRepoId,
      createdAt: schema.repoRelations.createdAt,
    })
    .from(schema.repoRelations)
    .where(eq(schema.repoRelations.accountId, accountId))
    .execute();

  // Sandbox "Always allow" hosts — the rules the user allowed, per workspace.
  const sandboxHostRows = await db
    .select({
      workspaceId: schema.sandboxAllowedHosts.workspaceId,
      rule: schema.sandboxAllowedHosts.rule,
      createdAt: schema.sandboxAllowedHosts.createdAt,
    })
    .from(schema.sandboxAllowedHosts)
    .where(eq(schema.sandboxAllowedHosts.accountId, accountId))
    .execute();

  // Sandbox workspace settings — the local folder, memory choices and resources, per workspace.
  const sandboxSettingRows = await db
    .select({
      workspaceId: schema.sandboxWorkspaceSettings.workspaceId,
      localFolder: schema.sandboxWorkspaceSettings.localFolder,
      memoryProjectsJson: schema.sandboxWorkspaceSettings.memoryProjectsJson,
      userClaudeMd: schema.sandboxWorkspaceSettings.userClaudeMd,
      userSkills: schema.sandboxWorkspaceSettings.userSkills,
      startDir: schema.sandboxWorkspaceSettings.startDir,
      globalProxyEnv: schema.sandboxWorkspaceSettings.globalProxyEnv,
      cpus: schema.sandboxWorkspaceSettings.cpus,
      memoryGb: schema.sandboxWorkspaceSettings.memoryGb,
      diskGb: schema.sandboxWorkspaceSettings.diskGb,
      servicesJson: schema.sandboxWorkspaceSettings.servicesJson,
      updatedAt: schema.sandboxWorkspaceSettings.updatedAt,
    })
    .from(schema.sandboxWorkspaceSettings)
    .where(eq(schema.sandboxWorkspaceSettings.accountId, accountId))
    .execute();

  // This Sprint's "needs code" judgements — model answers about the account's tickets.
  const codeJudgementRows = await db
    .select({
      workspaceId: schema.sprintCodeJudgements.workspaceId,
      ident: schema.sprintCodeJudgements.ident,
      needsCode: schema.sprintCodeJudgements.needsCode,
      reason: schema.sprintCodeJudgements.reason,
      model: schema.sprintCodeJudgements.model,
      provider: schema.sprintCodeJudgements.provider,
      createdAt: schema.sprintCodeJudgements.createdAt,
    })
    .from(schema.sprintCodeJudgements)
    .where(eq(schema.sprintCodeJudgements.accountId, accountId))
    .execute();

  // "Implement story" — explicit columns (the frozen prompt seed and worktree paths stay out).
  const storyBuildRows = await db
    .select({
      id: schema.storyBuilds.id,
      workspaceId: schema.storyBuilds.workspaceId,
      ident: schema.storyBuilds.ident,
      ticketKey: schema.storyBuilds.ticketKey,
      ticketTitle: schema.storyBuilds.ticketTitle,
      status: schema.storyBuilds.status,
      error: schema.storyBuilds.error,
      provider: schema.storyBuilds.provider,
      model: schema.storyBuilds.model,
      effort: schema.storyBuilds.effort,
      wantDiagram: schema.storyBuilds.wantDiagram,
      wantDocs: schema.storyBuilds.wantDocs,
      criteriaSource: schema.storyBuilds.criteriaSource,
      criteria: schema.storyBuilds.criteriaJson,
      coverage: schema.storyBuilds.coverageJson,
      candidates: schema.storyBuilds.candidatesJson,
      plan: schema.storyBuilds.planJson,
      planRevision: schema.storyBuilds.planRevision,
      transcript: schema.storyBuilds.transcriptJson,
      design: schema.storyBuilds.designJson,
      docsStatus: schema.storyBuilds.docsStatus,
      docs: schema.storyBuilds.docsJson,
      docsDecisions: schema.storyBuilds.docsDecisionsJson,
      acceptedRevision: schema.storyBuilds.acceptedRevision,
      acceptedDocs: schema.storyBuilds.acceptedDocsJson,
      planCostUsd: schema.storyBuilds.planCostUsd,
      docsCostUsd: schema.storyBuilds.docsCostUsd,
      // A workspace session (migration 0176): its phase, runtime, build spend and shown state (the
      // conversation, boot steps, network log). Never the sandbox's or the agent's internal ids.
      sessionPhase: schema.storyBuilds.sessionPhase,
      withDocs: schema.storyBuilds.withDocs,
      approvedAt: schema.storyBuilds.approvedAt,
      runtime: schema.storyBuilds.runtime,
      buildCostUsd: schema.storyBuilds.buildCostUsd,
      session: schema.storyBuilds.sessionJson,
      createdAt: schema.storyBuilds.createdAt,
      completedAt: schema.storyBuilds.completedAt,
    })
    .from(schema.storyBuilds)
    .where(eq(schema.storyBuilds.accountId, accountId))
    .execute();
  const storyBuildRepoRows = await db
    .select({
      buildId: schema.storyBuildRepos.buildId,
      repoId: schema.storyBuildRepos.repoId,
      ref: schema.storyBuildRepos.ref,
      include: schema.storyBuildRepos.include,
      status: schema.storyBuildRepos.status,
      baseRef: schema.storyBuildRepos.baseRef,
      baseSha: schema.storyBuildRepos.baseSha,
      stackedOnPrId: schema.storyBuildRepos.stackedOnPrId,
      branch: schema.storyBuildRepos.branch,
      summary: schema.storyBuildRepos.summary,
      commitMessage: schema.storyBuildRepos.commitMessage,
      filesChanged: schema.storyBuildRepos.filesChangedJson,
      changeReport: schema.storyBuildRepos.changeReportJson,
      checks: schema.storyBuildRepos.checksJson,
      patch: schema.storyBuildRepos.patch,
      stat: schema.storyBuildRepos.statJson,
      prTitle: schema.storyBuildRepos.prTitle,
      prBody: schema.storyBuildRepos.prBody,
      pushedBranch: schema.storyBuildRepos.pushedBranch,
      pushedPrNumber: schema.storyBuildRepos.pushedPrNumber,
      pushedPrUrl: schema.storyBuildRepos.pushedPrUrl,
      pushedAt: schema.storyBuildRepos.pushedAt,
      provider: schema.storyBuildRepos.provider,
      model: schema.storyBuildRepos.model,
      costUsd: schema.storyBuildRepos.costUsd,
      completedAt: schema.storyBuildRepos.completedAt,
    })
    .from(schema.storyBuildRepos)
    .where(eq(schema.storyBuildRepos.accountId, accountId))
    .execute();
  const storyBuildPlanRows = await db
    .select({
      buildId: schema.storyBuildPlans.buildId,
      revision: schema.storyBuildPlans.revision,
      source: schema.storyBuildPlans.source,
      plan: schema.storyBuildPlans.planJson,
      decisions: schema.storyBuildPlans.decisionsJson,
      replies: schema.storyBuildPlans.repliesJson,
      createdAt: schema.storyBuildPlans.createdAt,
    })
    .from(schema.storyBuildPlans)
    .where(eq(schema.storyBuildPlans.accountId, accountId))
    .execute();
  const storyBuildPrRows = await db
    .select({
      buildId: schema.storyBuildPrs.buildId,
      repoId: schema.storyBuildPrs.repoId,
      key: schema.storyBuildPrs.prKey,
      position: schema.storyBuildPrs.position,
      stackIndex: schema.storyBuildPrs.stackIndex,
      title: schema.storyBuildPrs.title,
      contains: schema.storyBuildPrs.contains,
      criteria: schema.storyBuildPrs.criteriaJson,
      dependsOn: schema.storyBuildPrs.dependsOnJson,
      branch: schema.storyBuildPrs.branch,
      status: schema.storyBuildPrs.status,
      patch: schema.storyBuildPrs.patch,
      stat: schema.storyBuildPrs.statJson,
      filesChanged: schema.storyBuildPrs.filesChangedJson,
      commitMessage: schema.storyBuildPrs.commitMessage,
      summary: schema.storyBuildPrs.summary,
      checks: schema.storyBuildPrs.checksJson,
      prTitle: schema.storyBuildPrs.prTitle,
      prBody: schema.storyBuildPrs.prBody,
      pushedBranch: schema.storyBuildPrs.pushedBranch,
      pushedPrNumber: schema.storyBuildPrs.pushedPrNumber,
      pushedPrUrl: schema.storyBuildPrs.pushedPrUrl,
      pushedAt: schema.storyBuildPrs.pushedAt,
      error: schema.storyBuildPrs.error,
      createdAt: schema.storyBuildPrs.createdAt,
    })
    .from(schema.storyBuildPrs)
    .where(eq(schema.storyBuildPrs.accountId, accountId))
    .execute();
  // The review loop (0186): every column is the reader's own (no secret, no worktree path).
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const loopRowsOf = async (t: any): Promise<Record<string, unknown>[]> =>
    (await db.select().from(t).where(eq(t.accountId, accountId)).execute()) as Record<string, unknown>[];
  const [storyBuildReviewRows, storyBuildReviewFindingRows, storyBuildStoryCheckRows, storyBuildAcResponseRows, storyBuildLoopPushRows] =
    await Promise.all([
      loopRowsOf(schema.storyBuildReviews),
      loopRowsOf(schema.storyBuildReviewFindings),
      loopRowsOf(schema.storyBuildStoryChecks),
      loopRowsOf(schema.storyBuildAcResponses),
      loopRowsOf(schema.storyBuildLoopPushes),
    ]);

  const [
    reviewRows,
    threadRows,
    reviewCommentRows,
    prCommentRows,
    eventRows,
    workspaceRows,
    workspaceRepoRows,
    usageRows,
    workspaceReviewerRows,
    benchmarkRows,
    autoMergeRows,
  ] = await Promise.all([
    childRows((ids) => db.select().from(reviews).where(inArray(reviews.prId, ids)).execute()),
    childRows((ids) =>
      db.select().from(reviewThreads).where(inArray(reviewThreads.prId, ids)).execute(),
    ),
    childRows((ids) =>
      db.select().from(reviewComments).where(inArray(reviewComments.prId, ids)).execute(),
    ),
    childRows((ids) =>
      db.select().from(prComments).where(inArray(prComments.prId, ids)).execute(),
    ),
    db.select().from(events).where(eq(events.accountId, accountId)).execute(),
    // Workspaces + their memberships. Explicit column lists, per this file's rule: adding a
    // column to either table must be a deliberate decision to export it, not a side effect.
    db
      .select({
        id: workspaces.id,
        accountId: workspaces.accountId,
        name: workspaces.name,
        isDefault: workspaces.isDefault,
        createdAt: workspaces.createdAt,
        // Chronology's working hours and budgets — settings the user TYPED, so Art. 15 material,
        // exported deliberately (NULL = every default).
        flowSettings: workspaces.flowSettings,
        flowView: workspaces.flowView,
        sprintChecks: workspaces.sprintChecks,
      })
      .from(workspaces)
      .where(eq(workspaces.accountId, accountId))
      .execute(),
    // Scoped by accountId rather than by the repo id list: the membership table carries its own
    // accountId, so this needs no `IN ()` guard and cannot be skewed by the pullRequests cap.
    db
      .select({ workspaceId: workspaceRepos.workspaceId, repoId: workspaceRepos.repoId })
      .from(workspaceRepos)
      .where(eq(workspaceRepos.accountId, accountId))
      .execute(),
    db.select().from(aiUsage).where(eq(aiUsage.accountId, accountId)).execute(),
    // THE BOT OBJECT, one row per (workspace, reviewer). See the payload field's comment for why
    // it is Art. 15 material: classification decisions, a vendor name and a price the user typed.
    db
      .select({
        id: workspaceReviewers.id,
        accountId: workspaceReviewers.accountId,
        workspaceId: workspaceReviewers.workspaceId,
        authorUserId: workspaceReviewers.authorUserId,
        automated: workspaceReviewers.automated,
        role: workspaceReviewers.role,
        confidence: workspaceReviewers.confidence,
        source: workspaceReviewers.source,
        reasonsJson: workspaceReviewers.reasonsJson,
        kind: workspaceReviewers.kind,
        label: workspaceReviewers.label,
        identitySource: workspaceReviewers.identitySource,
        // ⚠ THE PRICE IS EXPORTED EVEN THOUGH THE PRODUCT SURFACES STRIP IT, and that is a
        // decision, not an oversight. Reading a seat price on `GET /api/bot-reviewers` (and the
        // three sibling routes that echo a reviewer row) needs the paid `botDepth` entitlement —
        // `stripCost` in api/routes/bot-triage.ts. This export does not: Art. 15/20 are about the
        // SUBJECT'S OWN DATA, and `monthly_cents` is a number this account typed in. A downgraded
        // account can therefore still export prices it can no longer see in the UI, which is the
        // correct answer for a portability endpoint and the wrong one for a feature tier. If that
        // is ever reversed, it must be reversed HERE and recorded in bot-triage.ts's `stripCost`
        // note, which names this file as the one exemption.
        monthlyCents: workspaceReviewers.monthlyCents,
        // The price's reading rule ('flat' | 'per_seat') — user-typed the same way the price is.
        costModel: workspaceReviewers.costModel,
        updatedAt: workspaceReviewers.updatedAt,
      })
      .from(workspaceReviewers)
      .where(eq(workspaceReviewers.accountId, accountId))
      .execute(),
    db
      .select()
      .from(benchmarkContributions)
      .where(eq(benchmarkContributions.accountId, accountId))
      .execute(),
    // "Merge when ready" intents. A record of an action the user asked the server to take on
    // their behalf (and of merges it performed), so it belongs in an Art. 15 export even
    // though the rows are small and short-lived.
    db
      .select()
      .from(autoMergeRequests)
      .where(eq(autoMergeRequests.accountId, accountId))
      .execute(),
  ]);

  const extraExternalRows = await db
    .select({ workspaceId: workspaceExternalRepos.workspaceId, repoId: workspaceExternalRepos.repoId })
    .from(workspaceExternalRepos)
    .where(eq(workspaceExternalRepos.accountId, accountId))
    .execute();
  return {
    meta: {
      generatedAt: new Date().toISOString(),
      format: 'pierre-account-export',
      formatVersion: 1,
      truncated,
      notes: [
        'Your stored GitHub access token is deliberately excluded: it is a credential, not ' +
          'personal data you need, and an export file is not a safe place for one.',
        'Payment and card data is held by Stripe, never by this server — request it from Stripe.',
        'This export includes GitHub activity by OTHER people (their logins and the comments ' +
          'they wrote) because that is what was synced into your account. Handle it accordingly.',
        'Repository content is a cache of GitHub data and is regenerable from GitHub at any time.',
      ],
    },
    account: {
      ...account,
      // Report only the PRESENCE of a token, never the sealed value.
      hasStoredGithubToken: Boolean(account.hasStoredGithubToken),
    },
    repositories: repoRows,
    workspaces: workspaceRows.map((w) => ({
      ...w,
      repoIds: workspaceRepoRows.filter((wr) => wr.workspaceId === w.id).map((wr) => wr.repoId),
      // The EXTRA External memberships (migration 0191): repos whose home is another workspace.
      extraExternalRepoIds: extraExternalRows.filter((wr) => wr.workspaceId === w.id).map((wr) => wr.repoId),
    })),
    pullRequests: prRows,
    reviews: capped('reviews', reviewRows),
    reviewThreads: capped('reviewThreads', threadRows),
    reviewComments: capped('reviewComments', reviewCommentRows),
    prComments: capped('prComments', prCommentRows),
    events: capped('events', eventRows),
    aiUsage: usageRows,
    workspaceReviewers: workspaceReviewerRows,
    benchmarkContributions: benchmarkRows,
    autoMergeRequests: autoMergeRows,
    // ⚠ PRESENCE ONLY — never the stored token, in any form.
    workspaceTrackers: trackerRows.map((t) => ({ ...t, hasToken: t.hasToken != null && t.hasToken !== '' })),
    workspaceSonar: sonarRows.map((t) => ({ ...t, hasToken: t.hasToken != null && t.hasToken !== '' })),
    referenceDocs: referenceDocRows,
    referenceDocWikiPages: wikiPageRows,
    // ⚠ PRESENCE ONLY — never the stored token, in any form.
    workspaceWikiCredentials: wikiCredentialRows.map((t) => ({ ...t, hasToken: t.hasToken != null && t.hasToken !== '' })),
    referenceDocFigureDescriptions: figureRows,
    referenceDocRepoOffers: repoOfferRows,
    repoRelations: repoRelationRows,
    sandboxAllowedHosts: sandboxHostRows,
    sandboxWorkspaceSettings: sandboxSettingRows,
    sprintCodeJudgements: capped('sprintCodeJudgements', codeJudgementRows),
    referenceDocChatMessages: capped('referenceDocChatMessages', docChatRows),
    storyBuilds: capped('storyBuilds', storyBuildRows),
    storyBuildRepos: capped(
      'storyBuildRepos',
      storyBuildRepoRows.map((r) => {
        const long = r.patch != null && r.patch.length > STORY_BUILD_EXPORT_PATCH_MAX;
        return { ...r, patch: long ? r.patch!.slice(0, STORY_BUILD_EXPORT_PATCH_MAX) : r.patch, patchTruncated: long };
      }),
    ),
    storyBuildPlans: capped('storyBuildPlans', storyBuildPlanRows),
    storyBuildPrs: capped(
      'storyBuildPrs',
      storyBuildPrRows.map((r) => {
        const long = r.patch != null && r.patch.length > STORY_BUILD_EXPORT_PATCH_MAX;
        return { ...r, patch: long ? r.patch!.slice(0, STORY_BUILD_EXPORT_PATCH_MAX) : r.patch, patchTruncated: long };
      }),
    ),
    storyBuildReviews: capped('storyBuildReviews', storyBuildReviewRows),
    storyBuildReviewFindings: capped('storyBuildReviewFindings', storyBuildReviewFindingRows),
    storyBuildStoryChecks: capped('storyBuildStoryChecks', storyBuildStoryCheckRows),
    storyBuildAcResponses: capped('storyBuildAcResponses', storyBuildAcResponseRows),
    storyBuildLoopPushes: capped('storyBuildLoopPushes', storyBuildLoopPushRows),
  };
}
