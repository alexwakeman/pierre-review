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

  // ---- 5. the work-plan wording (stored as the route stores it) ----
  {
    const { getWorkPlan } = await import('../src/db/work-plan.js');
    const { resolveWorkspaceScope } = await import('../src/db/queries.js');
    const { workPlanPayloadHash } = await import('../src/platform/work-plan/hash.js');
    const { parseWorkPlanOutput } = await import('../src/platform/work-plan/prompt.js');
    const { proSchemaFor } = await import('../src/platform/db.js');
    const scope = await resolveWorkspaceScope(1, platformWs);
    const evidence = await getWorkPlan(1, scope as never);
    const scopeKey = `ws:${platformWs}`;
    const why = (i: (typeof evidence.items)[number]): string => {
      switch (i.kind) {
        case 'review':
          return 'Someone asked you for this review, and it is the oldest wait on your list.';
        case 'reply':
          return 'A reply is waiting on you in this thread.';
        case 'merge':
          return 'Approved and green, so landing it clears it off everyone’s board.';
        case 'update_branch':
          return 'Behind main and otherwise ready; one update and it can land.';
        case 'unblock_ci':
          return 'Your change has red checks, and they block the merge.';
        case 'thread':
          return 'Nobody has answered this review thread yet.';
        case 'nudge':
          return 'Waiting on a first review for longer than the team’s budget.';
        default:
          return 'High on the list for how long it has waited and how close it is to done.';
      }
    };
    const answer = JSON.stringify({
      headline: 'Start with your review requests, then land what is already approved.',
      steps: evidence.items.slice(0, 6).map((i) => ({ id: i.id, why: why(i) })),
      parked: 'The stale scheduler change can wait until the queue work is reviewed.',
    });
    const validated = parseWorkPlanOutput(answer, evidence);
    if (validated == null) throw new Error('work plan: answer refused');
    const pro = proSchemaFor();
    await db
      .insert(pro.proWorkPlans)
      .values({
        accountId: 1,
        scopeKey,
        payloadHash: workPlanPayloadHash(scopeKey, evidence),
        output: JSON.stringify(validated),
        model: 'claude-haiku-5-5',
        itemCount: evidence.items.length,
        generatedAt: new Date(nowMs - 40 * 60_000),
      })
      .execute();
    out.workPlanSteps = validated.steps.length;
  }

  void and;
  void inArray;
  return out;
}
