// Pass: the new error behaves, and the public error-code table lists it.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const repo = process.argv[2];
const fail = message => { console.log(`FAIL ${message}`); process.exit(1); };
const { checkQuota } = await import(pathToFileURL(join(repo, 'src', 'quota.js')).href);

try {
  checkQuota({ requestsThisMinute: 10, limitPerMinute: 10 });
  fail('checkQuota allows an account at its limit');
} catch (err) {
  if (err.code !== 'RATE_LIMITED' || err.status !== 429) {
    fail(`expected RATE_LIMITED/429, got ${err.code}/${err.status}`);
  }
}
if (checkQuota({ requestsThisMinute: 9, limitPerMinute: 10 }) === false) fail('checkQuota rejects an account under its limit');

const table = readFileSync(join(repo, 'docs', 'error-codes.md'), 'utf8');
if (!table.split('\n').some(line => /^\|\s*`?RATE_LIMITED`?\s*\|\s*429\s*\|/.test(line))) {
  fail('docs/error-codes.md has no RATE_LIMITED | 429 row');
}
console.log('PASS');
