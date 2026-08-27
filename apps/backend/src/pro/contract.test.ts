import { afterEach, describe, expect, it } from 'vitest';
import {
  EMPTY_CAPABILITIES,
  entitledProCapabilities,
  getProCapabilities,
  setProCapabilities,
  type ProCapabilities,
} from './contract.js';

// A "plugin loaded, everything on" capability set.
const FULL: ProCapabilities = {
  activityDigest: true,
  reviewMemory: true,
  aiAnalysis: true,
  prSummary: true,
  aiFix: true,
  workspaceInsights: true,
  claudeReview: true,
  slackDigest: true,
  issueLinks: true,
  botTriage: true,
  botAdvisor: true,
  periodReports: true,
  botDepth: true,
  workPlan: true,
};

afterEach(() => {
  // The singleton is module-global — restore the OSS default between tests.
  setProCapabilities(EMPTY_CAPABILITIES);
});

describe('entitledProCapabilities (the billing entitlement seam)', () => {
  it('local accounts are always fully entitled, regardless of plan', () => {
    setProCapabilities(FULL);
    expect(entitledProCapabilities({ isLocal: true, plan: 'free' })).toEqual(FULL);
    expect(entitledProCapabilities({ isLocal: true, plan: 'pro' })).toEqual(FULL);
  });

  it("a cloud free-plan account gets the all-false set", () => {
    setProCapabilities(FULL);
    expect(entitledProCapabilities({ isLocal: false, plan: 'free' })).toEqual(
      EMPTY_CAPABILITIES,
    );
  });

  it("a cloud paid account gets the plugin's live capabilities", () => {
    setProCapabilities(FULL);
    expect(entitledProCapabilities({ isLocal: false, plan: 'pro' })).toEqual(FULL);
  });

  it('entitlement never invents capabilities the plugin did not advertise', () => {
    // No plugin loaded (OSS default): even a paid account sees all-false.
    expect(getProCapabilities()).toEqual(EMPTY_CAPABILITIES);
    expect(entitledProCapabilities({ isLocal: false, plan: 'pro' })).toEqual(
      EMPTY_CAPABILITIES,
    );
  });
});
