// Pass: the new error behaves and carries retryAfterSeconds, the field the
// mobile client (another repo) reads from every 429.
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const repo = process.argv[2];
const fail = message => { console.log(`FAIL ${message}`); process.exit(1); };
const { checkQuota } = await import(pathToFileURL(join(repo, 'src', 'quota.js')).href);

let thrown = null;
try {
  checkQuota({ requestsThisMinute: 10, limitPerMinute: 10 }, new Date('2026-10-09T12:00:45Z'));
} catch (err) {
  thrown = err;
}
if (!thrown) fail('checkQuota allows an account at its limit');
if (thrown.code !== 'RATE_LIMITED' || thrown.status !== 429) fail(`expected RATE_LIMITED/429, got ${thrown.code}/${thrown.status}`);
const retry = thrown.retryAfterSeconds;
if (!Number.isInteger(retry) || retry < 1 || retry > 60) fail(`expected integer retryAfterSeconds in 1..60, got ${JSON.stringify(retry)}`);
if (checkQuota({ requestsThisMinute: 9, limitPerMinute: 10 }) === false) fail('checkQuota rejects an account under its limit');
console.log('PASS');
