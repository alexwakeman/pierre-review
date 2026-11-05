// THE DEMO'S SETTINGS AND WRITTEN SUMMARIES — run last, against everything else the seed wrote.
//
//   • SETTINGS through the real routes (an in-process app, `app.inject`): auto review + auto-posting,
//     working hours, dependency auto-merge, a Slack channel, the docs switch. Each real change writes
//     its own `workspace_setting_events` row (Chronology's "Over time" markers); those are then dated
//     across the last months, as if the team had switched them on over time.
//   • MERGE STATE: one PR armed to merge when ready, one in GitHub's merge queue, a security fix in
//     Dependencies.
//   • THE WRITTEN SUMMARIES (bot themes, Chronology pointers, a drill-down's clusters) through their
//     real POST routes, with the model answered by a FAKE Anthropic Messages endpoint in this process
//     (127.0.0.1, an ephemeral port): a placeholder `ANTHROPIC_API_KEY` with `LIMN_AI_USE_API_KEY=true`
//     sends those calls down the ladder's raw API-key rung even when a Claude login exists (never the
//     developer's real login), and `ANTHROPIC_BASE_URL` points that rung here. All three are restored
//     afterwards. Each answer is built from the request's own JSON (the ids it may cite), so the
//     product's validators accept it.
//   • THE WORK-PLAN WORDING runs on the local Claude route in the product, so it is stored through
//     its own exported pieces (the evidence fold, the payload hash, the output parser) with a
//     written answer.
// Nothing leaves the machine.
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

const DAY = 86_400_000;

export interface PlatformSeedCtx {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  schema: any;
  now: Date;
  platformWs: number;
  webWs: number;
}

// ── the fake Messages endpoint ───────────────────────────────────────────────────────────────

type Answer = (system: string, user: string) => string | null;

/** The JSON object inside a prompt (some prompts lead with a line of text). */
function jsonIn(user: string): unknown {
  const a = user.indexOf('{');
  const b = user.lastIndexOf('}');
  return a >= 0 && b > a ? JSON.parse(user.slice(a, b + 1)) : {};
}

function botThemesAnswer(_system: string, user: string): string {
  const payload = jsonIn(user) as { clusters?: Array<{ id: number; text: string; count: number; bots?: string[]; areas?: string[]; prs?: number[] }> };
  const clusters = payload.clusters ?? [];
  const groups: Array<{ title: string; category: string; severity: string; summary: string; re: RegExp }> = [
    { title: 'Secrets and input checks', category: 'security', severity: 'critical', summary: 'Bots flag secrets in logs, unchecked input and signatures verified on the wrong bytes.', re: /secret|token|signature|inject|sanitis|saniti|validat|permission|auth/i },
    { title: 'Missing null checks', category: 'correctness', severity: 'major', summary: 'Values read without a null or undefined check, mostly on optional API fields.', re: /null|undefined|optional|guard|nil\b/i },
    { title: 'Transactions and races', category: 'correctness', severity: 'major', summary: 'Writes outside a transaction and counters read without a lock.', re: /transaction|lock|race|concurren|atomic/i },
    { title: 'Query cost', category: 'performance', severity: 'minor', summary: 'Full scans, per-row queries and allocations inside hot loops.', re: /scan|index|batch|N\+1|loop|alloc|query|cache/i },
    { title: 'Error handling gaps', category: 'error_handling', severity: 'minor', summary: 'Promises without a catch, streams not closed on error, retries without a budget.', re: /catch|throw|error|retry|finally|leak|close/i },
    { title: 'Test coverage gaps', category: 'testing', severity: 'minor', summary: 'New branches with no test, and fixtures that no longer match the code.', re: /test|fixture|coverage|assert/i },
    { title: 'Naming and style nits', category: 'style', severity: 'nit', summary: 'Import order, naming, trailing whitespace and comments that restate the code.', re: /nit|naming|import|whitespace|comment|rename|style|ordering|const\b/i },
  ];
  const members = new Map<number, typeof clusters>();
  for (const c of clusters) {
    const gi = groups.findIndex((g) => g.re.test(c.text));
    const k = gi < 0 ? groups.length - 1 : gi;
    members.set(k, [...(members.get(k) ?? []), c]);
  }
  const themes = [...members.entries()]
    .filter(([, list]) => list.length > 0)
    .map(([k, list]) => {
      const g = groups[k]!;
      return {
        title: g.title,
        category: g.category,
        severity: g.severity,
        summary: g.summary,
        occurrences: list.reduce((n, c) => n + (c.count ?? 1), 0),
        bots: [...new Set(list.flatMap((c) => c.bots ?? []))].slice(0, 4),
        areas: [...new Set(list.flatMap((c) => c.areas ?? []))].slice(0, 4),
        examplePrNumbers: [...new Set(list.flatMap((c) => c.prs ?? []))].slice(0, 4),
        memberIds: list.slice(0, 15).map((c) => c.id),
      };
    });
  return JSON.stringify({
    narrative:
      'CodeRabbit writes most of the comments, and most of what it writes are style nits. The comments that matter cluster in two places: secrets and input checks in the API routes, and writes outside a transaction in the sync code.',
    themes,
  });
}

function flowPointersAnswer(_system: string, user: string): string {
  const e = jsonIn(user) as { prs?: Array<{ id: number; quarter?: string; title?: string }>; exemplars?: Array<{ id: number; side?: string }> };
  const prs = e.prs ?? [];
  const ex = e.exemplars ?? [];
  const fast = [...ex.filter((x) => /fast|quick/i.test(String(x.side ?? ''))).map((x) => x.id), ...prs.filter((p) => /fast|quick|q1|first/i.test(String(p.quarter ?? ''))).map((p) => p.id)];
  const slow = [...ex.filter((x) => /slow/i.test(String(x.side ?? ''))).map((x) => x.id), ...prs.filter((p) => /slow|q4|last/i.test(String(p.quarter ?? ''))).map((p) => p.id)];
  const any = prs.map((p) => p.id);
  const pick = (list: number[], n: number) => (list.length > 0 ? list : any).slice(0, n);
  return JSON.stringify({
    pointers: [
      { kind: 'example', text: 'The quick changes did one thing each: the index on events landed in a day, while the scheduler move bundled a queue, a migration and a config change.', cites: [...pick(fast, 1), ...pick(slow, 1)] },
      { kind: 'pattern', text: 'Slow pull requests mostly paired a schema change with feature work, so reviewers waited for both halves to settle.', cites: pick(slow, 2) },
      { kind: 'try', text: 'Arm merge when ready on approved work instead of waiting for the author to come back and press merge.', cites: pick(any, 2) },
    ],
  });
}

function synthesisAnswer(_system: string, user: string): string {
  const input = jsonIn(user) as { items?: Array<{ id: string; text: string }> };
  const items = input.items ?? [];
  const buckets: Array<{ label: string; re: RegExp; configFixable?: boolean }> = [
    { label: 'Style nits on generated or vendored files', re: /nit|import|whitespace|ordering|naming|comment/i, configFixable: true },
    { label: 'Missing null and error checks', re: /null|undefined|catch|error|throw/i },
    { label: 'Query and loop cost', re: /scan|index|batch|loop|alloc|query/i },
    { label: 'Security in request handling', re: /secret|token|signature|validat|permission/i },
  ];
  const claimed = new Set<string>();
  const clusters = buckets
    .map((b) => {
      const ids = items.filter((i) => !claimed.has(i.id) && b.re.test(i.text)).map((i) => i.id);
      ids.forEach((id) => claimed.add(id));
      return { label: b.label, itemIds: ids, configFixable: b.configFixable === true };
    })
    .filter((c) => c.itemIds.length > 0);
  return JSON.stringify({ clusters });
}

async function startFakeAnthropic(answers: Array<{ match: string; answer: Answer }>): Promise<{ server: Server; url: string; calls: string[] }> {
  const calls: string[] = [];
  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', (d) => (raw += d));
    req.on('end', () => {
      try {
        const body = JSON.parse(raw || '{}') as { system?: string | Array<{ text?: string }>; messages?: Array<{ content: string | Array<{ text?: string }> }>; model?: string };
        const system = typeof body.system === 'string' ? body.system : (body.system ?? []).map((b) => b.text ?? '').join('');
        const first = body.messages?.[0]?.content;
        const user = typeof first === 'string' ? first : (first ?? []).map((b) => b.text ?? '').join('');
        const hit = answers.find((a) => system.startsWith(a.match.slice(0, 60)));
        const text = hit?.answer(system, user) ?? '{}';
        calls.push(hit ? hit.match.slice(0, 40) : `unmatched: ${system.slice(0, 40)}`);
        res.writeHead(200, { 'content-type': 'application/json', 'request-id': 'req_demo' });
        res.end(
          JSON.stringify({
            id: `msg_demo_${calls.length}`,
            type: 'message',
            role: 'assistant',
            model: body.model ?? 'claude-haiku-5-5',
            content: [{ type: 'text', text }],
            stop_reason: 'end_turn',
            stop_sequence: null,
            usage: { input_tokens: Math.round(user.length / 4), output_tokens: Math.round(text.length / 4) },
          }),
        );
      } catch (err) {
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ type: 'error', error: { type: 'api_error', message: String(err) } }));
      }
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port;
  return { server, url: `http://127.0.0.1:${port}`, calls };
}

// ── the seed ─────────────────────────────────────────────────────────────────────────────────

export async function seedDemoPlatform(c: PlatformSeedCtx): Promise<Record<string, unknown>> {
  const { db, schema, now, platformWs, webWs } = c;
  const nowMs = now.getTime();
  const { eq, and, inArray } = await import('drizzle-orm');
  const out: Record<string, unknown> = {};

  // ---- 1. merge state on the board ----
  // A security fix from Dependabot (proven by its own marker), and a plain bump beside it.
  await db
    .update(schema.pullRequests)
    .set({ title: 'Bump undici from 6.19.2 to 6.21.1', dependencyVendor: 'dependabot', securityFix: 'proven', advisoryIds: ['GHSA-c76h-2ccp-4975', 'CVE-2025-22150'], securityCheckedAt: new Date(nowMs - 2 * 3_600_000) })
    .where(eq(schema.pullRequests.id, 2278))
    .execute();
  await db.update(schema.pullRequests).set({ dependencyVendor: 'renovate', securityCheckedAt: new Date(nowMs - 2 * 3_600_000) }).where(eq(schema.pullRequests.id, 2196)).execute();
  // #116 is approved and green: armed to merge when ready, waiting on its last check.
  const head116 = ((await db.select({ h: schema.pullRequests.headSha }).from(schema.pullRequests).where(eq(schema.pullRequests.id, 116)).execute()) as Array<{ h: string }>)[0]!.h;
  await db
    .insert(schema.autoMergeRequests)
    .values({
      accountId: 1,
      prId: 116,
      mergeMethod: 'squash',
      updateStrategy: 'merge',
      expectedHeadOid: head116,
      expectedBaseRef: 'main',
      viaMergeQueue: false,
      state: 'armed',
      armedAt: new Date(nowMs - 3.2 * 3_600_000),
      expiresAt: new Date(nowMs + 69 * 3_600_000),
      lastCheckedAt: new Date(nowMs - 4 * 60_000),
      lastReason: 'Waiting for a required review',
      phase: 'awaiting_review',
      createdAt: new Date(nowMs - 3.2 * 3_600_000),
      updatedAt: new Date(nowMs - 4 * 60_000),
    })
    .execute();
  // A search-service PR sits in GitHub's merge queue.
  await db.update(schema.pullRequests).set({ inMergeQueue: true, mergeQueueEntryState: 'AWAITING_CHECKS', reviewDecision: 'approved' }).where(eq(schema.pullRequests.id, 2349)).execute();

  // ---- 2. the in-process app ----
  const { SYSTEM: BOT_THEMES_SYSTEM } = await import('../src/platform/bot-themes/prompt.js');
  const { FLOW_POINTERS_SYSTEM } = await import('../src/platform/flow-pointers/prompt.js');
  const { SYNTHESIS_SYSTEM } = await import('../src/platform/synthesis/prompt.js');
  const fake2 = await startFakeAnthropic([
    { match: BOT_THEMES_SYSTEM, answer: botThemesAnswer },
    { match: FLOW_POINTERS_SYSTEM, answer: flowPointersAnswer },
    { match: SYNTHESIS_SYSTEM, answer: synthesisAnswer },
  ]);
  // The API-key rung, FIRST even over a Claude login (ai/credentials.ts), pointed at the fake server.
  const prevEnv = {
    ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
    LIMN_AI_USE_API_KEY: process.env.LIMN_AI_USE_API_KEY,
    ANTHROPIC_BASE_URL: process.env.ANTHROPIC_BASE_URL,
  };
  process.env.ANTHROPIC_BASE_URL = fake2.url;
  process.env.ANTHROPIC_API_KEY = 'sk-ant-demo-not-a-key';
  process.env.LIMN_AI_USE_API_KEY = 'true';

  const { buildApp } = await import('../src/app.js');
  const { bindPlatform } = await import('../src/platform/context.js');
  const app = await buildApp();
  await bindPlatform(app);
  await app.ready();
  const call = async (method: string, url: string, payload?: unknown): Promise<unknown> => {
    const res = await app.inject({ method: method as 'GET', url, ...(payload !== undefined ? { payload: payload as object } : {}) });
    if (res.statusCode >= 400) throw new Error(`${method} ${url} → ${res.statusCode} ${res.body.slice(0, 300)}`);
    return res.body ? JSON.parse(res.body) : null;
  };

  try {
    // ---- 3. settings, in the order a team would have switched them on ----
    await call('PUT', `/api/workspaces/${platformWs}/flow-settings`, {
      timeZone: 'Europe/London',
      days: [1, 2, 3, 4, 5],
      startMinute: 9 * 60,
      endMinute: 17 * 60 + 30,
    });
    await call('PUT', `/api/workspaces/${platformWs}/auto-review`, { enabled: true, dailyCap: 30 });
    await call('PUT', `/api/workspaces/${platformWs}/auto-review`, {
      autoPost: { enabled: true, scope: 'mine', kinds: { blockers: true, warnings: true, nits: false, questions: true, ciFailures: true, storyGaps: true }, autoVerdict: false, autoResolve: true },
    });
    await call('PUT', `/api/workspaces/${platformWs}/auto-review`, { autoFixEnabled: true, autoFix: { autoPush: false } });
    await call('PUT', `/api/workspaces/${platformWs}/dependency-auto-merge`, { enabled: true });
    await call('PUT', `/api/pro/slack/target?workspace=${platformWs}`, {
      webhookUrl: 'https://hooks.slack.com/services/T0ACME0000/B0ACME0000/demoDemoDemoDemoDemoDemo',
      cadence: 'daily',
      hour1: 9,
      timezone: 'Europe/London',
      botDigest: true,
      notifyReviews: true,
      notifyMerges: false,
    });
    await call('PUT', `/api/workspaces/${webWs}/flow-settings`, { timeZone: 'America/New_York', days: [1, 2, 3, 4, 5], startMinute: 9 * 60, endMinute: 17 * 60 });
    // Settings → Dependencies (written LAST so the older markers keep their ages): approve and resolve
    // conflicts on, patch and minor updates only, Dependabot trusted. Its bot row is what detection
    // itself persists for the known vendor login (`vendor_login`, role dependency).
    const depBot = ((await db.select({ id: schema.users.id }).from(schema.users).where(eq(schema.users.githubLogin, 'dependabot')).execute()) as Array<{ id: number }>)[0];
    if (depBot) {
      await db
        .insert(schema.workspaceReviewers)
        .values({
          accountId: 1,
          workspaceId: platformWs,
          authorUserId: depBot.id,
          automated: true,
          role: 'dependency',
          confidence: 'high',
          source: 'vendor_login',
          reasonsJson: ['login "dependabot" is a known Dependabot account'],
          kind: 'dependabot',
          identitySource: 'auto',
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: [schema.workspaceReviewers.accountId, schema.workspaceReviewers.workspaceId, schema.workspaceReviewers.authorUserId],
          set: { automated: true, role: 'dependency', kind: 'dependabot' },
        })
        .execute();
      await call('PUT', `/api/workspaces/${platformWs}/dependency-automation`, {
        autoApprove: true,
        autoResolveConflicts: true,
        // "Fix them with AI": a dependency PR whose CI fails gets one AI fix (docs/MERGE-CI-TRUNK.md).
        autoFix: true,
        maxLevel: 'minor',
        trustedBotIds: [depBot.id],
      });
      // What the automation did (Pending → Dependencies → "What automation did"): an approval, a
      // rebase request, and the AI run that followed when the branch still conflicted.
      const depPrs = (await db
        .select({ id: schema.pullRequests.id, head: schema.pullRequests.headSha })
        .from(schema.pullRequests)
        .innerJoin(schema.workspaceRepos, eq(schema.workspaceRepos.repoId, schema.pullRequests.repoId))
        .where(and(eq(schema.workspaceRepos.workspaceId, platformWs), eq(schema.pullRequests.authorId, depBot.id)))
        .orderBy(schema.pullRequests.id)
        .execute()) as Array<{ id: number; head: string | null }>;
      const at = (h: number) => new Date(nowMs - h * 3_600_000);
      const [a, b, cc, d, e, f] = [depPrs.at(-1), depPrs.at(-2), depPrs.at(-3), depPrs.at(-4), depPrs.at(-5), depPrs.at(-6)];
      // The open bump (Bump undici), where an AI fix is running now.
      const openDep = ((await db
        .select({ id: schema.pullRequests.id, head: schema.pullRequests.headSha })
        .from(schema.pullRequests)
        .innerJoin(schema.workspaceRepos, eq(schema.workspaceRepos.repoId, schema.pullRequests.repoId))
        .where(and(eq(schema.workspaceRepos.workspaceId, platformWs), eq(schema.pullRequests.authorId, depBot.id), eq(schema.pullRequests.state, 'open')))
        .orderBy(schema.pullRequests.id)
        .execute()) as Array<{ id: number; head: string | null }>)[0];
      const rows: Array<Record<string, unknown>> = [
        ...(a ? [{ prId: a.id, headSha: a.head ?? 'demo-a', action: 'approve', state: 'done', detail: 'a patch dependency update', createdAt: at(3), updatedAt: at(3) }] : []),
        ...(b
          ? [
              { prId: b.id, headSha: 'demo-b0', action: 'rebase_request', state: 'done', detail: 'Asked Dependabot to rebase', createdAt: at(7), updatedAt: at(7) },
              { prId: b.id, headSha: 'demo-b0', action: 'ai_resolve', state: 'done', detail: 'Resolved with Claude and pushed 4f2a9c1', resultSha: '4f2a9c1e0b7d', createdAt: at(6), updatedAt: at(6) },
            ]
          : []),
        // Red CI → one AI fix, pushed; then armed, and the merge landed (docs/MERGE-CI-TRUNK.md §
        // Dependency automation: "Merged" is a LANDED merge only).
        ...(cc
          ? [
              { prId: cc.id, headSha: 'demo-c0', action: 'ai_fix', state: 'done', detail: 'Fixed with Claude and pushed 1a2b3c4', resultSha: '1a2b3c4d5e6f', createdAt: at(11), updatedAt: at(10.8) },
              { prId: cc.id, headSha: cc.head ?? 'demo-c1', action: 'arm_merge', state: 'done', detail: null, createdAt: at(10), updatedAt: at(10) },
              { prId: cc.id, headSha: cc.head ?? 'demo-c1', action: 'merge_landed', state: 'done', detail: null, createdAt: at(9.5), updatedAt: at(9.5) },
            ]
          : []),
        ...(d ? [{ prId: d.id, headSha: 'demo-d0', action: 'ai_fix', state: 'failed', detail: 'Not pushed: the branch moved since the fix was made.', createdAt: at(14), updatedAt: at(13.8) }] : []),
        ...(openDep ? [{ prId: openDep.id, headSha: openDep.head ?? 'demo-o', action: 'ai_fix', state: 'running', detail: null, createdAt: at(0.1), updatedAt: at(0.1) }] : []),
        // A teammate's Limn holds the head (its `limn/deps` status): a skip, never a failure.
        ...(e ? [{ prId: e.id, headSha: e.head ?? 'demo-e', action: 'approve', state: 'skipped', detail: null, teammateLogin: 'priya-nair', teammateHandled: false, createdAt: at(1), updatedAt: at(1) }] : []),
        ...(f ? [{ prId: f.id, headSha: f.head ?? 'demo-f', action: 'arm_merge', state: 'skipped', detail: null, teammateLogin: 'wei-zhang', teammateHandled: true, createdAt: at(20), updatedAt: at(20) }] : []),
      ];
      if (rows.length > 0) {
        await db.insert(schema.dependencyAutomationActions).values(rows.map((r) => ({ accountId: 1, ...r }))).execute();
      }
      out.dependencyAutomation = rows.length;
    }
    // The markers, spread back over the last months (oldest first, in the order written above).
    const events = (await db
      .select({ id: schema.workspaceSettingEvents.id, ws: schema.workspaceSettingEvents.workspaceId })
      .from(schema.workspaceSettingEvents)
      .where(eq(schema.workspaceSettingEvents.accountId, 1))
      .orderBy(schema.workspaceSettingEvents.id)
      .execute()) as Array<{ id: number; ws: number }>;
    const agesDays = [118, 84, 61, 61, 37, 9, 20, 14, 7];
    for (let i = 0; i < events.length; i++) {
      const at = new Date(nowMs - (agesDays[i] ?? 5) * DAY);
      await db.update(schema.workspaceSettingEvents).set({ occurredAt: at }).where(eq(schema.workspaceSettingEvents.id, events[i]!.id)).execute();
    }
    out.settingEvents = events.length;
    // The auto-review switch's own clock follows its marker.
    await db.update(schema.workspaces).set({ autoReviewEnabledAt: new Date(nowMs - 84 * DAY) }).where(eq(schema.workspaces.id, platformWs)).execute();
    // THE DAILY LIMIT TOAST (components/AutoReviewCapToast.tsx): Platform's daily limit sits at what
    // today's auto reviews already used, so the header shows "limit reached" with "Change limit" (or
    // "nearly used up" once four or more ran today). Today = since 00:00 UTC, so the count depends on
    // the hour the seed runs; with none today the toast stays hidden. Written straight to the column:
    // a route write would add a setting marker after the ones dated above.
    {
      const { getAutoReviewCandidates } = await import('../src/db/queries.js');
      const d0 = new Date(nowMs);
      const dayStartMs = Date.UTC(d0.getUTCFullYear(), d0.getUTCMonth(), d0.getUTCDate());
      const used = (await getAutoReviewCandidates(1, platformWs, { openedSinceMs: nowMs, dayStartMs, limit: 0 }))?.autoToday ?? 0;
      if (used > 0) {
        const cap = used >= 4 ? Math.max(used + 1, Math.floor(used / 0.8)) : used;
        await db.update(schema.workspaces).set({ autoReviewDailyCap: cap }).where(eq(schema.workspaces.id, platformWs)).execute();
      }
      out.autoReviewToday = used;
    }

    // ---- 4. the written summaries through their real routes ----
    for (const window of ['rolling_14', 'rolling_30', 'sprint']) {
      await call('POST', `/api/pro/bot-themes/refresh?window=${window}&workspace=${platformWs}`);
    }
    const pointers = (await call('POST', `/api/pro/flow-pointers?window=reporting&workspace=${platformWs}`)) as { result: unknown };
    out.flowPointers = pointers?.result != null;
    for (const days of [30, 90]) await call('POST', `/api/pro/flow-pointers?days=${days}&workspace=${platformWs}`).catch(() => null);
    out.llmCalls = fake2.calls;
  } finally {
    await app.close();
    fake2.server.close();
    for (const [k, v] of Object.entries(prevEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }

  void and;
  void inArray;
  return out;
}
