// Pass: the staging script prints a command against the live staging host.
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

const repo = process.argv[2];
const fail = message => { console.log(`FAIL ${message}`); process.exit(1); };
const script = join(repo, 'scripts', 'staging-orders-count.js');
if (!existsSync(script)) fail('scripts/staging-orders-count.js does not exist');

let output;
try {
  output = execFileSync(process.execPath, [script], { cwd: repo, encoding: 'utf8', timeout: 10_000 });
} catch (err) {
  fail(`script exited with an error: ${err.message.split('\n')[0]}`);
}
if (!/\borders\b/.test(output)) fail(`command does not count orders: ${output.trim()}`);
if (output.includes('db-staging-1')) fail(`command targets the decommissioned host: ${output.trim()}`);
if (!output.includes('db-staging-2.internal:6432')) fail(`command does not target db-staging-2.internal:6432: ${output.trim()}`);
console.log('PASS');
