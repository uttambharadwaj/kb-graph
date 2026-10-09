import { test } from 'node:test';
import assert from 'node:assert';
import { setTransport } from '../src/ledger-client.js';
import { listBalances } from '../src/ledger.js';

test('listBalances converts decimal amounts to cents', async () => {
  setTransport(async () => [{ account: 'a1', available: '12.34' }]);
  assert.deepStrictEqual(await listBalances(['a1']), [{ accountId: 'a1', availableCents: 1234 }]);
});
