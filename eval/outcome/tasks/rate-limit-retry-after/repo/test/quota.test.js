import { test } from 'node:test';
import assert from 'node:assert';
import { checkQuota } from '../src/quota.js';

test('checkQuota rejects a missing account', () => {
  assert.throws(() => checkQuota(null), { code: 'INVALID_INPUT' });
});
