import type { PeriodReportCostEstimate } from '@pierre-review/shared';
import type { ProContext } from '../contract.js';

// The cheap-tier completion seam for the plugin. It calls the HOST llm seam
// (ctx.llm.complete → review/llm.ts cheapComplete), so the plugin adds NO new
// Anthropic dependency at runtime — the host owns the SDK wiring. A future
// OpenAI-compatible client implements the same `LlmClient` interface.
//
// AUTH — the summary is a Pro feature with its OWN discrete credential (BYOK /
// server-side key). It uses `SUMMARY_ANTHROPIC_API_KEY` when set — passed EXPLICITLY
// to the host seam's raw metered path — so it's fast (no Agent SDK subprocess) and
// completely independent of Claude Review, which keeps preferring the ambient
// subscription. With no summary key set it falls back to the ambient session
// (works out of the box in dev, just slower).
export interface LlmClient {
  complete(req: { system: string; user: string; maxTokens: number }): Promise<{
    text: string;
    inputTokens: number;
    outputTokens: number;
    costUsd: number;
  }>;
}

// The plugin's ONE cheap model. The host seam (review/llm.ts) defaults to the same id, gives it
// effort 'low' and pads its cap for thinking; every plugin caller that names a model names this.
export const HAIKU_MODEL = 'claude-haiku-5-5';

// Its list price is TIERED BY PROMPT LENGTH: $0.10 / 1M input and $0.50 / 1M output for a prompt up
// to 100,000 input tokens, $0.50 / $2.50 above it (the whole request moves tier, output included).
const HAIKU_INPUT_USD_PER_TOKEN = 0.1 / 1_000_000;
const HAIKU_OUTPUT_USD_PER_TOKEN = 0.5 / 1_000_000;
const HAIKU_LONG_PROMPT = {
  aboveInputTokens: 100_000,
  inputUsdPerToken: 0.5 / 1_000_000,
  outputUsdPerToken: 2.5 / 1_000_000,
} as const;

/** The USD cost of one Haiku call, tier included. Exported so every plugin caller prices alike. */
export function haikuCostUsd(inputTokens: number, outputTokens: number): number {
  return priceTokens(REPORT_MODEL_PRICING[HAIKU_MODEL], inputTokens, outputTokens);
}

// The summary's dedicated Anthropic API key. Empty → the ambient fallback.
function summaryApiKey(): string | undefined {
  const k = process.env.SUMMARY_ANTHROPIC_API_KEY;
  return k && k.trim().length > 0 ? k.trim() : undefined;
}

// `localAgent: true` ⇒ LOCALLY the host runs the call on the reader's Claude Code login (the Agent
// SDK) even when the summary key is set — the ONE local route for the one-shot features (the impact
// note, the work-plan wording, the Slack sprint report). The Reports and Bots Monitoring clients
// leave it off and keep the key. Cloud ignores it.
export function makeHaikuClient(ctx: ProContext, opts: { localAgent?: boolean } = {}): LlmClient {
  return {
    async complete(req) {
      const res = await ctx.llm.complete({
        model: undefined, // the host seam's default, HAIKU_MODEL (review/llm.ts)
        system: req.system,
        prompt: req.user,
        maxTokens: req.maxTokens,
        apiKey: summaryApiKey(),
        ...(opts.localAgent ? { localRoute: 'agent' as const } : {}),
      });
      const inputTokens = res.usage?.inputTokens ?? 0;
      const outputTokens = res.usage?.outputTokens ?? 0;
      const costUsd = haikuCostUsd(inputTokens, outputTokens);
      return { text: res.text, inputTokens, outputTokens, costUsd };
    },
  };
}

// ── The period report's MODEL ─────────────────────────────────────────────────────────────────
//
// Every summary feature in this plugin is Haiku-only, INCLUDING this one. The others get
// `makeHaikuClient` above, which passes `model: undefined` so the HOST picks its configured
// default; the period report goes through `makeReportClient` because it must PRICE what it ran
// (the pre-flight quote, the receipt, and the ledger row all name a specific id) — not because it
// offers a choice any more.
//
// ⚠ TWO TABLES, TWO JOBS — and conflating them is the trap this split exists to prevent.
//   · REPORT_MODEL_PRICING is the HISTORY table: every model that has EVER narrated a stored
//     `workspace_period_reports` row, so an old artifact can still be priced and labelled.
//   · REPORT_MODELS is the SELECTION allowlist: what a REQUEST (body `model`,
//     `pro_settings.report_model`, `PRO_REPORT_MODEL`) is permitted to ask for TODAY.
// Retiring a choice removes it from the second and NEVER from the first. The gate used to be
// "is there a pricing row", which welded the two together: dropping Sonnet from the pricing table
// to retire it would have made every stored Sonnet report unpriceable and unlabellable, and
// keeping it there would have left it selectable. `resolveReportModel` now reads REPORT_MODELS.
//
// The model id is still never a free string: it arrives from a request body and from stored
// settings and is handed straight to the metered Anthropic path, so an unvalidated value would let
// a caller name an arbitrarily expensive model on someone else's meter.
//
// Prices are the first-party Anthropic sticker rates per 1M tokens. A pre-flight estimate that
// reads low and then bills higher is the support ticket this feature exists to avoid, so the
// estimate rounds towards over-quoting.
interface ModelPricing {
  inputUsdPerToken: number;
  outputUsdPerToken: number;
  // A prompt-length tier: a request whose input exceeds `aboveInputTokens` pays these rates on
  // BOTH legs. Absent on a flat-priced model.
  longPrompt?: { aboveInputTokens: number; inputUsdPerToken: number; outputUsdPerToken: number };
}

function priceTokens(price: ModelPricing, inputTokens: number, outputTokens: number): number {
  const rates =
    price.longPrompt && inputTokens > price.longPrompt.aboveInputTokens ? price.longPrompt : price;
  return inputTokens * rates.inputUsdPerToken + outputTokens * rates.outputUsdPerToken;
}

const REPORT_MODEL_PRICING = {
  // The current Haiku (the constants above, re-expressed per model so one table prices every
  // model that can appear on a report row).
  'claude-haiku-5-5': {
    inputUsdPerToken: HAIKU_INPUT_USD_PER_TOKEN,
    outputUsdPerToken: HAIKU_OUTPUT_USD_PER_TOKEN,
    longPrompt: HAIKU_LONG_PROMPT,
  },
  // The previous Haiku: $1.00 / 1M input, $5.00 / 1M output. RETIRED AS A CHOICE, KEPT AS A PRICE
  // (see Sonnet below) — reports it narrated are stored and must keep their model name and spend.
  'claude-haiku-4-5': {
    inputUsdPerToken: 1.0 / 1_000_000,
    outputUsdPerToken: 5.0 / 1_000_000,
  },
  // claude-sonnet-5: $3.00 / 1M input, $15.00 / 1M output.
  //
  // ⚠ RETIRED AS A CHOICE, KEPT AS A PRICE. It is absent from REPORT_MODELS, so nothing can
  // select it again; the row stays because reports narrated by it are STORED (one row per
  // (period, model)) and must keep rendering their model name and their spend. Removing it here
  // would break reading HISTORY, which is a different thing from removing a choice. It also keeps
  // `ReportModel` wide enough that the `Record<ReportModel, …>` context/max-token tables in
  // insights/chat*.ts still cover a stored id.
  'claude-sonnet-5': {
    inputUsdPerToken: 3.0 / 1_000_000,
    outputUsdPerToken: 15.0 / 1_000_000,
  },
} as const satisfies Record<string, ModelPricing>;

/** Any model we can PRICE — the union of what is selectable now and what narrated a stored row. */
export type ReportModel = keyof typeof REPORT_MODEL_PRICING;

/**
 * The SELECTABLE models, in the order the picker should show them (cheapest first).
 *
 * ONE entry, deliberately: Haiku narrates every report. The picker hides itself below two options
 * (`choices.length < 2` in PeriodReportsPanel), so this list being a singleton is what removes the
 * control — nothing else needs to know.
 */
export const REPORT_MODELS: ReportModel[] = [HAIKU_MODEL];

/** The account-level default when `pro_settings.report_model` is unset. Mirrors PRO_DIGEST_MODEL's
 *  shape: an env override (host config.ts documents it as `config.pro.reportModel`), otherwise
 *  Haiku. ⚠ THE TWO SPELLINGS MUST AGREE — `config.pro.reportModel` in
 *  `apps/backend/src/config.ts` carries the same literal, and its comment says so back.
 *
 *  It used to be Sonnet, on plan P4.1's argument that a forwarded sprint retro generated ~twice a
 *  month is worth the prose tier's ~3× cost. THAT ARGUMENT IS RETIRED, not forgotten: Haiku
 *  writes this particular artifact — a bounded, heavily-grounded narration over a metric vector
 *  the code already computed — well enough that the difference did not survive reading them side
 *  by side, and one model everywhere is one fewer axis on which a report can differ from the
 *  report someone else forwarded. The env override survives so a deployment can still pin a model,
 *  but it is validated against REPORT_MODELS, so today it can only ever spell Haiku.
 *
 *  ⚠ The model id rides `payloadHashFor` AND the stored row's unique key (period, model), so this
 *  flip is a cache MISS: the next generate of each period bills once and writes a new Haiku row
 *  beside the old Sonnet one. Reads are unaffected in the meantime — `loadStoredReport` falls
 *  through to the narrated row, so a period keeps showing its Sonnet write-up until regenerated.
 *  That one-off re-bill is the intended cost of the flip, not a bug. */
export const DEFAULT_REPORT_MODEL: ReportModel = isReportModel(process.env.PRO_REPORT_MODEL)
  ? process.env.PRO_REPORT_MODEL
  : HAIKU_MODEL;

/** Type guard — the SELECTION gate between an untrusted string and a model a request may ask for.
 *  ⚠ It reads REPORT_MODELS, NOT the pricing table: a retired model is still priceable (stored
 *  rows) and must not be selectable. Every selectable model is priceable, so the narrowing to
 *  `ReportModel` is sound. */
export function isReportModel(raw: string | null | undefined): raw is ReportModel {
  return raw != null && (REPORT_MODELS as readonly string[]).includes(raw);
}

/** An untrusted value → a model a request may select, or null. Callers fall back to their own
 *  default; nothing here throws, because a bad — or RETIRED — stored setting must not break the
 *  free GET. A `pro_settings.report_model` of 'claude-sonnet-5' lands here and degrades to
 *  `DEFAULT_REPORT_MODEL`, which is the whole reason this returns null instead of throwing. */
export function resolveReportModel(raw: string | null | undefined): ReportModel | null {
  return isReportModel(raw) ? raw : null;
}

// USD → credits, MIRRORED from `AI_CREDITS_PER_USD` in @pierre-review/shared. DISPLAY-ONLY: the
// pre-flight estimate for a report generation is quoted in credits. Nothing meters or blocks on it.
const AI_CREDITS_PER_USD = 1250;

/**
 * The pre-flight spend quote for one report generation, and the same maths for the after-the-fact
 * readout. `inputTokens`/`outputTokens` are ESTIMATES at quote time and the REAL usage afterwards,
 * so both readouts are computed by one function and can never disagree about the rates.
 */
export function estimateReportCost(
  model: ReportModel,
  inputTokens: number,
  outputTokens: number,
): PeriodReportCostEstimate {
  const estimatedUsd = priceTokens(REPORT_MODEL_PRICING[model], inputTokens, outputTokens);
  return {
    model,
    // Whole credits, like core's ledger. Rounded UP so a quote never reads cheaper than the run.
    estimatedCredits: Math.ceil(estimatedUsd * AI_CREDITS_PER_USD),
    // 4dp — a report costs cents, and 0.0038 is readable where 0.003812... is not.
    estimatedUsd: Math.round(estimatedUsd * 10_000) / 10_000,
  };
}

/**
 * A completion client pinned to ONE model. Same auth story as `makeHaikuClient` (the summary key,
 * falling back to the ambient session) — the only difference is that the model id is passed
 * EXPLICITLY rather than left to the host default, and the cost is priced from that model's row
 * rather than the Haiku constants.
 *
 * That explicitness is still worth having now that Haiku is the only selectable model: the id it
 * bills under is the id it stores on the report row and quotes in the receipt, so the ledger and
 * the artifact can never name different models. Every runtime caller reaches it through
 * `resolveReportModel`, so `model` is Haiku in practice; the wider `ReportModel` type is what lets
 * a test price a stored Sonnet row.
 *
 * `makeHaikuClient` is untouched and remains the client every other caller uses.
 */
export function makeReportClient(ctx: ProContext, model: ReportModel): LlmClient {
  const price = REPORT_MODEL_PRICING[model];
  return {
    async complete(req) {
      const res = await ctx.llm.complete({
        model,
        system: req.system,
        prompt: req.user,
        maxTokens: req.maxTokens,
        apiKey: summaryApiKey(),
      });
      const inputTokens = res.usage?.inputTokens ?? 0;
      const outputTokens = res.usage?.outputTokens ?? 0;
      const costUsd = priceTokens(price, inputTokens, outputTokens);
      return { text: res.text, inputTokens, outputTokens, costUsd };
    },
  };
}
