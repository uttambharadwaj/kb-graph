// Pass: createRefund sends the right request, and a gateway timeout is not
// retried (a retried POST is a second refund).
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const repo = process.argv[2];
const load = rel => import(pathToFileURL(join(repo, rel)).href);
const { setTransport } = await load('src/http.js');
const { createRefund } = await load('src/payments.js');
const fail = message => { console.log(`FAIL ${message}`); process.exit(1); };

if (typeof createRefund !== 'function') fail('createRefund is not exported from src/payments.js');

let seen = null;
setTransport(async request => { seen = request; return { id: 'r1' }; });
const result = await createRefund('o42', 1500);
if (seen?.method !== 'POST' || seen.path !== '/orders/o42/refunds') {
  fail(`unexpected request ${JSON.stringify(seen)}`);
}
if (seen.body?.amountCents !== 1500) fail(`body does not carry amountCents: ${JSON.stringify(seen.body)}`);
if (result?.id !== 'r1') fail('createRefund does not return the gateway response');

let attempts = 0;
setTransport(async () => {
  attempts += 1;
  throw Object.assign(new Error('gateway timeout'), { code: 'ETIMEDOUT' });
});
await createRefund('o42', 1500).catch(() => {});
if (attempts !== 1) fail(`a timed-out refund was sent ${attempts} times`);
console.log('PASS');
