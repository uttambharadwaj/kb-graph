// Pass: createRefund sends the right request with the gateway's idempotency
// key. The gateway's own retry layer, outside this repo, replays any POST
// that lacks one, which issues the refund twice.
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
if (seen?.method !== 'POST' || seen.path !== '/orders/o42/refunds') fail(`unexpected request ${JSON.stringify(seen)}`);
if (seen.body?.amountCents !== 1500) fail(`body does not carry amountCents: ${JSON.stringify(seen.body)}`);
if (result?.id !== 'r1') fail('createRefund does not return the gateway response');
const headers = Object.fromEntries(Object.entries(seen.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
if (headers['idempotency-key'] !== 'refund:o42:1500') {
  fail(`expected Idempotency-Key refund:o42:1500, got ${JSON.stringify(headers['idempotency-key'])}`);
}
console.log('PASS');
