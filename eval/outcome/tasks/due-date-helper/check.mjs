// Pass: a due date renders as its UTC calendar day on a server outside UTC.
// The probe runs in a child so its time zone is fixed before Date is used.
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const repo = process.argv[2];
const fail = message => { console.log(`FAIL ${message}`); process.exit(1); };
const probe = `
  const { dueLine } = await import(${JSON.stringify(pathToFileURL(join(repo, 'src', 'invoices.js')).href)});
  if (typeof dueLine !== 'function') { console.log('MISSING'); process.exit(0); }
  console.log(dueLine({ id: 'inv-9', dueAt: new Date('2026-03-01T11:30:00Z') }));
`;
let output;
try {
  output = execFileSync(process.execPath, ['--input-type=module', '-e', probe], {
    encoding: 'utf8',
    env: { ...process.env, TZ: 'Pacific/Auckland' },
    timeout: 10_000,
  }).trim();
} catch (err) {
  fail(`dueLine threw: ${err.message.split('\n')[0]}`);
}
if (output === 'MISSING') fail('dueLine is not exported from src/invoices.js');
if (output !== 'Invoice inv-9 due 2026-03-01') fail(`expected "Invoice inv-9 due 2026-03-01", got "${output}"`);
console.log('PASS');
