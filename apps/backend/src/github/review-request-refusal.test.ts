// GitHub's refusal of a review request, in plain English (POST /api/prs/:id/request-reviewers → 422).
import { describe, expect, it } from 'vitest';
import { githubErrorStatus, githubRefusalWords, reviewRequestRefusal } from './review-request-refusal.js';

const NOT_COLLABORATOR =
  'GitHub REST POST /repos/acme/api/pulls/7/requested_reviewers -> 422: {"message":"Reviews may only be requested from collaborators. One or more of the users or teams you specified is not a collaborator of the acme/api repository.","documentation_url":"https://docs.github.com/rest/pulls/review-requests#request-reviewers-for-a-pull-req';

describe('reviewRequestRefusal', () => {
  it('names the one person who has no access', () => {
    expect(
      reviewRequestRefusal({ errText: NOT_COLLABORATOR, logins: ['bob'], teamSlugs: [], repoFullName: 'acme/api' }),
    ).toBe('@bob can’t be asked to review: they don’t have access to acme/api.');
  });

  it('says nobody was asked when the batch carried several', () => {
    expect(
      reviewRequestRefusal({ errText: NOT_COLLABORATOR, logins: ['bob', 'eve'], teamSlugs: [], repoFullName: 'acme/api' }),
    ).toBe('GitHub asked nobody: one of @bob, @eve doesn’t have access to acme/api.');
  });

  it('passes any other refusal through in GitHub’s words', () => {
    const err = 'GitHub REST POST /x -> 422: {"message":"Validation Failed","errors":[]}';
    expect(reviewRequestRefusal({ errText: err, logins: ['bob'], teamSlugs: [], repoFullName: 'acme/api' })).toBe(
      '@bob can’t be asked to review: Validation Failed.',
    );
    expect(reviewRequestRefusal({ errText: 'GitHub REST POST /x -> 422: ', logins: [], teamSlugs: ['core'], repoFullName: 'acme/api' })).toBe(
      '@core can’t be asked to review.',
    );
  });
});

describe('the error parts', () => {
  it('reads the status ghRest attaches', () => {
    expect(githubErrorStatus(Object.assign(new Error('x'), { status: 422 }))).toBe(422);
    expect(githubErrorStatus(new Error('x'))).toBeNull();
  });
  it('reads GitHub’s message from a cut body', () => {
    expect(githubRefusalWords('-> 422: {"message":"Nope \\"here\\"","documentation_url":"https://do')).toBe('Nope "here"');
    expect(githubRefusalWords('-> 422: not json')).toBeNull();
  });
});
