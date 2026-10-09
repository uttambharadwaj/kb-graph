import { test } from 'node:test';
import assert from 'node:assert';
import { setTransport } from '../src/http.js';
import { getOrder } from '../src/payments.js';

test('getOrder reads the order', async () => {
  setTransport(async ({ method, path }) => ({ method, path }));
  assert.deepStrictEqual(await getOrder('o1'), { method: 'GET', path: '/orders/o1' });
});
