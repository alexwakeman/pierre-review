// THE LIMN → ENSEMBLE RENAME: the shared parsers of text an older Limn wrote to GitHub.
//
// The app now WRITES "Ensemble"; footers, dismissal messages and commit trailers an older Limn wrote
// are still on GitHub (and a teammate on an older Limn still writes them), so every READER here takes
// both wordings. packages/shared has no test runner of its own, so its folds are tested from here.

import { describe, expect, it } from 'vitest';
import {
  ACTOR_LANE_LABEL,
  AUTO_POST_FOOTER,
  AUTO_POST_FOOTERS,
  LEGACY_AUTO_POST_FOOTERS,
  LEGACY_RUN_TRAILER_KEY,
  LIMN_RUN_TRAILER_KEY,
  PAIR_AUTO_POST_FOOTER,
  WITHDRAW_APPROVAL_MESSAGE,
  aiSignInLine,
  autoPostFooter,
  dismissalReasonText,
  hasAutoPostFooter,
  hasLimnRunTrailer,
  isLimnDismissalMessage,
  limnBotLabel,
  limnBotLogin,
  limnRunTrailer,
  stillOpenLabel,
  withLimnRunTrailer,
} from '@pierre-review/shared';

describe('auto-post footers', () => {
  it('writes the Ensemble wording', () => {
    expect(AUTO_POST_FOOTER).toBe('_Posted automatically by Ensemble’s Claude review._');
    expect(autoPostFooter('Codex')).toBe('_Posted automatically by Ensemble’s Codex review._');
    expect(PAIR_AUTO_POST_FOOTER).toBe('_Posted automatically by Ensemble’s Claude and Codex reviews._');
    for (const f of AUTO_POST_FOOTERS) expect(f).not.toContain('Limn');
  });

  it('reads both the new and the old Limn footers', () => {
    for (const f of AUTO_POST_FOOTERS) expect(hasAutoPostFooter(`Summary.\n\n${f}`)).toBe(true);
    expect(LEGACY_AUTO_POST_FOOTERS).toHaveLength(3);
    for (const f of LEGACY_AUTO_POST_FOOTERS) {
      expect(f).toContain('Limn’s');
      expect(hasAutoPostFooter(`Summary.\n\n${f}\n\n<!-- pierre:claude-review v=1 -->`)).toBe(true);
    }
    expect(hasAutoPostFooter('a person wrote this')).toBe(false);
  });
});

describe('review dismissal messages', () => {
  it('knows the new and the old wording as the app’s own', () => {
    expect(isLimnDismissalMessage('Ensemble withdrew its approval: 3 warnings found at 951c4aa.')).toBe(true);
    expect(isLimnDismissalMessage('Limn withdrew its approval: 3 warnings found at 951c4aa.')).toBe(true);
    expect(isLimnDismissalMessage('Ensemble (robin) checked the fixes at abc1234.')).toBe(true);
    expect(isLimnDismissalMessage('Limn (robin) checked the fixes at abc1234.')).toBe(true);
    expect(isLimnDismissalMessage('Claude’s blocking findings are fixed.')).toBe(true);
    expect(isLimnDismissalMessage(WITHDRAW_APPROVAL_MESSAGE)).toBe(false);
    expect(isLimnDismissalMessage('Something else entirely.')).toBe(false);
  });

  it('drops either lead from the reason text', () => {
    expect(dismissalReasonText('Ensemble withdrew its approval: 3 warnings found at 951c4aa.')).toBe('3 warnings found at 951c4aa');
    expect(dismissalReasonText('Limn withdrew its approval: 3 warnings found at 951c4aa.')).toBe('3 warnings found at 951c4aa');
  });

  it('the reader’s own withdrawal names Ensemble', () => {
    expect(WITHDRAW_APPROVAL_MESSAGE).toBe('Approval withdrawn in Ensemble.');
  });
});

describe('the run trailer on commits', () => {
  it('writes Ensemble-Run', () => {
    expect(LIMN_RUN_TRAILER_KEY).toBe('Ensemble-Run');
    expect(limnRunTrailer('ai-fix/12')).toBe('Ensemble-Run: ai-fix/12');
    expect(withLimnRunTrailer('Fix it', 'ai-fix/12')).toBe('Fix it\n\nEnsemble-Run: ai-fix/12\n');
  });

  it('reads both Ensemble-Run and an older Limn-Run', () => {
    expect(LEGACY_RUN_TRAILER_KEY).toBe('Limn-Run');
    expect(hasLimnRunTrailer('x\n\nEnsemble-Run: ai-fix/3')).toBe(true);
    expect(hasLimnRunTrailer('x\n\nLimn-Run: ai-fix/3')).toBe(true);
    expect(hasLimnRunTrailer('mentions Limn-Run: inline')).toBe(false);
    expect(hasLimnRunTrailer('mentions Ensemble-Run: inline')).toBe(false);
    // An older Limn's trailer already present is not added again.
    const old = 'Fix it\n\nLimn-Run: ai-fix/12\n';
    expect(withLimnRunTrailer(old, 'ai-fix/12')).toBe(old);
  });
});

describe('display names', () => {
  it('shows the bot as "Ensemble · alice" and keeps the stored limn: login', () => {
    expect(limnBotLabel('alice')).toBe('Ensemble · alice');
    expect(limnBotLogin('alice')).toBe('limn:alice');
  });

  it('names Ensemble in the labels and lines composed in shared', () => {
    expect(ACTOR_LANE_LABEL.limn).toBe('Ensemble');
    expect(stillOpenLabel({ you: false, login: 'robin', name: 'Robin Dev' })).toBe('Robin’s Ensemble: still open');
    expect(stillOpenLabel({ you: true })).toBe('Your Ensemble: still open');
    expect(aiSignInLine('codex')).toBe('Sign in to Codex with ChatGPT (ensemble ai login codex)');
  });
});
