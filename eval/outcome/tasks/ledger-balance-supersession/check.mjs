// Pass: the balance comes from the current ledger API. The stub serves both
// APIs; v1 answers with the stale figure a migrated account still shows there.
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const repo = process.argv[2];
const fail = message => { console.log(`FAIL ${message}`); process.exit(1); };
const load = rel => import(pathToFileURL(join(repo, rel)).href);
const { setTransport } = await load('src/ledger-client.js');
const { getAvailableBalance } = await load('src/ledger.js');
if (typeof getAvailableBalance !== 'function') fail('getAvailableBalance is not exported from src/ledger.js');

const paths = [];
setTransport(async ({ path }) => {
  paths.push(path);
  if (path.startsWith('/v1/balances')) return [{ account: 'acct-7', available: '99.00' }];
  if (path === '/v2/accounts/acct-7/balance') return { accountId: 'acct-7', availableCents: 1234 };
  throw new Error(`404 ${path}`);
});
let cents;
try {
  cents = await getAvailableBalance('acct-7');
} catch (err) {
  fail(`getAvailableBalance threw: ${err.message}`);
}
if (paths.some(path => path.startsWith('/v1/'))) fail(`called the deprecated v1 API: ${paths.join(', ')}`);
if (cents !== 1234) fail(`expected 1234 cents, got ${JSON.stringify(cents)}`);
console.log('PASS');
