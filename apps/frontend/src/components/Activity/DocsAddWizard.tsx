import { useEffect, useId, useMemo, useRef, useState, type DragEvent, type ReactNode } from 'react';
import { FloatingFocusManager, FloatingPortal, useFloating } from '@floating-ui/react';
import {
  REFERENCE_DOC_CRAWL_MAX_DEPTH,
  REFERENCE_DOC_CRAWL_MAX_PAGES,
  REFERENCE_DOC_WIKI_MAX_PAGES,
  WIKI_PROVIDER_NAMES,
  parseGithubRepoName,
  wikiProviderOfUrl,
  type GithubDocsFolder,
  type RepoDocsOffer,
  type RepoDocsUnreadable,
  type WikiCredentialsSettings,
} from '@pierre-review/shared';
import {
  useAddDocsOffers,
  useAddReferenceDocGithub,
  useCheckDocsFolders,
  useAddReferenceDocUrl,
  useAddReferenceDocWikiTree,
  usePreflightGithubDocs,
  usePreflightWikiDocs,
  useUploadReferenceDoc,
  useWikiCredentials,
} from '../../hooks/useReferenceDocs.js';
import { useAiCapabilities } from '../../hooks/useAiCapabilities.js';
import { useRunCostText } from '../../hooks/useAiBudget.js';
import { useRepos } from '../../hooks/useTimeline.js';
import { useMe } from '../../hooks/useTriage.js';
import { closeActivePopover } from '../../lib/activePopover.js';
import { DOC_UPLOAD_ACCEPT, uploadRefusal } from '../../lib/referenceDocs.js';
import { offerFiles, offerLabel, offersAddProblem } from '../../lib/docsOffers.js';
import {
  DOCS_SOURCE_LABEL,
  DOCS_WIZARD_STEPS,
  folderLabel,
  githubReviewSentence,
  nextStep,
  pickedRepoFolders,
  previousStep,
  repoFoldersNote,
  shownUnreadableRepos,
  unreadableRepoText,
  repoFoldersReviewSentence,
  wikiOverCapSentence,
  wikiReviewSentence,
  type DocsSourceType,
  type DocsWizardStep,
} from '../../lib/docsWizard.js';
import { CheckCircleIcon, CloseIcon, ConfluenceIcon, GlobeIcon, NotionIcon, OctocatIcon, RepoIcon, UploadIcon } from '../Icons.js';
import { ConfluenceForm } from '../settings/ConfluenceSection.js';
import { NotionForm } from '../settings/NotionSection.js';
import { inputCls } from '../settings/ui.js';
import { AiRunGate } from '../AiSetup.js';
import { Button, CheckboxBox, RadioBox, Select, TEXT_LINK, FOCUS_RING, cx } from '../ui/index.js';

// THE ADD-DOCUMENTS WIZARD (docs/REFERENCE-DOCS.md § The SPA → Adding), opened by the Library's "+".
//
//   1. the source type: an upload, a web page or site, Confluence, Notion, a GitHub repository, or
//      "From your repositories";
//   2. per type — the files (an upload: chosen or dropped, each SENT AT ONCE, as the Library's old
//      "Choose files" box did; no review step), the address and "links to follow" (web); the connection, then the page (a wiki);
//      the repository, then the folder (GitHub); a checkbox per qualifying docs folder (From your
//      repositories: the docs offer's SAME check, `POST /api/docs/offers/check`, run by Next on the type
//      step; added through the offer's own Add, `from: 'wizard'`);
//   3. the REVIEW: what will be added, COUNTED by the server first ("This will add 12 pages from
//      Payments handbook"), then Start.
//
// ⚠ NOTHING IS READ ON MOUNT. The counts are click-gated mutations (each reads the wiki or GitHub):
// "Next" on the page / repository step runs them. ⚠ A wiki's page step says what it will take: the
// wiki's HOME (a Confluence space, a Notion top-level page) adds the whole wiki; any other page adds it
// and every page below it — never a sibling or an ancestor. Two sections of one wiki are two sources.
//
// ⚠ A REAL DIALOG (InfoModal's pattern): focus trapped, Escape captured, focus handed back on close.

const TYPE_ICON: Record<DocsSourceType, (p: { size: number }) => JSX.Element> = {
  upload: (p) => <UploadIcon {...p} aria-hidden />,
  web: (p) => <GlobeIcon {...p} aria-hidden />,
  confluence: (p) => <ConfluenceIcon {...p} aria-hidden />,
  notion: (p) => <NotionIcon {...p} aria-hidden />,
  github: (p) => <OctocatIcon {...p} aria-hidden />,
  repos: (p) => <RepoIcon {...p} aria-hidden />,
};

const TYPE_HINT: Record<DocsSourceType, string> = {
  upload: 'PDF, Word, text or markdown files from this computer.',
  web: 'One page, or a page and the links it leads to on the same site.',
  confluence: 'A whole space, or one page and every page below it.',
  notion: 'A whole wiki, or one page and every page below it.',
  github: 'The markdown and text documents in a repository or one of its folders.',
  repos: 'The docs folders Limn finds in this workspace’s repositories.',
};

const STEP_TITLE: Record<DocsWizardStep, string> = {
  type: 'What would you like to add?',
  files: 'Which files?',
  address: 'Which page?',
  connection: 'Connection',
  page: 'Which part of the wiki?',
  repo: 'Which repository?',
  folder: 'Which folder?',
  folders: 'Which folders?',
  review: 'Ready to add',
};

/** Is the workspace's wiki connection ready (the server's ladder, mirrored)? */
function wikiReady(type: 'confluence' | 'notion', c: WikiCredentialsSettings | undefined): boolean {
  if (!c) return false;
  if (type === 'notion') return c.notion?.hasToken === true;
  return (c.confluence.hasToken && c.confluence.siteUrl != null) || c.confluence.jiraSite != null;
}

export function DocsAddWizard({
  workspaceId,
  maxBytes,
  onClose,
  initialRepo,
}: {
  workspaceId: number;
  maxBytes: number;
  onClose: () => void;
  /** Open on the GitHub repository step with this `owner/name` filled in (a docs offer's "Choose part of it"). */
  initialRepo?: string;
}): JSX.Element {
  const titleId = useId();
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const { refs, context } = useFloating({ open: true, onOpenChange: (o) => !o && onClose() });
  const [type, setType] = useState<DocsSourceType>(initialRepo != null ? 'github' : 'upload');
  const [step, setStep] = useState<DocsWizardStep>(initialRepo != null ? 'repo' : 'type');
  // Upload: the file being sent, while one is.
  const [sending, setSending] = useState<string | null>(null);
  // Web
  const [url, setUrl] = useState('');
  const [crawlDepth, setCrawlDepth] = useState(0);
  // Wiki
  const [pageUrl, setPageUrl] = useState('');
  // GitHub
  const [repo, setRepo] = useState(initialRepo ?? '');
  const [folder, setFolder] = useState<GithubDocsFolder | null>(null);
  // From your repositories: the ticked folders (offer ids).
  const [picked, setPicked] = useState<ReadonlySet<number>>(() => new Set());
  const [reposProblem, setReposProblem] = useState<string | null>(null);
  const ai = useAiCapabilities();

  const creds = useWikiCredentials(type === 'confluence' || type === 'notion' ? workspaceId : null);
  const wikiCount = usePreflightWikiDocs(workspaceId);
  const repoCount = usePreflightGithubDocs(workspaceId);
  const addUrl = useAddReferenceDocUrl(workspaceId);
  const addWiki = useAddReferenceDocWikiTree(workspaceId);
  const addRepo = useAddReferenceDocGithub(workspaceId);
  const folderCheck = useCheckDocsFolders(workspaceId);
  const addFolders = useAddDocsOffers(workspaceId, 'wizard');
  const adding = type === 'web' ? addUrl : type === 'github' ? addRepo : type === 'repos' ? addFolders : addWiki;
  const repoFolders = folderCheck.data?.folders ?? [];
  const chosenFolders = pickedRepoFolders(repoFolders, picked);

  useEffect(() => {
    closeActivePopover();
  }, []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return;
      // An open listbox / menu inside owns its own Escape.
      if ((e.target as HTMLElement | null)?.closest?.('[role="listbox"],[role="menu"]')) return;
      e.stopImmediatePropagation();
      onClose();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onClose]);

  const steps = DOCS_WIZARD_STEPS[type];
  const stepIndex = steps.indexOf(step);
  const webWiki = type === 'web' ? wikiProviderOfUrl(url) : null;
  const pageWiki = wikiProviderOfUrl(pageUrl);
  const repoName = parseGithubRepoName(repo);

  // What "Next" needs on each step, and what it does.
  const canNext = ((): boolean => {
    switch (step) {
      case 'type':
        return !folderCheck.isPending;
      case 'files':
        return false;
      case 'address':
        return url.trim() !== '' && webWiki == null;
      case 'connection':
        return (type === 'confluence' || type === 'notion') && wikiReady(type, creds.data);
      case 'page':
        return pageWiki === type && !wikiCount.isPending;
      case 'repo':
        return repoName != null && !repoCount.isPending;
      case 'folder':
        return folder != null && folder.docs > 0;
      case 'folders':
        return chosenFolders.length > 0;
      case 'review':
        return !adding.isPending;
    }
  })();

  const goNext = (): void => {
    if (!canNext) return;
    if (step === 'type' && type === 'repos') {
      folderCheck.mutate(undefined, { onSuccess: () => setStep('folders') });
      return;
    }
    if (step === 'page') {
      wikiCount.mutate(pageUrl.trim(), { onSuccess: () => setStep('review') });
      return;
    }
    if (step === 'repo' && repoName) {
      repoCount.mutate(`${repoName.owner}/${repoName.repo}`, {
        onSuccess: (r) => {
          setFolder(r.folders[0] ?? null);
          setStep('folder');
        },
      });
      return;
    }
    if (step === 'review') {
      const done = { onSuccess: () => onClose() };
      if (type === 'repos') {
        setReposProblem(null);
        addFolders.mutate(
          chosenFolders.map((f) => f.id),
          {
            onSuccess: (res) => {
              const problem = offersAddProblem(res);
              if (problem == null) onClose();
              else setReposProblem(problem);
            },
          },
        );
        return;
      }
      if (type === 'web') addUrl.mutate({ url: url.trim(), crawlDepth: crawlDepth > 0 ? crawlDepth : null }, done);
      else if (type === 'github' && repoName && folder) addRepo.mutate({ repo: `${repoName.owner}/${repoName.repo}`, path: folder.path }, done);
      else addWiki.mutate(pageUrl.trim(), done);
      return;
    }
    const n = nextStep(type, step);
    if (n) setStep(n);
  };
  const goBack = (): void => {
    const p = previousStep(type, step);
    if (p) setStep(p);
  };

  let body: ReactNode;
  switch (step) {
    case 'type':
      body = (
        <div role="radiogroup" aria-label="Source" className="space-y-1">
          {/* "From your repositories" runs the AI on Add: shown only where AI is on (`me.ai.enabled`). */}
          {(Object.keys(DOCS_WIZARD_STEPS) as DocsSourceType[]).filter((t) => t !== 'repos' || ai.enabled).map((t) => (
            <label
              key={t}
              className={cx(
                'flex cursor-pointer items-start gap-3 rounded-ui px-3 py-2.5 touch:min-h-11',
                type === t ? 'bg-ui-sel' : 'hover:bg-ui-hover',
              )}
            >
              <RadioBox name="docs-source" value={t} checked={type === t} onChange={() => setType(t)} />
              <span className="mt-0.5 shrink-0 text-ui-mute">{TYPE_ICON[t]({ size: 16 })}</span>
              <span className="min-w-0">
                <span className="block font-medium text-ui-ink">{DOCS_SOURCE_LABEL[t]}</span>
                <span className="block text-meta text-ui-mute">{TYPE_HINT[t]}</span>
              </span>
            </label>
          ))}
          {type === 'repos' && folderCheck.isPending && <p className="px-3 pt-1 text-body text-ui-mute">Looking through your repositories…</p>}
          {type === 'repos' && folderCheck.isError && <p className="px-3 pt-1 text-body text-ui-danger">{folderCheck.error.message}</p>}
        </div>
      );
      break;
    case 'files':
      body = <UploadStep workspaceId={workspaceId} maxBytes={maxBytes} sending={sending} setSending={setSending} onDone={onClose} />;
      break;
    case 'address':
      body = (
        <div className="space-y-3">
          <label className="flex flex-col gap-1">
            <span className="text-meta font-medium text-ui-mute">Address</span>
            <input
              type="url"
              inputMode="url"
              autoFocus
              className={inputCls}
              placeholder="https://…"
              maxLength={2048}
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && goNext()}
            />
          </label>
          {webWiki != null && webWiki !== 'github' && (
            <p className="text-body text-ui-ink">
              That is a {WIKI_PROVIDER_NAMES[webWiki]} page.{' '}
              <button
                type="button"
                className="font-medium text-ui-accent underline-offset-2 hover:underline"
                onClick={() => {
                  setType(webWiki);
                  setPageUrl(url.trim());
                  setStep('connection');
                }}
              >
                Add it from {WIKI_PROVIDER_NAMES[webWiki]}
              </button>
            </p>
          )}
          <div className="flex flex-col items-start gap-1">
            <span className="text-meta font-medium text-ui-mute">Links to follow</span>
            <Select
              size="sm"
              label="Links to follow"
              value={String(crawlDepth)}
              onChange={(v) => setCrawlDepth(Number(v))}
              options={[
                { value: '0', label: 'This page only' },
                ...Array.from({ length: REFERENCE_DOC_CRAWL_MAX_DEPTH }, (_, i) => i + 1).map((d) => ({
                  value: String(d),
                  label: `Follow links, ${d} level${d === 1 ? '' : 's'}`,
                })),
              ]}
            />
            <span className="text-meta text-ui-mute">Same site only, up to {REFERENCE_DOC_CRAWL_MAX_PAGES} pages.</span>
          </div>
        </div>
      );
      break;
    case 'connection':
      body =
        type !== 'confluence' && type !== 'notion' ? null : creds.data == null ? (
          <p className="text-body text-ui-mute">{creds.isError ? creds.error.message : 'Loading…'}</p>
        ) : type === 'confluence' ? (
          <ConfluenceForm key={workspaceId} workspaceId={workspaceId} saved={creds.data} />
        ) : (
          <NotionForm key={workspaceId} workspaceId={workspaceId} saved={creds.data} />
        );
      break;
    case 'page':
      body = (
        <div className="space-y-3">
          <label className="flex flex-col gap-1">
            <span className="text-meta font-medium text-ui-mute">Page address</span>
            <input
              type="text"
              inputMode="url"
              autoFocus
              className={inputCls}
              placeholder={type === 'notion' ? 'https://www.notion.so/…' : 'https://your-site.atlassian.net/wiki/spaces/…'}
              maxLength={2048}
              value={pageUrl}
              onChange={(e) => {
                setPageUrl(e.target.value);
                wikiCount.reset();
              }}
              onKeyDown={(e) => e.key === 'Enter' && goNext()}
            />
          </label>
          <p className="text-meta text-ui-mute">
            {type === 'confluence'
              ? 'Paste the space’s home page (or the space’s address) to add the whole space, or any page to add it and every page below it.'
              : 'Paste a top-level page to add the whole wiki, or any page to add it and every page below it.'}{' '}
            Add another section later as its own source.
          </p>
          {pageUrl.trim() !== '' && pageWiki !== type && (
            <p className="text-meta text-ui-danger">That is not a {DOCS_SOURCE_LABEL[type]} page address.</p>
          )}
          {wikiCount.isPending && <p className="text-body text-ui-mute">Counting the pages…</p>}
          {wikiCount.isError && <p className="text-body text-ui-danger">{wikiCount.error.message}</p>}
        </div>
      );
      break;
    case 'repo':
      body = <RepoStep repo={repo} setRepo={(v) => (setRepo(v), repoCount.reset())} onEnter={goNext} pending={repoCount.isPending} error={repoCount.error?.message ?? null} />;
      break;
    case 'folder': {
      const folders = repoCount.data?.folders ?? [];
      body = (
        <div className="space-y-2">
          <p className="text-meta text-ui-mute">
            {repoCount.data ? `${repoCount.data.owner}/${repoCount.data.repo} · ${repoCount.data.branch}` : ''}
            {repoCount.data?.truncated ? ' · GitHub listed only part of this repository.' : ''}
          </p>
          {folders.length === 0 || folders[0]!.docs === 0 ? (
            <p className="text-body text-ui-ink">This repository has no markdown or text documents.</p>
          ) : (
            <div role="radiogroup" aria-label="Folder" className="max-h-72 space-y-px overflow-y-auto">
              {folders.map((f) => (
                <label
                  key={f.path}
                  className={cx('flex cursor-pointer items-center gap-2.5 rounded-ui px-2.5 py-1.5 touch:min-h-10', folder?.path === f.path ? 'bg-ui-sel' : 'hover:bg-ui-hover')}
                >
                  <RadioBox name="docs-folder" value={f.path} checked={folder?.path === f.path} onChange={() => setFolder(f)} />
                  <span className="min-w-0 flex-1 truncate text-body text-ui-ink">{folderLabel(f)}</span>
                  <span className="shrink-0 text-meta tabular-nums text-ui-mute">{f.docs}</span>
                </label>
              ))}
            </div>
          )}
        </div>
      );
      break;
    }
    case 'folders':
      body = (
        <RepoFoldersStep
          folders={repoFolders}
          notLookedAt={folderCheck.data?.notLookedAt ?? 0}
          unreadable={shownUnreadableRepos(folderCheck.data?.unreadable ?? [])}
          picked={picked}
          setPicked={setPicked}
          onChoosePart={(repoFullName) => {
            setType('github');
            setRepo(repoFullName);
            repoCount.reset();
            setStep('repo');
          }}
        />
      );
      break;
    case 'review':
      if (type === 'repos') {
        body = <RepoFoldersReview folders={chosenFolders} budgetUsd={folderCheck.data?.budgetUsd ?? null} problem={reposProblem} />;
        break;
      }
      body = <ReviewStep type={type} url={url} crawlDepth={crawlDepth} wiki={wikiCount.data ?? null} repo={repoName ? `${repoName.owner}/${repoName.repo}` : ''} folder={folder} />;
      break;
  }

  return (
    <FloatingPortal>
      <div
        className="fixed inset-0 z-[60] flex items-end justify-center bg-ui-scrim/40 sm:items-center sm:p-4 motion-safe:animate-ui-fade"
        role="presentation"
        onClick={(e) => {
          if (e.target === e.currentTarget) onClose();
        }}
      >
        <FloatingFocusManager context={context} modal initialFocus={bodyRef} returnFocus>
          <div
            ref={refs.setFloating}
            role="dialog"
            aria-modal="true"
            aria-labelledby={titleId}
            data-testid="docs-add-wizard"
            className="flex max-h-[90vh] w-full flex-col rounded-t-xl bg-ui-raise pb-[env(safe-area-inset-bottom)] shadow-2xl shadow-black/30 focus:outline-none motion-safe:animate-ui-sheet-up sm:max-h-[85vh] sm:w-[34rem] sm:max-w-[94vw] sm:rounded-ui sm:pb-0 sm:motion-safe:animate-ui-pop"
          >
            <div className="flex items-start justify-between gap-3 px-5 pb-1 pt-4">
              <div className="min-w-0">
                <p className="text-meta text-ui-mute">
                  Add documents{step !== 'type' ? ` · ${DOCS_SOURCE_LABEL[type]}` : ''} · step {stepIndex + 1} of {steps.length}
                </p>
                <h2 id={titleId} className="text-title text-ui-ink">
                  {STEP_TITLE[step]}
                </h2>
              </div>
              <button
                type="button"
                onClick={onClose}
                aria-label="Close"
                title="Close"
                className="-mr-1.5 inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-ui text-ui-mute hover:bg-ui-hover hover:text-ui-ink focus:outline-none focus-visible:ring-2 focus-visible:ring-ui-accent touch:h-10 touch:w-10"
              >
                <CloseIcon size={14} />
              </button>
            </div>
            <div ref={bodyRef} tabIndex={-1} className="min-h-0 flex-1 overflow-auto px-5 pb-4 pt-2 text-body text-ui-ink focus:outline-none" data-testid={`docs-wizard-step-${step}`}>
              {body}
            </div>
            <div className="flex items-center gap-2 border-t border-ui-line px-5 py-3">
              {adding.isError && step === 'review' && <p className="min-w-0 flex-1 text-meta text-ui-danger">{adding.error.message}</p>}
              <span className="flex-1" />
              {stepIndex > 0 && (
                <Button variant="ghost" onClick={goBack} disabled={adding.isPending || sending != null}>
                  Back
                </Button>
              )}
              {step === 'files' ? null : step === 'review' ? (
                // The run button: behind the ONE gate (setup / sign-in line, the over-budget confirm).
                <AiRunGate kind="docs_build" meter={false}>
                  <Button variant="primary" data-ai-run onClick={goNext} disabled={!canNext} busy={adding.isPending}>
                    {type === 'repos' ? 'Add' : 'Start'}
                  </Button>
                </AiRunGate>
              ) : (
                <Button variant="primary" onClick={goNext} disabled={!canNext} busy={wikiCount.isPending || repoCount.isPending || folderCheck.isPending}>
                  Next
                </Button>
              )}
            </div>
          </div>
        </FloatingFocusManager>
      </div>
    </FloatingPortal>
  );
}

/**
 * The upload step: a drop zone and "Choose files". Each file is checked (`uploadRefusal`), then sent
 * at once, one after another, through the same upload call the Library's old box used. All sent
 * closes the wizard; any refusal or failure stays, listed by file name.
 */
function UploadStep({
  workspaceId,
  maxBytes,
  sending,
  setSending,
  onDone,
}: {
  workspaceId: number;
  maxBytes: number;
  sending: string | null;
  setSending: (name: string | null) => void;
  onDone: () => void;
}): JSX.Element {
  // Codex cannot read PDF pages (the build refuses one on Codex): say so BEFORE the upload.
  const onCodex = useMe().data?.ai.provider === 'codex';
  const upload = useUploadReferenceDoc(workspaceId);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [dragging, setDragging] = useState(false);
  const [problems, setProblems] = useState<Array<{ name: string; message: string }>>([]);

  const send = async (files: File[]): Promise<void> => {
    const found: Array<{ name: string; message: string }> = [];
    setProblems([]);
    for (const f of files) {
      const refusal = uploadRefusal(f.name, f.size, maxBytes);
      if (refusal != null) {
        found.push({ name: f.name, message: refusal });
        continue;
      }
      setSending(f.name);
      try {
        await upload.mutateAsync(f);
      } catch (err) {
        found.push({ name: f.name, message: err instanceof Error ? err.message : 'The upload failed.' });
      }
    }
    setSending(null);
    setProblems(found);
    if (found.length === 0) onDone();
  };

  const onDrop = (e: DragEvent<HTMLDivElement>): void => {
    e.preventDefault();
    setDragging(false);
    const files = Array.from(e.dataTransfer.files ?? []);
    if (files.length > 0 && sending == null) void send(files);
  };

  return (
    <div className="space-y-2">
      <div
        onDragOver={(e) => {
          e.preventDefault();
          if (!dragging) setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={onDrop}
        data-testid="docs-drop-zone"
        className={cx(
          'flex min-h-28 flex-col items-center justify-center gap-2 rounded-ui border border-dashed px-4 py-5 text-center',
          dragging ? 'border-ui-accent bg-ui-sel' : 'border-ui-line',
        )}
      >
        <input
          ref={inputRef}
          type="file"
          multiple
          accept={DOC_UPLOAD_ACCEPT}
          className="hidden"
          aria-label="Choose files to add"
          onChange={(e) => {
            const files = Array.from(e.target.files ?? []);
            e.target.value = '';
            if (files.length > 0) void send(files);
          }}
        />
        {sending != null ? (
          <p className="text-body text-ui-ink">Uploading {sending}…</p>
        ) : (
          <>
            <AiRunGate kind="docs_build" meter={false}>
              <Button variant="primary" data-ai-run icon={<UploadIcon size={13} aria-hidden />} onClick={() => inputRef.current?.click()}>
                Choose files
              </Button>
            </AiRunGate>
            <p className="text-meta text-ui-mute">
              {onCodex ? 'or drop Word, text or markdown files here. Codex cannot read PDFs.' : 'or drop PDF, Word, text or markdown files here'}
            </p>
          </>
        )}
      </div>
      {problems.length > 0 && (
        <ul className="space-y-0.5 text-meta text-ui-danger" data-testid="docs-upload-problems">
          {problems.map((p, i) => (
            <li key={`${p.name}-${i}`}>
              {p.name}: {p.message}
            </li>
          ))}
        </ul>
      )}
      <p className="text-meta text-ui-mute">Building starts as soon as a file is sent, and runs on your machine.</p>
    </div>
  );
}

/**
 * From your repositories, the folders step: every qualifying folder not in Docs yet (the docs offer's own
 * check), a checkbox each — none ticked to begin with. A too-large folder has no checkbox: it points at the
 * GitHub repository source, opened on that repository, to add part of it.
 */
function RepoFoldersStep({
  folders,
  notLookedAt,
  unreadable,
  picked,
  setPicked,
  onChoosePart,
}: {
  folders: readonly RepoDocsOffer[];
  notLookedAt: number;
  /** Repositories whose files Limn could not read (the stored failure): one line each, after the list. */
  unreadable: readonly RepoDocsUnreadable[];
  picked: ReadonlySet<number>;
  setPicked: (next: ReadonlySet<number>) => void;
  onChoosePart: (repoFullName: string) => void;
}): JSX.Element {
  const note = repoFoldersNote(folders.length, notLookedAt);
  const toggle = (id: number, on: boolean): void => {
    const next = new Set(picked);
    if (on) next.add(id);
    else next.delete(id);
    setPicked(next);
  };
  return (
    <div className="space-y-2" data-testid="docs-wizard-repo-folders">
      {folders.length > 0 && (
        <ul className="max-h-72 space-y-px overflow-y-auto">
          {folders.map((f) =>
            f.tooLarge ? (
              <li key={f.id} className="flex flex-wrap items-baseline gap-x-2 px-2.5 py-1.5 pl-9 text-body">
                <span className="min-w-0 truncate text-ui-ink">{offerLabel(f)}</span>
                <span className="text-meta text-ui-faint">{offerFiles(f)} · too large to add in one go</span>
                <button type="button" className={cx('rounded-ui text-meta', TEXT_LINK, FOCUS_RING)} onClick={() => onChoosePart(f.repoFullName)}>
                  Choose part of it
                </button>
              </li>
            ) : (
              <li key={f.id}>
                <label className={cx('flex cursor-pointer items-center gap-2.5 rounded-ui px-2.5 py-1.5 touch:min-h-10', picked.has(f.id) ? 'bg-ui-sel' : 'hover:bg-ui-hover')}>
                  <CheckboxBox checked={picked.has(f.id)} onChange={(e) => toggle(f.id, e.currentTarget.checked)} />
                  <span className="min-w-0 flex-1 truncate text-body text-ui-ink">{offerLabel(f)}</span>
                  <span className="shrink-0 text-meta tabular-nums text-ui-mute">{offerFiles(f)}</span>
                </label>
              </li>
            ),
          )}
        </ul>
      )}
      {note != null && <p className={folders.length === 0 ? 'text-body text-ui-ink' : 'text-meta text-ui-mute'}>{note}</p>}
      {unreadable.length > 0 && (
        <ul className="space-y-0.5" data-testid="docs-wizard-unreadable">
          {unreadable.map((u) => (
            <li key={u.repoId} className="text-meta text-ui-mute" data-reason={u.reason}>
              {unreadableRepoText(u)}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** From your repositories, the review: what will be added, and what one build may cost. */
function RepoFoldersReview({
  folders,
  budgetUsd,
  problem,
}: {
  folders: readonly RepoDocsOffer[];
  budgetUsd: number | null;
  problem: string | null;
}): JSX.Element {
  const ai = useAiCapabilities();
  const costText = useRunCostText();
  const cost = costText(budgetUsd, ai.provider);
  return (
    <div className="space-y-2" data-testid="docs-wizard-review">
      <p className="flex items-start gap-2 font-medium text-ui-ink">
        <CheckCircleIcon size={14} className="mt-0.5 shrink-0 text-ui-success" aria-hidden />
        <span>{repoFoldersReviewSentence(folders.length)}</span>
      </p>
      <ul className="space-y-0.5 pl-6 text-body text-ui-ink">
        {folders.map((f) => (
          <li key={f.id}>
            {offerLabel(f)} <span className="text-meta text-ui-faint">· {offerFiles(f)}</span>
          </li>
        ))}
      </ul>
      <p className="text-meta text-ui-mute">
        Building uses {ai.providerName}, on your machine.{cost != null && ` Up to ${cost} each.`}
      </p>
      {problem != null && <p className="text-meta text-ui-danger">{problem}</p>}
    </div>
  );
}

function RepoStep({
  repo,
  setRepo,
  onEnter,
  pending,
  error,
}: {
  repo: string;
  setRepo: (v: string) => void;
  onEnter: () => void;
  pending: boolean;
  error: string | null;
}): JSX.Element {
  const repos = useRepos();
  const listId = useId();
  const names = useMemo(() => (repos.data ?? []).map((r) => r.fullName).sort((a, b) => a.localeCompare(b)), [repos.data]);
  return (
    <div className="space-y-3">
      <label className="flex flex-col gap-1">
        <span className="text-meta font-medium text-ui-mute">Repository</span>
        <input
          type="text"
          autoFocus
          list={listId}
          className={inputCls}
          placeholder="owner/name"
          maxLength={200}
          value={repo}
          onChange={(e) => setRepo(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && onEnter()}
        />
        <datalist id={listId}>
          {names.map((n) => (
            <option key={n} value={n} />
          ))}
        </datalist>
      </label>
      <p className="text-meta text-ui-mute">Read with your gh sign-in, on the default branch. Code, images and lockfiles are left out.</p>
      {pending && <p className="text-body text-ui-mute">Reading the repository…</p>}
      {error != null && <p className="text-body text-ui-danger">{error}</p>}
    </div>
  );
}

function ReviewStep({
  type,
  url,
  crawlDepth,
  wiki,
  repo,
  folder,
}: {
  type: DocsSourceType;
  url: string;
  crawlDepth: number;
  wiki: ReturnType<typeof usePreflightWikiDocs>['data'] | null;
  repo: string;
  folder: GithubDocsFolder | null;
}): JSX.Element {
  let lines: ReactNode[] = [];
  if (type === 'web') {
    lines = [
      `This will add ${url.trim()}${crawlDepth > 0 ? ` and the pages it links to, ${crawlDepth} level${crawlDepth === 1 ? '' : 's'} deep (up to ${REFERENCE_DOC_CRAWL_MAX_PAGES} pages)` : ''}.`,
    ];
  } else if (type === 'github' && folder) {
    lines = [githubReviewSentence(repo, folder), wikiOverCapSentence({ more: folder.docs >= REFERENCE_DOC_WIKI_MAX_PAGES })];
  } else if (wiki) {
    lines = [
      wikiReviewSentence(wiki),
      wikiOverCapSentence(wiki),
      wiki.credentialFrom === 'jira' ? 'Read with your Jira connection.' : null,
      wiki.existing ? `“${wiki.existing.title}” already reads this page. Adding it again makes a second copy.` : null,
    ];
  }
  return (
    <div className="space-y-2" data-testid="docs-wizard-review">
      {lines
        .filter((l) => l != null)
        .map((l, i) => (
          <p key={i} className={i === 0 ? 'flex items-start gap-2 font-medium text-ui-ink' : 'text-ui-mute'}>
            {i === 0 && <CheckCircleIcon size={14} className="mt-0.5 shrink-0 text-ui-success" aria-hidden />}
            <span>{l}</span>
          </p>
        ))}
      <p className="text-meta text-ui-mute">Building runs on your machine. Refresh and Rebuild read the same {type === 'web' ? 'pages' : 'source'} again.</p>
    </div>
  );
}
