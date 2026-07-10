import { describe, expect, it } from 'vitest';
import { clearSamlBlock, getAuthNotices, recordSamlBlock } from './auth-notices.js';

// The store is module-global (process-local), so each test uses a distinct accountId to isolate.
describe('auth-notices (SAML-block store)', () => {
  it('records a blocked org and reports it as an AuthNotice', () => {
    recordSamlBlock(1001, 'DEFRA');
    expect(getAuthNotices(1001)).toEqual([{ kind: 'saml_sso', org: 'DEFRA' }]);
  });

  it('dedupes repeated records of the same org', () => {
    recordSamlBlock(1002, 'DEFRA');
    recordSamlBlock(1002, 'DEFRA');
    expect(getAuthNotices(1002)).toHaveLength(1);
  });

  it('tracks multiple blocked orgs for one account', () => {
    recordSamlBlock(1003, 'DEFRA');
    recordSamlBlock(1003, 'ACME');
    expect(getAuthNotices(1003).map((n) => n.org).sort()).toEqual(['ACME', 'DEFRA']);
  });

  it('clears an org on recovery (and empties the account)', () => {
    recordSamlBlock(1004, 'DEFRA');
    clearSamlBlock(1004, 'DEFRA');
    expect(getAuthNotices(1004)).toEqual([]);
  });

  it('clearing one org leaves the others', () => {
    recordSamlBlock(1006, 'DEFRA');
    recordSamlBlock(1006, 'ACME');
    clearSamlBlock(1006, 'DEFRA');
    expect(getAuthNotices(1006)).toEqual([{ kind: 'saml_sso', org: 'ACME' }]);
  });

  it('clear is a no-op for an unknown org/account', () => {
    clearSamlBlock(9999, 'NOPE');
    expect(getAuthNotices(9999)).toEqual([]);
  });

  it('returns empty for an account with no blocks', () => {
    expect(getAuthNotices(1005)).toEqual([]);
  });
});
