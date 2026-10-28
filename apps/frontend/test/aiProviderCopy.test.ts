import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  aiCredentialWords,
  aiKindsAll,
  aiModelWords,
  aiModelChoiceLabel,
  aiProviderName,
  aiProviderOfModel,
  aiRunProviderName,
  aiSignInLine,
  CLAUDE_REVIEW_MODEL_LABELS,
  type AiBudgetResponse,
  type AiBudgetStatus,
  type AiUsageView,
  type MeResponse,
} from '@pierre-review/shared';
import { aiCapabilitiesOf } from '../src/lib/aiCapabilities.js';
import { codexWindowLines, headerUsageOf, meterText, usageDetailOf } from '../src/lib/aiBudget.js';
import { claudeFindingReason, threadPillFor } from '../src/lib/claudeThreadMarker.js';
import { ciNotCheckedSentence } from '../src/lib/claudeReviewCi.js';
import { notCheckedReason, threadNotCheckedReason } from '../src/lib/claudeReviewFollowUp.js';
import { autoLiftLine, autoVerdictLine } from '../src/lib/autoPost.js';
import { pickerSectionLabel } from '../src/components/AiFix/fixPickerModel.js';

// THE ACTIVE PROVIDER NAMES ITSELF (docs/CODEX-PLAN.md § 3.7): with Codex active, every sentence that
// means "the AI that will run now" says Codex; a STORED run names the provider it ran on; with Claude
// active nothing reads differently (except the neutral feature names: "AI Review", "AI spend").

function me(provider: 'claude' | 'codex' | undefined): MeResponse {
  return {
    ai: {
      enabled: true,
      runtime: 'ready',
      runtimeMessage: null,
      auth: 'ok',
      authMessage: null,
      ...(provider ? { provider } : {}),
      kinds: aiKindsAll({ auth: 'ok', message: null }),
    },
  } as unknown as MeResponse;
}

describe('the active provider’s name', () => {
  it('comes from /api/me ai.provider; an older server reads as Claude', () => {
    expect(aiCapabilitiesOf(me('codex'))).toMatchObject({ provider: 'codex', providerName: 'Codex' });
    expect(aiCapabilitiesOf(me('claude'))).toMatchObject({ provider: 'claude', providerName: 'Claude' });
    expect(aiCapabilitiesOf(me(undefined))).toMatchObject({ provider: 'claude', providerName: 'Claude' });
    expect(aiCapabilitiesOf(undefined).providerName).toBe('Claude');
  });

  it('the sign-in line and the credential words are the provider’s own', () => {
    expect(aiSignInLine('claude')).toBe('Sign in to Claude Code or set ANTHROPIC_API_KEY');
    expect(aiSignInLine('codex')).toBe('Sign in to Codex with ChatGPT (limn ai login codex)');
    expect(aiCredentialWords('claude')).toBe('your own Claude Code login or Anthropic API key');
    expect(aiCredentialWords('codex')).toBe('your own Codex sign-in');
    expect(aiModelWords('claude', 'Haiku')).toBe('Claude Haiku');
    expect(aiModelWords('codex', 'Sonnet')).toBe('Codex');
  });

  it('the model pickers name the Codex model a pick runs, and Claude’s labels are unchanged', () => {
    const opus = 'claude-opus-5-5' as const;
    const sonnet = 'claude-sonnet-5' as const;
    expect(aiModelChoiceLabel(opus, 'claude')).toBe(CLAUDE_REVIEW_MODEL_LABELS[opus]);
    expect(aiModelChoiceLabel(opus, 'codex')).toBe('Codex · GPT-6.1 Sol (most thorough)');
    expect(aiModelChoiceLabel(sonnet, 'codex')).toBe('Codex · GPT-6.1 Terra (best value)');
  });
});

describe('a stored run names the provider it ran on', () => {
  it('from its provider when the row has one, else from its model id', () => {
    expect(aiProviderOfModel('gpt-6.1-sol')).toBe('codex');
    expect(aiProviderOfModel('claude-opus-5-5')).toBe('claude');
    expect(aiProviderOfModel('opus')).toBe('claude');
    expect(aiProviderOfModel(null)).toBe('claude');
    expect(aiRunProviderName({ model: 'gpt-6.1-terra' })).toBe('Codex');
    expect(aiRunProviderName({ model: 'claude-opus-5-5' })).toBe('Claude');
    // A row that carries its provider wins over the model it names.
    expect(aiRunProviderName({ model: 'claude-opus-5-5', provider: 'codex' })).toBe('Codex');
    expect(aiProviderName(undefined)).toBe('Claude');
  });

  it('thread judgements: Claude’s words unchanged, Codex’s with its name', () => {
    const f = { status: 'reply_accepted' as const, replyAuthor: 'ana' };
    expect(claudeFindingReason(f)).toBe('Claude’s comment. Claude accepted @ana’s reply.');
    expect(claudeFindingReason(f, 'codex')).toBe('Codex’s comment. Codex accepted @ana’s reply.');
    expect(claudeFindingReason({ status: 'addressed', replyAuthor: null }, 'codex')).toBe(
      'Codex’s comment, checked again by a later review.',
    );
    const pr = {
      prId: 1,
      reviewId: 2,
      checkId: null,
      reviewedHeadSha: 'abc',
      finishedAt: null,
      currentHeadSha: 'abc',
      judgements: [
        {
          threadId: 9,
          validity: 'valid' as const,
          addressed: 'not_addressed' as const,
          explanation: null,
          reason: 'Right.',
          resolved: false,
          assessedAtHead: 'abc',
          carried: false,
        },
      ],
    };
    const claude = threadPillFor({ id: 9, derivedState: 'untouched' }, pr);
    const codex = threadPillFor({ id: 9, derivedState: 'untouched' }, pr, 'codex');
    expect(claude.kind === 'claude' && claude.marker.provider).toBe('claude');
    expect(codex.kind === 'claude' && codex.marker.provider).toBe('codex');
    // The judgement's own provider (on the wire since Phase 4) beats the caller's fallback.
    const own = { ...pr, judgements: pr.judgements.map((j) => ({ ...j, provider: 'codex' as const })) };
    const judged = threadPillFor({ id: 9, derivedState: 'untouched' }, own);
    expect(judged.kind === 'claude' && judged.marker.provider).toBe('codex');
  });

  it('the "not checked" lines and the auto-post lines', () => {
    expect(ciNotCheckedSentence('over_cap')).toBe('Not sent to Claude: too many failing checks.');
    expect(ciNotCheckedSentence('not_reported', 'Codex')).toBe("Codex didn't report on this one.");
    expect(notCheckedReason({ sent: false })).toBe('Not sent to Claude: too many earlier comments.');
    expect(notCheckedReason({ sent: true }, 'Codex')).toBe("Codex didn't report on this one.");
    expect(threadNotCheckedReason({ sent: false }, 'Codex')).toBe('Not sent to Codex: too many open threads.');
    const lift = { liftedBlock: { reviewId: '1', how: 'dismissed' as const, error: null } };
    expect(autoLiftLine(lift)).toBe('Lifted Claude’s earlier request for changes.');
    expect(autoLiftLine(lift, 'Codex')).toBe('Lifted Codex’s earlier request for changes.');
    const held = {
      status: 'posted' as const,
      verdict: { wanted: 'REQUEST_CHANGES' as const, submitted: 'COMMENT' as const, heldReason: 'already_requested' as const },
    };
    expect(autoVerdictLine(held as never, 'Codex')).toBe('Changes already requested by Codex’s earlier review.');
    expect(pickerSectionLabel('findings')).toBe('Claude’s findings');
    expect(pickerSectionLabel('findings', 'Codex')).toBe('Codex’s findings');
    expect(pickerSectionLabel('judged_threads', 'Codex')).toBe('Threads Codex says need a fix');
    expect(pickerSectionLabel('ci_failures', 'Codex')).toBe('CI failures');
  });
});

// ---- AI spend on Codex: its own windows, in percent only ----------------------------------------

const codexUsage = (over: Partial<AiUsageView> = {}): AiUsageView => ({
  provider: 'codex',
  route: 'login',
  account: {
    reportedSubscription: 'plus',
    subscription: null,
    fiveHour: { key: 'five_hour', label: null, usedPct: 12, resetsAt: null, observedAt: new Date(0).toISOString() },
    week: { key: 'seven_day', label: null, usedPct: 31, resetsAt: null, observedAt: new Date(0).toISOString() },
    models: [],
    observedAt: new Date(0).toISOString(),
  },
  limn: {
    weekFrom: new Date(0).toISOString(),
    window: 'rolling',
    runs: 3,
    inputTokens: 1200,
    outputTokens: 300,
    weekSharePct: 2.4,
    fiveHourSharePct: 1,
  },
  apiKey: null,
  weekPctPerUsd: null,
  ...over,
});

const codexStatus = (over: Partial<AiBudgetStatus> = {}): AiBudgetStatus => ({
  enabled: false,
  provider: 'codex',
  mode: 'off',
  route: 'login',
  subscription: null,
  apiKey: null,
  overBudget: false,
  limitedBy: null,
  reason: null,
  resumesAt: null,
  ...over,
});

const response = (status: AiBudgetStatus, usage: AiUsageView): AiBudgetResponse =>
  ({ settings: {}, isDefault: true, status, usage }) as unknown as AiBudgetResponse;

describe('AI spend with Codex active', () => {
  it('the popover names Codex, its ChatGPT plan and its own two windows — no US$ anywhere', () => {
    const d = usageDetailOf(response(codexStatus(), codexUsage()), 0);
    expect(d.heading).toBe('Codex · ChatGPT Plus');
    const titles = d.sections.map((s) => s.title);
    expect(titles).toEqual(['Limn’s runs', 'Your Codex account']);
    const acct = d.sections[1]!.rows.map((r) => `${r.label}: ${r.value}`);
    expect(acct).toEqual(['5-hour session: 12% used · 88% left', 'Week: 31% used · 69% left']);
    const limn = d.sections[0]!.rows.map((r) => `${r.label}: ${r.value}`);
    expect(limn[0]).toBe('This week: 2.4% of your week');
    expect(JSON.stringify(d)).not.toMatch(/\$|Claude/);
  });

  it('the header item reads Codex’s week while the budget is off', () => {
    const h = headerUsageOf(response(codexStatus(), codexUsage()));
    expect(h).toMatchObject({ label: 'Codex this week:', figure: '31%', title: 'Your Codex account has used 31% of this week' });
  });

  it('the meter never asks a Codex reader to pick a Claude subscription', () => {
    const sub = {
      subscription: null,
      subscriptionSource: null,
      reportedSubscription: 'plus',
      pickFrom: null,
      sharePct: 5,
      usedSharePct: null,
      reviewsPerDay: null,
      window: 'rolling' as const,
      weekResetsAt: null,
      fiveHourSharePct: 5,
      fiveHourFollowsWeek: true,
      fiveHourUsedSharePct: null,
      fiveHourWindow: 'rolling' as const,
      fiveHourResetsAt: null,
    };
    expect(meterText(codexStatus({ enabled: true, mode: 'subscription', subscription: sub }))).toBe('Limn: usage not read yet');
    expect(
      meterText(codexStatus({ enabled: true, mode: 'subscription', subscription: { ...sub, usedSharePct: 3 } })),
    ).toBe('Limn: 3% of your week · limit 5%');
  });

  it('Settings lists Codex’s windows in percent; nothing for Claude or an unread Codex', () => {
    expect(codexWindowLines(codexUsage(), 0)).toEqual([
      'Codex, 5-hour session: 12% used · 88% left',
      'Codex, week: 31% used · 69% left',
    ]);
    expect(codexWindowLines(codexUsage({ provider: 'claude' }), 0)).toEqual([]);
    expect(codexWindowLines(codexUsage({ provider: undefined }), 0)).toEqual([]);
    expect(codexWindowLines(codexUsage({ account: null }), 0)).toEqual([]);
  });

  it('Claude’s popover is unchanged', () => {
    const claude = usageDetailOf(
      response(codexStatus({ provider: 'claude' }), codexUsage({ provider: 'claude', account: { ...codexUsage().account!, subscription: 'pro' } })),
      0,
    );
    expect(claude.heading).toBe('Claude Pro');
    expect(claude.sections.map((s) => s.title)).toEqual(['Limn’s runs', 'Your Claude account']);
  });
});

// ---- the wiring --------------------------------------------------------------------------------

describe('the wiring', () => {
  const root = join(__dirname, '..', 'src');
  const read = (...p: string[]): string => readFileSync(join(root, ...p), 'utf8');
  const files: string[] = [];
  const walk = (d: string): void => {
    for (const n of readdirSync(d)) {
      const p = join(d, n);
      if (statSync(p).isDirectory()) walk(p);
      else if (/\.tsx?$/.test(n)) files.push(p);
    }
  };
  walk(root);

  it('"Claude spend" is "AI spend" everywhere a reader sees it', () => {
    for (const f of files) {
      const lines = readFileSync(f, 'utf8')
        .split('\n')
        .filter((l) => !/^\s*(\/\/|\*|\/\*|\{\/\*)/.test(l));
      expect(lines.join('\n'), f).not.toMatch(/Claude spend/);
    }
    expect(read('components', 'settings', 'ClaudeSpendSection.tsx')).toMatch(/title="AI spend"/);
    expect(read('components', 'AiUsageMenu.tsx')).toMatch(/AI spend settings/);
  });

  it('run buttons and status lines name the active provider', () => {
    expect(read('components', 'conflicts', 'ResolveConflictsButton.tsx')).toMatch(/Resolve with \{name\}/);
    expect(read('components', 'AiFix', 'ConflictAiCard.tsx')).toMatch(/`Resolve merge conflicts with \$\{name\}`/);
    expect(read('components', 'Activity', 'PendingClaude.tsx')).toMatch(/`Review with \$\{aiName\}`/);
    expect(read('components', 'ClaudeReviewChat.tsx')).toMatch(/`Ask \$\{providerName\} about this review`/);
    expect(read('components', 'Activity', 'SprintView.tsx')).toMatch(/Ask \{aiName\}/);
    // A RUNNING review names the provider it runs on (the row's, stamped with the reader's pick),
    // never the default's.
    // "Running Codex review" — and for a Claude + Codex pair, which half (lib/modelPick.ts).
    expect(read('components', 'ClaudeReviewTab.tsx')).toMatch(/label=\{pairRunningLabel\(aiProviderName\(liveProvider\), status\?\.pair\?\.role \?\? null, phase\)\}/);
    expect(read('components', 'ClaudeReviewTab.tsx')).toMatch(/aiCredentialWords\(liveProvider\)/);
    // AI Fix's ⓘ names the PICKED provider.
    expect(read('components', 'AiFixTab.tsx')).toMatch(/\{pickedName\} reads the PR's code/);
    expect(read('components', 'AiSetup.tsx')).toMatch(/aiSignInLine\(ai\.provider\)/);
  });

  it('the tab is the feature: "AI Review"', () => {
    expect(read('components', 'PrDetail.tsx')).toMatch(/claude_review: 'AI Review'/);
  });
});
