// THE SESSION MANAGER (docs/SANDBOX.md § Sessions; plan WP7). ONE state machine for a workspace session,
// on top of the pieces WP2–WP6 built: the runtime, the egress proxy, the workspace mirror + seed, the
// services and the agent drivers. The machine serves two SUBJECTS (subject.ts): Implement's story — a
// `story_builds` row (`session_phase` not null) and its `story_build_repos` rows (one per mirrored
// repository; the patch Push applies), `storySubject` below — and AI Fix (fix.ts, an `ai_fixes` row).
//
//   POST start ─► booting ─► ready ⇄ chatting           (each reader message is one chat turn)
//                    │          │ Start build (the ticket is read AGAIN first)
//                    │          ▼
//                    │       building ─► built ⇄ building   (every build-mode turn ends with the patches
//                    │                     │                 extracted and stored per repository)
//                    │                     ▼ Push (the EXISTING push routes)
//                    │                   pushed               (derived on read once every change is pushed)
//                    └─► failed          Discard (any state) ─► discarded
//
// LIMITS: ≤ LIMN_SANDBOX_MAX_SESSIONS sandboxes at once (default 2) — story AND fix sessions, and the
// slots an AI Fix start has reserved; ONE build-mode turn at a time on the machine; a session with no turn
// and no reader action for LIMN_SANDBOX_IDLE_MINUTES (60) is closed.
// A closed session (idle, a restart, the agent ending) KEEPS its stored patches — it can be pushed, or
// RESUMED (booted again from the same bases with the patches applied); with no patch it says the work
// is gone. Every story turn is a reader's click, so the ONE budget gate (review/budget-gate.ts) has
// nothing to gate here; an UNATTENDED AI Fix asks the gate before it starts (coding/ai-fix/manager.ts).
//
// ⚠ THE STREAM GAP: the in-memory session is set in the SAME tick as the claim, before any other await.
// ⚠ Nothing here pushes, posts or writes to the tracker; the host pushes only on the reader's press (or
//   an AI Fix's own push rules, coding/ai-fix/auto-push.ts).
import { and, eq, inArray } from 'drizzle-orm';
import {
  SANDBOX_SESSION_LIVE_PHASES,
  sandboxSessionStatus,
  type AiProviderId,
  type SandboxAgentEvent,
  type SandboxAgentMode,
  type SandboxAgentState,
  type SandboxBootStepKey,
  type SandboxConversationItem,
  type SandboxNetworkEntry,
  type SandboxSessionPhase,
  type SandboxSessionStreamEvent,
  type StoryBuild,
  type StoryBuildCoverage,
} from '@pierre-review/shared';
import type { AgentContext } from '../../review/agent-context.js';
import { storyBuildBaseRef, dropSessionBaseRefs } from '../../coding/story-build/base-refs.js';
import { baseFor, unstackablePrs } from '../../coding/story-build/candidates.js';
import type { StoryBuildTicketPr } from '../../coding/story-build/inputs.js';
import { storyBuildLimits } from '../../coding/story-build/limits.js';
import {
  getStoryBuildRow,
  insertStoryBuild,
  listStoryBuildRepoRows,
  storyBuildRepoNames,
  toStoryBuild,
  updateStoryBuild,
  updateStoryBuildRepo,
  upsertStoryBuildRepo,
  type StoryBuildRepoRow,
  type StoryBuildRow,
  type StoryBuildSeed,
} from '../../coding/story-build/persist.js';
import { isStoryBuildRepoPushing } from '../../coding/story-build/push.js';
import { defaultSandboxSettings, readSandboxSettings, type SandboxSettingsRow } from '../../db/sandbox-settings.js';
import { resolveSandboxAgentChoice, startSandboxAgent, type SandboxAgentChoice, type SandboxAgentDriver, type SandboxUsageSink } from '../drivers/index.js';
import { credentialModeLine } from '../proxy/credentials.js';
import { startEgress, type EgressSession } from '../proxy/egress.js';
import { bootSweepSettled, sandboxRuntime } from '../runtime/index.js';
import { DEFAULT_RESOURCES, type SandboxResources, type SandboxRuntime, type SessionOwner } from '../runtime/types.js';
import { serviceStacksFor, startSessionServices, type SessionServices } from '../services/index.js';
import {
  defaultLayoutPlaces,
  prepareSessionWorkspace,
  readSessionTicket,
  resolveWorkspaceLayout,
  sandboxMountsFor,
  sessionBranch,
  type RepoBaseRequest,
  type SessionTicket,
} from '../workspace/index.js';
import type { LayoutPlaces } from '../workspace/check.js';
import type { MirrorSeams } from '../workspace/mirror.js';
import { ticketMarkdown } from '../workspace/seed.js';
import { sessionLimits } from './limits.js';
import { extractRepoPatch, PatchTooLargeError, restoreRepoPatch } from './patches.js';
import {
  emptySessionState,
  itemForAgentEvent,
  nextId,
  putItem,
  putNetworkEntry,
  readSessionState,
  setBootStep,
  toStoryBuildSession,
  type SessionStateJson,
} from './state.js';
import type { SessionKey, SessionRepoInfo, SessionRowPatch, SessionSubject, SubjectLive } from './subject.js';

export type { SessionRepoInfo } from './subject.js';

// ---- words --------------------------------------------------------------------------------------------

export const RESTART_LINE = 'Limn restarted, so the sandbox closed.';
export const KEPT_LINE = 'Your changes are kept: push them, or resume to keep working.';
export const GONE_LINE = 'Nothing was built, so the work is gone. Start again to keep working.';
export const NO_STORY_LINE = 'There is no story text or criteria to build from.';
export const AGENT_ENDED_LINE = 'The agent stopped.';
export const NO_RUNTIME_LINE = 'No container runtime is running on this computer.';

export const idleLine = (minutes: number): string => `Closed after ${minutes} minutes with nothing happening.`;

/** The build turn's instruction. The ticket and the rules are in the seed; this only starts the work. */
export function buildInstruction(o: { ticketChanged: boolean; extra: string | null }): string {
  const lines = [
    'Start the build now. Implement the ticket in TICKET.md in the repositories of this workspace.',
    "Run each changed repository's own tests, and use limn-svc for the services they need.",
    'Commit your work on the session branch in each repository you change.',
    'End with one line per acceptance criterion: done, partly done or not done, and why.',
  ];
  if (o.ticketChanged) lines.unshift('TICKET.md was read again just now and the acceptance criteria changed. Read it again first.');
  if (o.extra) lines.push('', 'The reader adds:', o.extra);
  return lines.join('\n');
}

// ---- seams ----------------------------------------------------------------------------------------------

export interface SessionDeps {
  runtime(): SandboxRuntime;
  /** The start's cheap DB check (no tracker call): the ticket's key and title, and whether it has a story. */
  storyInputs(ctx: AgentContext, accountId: number, workspaceId: number, ident: string): Promise<{ ticketKey: string; title: string | null; empty: boolean } | null>;
  startEgress: typeof startEgress;
  startAgent: typeof startSandboxAgent;
  startServices: typeof startSessionServices;
  readTicket(ctx: AgentContext, accountId: number, workspaceId: number, ident: string, coverage: StoryBuildCoverage | null): Promise<SessionTicket | null>;
  /** Fill gaps: the latest story check's verdicts (no new check is started). */
  coverage(ctx: AgentContext, accountId: number, ident: string): Promise<StoryBuildCoverage | null>;
  settings(accountId: number, workspaceId: number): Promise<SandboxSettingsRow | null>;
  repos(ctx: AgentContext, accountId: number, repoIds: readonly number[]): Promise<SessionRepoInfo[]>;
  ticketPrs(ctx: AgentContext, accountId: number, ident: string): Promise<StoryBuildTicketPr[]>;
  places(): LayoutPlaces;
  mirrorSeams?: MirrorSeams;
  /** The environment the proxy reads the host's sign-in from. */
  credentialEnv(): NodeJS.ProcessEnv;
  usageSink?: SandboxUsageSink;
  now(): number;
}

const defaultDeps: SessionDeps = {
  runtime: () => sandboxRuntime(),
  async storyInputs(ctx, accountId, workspaceId, ident) {
    const { resolveStoryBuildInputs } = await import('../../coding/story-build/inputs.js');
    return resolveStoryBuildInputs(ctx, accountId, workspaceId, ident);
  },
  startEgress,
  startAgent: startSandboxAgent,
  startServices: startSessionServices,
  readTicket: (ctx, accountId, workspaceId, ident, coverage) => readSessionTicket(ctx, accountId, workspaceId, ident, { coverage }),
  async coverage(ctx, accountId, ident) {
    const { latestTicketCheck, foldCoverage } = await import('../../coding/story-build/coverage.js');
    const check = await latestTicketCheck(ctx, accountId, ident);
    if (check?.assessment == null) return null;
    return foldCoverage({ criteria: [], check, state: 'checked', prs: [], note: null });
  },
  settings: readSandboxSettings,
  async repos(ctx, accountId, repoIds) {
    if (repoIds.length === 0) return [];
    const r = ctx.schema.repos;
    const rows = (await ctx.db
      .select({ repoId: r.id, owner: r.owner, name: r.name, defaultBranch: r.defaultBranch })
      .from(r)
      .where(and(eq(r.accountId, accountId), inArray(r.id, [...new Set(repoIds)])))
      .execute()) as SessionRepoInfo[];
    return rows.sort((a, b) => `${a.owner}/${a.name}`.localeCompare(`${b.owner}/${b.name}`));
  },
  async ticketPrs(ctx, accountId, ident) {
    const { defaultStoryBuildInputSeams } = await import('../../coding/story-build/inputs.js');
    const ids = await defaultStoryBuildInputSeams.ticketPrIds(ctx, accountId, ident).catch(() => []);
    return defaultStoryBuildInputSeams.ticketPrs(ctx, accountId, ids).catch(() => []);
  },
  places: () => defaultLayoutPlaces(),
  credentialEnv: () => process.env,
  now: () => Date.now(),
};

let deps: SessionDeps = defaultDeps;

/** Test seam: replace any dependency (null restores the real ones). */
export function setSessionDepsForTests(d: Partial<SessionDeps> | null): void {
  deps = d == null ? defaultDeps : { ...defaultDeps, ...d };
}

/** The machine's dependencies, for a subject (fix.ts). */
export function sessionDeps(): SessionDeps {
  return deps;
}

// ---- the live sessions ------------------------------------------------------------------------------------

export type Listener = (e: SandboxSessionStreamEvent) => void;

export interface Live extends SubjectLive {
  ctx: AgentContext;
  key: SessionKey;
  subject: SessionSubject;
  accountId: number;
  workspaceId: number;
  owner: SessionOwner;
  choice: SandboxAgentChoice;
  phase: SandboxSessionPhase;
  state: SessionStateJson;
  runtime: SandboxRuntime;
  abort: AbortController;
  resume: boolean;
  egress: EgressSession | null;
  services: SessionServices | null;
  driver: SandboxAgentDriver | null;
  container: string | null;
  layoutRoot: string | null;
  agentState: SandboxAgentState | null;
  /** A turn is running (set in the same tick as the click). */
  turn: boolean;
  lastAgentText: string;
  toolIds: Map<string, string>;
  subs: Set<Listener>;
  idleTimer: ReturnType<typeof setTimeout> | null;
  idleAt: number | null;
  saveTimer: ReturnType<typeof setTimeout> | null;
  closing: boolean;
  closed: Promise<void> | null;
}

const live = new Map<SessionKey, Live>();
/** Slots an AI Fix start holds while it reads GitHub and writes its row (counted in the cap). */
const reserved = new Set<SessionKey>();
/** The ONE build-mode turn on this machine (owner decision 3 of STORY-BUILD), story or fix. */
let building: SessionKey | null = null;

const storyKey = (id: number): SessionKey => `story:${id}`;
const iso = (ms: number): string => new Date(ms).toISOString();

function emit(l: Live, e: SandboxSessionStreamEvent): void {
  for (const fn of [...l.subs]) {
    try {
      fn(e);
    } catch {
      /* a listener's failure is its own */
    }
  }
}

type NewItem = SandboxConversationItem extends infer T ? (T extends SandboxConversationItem ? Omit<T, 'id' | 'at'> & { id?: string } : never) : never;

export function addItem(l: Live, item: NewItem): SandboxConversationItem {
  const full = { ...item, id: item.id ?? nextId(l.state, item.kind[0]!), at: iso(deps.now()) } as SandboxConversationItem;
  putItem(l.state, full);
  emit(l, { type: 'item', item: full });
  scheduleSave(l);
  return full;
}

export const notice = (l: Live, text: string): void => void addItem(l, { kind: 'notice', text });

function step(l: Live, key: SandboxBootStepKey, state: 'running' | 'done' | 'failed' | 'skipped', detail: string | null = null): void {
  emit(l, { type: 'boot', step: setBootStep(l.state, key, state, detail) });
  scheduleSave(l);
}

function scheduleSave(l: Live): void {
  if (l.saveTimer) return;
  l.saveTimer = setTimeout(() => {
    l.saveTimer = null;
    void saveState(l);
  }, 500);
  l.saveTimer.unref?.();
}

async function saveState(l: Live): Promise<void> {
  if (l.saveTimer) {
    clearTimeout(l.saveTimer);
    l.saveTimer = null;
  }
  await l.subject.save(l, { sessionJson: true }).catch((err: unknown) => l.ctx.log.warn({ err }, `sandbox session ${l.key}: saving its state failed`));
}

async function setPhase(l: Live, phase: SandboxSessionPhase, extra: Omit<SessionRowPatch, 'phase' | 'sessionJson'> = {}): Promise<void> {
  l.phase = phase;
  emit(l, { type: 'phase', phase, error: extra.error ?? null });
  try {
    l.subject.onPhase?.(l, phase);
  } catch {
    /* a subject's listener never stops the machine */
  }
  await l.subject.save(l, { phase, sessionJson: true, ...extra });
}

/** The reader acted or a turn ended: the idle clock starts again (it never runs during a turn). */
function touch(l: Live): void {
  if (l.idleTimer) clearTimeout(l.idleTimer);
  l.idleTimer = null;
  l.idleAt = null;
  if (l.closing || l.turn || l.driver == null) return;
  const { idleMs } = sessionLimits();
  l.idleAt = deps.now() + idleMs;
  l.idleTimer = setTimeout(() => void idleClose(l), idleMs);
  l.idleTimer.unref?.();
  void l.subject.save(l, { lastActiveAt: new Date(deps.now()) }).catch(() => {});
}

async function idleClose(l: Live): Promise<void> {
  if (l.closing) return;
  if (l.turn) return touch(l);
  const minutes = Math.round(sessionLimits().idleMs / 60_000);
  const kept = await l.subject.hasStoredWork();
  await closeSession(l, { phase: kept ? keptPhase(l.phase) : 'failed', error: `${idleLine(minutes)} ${kept ? KEPT_LINE : GONE_LINE}` });
}

const keptPhase = (p: SandboxSessionPhase): SandboxSessionPhase => (p === 'pushed' ? 'pushed' : 'built');

/** The start's cheap check: null ⇒ not a ticket Limn knows; `empty` ⇒ no story text and no criteria. */
export function sessionStoryInputs(ctx: AgentContext, accountId: number, workspaceId: number, ident: string): ReturnType<SessionDeps['storyInputs']> {
  return deps.storyInputs(ctx, accountId, workspaceId, ident);
}

/** Sandboxes running now (booting included), plus the slots an AI Fix start holds. */
export function openSessionCount(): number {
  return live.size + reserved.size;
}

export function isSessionLive(buildId: number): boolean {
  return live.has(storyKey(buildId));
}

/** The live session of a key (any subject), or null. */
export function liveSession(key: SessionKey): Live | null {
  return live.get(key) ?? null;
}

/** The session ids the boot sweep and `limn sandbox prune` must keep. */
export function liveSandboxIds(): string[] {
  return [...live.values()].map((l) => l.owner.sessionId);
}

/** Another session's build-mode turn runs (or is reserved): a build here must wait. */
export function buildSlotTaken(key: SessionKey | null = null): boolean {
  return building != null && building !== key;
}

export type ReserveResult = { ok: true } | { ok: false; reason: 'too_many'; message: string } | { ok: false; reason: 'build_busy' };

/**
 * An AI Fix start's slot, taken SYNCHRONOUSLY in the tick of its checks (fix.ts): one of the open
 * sessions and, for a fix that builds at once, THE build slot, held through the boot (its first turn must
 * start the moment the agent is ready). `releaseSessionSlot` on every bail path; `adoptReservation`
 * when the session is registered.
 */
export function reserveSessionSlot(key: SessionKey, o: { build: boolean }): ReserveResult {
  const { maxOpen } = sessionLimits();
  if (live.has(key) || reserved.has(key)) return { ok: false, reason: 'too_many', message: 'This session is already open.' };
  if (openSessionCount() >= maxOpen) return { ok: false, reason: 'too_many', message: tooManyLine(maxOpen) };
  if (o.build && building != null) return { ok: false, reason: 'build_busy' };
  reserved.add(key);
  if (o.build) building = key;
  return { ok: true };
}

/**
 * Would a reservation succeed now? The same rules as `reserveSessionSlot`, nothing taken. For the
 * UNATTENDED callers' pre-checks (auto fix, dependency automation): a busy machine is answered before
 * any claim or GitHub write, and the start's own reservation stays the authority (it may still lose a race).
 */
export function sessionSlotFree(o: { build: boolean }): ReserveResult {
  const { maxOpen } = sessionLimits();
  if (openSessionCount() >= maxOpen) return { ok: false, reason: 'too_many', message: tooManyLine(maxOpen) };
  if (o.build && building != null) return { ok: false, reason: 'build_busy' };
  return { ok: true };
}

/** Move a reservation to the row's own key once the row exists (same tick; the build slot moves too). */
export function rekeySessionSlot(from: SessionKey, to: SessionKey): void {
  if (!reserved.delete(from)) return;
  reserved.add(to);
  if (building === from) building = to;
}

export function releaseSessionSlot(key: SessionKey): void {
  reserved.delete(key);
  if (building === key && !live.get(key)?.turn) building = null;
}

// ---- start ------------------------------------------------------------------------------------------------

export interface StartSessionArgs {
  accountId: number;
  workspaceId: number;
  memberRepoIds: readonly number[];
  ident: string;
  ticketKey: string;
  ticketTitle: string | null;
  action: 'implement' | 'fill_gaps';
  choice: SandboxAgentChoice;
}

export type StartSessionResult =
  | { outcome: 'started'; id: number }
  | { outcome: 'already_open'; id: number }
  | { outcome: 'no_runtime'; message: string }
  | { outcome: 'too_many'; message: string };

export const tooManyLine = (max: number): string => `${max === 1 ? 'A session is' : `${max} sessions are`} already open. Discard one first.`;

const tooMany = (max: number): StartSessionResult => ({ outcome: 'too_many', message: tooManyLine(max) });

function sessionIdFor(prefix: 'sb' | 'fx', rowId: number): string {
  return `${prefix}${rowId}-${Math.random().toString(36).slice(2, 6)}`;
}

/** A new in-memory session (not registered yet: `registerLive`). */
export function newLive(
  ctx: AgentContext,
  subject: SessionSubject,
  o: { accountId: number; workspaceId: number; choice: SandboxAgentChoice; state: SessionStateJson; resume: boolean },
): Live {
  return {
    ctx,
    key: `${subject.kind}:${subject.rowId}` as SessionKey,
    subject,
    accountId: o.accountId,
    workspaceId: o.workspaceId,
    owner: { sessionId: sessionIdFor(subject.idPrefix, subject.rowId), accountId: o.accountId },
    choice: o.choice,
    phase: 'booting',
    state: o.state,
    runtime: deps.runtime(),
    abort: new AbortController(),
    resume: o.resume,
    egress: null,
    services: null,
    driver: null,
    container: null,
    layoutRoot: null,
    agentState: null,
    turn: false,
    lastAgentText: '',
    toolIds: new Map(),
    subs: new Set(),
    idleTimer: null,
    idleAt: null,
    saveTimer: null,
    closing: false,
    closed: null,
  };
}

/** Register a session (a reserved slot becomes its own) and boot it in the background. Same tick. */
export function registerLive(l: Live, memberRepoIds: readonly number[]): void {
  reserved.delete(l.key);
  live.set(l.key, l);
  void boot(l, memberRepoIds);
}

export async function startSession(ctx: AgentContext, a: StartSessionArgs): Promise<StartSessionResult> {
  const { maxOpen } = sessionLimits();
  if (openSessionCount() >= maxOpen) return tooMany(maxOpen);
  const detected = await deps.runtime().detect();
  if (!detected.available) {
    return { outcome: 'no_runtime', message: detected.problem ?? NO_RUNTIME_LINE };
  }
  const claimArgs = {
    accountId: a.accountId,
    workspaceId: a.workspaceId,
    ident: a.ident,
    ticketKey: a.ticketKey,
    ticketTitle: a.ticketTitle,
    wantDiagram: false,
    wantDocs: false,
    provider: a.choice.provider,
    model: a.choice.model,
    session: { effort: a.choice.effort, lastActiveAt: new Date(deps.now()) },
  };
  let claim = await insertStoryBuild(ctx, claimArgs);
  if (claim.outcome === 'already_open') {
    // An OPEN row of the old plan/build flow cannot be continued any more (its routes are gone): close
    // it, once, so the ticket can start a session. A session row is answered as it is.
    const open = await getStoryBuildRow(ctx, a.accountId, claim.id);
    if (open == null || open.sessionPhase != null) return claim;
    await updateStoryBuild(ctx, a.accountId, open.id, { status: 'discarded', phase: null, completedAt: new Date() });
    claim = await insertStoryBuild(ctx, claimArgs);
    if (claim.outcome === 'already_open') return claim;
  }
  const id = claim.id;
  // ⚠ The cap again, in the SAME tick as the claim: two starts may both have passed the first check.
  if (openSessionCount() >= maxOpen) {
    await updateStoryBuild(ctx, a.accountId, id, { sessionPhase: 'discarded', status: 'discarded', completedAt: new Date() });
    return tooMany(maxOpen);
  }
  const subject = storySubject(ctx, { id, accountId: a.accountId, workspaceId: a.workspaceId, ident: a.ident, ticketKey: a.ticketKey });
  const l = newLive(ctx, subject, { accountId: a.accountId, workspaceId: a.workspaceId, choice: a.choice, state: emptySessionState(a.action), resume: false });
  registerLive(l, a.memberRepoIds);
  return { outcome: 'started', id };
}

// ---- boot -------------------------------------------------------------------------------------------------

export class SessionFail extends Error {}

function resourcesOf(s: SandboxSettingsRow): SandboxResources {
  return {
    cpus: s.resources.cpus ?? DEFAULT_RESOURCES.cpus,
    memoryBytes: s.resources.memoryGb != null ? s.resources.memoryGb * 1024 ** 3 : DEFAULT_RESOURCES.memoryBytes,
    pids: DEFAULT_RESOURCES.pids,
    diskBytes: s.resources.diskGb != null ? s.resources.diskGb * 1024 ** 3 : DEFAULT_RESOURCES.diskBytes,
  };
}

export const criteriaLines = (t: SessionTicket): string[] => t.criteria.map((c) => `AC${c.n}: ${c.text.replace(/\s+/g, ' ').trim()}`);
export const openPointLines = (t: SessionTicket): string[] => t.openPoints.map((p) => p.text.replace(/\s+/g, ' ').trim()).filter((x) => x !== '');

/** The frozen story Push reads (`seed_json`, the old flow's v1 shape). Never on the wire. */
function seedJsonOf(t: SessionTicket): StoryBuildSeed {
  return {
    version: 1,
    story: { key: t.key, title: t.title, text: t.description, url: t.url },
    criteria: t.criteria.map((c) => ({ n: c.n, text: c.text })),
    comments: t.comments,
    cards: [],
  };
}

function stopIfClosing(l: Live): void {
  if (l.closing || l.abort.signal.aborted) throw new SessionFail('Stopped');
}

async function boot(l: Live, memberRepoIds: readonly number[]): Promise<void> {
  const { ctx, accountId } = l;
  const sub = l.subject;
  const rt = l.runtime;
  let current: SandboxBootStepKey = 'runtime';
  const begin = (k: SandboxBootStepKey, detail: string | null = null): void => {
    current = k;
    step(l, k, 'running', detail);
  };
  try {
    await bootSweepSettled();
    stopIfClosing(l);
    begin('runtime');
    const detected = await rt.detect();
    if (!detected.available) throw new SessionFail(detected.problem ?? NO_RUNTIME_LINE);
    l.state.runtimeNote = detected.licenceNote;
    await sub.save(l, { runtime: detected.kind, sandboxRef: l.owner.sessionId });
    step(l, 'runtime', 'done', detected.flavour);
    stopIfClosing(l);

    begin('image');
    const image = await rt.ensureImage({ onProgress: (p) => step(l, 'image', 'running', p.line), signal: l.abort.signal });
    step(l, 'image', 'done', image.source === 'local' ? null : image.source);
    stopIfClosing(l);

    begin(sub.bootStep);
    const subjectDetail = await sub.readSubject(l);
    step(l, sub.bootStep, 'done', subjectDetail);
    stopIfClosing(l);

    const settings = (await deps.settings(accountId, l.workspaceId)) ?? defaultSandboxSettings(l.workspaceId);
    const repos = await deps.repos(ctx, accountId, await sub.repoIds(memberRepoIds));
    if (repos.length === 0) throw new SessionFail('No repository in this workspace to work in.');
    const places = deps.places();
    const resolved = resolveWorkspaceLayout(
      repos.map((r) => ({ repoId: r.repoId, owner: r.owner, name: r.name })),
      { localFolder: settings.localFolder, memoryProjects: settings.memoryProjects, startDir: settings.startDir },
      places,
    );
    if (resolved.problem) l.state.notes.push(resolved.problem);
    const layout = resolved.layout;

    begin('network');
    const net = await rt.createNetwork(l.owner);
    const volume = await rt.createVolume(l.owner, 'ws');
    step(l, 'network', 'done');
    stopIfClosing(l);

    begin('proxy');
    const egress = await deps.startEgress({
      runtime: rt,
      owner: l.owner,
      workspaceId: l.workspaceId,
      image: image.ref,
      network: net.name,
      provider: l.choice.provider,
      globalProxyEnv: settings.globalProxyEnv,
      env: deps.credentialEnv(),
      onNetwork: (e) => {
        const entry: SandboxNetworkEntry = e;
        putNetworkEntry(l.state, entry);
        emit(l, { type: 'network', entry });
        scheduleSave(l);
      },
    });
    l.egress = egress;
    if (egress.credentialProblem) throw new SessionFail(egress.credentialProblem);
    l.state.credentialLine = credentialModeLine(l.choice.provider, egress.credentialMode);
    step(l, 'proxy', 'done');
    stopIfClosing(l);

    begin('sandbox');
    const { mounts, workdir } = sandboxMountsFor(layout, volume);
    const box = await rt.startSandbox({ ...l.owner, image: image.ref, network: net.name, env: egress.sandboxEnv, mounts, resources: resourcesOf(settings), workdir });
    l.container = box.name;
    l.layoutRoot = layout.root;
    step(l, 'sandbox', 'done');
    stopIfClosing(l);

    const { bases, labels: baseLabels } = await sub.bases(l, repos);

    begin('repos');
    const branch = sub.branch();
    const prepared = await prepareSessionWorkspace(rt, box.name, {
      resolved,
      places,
      bases,
      baseLabels,
      branch,
      ...sub.seed(layout),
      userClaudeMd: settings.userClaudeMd,
      userSkills: settings.userSkills,
      ...(deps.mirrorSeams ? { seams: deps.mirrorSeams } : {}),
      onProgress: (line) => step(l, current, 'running', line),
      signal: l.abort.signal,
      services: async (mirror) => {
        step(l, 'repos', 'done', `${mirror.repos.length} of ${layout.repos.length} cloned`);
        const { stacks, notes } = serviceStacksFor(settings.services, mirror.repos);
        l.state.notes.push(...notes);
        if (stacks.length === 0) {
          step(l, 'services', 'skipped', 'None picked in Settings.');
          return null;
        }
        // microsandbox: Docker would run INSIDE the VM (services/dind.ts), and the image has no
        // Docker Engine yet (docs/SANDBOX.md § microsandbox).
        if (rt.kind === 'microsandbox') {
          step(l, 'services', 'skipped', 'Services do not run on microsandbox yet. Use Docker for integration tests.');
          return null;
        }
        begin('services');
        l.services = await deps.startServices({
          runtime: rt,
          owner: l.owner,
          sandbox: box.name,
          network: net.name,
          workspaceRoot: layout.root,
          workspaceVolume: volume,
          stacks,
          serverVersion: detected.serverVersion,
          onStatus: (s) => {
            l.state.services = s;
            emit(l, { type: 'services', status: s });
            scheduleSave(l);
          },
          onProblem: (line) => notice(l, line),
        });
        const inv = await l.services.inventory();
        l.state.services = l.services.status();
        step(l, 'services', 'done', `${inv.length} services`);
        begin('repos', 'Writing the session notes');
        return inv;
      },
    });
    l.state.notes.push(...prepared.notes);
    l.state.startDir = layout.startDir;
    l.state.repos = prepared.mirror.repos.map((r) => ({ repoId: r.repoId, fullName: r.fullName, path: r.path, branch, baseSha: r.sha }));
    if (prepared.mirror.repos.length === 0) throw new SessionFail('No repository could be cloned.');
    await sub.afterMirror(l, prepared.mirror, bases);
    step(l, 'repos', 'done', `${prepared.mirror.repos.length} of ${layout.repos.length} cloned`);
    stopIfClosing(l);

    if (l.resume) {
      begin('patches');
      const n = await sub.restore(l, prepared.mirror);
      step(l, 'patches', 'done', `${n} repositories`);
    }

    begin('agent');
    const startDir = layout.startDir;
    const paths = prepared.mirror.repos.map((r) => r.path);
    const mode: SandboxAgentMode = sub.startMode(l);
    const driver = await deps.startAgent({
      runtime: rt,
      container: box.name,
      cwd: startDir,
      choice: l.choice,
      env: egress.sandboxEnv,
      systemPrompt: prepared.seed.systemPrompts[l.choice.provider],
      addDirs: paths.filter((p) => !(p === startDir || p.startsWith(`${startDir}/`))),
      repoDirs: paths,
      mode,
      maxTurns: sub.maxTurns,
      ...(sub.maxBudgetUsd != null ? { maxBudgetUsd: sub.maxBudgetUsd } : {}),
      usage: { accountId, ...sub.usage },
      ...(deps.usageSink ? { usageSink: deps.usageSink } : {}),
      beforeTurn: () => egress.refreshCredentials(),
      onEvent: (e) => onAgentEvent(l, e),
      codexAuthJson: egress.codexAuthJson,
    });
    l.driver = driver;
    l.state.mode = driver.mode();
    void driver.exited.then(() => {
      if (!l.closing) void agentEnded(l);
    });
    await sub.save(l, { agentRef: driver.agentRef() });
    step(l, 'agent', 'done');
    if (l.closing) return void (await reapAfterClose(l));
    if (l.resume) notice(l, 'The session was booted again with your stored changes.');
    const first = l.resume ? null : (sub.firstTurn?.(l) ?? null);
    if (first) {
      // THE FIRST TURN (an AI Fix's Start / Plan first): the claim in this same tick; the build slot was
      // reserved at the start (reserveSessionSlot) and is this session's.
      await sub.save(l, { error: null, startedAt: new Date(deps.now()) });
      if (l.closing) return void (await reapAfterClose(l));
      if (first.build && buildSlotTaken(l.key)) {
        notice(l, 'Another session is building. Send a message to start the fix when it is done.');
        await setPhase(l, 'built');
        touch(l);
        return;
      }
      l.turn = true;
      if (first.build) building = l.key;
      addItem(l, { kind: 'reader', text: first.readerText, build: first.build });
      runTurn(l, { build: first.build, text: first.text });
      return;
    }
    await setPhase(l, l.resume || mode === 'build' ? 'built' : 'ready', { error: null, startedAt: new Date(deps.now()) });
    touch(l);
  } catch (err) {
    if (l.closing) return void (await reapAfterClose(l));
    const message = err instanceof SessionFail ? err.message : scrub(err);
    if (!(err instanceof SessionFail)) ctx.log.warn({ err }, `sandbox session ${l.key}: boot failed`);
    step(l, current, 'failed', message);
    const kept = await sub.hasStoredWork().catch(() => false);
    await closeSession(l, { phase: kept ? 'built' : 'failed', error: kept ? `${message} ${KEPT_LINE}` : message });
  }
}

export function scrub(err: unknown): string {
  const m = err instanceof Error ? err.message : String(err);
  return m.replace(/https?:\/\/[^@\s/]*@/g, 'https://').split('\n').slice(0, 2).join(' ').slice(0, 300) || 'The session could not start.';
}

// ---- the agent's events -----------------------------------------------------------------------------------

function onAgentEvent(l: Live, e: SandboxAgentEvent): void {
  if (e.type === 'status') {
    l.agentState = e.state;
    l.state.mode = e.mode;
    emit(l, { type: 'agent', event: e });
    return;
  }
  if (e.type === 'text' && e.partial) {
    emit(l, { type: 'agent', event: e });
    return;
  }
  if (e.type === 'text' && e.text.trim() !== '') l.lastAgentText = e.text;
  const item = itemForAgentEvent(l.state, e, iso(deps.now()), l.toolIds);
  if (item) {
    emit(l, { type: 'item', item });
    scheduleSave(l);
  }
}

async function agentEnded(l: Live): Promise<void> {
  if (l.closing) return;
  if (l.state.mode === 'build' && l.container) await l.subject.afterBuildTurn(l).catch(() => {});
  const kept = await l.subject.hasStoredWork().catch(() => false);
  await closeSession(l, { phase: kept ? keptPhase(l.phase) : 'failed', error: `${AGENT_ENDED_LINE} ${kept ? KEPT_LINE : GONE_LINE}` });
}

// ---- turns --------------------------------------------------------------------------------------------------

export type SessionActionResult =
  | { status: 'queued'; id: number }
  | { status: 'not_found' }
  | { status: 'not_live'; message: string }
  | { status: 'agent_busy' }
  | { status: 'build_busy' }
  | { status: 'not_ready'; message: string };

/**
 * The live session behind an action, or why not. `rowExists` reads the subject's row (account-scoped):
 * false ⇒ not_found (another account's id, or a row that is not a session).
 */
export async function liveFor(key: SessionKey, accountId: number, rowExists: () => Promise<boolean>): Promise<Live | SessionActionResult> {
  const l = live.get(key);
  if (l && l.accountId === accountId) {
    if (l.closing) return { status: 'not_live', message: 'This session is closing.' };
    if (l.driver == null) return { status: 'not_live', message: 'The session is still starting.' };
    return l;
  }
  if (!(await rowExists())) return { status: 'not_found' };
  return { status: 'not_live', message: 'This session is closed.' };
}

export const isLive = (x: Live | SessionActionResult): x is Live => (x as Live).key != null;

/**
 * One turn. The CLAIM (`l.turn`, and `building` for a build turn) is taken by the caller in the same
 * tick as its checks; this runs `text` (Start build's ticket read), the turn, then — for a build turn —
 * the subject's store step, and settles the phase.
 */
function runTurn(l: Live, o: { build: boolean; text: () => Promise<string> }): void {
  void (async () => {
    let after: 'keep' | 'close' = 'keep';
    try {
      await setPhase(l, o.build ? 'building' : 'chatting');
      const text = await o.text();
      if (l.closing || l.driver == null) return;
      if (o.build) await l.subject.beforeBuildTurn?.(l);
      l.lastAgentText = '';
      const end = await l.driver.send(text);
      await l.subject.addSpend(l, end.mode, end.usage).catch(() => {});
    } catch (err) {
      if (!l.closing) addItem(l, { kind: 'error', code: 'session', text: scrub(err) });
    } finally {
      try {
        if (o.build && !l.closing && l.container) after = await l.subject.afterBuildTurn(l);
      } catch (err) {
        if (!l.closing) addItem(l, { kind: 'error', code: 'session', text: scrub(err) });
      }
      l.turn = false;
      if (building === l.key) building = null;
      if (!l.closing) {
        if (after === 'close') {
          await closeSession(l, { phase: 'built', error: null }).catch(() => {});
        } else {
          const next: SandboxSessionPhase = o.build || l.phase === 'built' ? 'built' : 'ready';
          await setPhase(l, next).catch(() => {});
          touch(l);
        }
      }
    }
  })();
}

/** One reader message: a chat turn, or (after Start build) a build turn. Any subject. */
export async function messageSession(key: SessionKey, accountId: number, text: string, rowExists: () => Promise<boolean>): Promise<SessionActionResult> {
  const l = await liveFor(key, accountId, rowExists);
  if (!isLive(l)) return l;
  const busy = l.subject.busyReason?.() ?? null;
  if (busy) return { status: 'not_ready', message: busy };
  if (l.turn || l.driver!.busy()) return { status: 'agent_busy' };
  const build = l.driver!.mode() === 'build';
  if (build && buildSlotTaken(key)) return { status: 'build_busy' };
  // THE CLAIM, synchronously.
  l.turn = true;
  if (build) building = key;
  touch(l);
  addItem(l, { kind: 'reader', text, build: false });
  const sent = build && l.subject.followUpText ? l.subject.followUpText(l, text) : text;
  runTurn(l, { build, text: async () => sent });
  return { status: 'queued', id: l.subject.rowId };
}

/** Start build (Implement) / Start fix (AI Fix, Plan first): the driver switches, then one build turn. */
export async function buildSession(key: SessionKey, accountId: number, extra: string | null, rowExists: () => Promise<boolean>, readerText = 'Start build'): Promise<SessionActionResult> {
  const l = await liveFor(key, accountId, rowExists);
  if (!isLive(l)) return l;
  const busy = l.subject.busyReason?.() ?? null;
  if (busy) return { status: 'not_ready', message: busy };
  if (l.driver!.mode() === 'build') return { status: 'not_ready', message: 'The build has started. Send the agent a message instead.' };
  if (l.turn || l.driver!.busy()) return { status: 'agent_busy' };
  if (buildSlotTaken(key)) return { status: 'build_busy' };
  l.turn = true;
  building = key;
  touch(l);
  addItem(l, { kind: 'reader', text: extra ?? readerText, build: true });
  runTurn(l, {
    build: true,
    text: async () => {
      const instruction = await l.subject.buildInstruction(l, extra);
      await l.driver!.startBuild();
      l.state.mode = 'build';
      return instruction;
    },
  });
  return { status: 'queued', id: l.subject.rowId };
}

export async function interruptLive(key: SessionKey, accountId: number, rowExists: () => Promise<boolean>): Promise<{ status: 'stopping' } | { status: 'idle' } | SessionActionResult> {
  const l = await liveFor(key, accountId, rowExists);
  if (!isLive(l)) return l;
  touch(l);
  if (!l.turn && !l.driver!.busy()) return { status: 'idle' };
  await l.driver!.interrupt();
  return { status: 'stopping' };
}

export async function allowLiveHost(
  key: SessionKey,
  accountId: number,
  rule: string,
  scope: 'session' | 'workspace',
  rowExists: () => Promise<boolean>,
): Promise<{ status: 'allowed'; rule: string } | { status: 'refused'; reason: string } | SessionActionResult> {
  const l = await liveFor(key, accountId, rowExists);
  if (!isLive(l)) return l;
  if (!l.egress) return { status: 'not_live', message: 'The session is still starting.' };
  touch(l);
  const r = await l.egress.allow(rule, scope);
  if (!r.ok) return { status: 'refused', reason: r.reason };
  notice(l, scope === 'workspace' ? `${r.rule} is allowed in this workspace from now on.` : `${r.rule} is allowed for this session.`);
  return { status: 'allowed', rule: r.rule };
}

// ---- story: the turns -------------------------------------------------------------------------------------

const storyRowExists = (ctx: AgentContext, accountId: number, buildId: number) => async (): Promise<boolean> => {
  const row = await getStoryBuildRow(ctx, accountId, buildId);
  return row != null && row.sessionPhase != null;
};

export function sendSessionMessage(ctx: AgentContext, accountId: number, buildId: number, text: string): Promise<SessionActionResult> {
  return messageSession(storyKey(buildId), accountId, text, storyRowExists(ctx, accountId, buildId));
}

export function startSessionBuild(ctx: AgentContext, accountId: number, buildId: number, extra: string | null): Promise<SessionActionResult> {
  return buildSession(storyKey(buildId), accountId, extra, storyRowExists(ctx, accountId, buildId));
}

export function interruptSession(ctx: AgentContext, accountId: number, buildId: number): Promise<{ status: 'stopping' } | { status: 'idle' } | SessionActionResult> {
  return interruptLive(storyKey(buildId), accountId, storyRowExists(ctx, accountId, buildId));
}

export function allowSessionHost(
  ctx: AgentContext,
  accountId: number,
  buildId: number,
  rule: string,
  scope: 'session' | 'workspace',
): Promise<{ status: 'allowed'; rule: string } | { status: 'refused'; reason: string } | SessionActionResult> {
  return allowLiveHost(storyKey(buildId), accountId, rule, scope, storyRowExists(ctx, accountId, buildId));
}

// ---- closing ---------------------------------------------------------------------------------------------------

export async function closeSession(l: Live, o: { phase: SandboxSessionPhase; error: string | null }): Promise<void> {
  if (l.closed) return l.closed;
  l.closing = true;
  l.closed = (async () => {
    l.abort.abort();
    if (l.idleTimer) clearTimeout(l.idleTimer);
    l.idleTimer = null;
    l.idleAt = null;
    await l.driver?.close().catch(() => {});
    await l.services?.close().catch(() => {});
    if (l.egress) {
      for (const e of l.egress.log.snapshot()) putNetworkEntry(l.state, e);
      l.egress.close();
    }
    await l.runtime.destroy(l.owner.sessionId).catch((err: unknown) => l.ctx.log.warn({ err }, `sandbox session ${l.key}: removing it failed`));
    if (building === l.key) building = null;
    if (o.error) addItem(l, { kind: 'notice', text: o.error });
    if (l.saveTimer) clearTimeout(l.saveTimer);
    l.saveTimer = null;
    const ended = o.phase === 'discarded' || o.phase === 'failed';
    await setPhase(l, o.phase, { sandboxRef: null, error: o.error, ...(ended ? { completedAt: new Date(deps.now()) } : {}) }).catch((err: unknown) =>
      l.ctx.log.warn({ err }, `sandbox session ${l.key}: recording its close failed`),
    );
    live.delete(l.key);
    await l.subject.onClosed?.(l, o.phase).catch((err: unknown) => l.ctx.log.warn({ err }, `sandbox session ${l.key}: after its close`));
    emit(l, { type: 'done' });
    l.subs.clear();
  })();
  return l.closed;
}

/**
 * A session closed WHILE its boot was inside a step that cannot be cancelled (creating the network, the
 * proxy, the sandbox, starting the agent): the close's `destroy` may have run before that step made its
 * resource. Once the close has settled, everything the boot made is removed again.
 */
async function reapAfterClose(l: Live): Promise<void> {
  await l.closed?.catch(() => {});
  await l.driver?.close().catch(() => {});
  await l.services?.close().catch(() => {});
  l.egress?.close();
  await l.runtime.destroy(l.owner.sessionId).catch((err: unknown) => l.ctx.log.warn({ err }, `sandbox session ${l.key}: removing it failed`));
}

export async function discardSession(ctx: AgentContext, accountId: number, buildId: number): Promise<{ status: 'discarded' | 'not_ready' | 'not_found' }> {
  const row = await getStoryBuildRow(ctx, accountId, buildId);
  if (row == null) return { status: 'not_found' };
  const repos = await listStoryBuildRepoRows(ctx, accountId, buildId);
  if (repos.some((r) => isStoryBuildRepoPushing(r.id))) return { status: 'not_ready' };
  if (row.sessionPhase == null) {
    // A row of the old plan/build flow: its own discard (kept worktrees, refs).
    const { discardLegacyStoryBuild } = await import('../../coding/story-build/legacy.js');
    return discardLegacyStoryBuild(ctx, accountId, buildId);
  }
  const l = live.get(storyKey(buildId));
  if (l && l.accountId === accountId) await closeSession(l, { phase: 'discarded', error: null });
  else if (row.sessionPhase !== 'discarded') {
    await updateStoryBuild(ctx, accountId, buildId, { sessionPhase: 'discarded', status: 'discarded', sandboxRef: null, completedAt: new Date(deps.now()) });
  }
  const names = await storyBuildRepoNames(ctx, accountId, repos.map((r) => r.repoId));
  await dropSessionBaseRefs([...names.values()], buildId).catch(() => {});
  return { status: 'discarded' };
}

// ---- resume -------------------------------------------------------------------------------------------------------

export type ResumeResult = SessionActionResult | { status: 'no_runtime'; message: string } | { status: 'too_many'; message: string } | { status: 'not_resumable'; message: string };

/** Resume's shared checks, then the boot (any subject). The caller checked the row is resumable. */
export async function resumeLive(make: () => Live): Promise<ResumeResult | null> {
  const { maxOpen } = sessionLimits();
  if (openSessionCount() >= maxOpen) return { status: 'too_many', message: tooManyLine(maxOpen) };
  const detected = await deps.runtime().detect();
  if (!detected.available) return { status: 'no_runtime', message: detected.problem ?? NO_RUNTIME_LINE };
  const l = make();
  if (live.has(l.key) || openSessionCount() >= maxOpen) return { status: 'not_ready', message: 'This session is running.' };
  live.set(l.key, l);
  await setPhase(l, 'booting', { error: null, completedAt: null });
  void boot(l, []);
  return null;
}

export async function resumeSession(ctx: AgentContext, accountId: number, buildId: number): Promise<ResumeResult> {
  const row = await getStoryBuildRow(ctx, accountId, buildId);
  if (row == null || row.sessionPhase == null) return { status: 'not_found' };
  if (live.has(storyKey(buildId))) return { status: 'not_ready', message: 'This session is running.' };
  if (!(row.sessionPhase === 'built' || row.sessionPhase === 'pushed') || !(await storyHasPatches(ctx, accountId, buildId))) {
    return { status: 'not_resumable', message: 'Only a session with stored changes can be resumed. Start again instead.' };
  }
  const provider: AiProviderId = row.provider === 'codex' ? 'codex' : 'claude';
  const choice = resolveSandboxAgentChoice({ provider, model: row.model ?? 'claude-sonnet-5' });
  const r = await resumeLive(() => {
    const state = readSessionState(row.sessionJson);
    state.boot = [];
    state.services = null;
    return newLive(ctx, storySubject(ctx, row), { accountId: row.accountId, workspaceId: row.workspaceId, choice, state, resume: true });
  });
  return r ?? { status: 'queued', id: buildId };
}

// ---- the wire and the stream ------------------------------------------------------------------------------------

/**
 * The wire session: the old `StoryBuild` shape (repositories, patches flags, spend) plus `session`.
 * A session whose every change is pushed is recorded `pushed` here (the push routes are the old ones).
 */
export async function sessionWire(ctx: AgentContext, accountId: number, row: StoryBuildRow): Promise<StoryBuild> {
  let repos = await listStoryBuildRepoRows(ctx, accountId, row.id);
  const l = live.get(storyKey(row.id));
  if (row.sessionPhase === 'built' && pushedEverything(repos)) {
    await updateStoryBuild(ctx, accountId, row.id, { sessionPhase: 'pushed', status: sandboxSessionStatus('pushed') });
    row = { ...row, sessionPhase: 'pushed' };
    if (l && l.phase === 'built') l.phase = 'pushed';
    repos = await listStoryBuildRepoRows(ctx, accountId, row.id);
  }
  const names = await storyBuildRepoNames(ctx, accountId, repos.map((r) => r.repoId));
  const base = toStoryBuild(row, repos, { repoNames: names, sessionBudgetUsd: storyBuildLimits().sessionBudgetUsd });
  const state = l ? l.state : readSessionState(row.sessionJson);
  const session = toStoryBuildSession(
    { ...row, sessionPhase: l ? l.phase : row.sessionPhase },
    state,
    l ? liveFactsOf(l) : null,
    repos.some((r) => (r.patch ?? '') !== ''),
  );
  return { ...base, session };
}

/** The live facts the wire mapper reads (agent state, the idle close time). */
export function liveFactsOf(l: Live): { agentState: SandboxAgentState | null; idleCloseAt: string | null } {
  return { agentState: l.agentState, idleCloseAt: l.idleAt != null ? iso(l.idleAt) : null };
}

const pushedEverything = (repos: readonly StoryBuildRepoRow[]): boolean =>
  repos.some((r) => r.status === 'pushed') && !repos.some((r) => r.include && r.status === 'ready');

/** Follow a live session (any subject): every frame until `done`; null when it is not live. */
export function subscribeLive(key: SessionKey, accountId: number, fn: Listener): (() => void) | null {
  const l = live.get(key);
  if (!l || l.accountId !== accountId || l.closing) return null;
  l.subs.add(fn);
  return () => l.subs.delete(fn);
}

/**
 * Follow a session: the listener gets every frame until `done`. Returns null when the session is not
 * live (the route then sends one snapshot and ends).
 */
export function subscribeSession(buildId: number, accountId: number, fn: Listener): (() => void) | null {
  return subscribeLive(storyKey(buildId), accountId, fn);
}

// ---- restart ---------------------------------------------------------------------------------------------------------

/** A restart's line for one closed session, and its boot steps settled (any subject). Pure on `state`. */
export function restartState(raw: unknown, kept: boolean): { state: SessionStateJson; error: string } {
  const error = `${RESTART_LINE} ${kept ? KEPT_LINE : GONE_LINE}`;
  const state = readSessionState(raw);
  putItem(state, { kind: 'notice', id: nextId(state, 'n'), text: error, at: iso(Date.now()) });
  for (const s of state.boot) if (s.state === 'running') s.state = 'failed';
  return { state, error };
}

/**
 * A restart cut every sandbox off (the boot sweep removes what is left): a session that was live is
 * `built` when it has stored patches (pushable, resumable) and `failed` without. Every account's rows.
 */
export async function reconcileSessionsOnStartup(ctx: AgentContext): Promise<number> {
  const b = ctx.schema.storyBuilds;
  const rows = (await ctx.db.select().from(b).where(inArray(b.sessionPhase, [...SANDBOX_SESSION_LIVE_PHASES, 'pushed'])).execute()) as StoryBuildRow[];
  let moved = 0;
  for (const row of rows) {
    if (live.has(storyKey(row.id))) continue;
    const closed = row.sandboxRef == null && (row.sessionPhase === 'built' || row.sessionPhase === 'pushed');
    if (closed) continue;
    const kept = await storyHasPatches(ctx, row.accountId, row.id);
    const phase: SandboxSessionPhase = kept ? (row.sessionPhase === 'pushed' ? 'pushed' : 'built') : 'failed';
    const { state, error } = restartState(row.sessionJson, kept);
    await updateStoryBuild(ctx, row.accountId, row.id, {
      sessionPhase: phase,
      status: sandboxSessionStatus(phase),
      sandboxRef: null,
      error,
      sessionJson: state as unknown as Record<string, unknown>,
      ...(phase === 'failed' ? { completedAt: new Date() } : {}),
    });
    moved += 1;
  }
  if (moved > 0) ctx.log.info(`reconciled ${moved} sandbox session(s) cut off by a restart`);
  return moved;
}

// ---- the story subject -----------------------------------------------------------------------------------------------

async function storyHasPatches(ctx: AgentContext, accountId: number, buildId: number): Promise<boolean> {
  return (await listStoryBuildRepoRows(ctx, accountId, buildId)).some((r) => (r.patch ?? '') !== '' || r.status === 'pushed');
}

/** Implement's subject: the ticket, the bases (the reader's own open ticket PR, else the default branch), one row per repository. */
function storySubject(ctx: AgentContext, row: Pick<StoryBuildRow, 'id' | 'accountId' | 'workspaceId' | 'ident' | 'ticketKey'>): SessionSubject {
  const buildId = row.id;
  const accountId = row.accountId;
  let ticket: SessionTicket | null = null;
  let action: 'implement' | 'fill_gaps' = 'implement';
  let repoRows: StoryBuildRepoRow[] = [];
  const stacked = new Map<number, number | null>();
  const stateOf = (l: SubjectLive): SessionStateJson => (l as Live).state;

  return {
    kind: 'story',
    rowId: buildId,
    idPrefix: 'sb',
    bootStep: 'ticket',
    usage: {},
    maxTurns: sessionLimits().maxTurns,
    async save(l, p) {
      await updateStoryBuild(ctx, accountId, buildId, {
        ...(p.phase ? { sessionPhase: p.phase, status: sandboxSessionStatus(p.phase) } : {}),
        ...(p.sessionJson ? { sessionJson: stateOf(l) as unknown as Record<string, unknown> } : {}),
        ...(p.error !== undefined ? { error: p.error } : {}),
        ...(p.sandboxRef !== undefined ? { sandboxRef: p.sandboxRef } : {}),
        ...(p.agentRef !== undefined ? { agentRef: p.agentRef } : {}),
        ...(p.runtime !== undefined ? { runtime: p.runtime } : {}),
        ...(p.startedAt !== undefined ? { startedAt: p.startedAt } : {}),
        ...(p.completedAt !== undefined ? { completedAt: p.completedAt } : {}),
        ...(p.lastActiveAt !== undefined ? { lastActiveAt: p.lastActiveAt } : {}),
      });
    },
    async addSpend(_l, mode, usage) {
      const r = await getStoryBuildRow(ctx, accountId, buildId);
      if (r == null) return;
      const cost = usage?.costUsd ?? null;
      await updateStoryBuild(ctx, accountId, buildId, {
        ...(cost != null && mode === 'chat' ? { planCostUsd: (r.planCostUsd ?? 0) + cost } : {}),
        ...(cost != null && mode === 'build' ? { buildCostUsd: (r.buildCostUsd ?? 0) + cost } : {}),
        inputTokens: (r.inputTokens ?? 0) + (usage?.inputTokens ?? 0),
        outputTokens: (r.outputTokens ?? 0) + (usage?.outputTokens ?? 0),
        numTurns: (r.numTurns ?? 0) + 1,
      });
    },
    hasStoredWork: () => storyHasPatches(ctx, accountId, buildId),
    async readSubject(l) {
      const state = stateOf(l);
      action = state.action === 'fill_gaps' ? 'fill_gaps' : 'implement';
      const coverage = state.action === 'fill_gaps' ? await deps.coverage(ctx, accountId, row.ident).catch(() => null) : null;
      ticket = await deps.readTicket(ctx, accountId, l.workspaceId, row.ident, coverage);
      if (ticket == null) throw new SessionFail(NO_STORY_LINE);
      state.criteria = criteriaLines(ticket);
      state.openPoints = openPointLines(ticket);
      await updateStoryBuild(ctx, accountId, buildId, {
        ticketTitle: ticket.title || null,
        criteriaSource: ticket.criteriaSource,
        criteriaJson: ticket.criteria.map((c) => ({ n: c.n, text: c.text })),
        coverageJson: coverage,
        seedJson: seedJsonOf(ticket),
      });
      return ticket.fresh ? null : 'The tracker could not be read; this is Limn’s stored copy.';
    },
    async repoIds(memberRepoIds) {
      repoRows = await listStoryBuildRepoRows(ctx, accountId, buildId);
      // A resumed session keeps every repository it stored work for.
      return [...new Set([...memberRepoIds, ...repoRows.map((r) => r.repoId)])];
    },
    async bases(l, repos) {
      // The bases: today's rules (the reader's own open ticket PR, else the default branch); a resumed
      // session keeps the commits its patches were made on.
      const prs = l.resume ? [] : await deps.ticketPrs(ctx, accountId, row.ident).catch(() => []);
      const infos = repos.map((r) => ({ id: r.repoId, owner: r.owner, name: r.name, defaultBranch: r.defaultBranch }));
      const unstackable = l.resume ? new Map<number, 'fork' | 'unknown'>() : await unstackablePrs(ctx, accountId, infos, prs).catch(() => new Map<number, 'fork' | 'unknown'>());
      const bases = new Map<number, RepoBaseRequest>();
      const labels = new Map<number, { label: string; note: string | null }>();
      for (const r of repos) {
        const stored = repoRows.find((x) => x.repoId === r.repoId);
        const pinRef = storyBuildBaseRef(buildId, r.repoId);
        if (stored) {
          bases.set(r.repoId, { repoId: r.repoId, owner: r.owner, name: r.name, baseRef: stored.baseRef, baseSha: stored.baseSha || null, pinRef });
          labels.set(r.repoId, { label: stored.baseRef === 'HEAD' ? 'the default branch' : stored.baseRef, note: null });
          stacked.set(r.repoId, stored.stackedOnPrId ?? null);
          continue;
        }
        const b = baseFor({ id: r.repoId, defaultBranch: r.defaultBranch }, prs, unstackable);
        bases.set(r.repoId, { repoId: r.repoId, owner: r.owner, name: r.name, baseRef: b.baseRef, baseSha: b.baseSha || null, pinRef });
        labels.set(r.repoId, {
          label: b.stackedOnPrNumber != null ? `your PR #${b.stackedOnPrNumber} (${b.baseRef})` : (r.defaultBranch ?? 'the default branch'),
          note: b.baseNote,
        });
        stacked.set(r.repoId, b.stackedOnPrId);
      }
      return { bases, labels };
    },
    branch: () => sessionBranch(row.ticketKey),
    seed() {
      return { ticket: ticket!, mode: action };
    },
    async afterMirror(_l, mirror, bases) {
      // One row per mirrored repository: the patch Push applies lands here.
      const branch = sessionBranch(row.ticketKey);
      for (const [i, r] of mirror.repos.entries()) {
        const stored = repoRows.find((x) => x.repoId === r.repoId);
        const rowId =
          stored?.id ??
          (await upsertStoryBuildRepo(ctx, {
            accountId,
            buildId,
            repoId: r.repoId,
            ref: `R${i + 1}`,
            buildOrder: i,
            include: true,
            status: 'planned',
            baseRef: bases.get(r.repoId)?.baseRef ?? 'HEAD',
            baseSha: r.sha,
            stackedOnPrId: stacked.get(r.repoId) ?? null,
            branch,
          }));
        await updateStoryBuildRepo(ctx, accountId, rowId, { sandboxPath: r.path });
      }
    },
    async restore(l, mirror) {
      let n = 0;
      for (const rr of repoRows) {
        const at = mirror.repos.find((m) => m.repoId === rr.repoId);
        if (!at || !rr.patch || !l.container) continue;
        await restoreRepoPatch((l as Live).runtime, l.container, at.path, rr.patch, rr.commitMessage?.trim() || `${row.ticketKey}: the work so far`, (n += 1));
      }
      return n;
    },
    startMode: (l) => (l.resume ? 'build' : 'chat'),
    async buildInstruction(l0, extra) {
      // THE TICKET AGAIN (open points and criteria change while a ticket is in flight), into TICKET.md.
      const l = l0 as Live;
      let ticketChanged = false;
      const before = l.state.criteria;
      const fresh = await deps.readTicket(ctx, accountId, l.workspaceId, row.ident, null).catch(() => null);
      if (fresh && l.container && l.layoutRoot) {
        const ticketFile = `${l.layoutRoot.replace(/\/$/, '')}/TICKET.md`;
        await l.runtime.copyIn(l.container, [{ path: ticketFile, content: ticketMarkdown(fresh, l.state.action === 'fill_gaps' ? 'fill_gaps' : 'implement') }]);
        const after = criteriaLines(fresh);
        ticketChanged = JSON.stringify(after) !== JSON.stringify(before);
        if (ticketChanged) {
          notice(l, `The acceptance criteria changed since the session started: there ${after.length === 1 ? 'is' : 'are'} now ${after.length}.`);
          l.state.criteria = after;
        }
        l.state.openPoints = openPointLines(fresh);
        await updateStoryBuild(ctx, accountId, buildId, {
          criteriaJson: fresh.criteria.map((c) => ({ n: c.n, text: c.text })),
          seedJson: seedJsonOf(fresh),
        });
      } else if (fresh == null) {
        notice(l, 'The ticket could not be read again, so the build uses the copy from the start of the session.');
      }
      return buildInstruction({ ticketChanged, extra });
    },
    afterBuildTurn: async (l) => {
      await extractAll(l as Live, buildId);
      return 'keep';
    },
  };
}

async function extractAll(l: Live, buildId: number): Promise<void> {
  const { patchMaxBytes } = sessionLimits();
  const rows = await listStoryBuildRepoRows(l.ctx, l.accountId, buildId);
  const names = await storyBuildRepoNames(l.ctx, l.accountId, rows.map((r) => r.repoId));
  const stored: string[] = [];
  const summary = l.lastAgentText.trim() ? l.lastAgentText.trim().slice(0, 4_000) : null;
  for (const row of rows) {
    if (!row.sandboxPath || row.status === 'pushed' || !l.container) continue;
    const name = names.get(row.repoId) ?? `#${row.repoId}`;
    try {
      const got = await extractRepoPatch(l.runtime, l.container, row.sandboxPath, { maxBytes: patchMaxBytes });
      if (got.patch === '') {
        await updateStoryBuildRepo(l.ctx, l.accountId, row.id, { status: 'skipped', patch: null, patchSha: null, statJson: got.stat, filesChangedJson: [], error: null });
        continue;
      }
      await updateStoryBuildRepo(l.ctx, l.accountId, row.id, {
        status: 'ready',
        patch: got.patch,
        patchSha: got.sha,
        statJson: got.stat,
        filesChangedJson: got.filesChanged,
        commitMessage: got.commitMessage,
        summary,
        provider: l.choice.provider,
        model: l.choice.model,
        effort: l.choice.effort,
        error: null,
        completedAt: new Date(deps.now()),
      });
      stored.push(`${name} (${got.stat.files} ${got.stat.files === 1 ? 'file' : 'files'})`);
    } catch (err) {
      const message = err instanceof PatchTooLargeError ? err.message : scrub(err);
      if (err instanceof PatchTooLargeError) {
        await updateStoryBuildRepo(l.ctx, l.accountId, row.id, { status: 'failed', patch: null, patchSha: null, error: message });
      }
      notice(l, `${name}: ${message}`);
    }
  }
  notice(l, stored.length > 0 ? `Changes stored: ${stored.join(', ')}.` : 'The build changed no files.');
}

// ---- test seams -------------------------------------------------------------------------------------------------------

/** Test seam: wait until no turn runs in any session and every boot has settled. */
export async function _sessionsIdleForTest(timeoutMs = 10_000): Promise<void> {
  const until = Date.now() + timeoutMs;
  const busy = (): boolean => [...live.values()].some((l) => l.turn || (l.driver == null && !l.closing));
  while (busy() && Date.now() < until) await new Promise((r) => setTimeout(r, 10));
}

/** Test seam: close every live session (as a discard would). */
export async function _closeAllSessionsForTest(): Promise<void> {
  await Promise.all([...live.values()].map((l) => closeSession(l, { phase: 'discarded', error: null })));
  reserved.clear();
  building = null;
}

/** Test seam: run the idle teardown of one session now. */
export async function _idleCloseForTest(buildId: number, kind: 'story' | 'fix' = 'story'): Promise<void> {
  const l = live.get(`${kind}:${buildId}` as SessionKey);
  if (l) await idleClose(l);
}
