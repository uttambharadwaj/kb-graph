import './helpers/tmp-kb.js';
import { afterEach, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { getBusNotifierPidPath, readBusNotifierPid } from '../src/bus/pending.js';

let home;
const originalBusHome = process.env.KB_BUS_HOME;

function pidFixture() {
  home = fs.mkdtempSync(join(tmpdir(), 'kb-notifier-pid-'));
  process.env.KB_BUS_HOME = home;
  const scope = { agent: 'claude', cwd: home };
  const path = getBusNotifierPidPath(scope);
  fs.mkdirSync(dirname(path), { recursive: true });
  return { scope, path };
}

afterEach(() => {
  if (originalBusHome === undefined) delete process.env.KB_BUS_HOME;
  else process.env.KB_BUS_HOME = originalBusHome;
  if (home) fs.rmSync(home, { recursive: true, force: true });
});

it('returns no notifier when its PID file disappears during the read', t => {
  const { scope, path } = pidFixture();
  fs.writeFileSync(path, '123\n');
  assert.equal(fs.existsSync(path), true);
  const originalRead = fs.readFileSync;
  let removed = false;
  const read = t.mock.method(fs, 'readFileSync', (file, ...args) => {
    if (file === path) {
      fs.rmSync(path);
      removed = true;
    }
    return originalRead(file, ...args);
  });
  syncBuiltinESMExports();
  try {
    assert.equal(readBusNotifierPid(scope), null);
    assert.equal(removed, true);
  } finally {
    read.mock.restore();
    syncBuiltinESMExports();
  }
});

it('retains absent and malformed notifier PID behavior', () => {
  const { scope, path } = pidFixture();
  assert.equal(readBusNotifierPid(scope), null);
  for (const [content, expected] of [['', null], ['invalid', null], ['0', null], ['-1', null], [' 123\n', 123], ['123suffix', 123]]) {
    fs.writeFileSync(path, content);
    assert.equal(readBusNotifierPid(scope), expected);
  }
});

it('propagates notifier PID read errors other than absence', t => {
  const { scope, path } = pidFixture();
  fs.writeFileSync(path, '123\n');
  const denied = Object.assign(new Error('permission denied'), { code: 'EACCES' });
  const originalRead = fs.readFileSync;
  const read = t.mock.method(fs, 'readFileSync', (file, ...args) => {
    if (file === path) throw denied;
    return originalRead(file, ...args);
  });
  syncBuiltinESMExports();
  try {
    assert.throws(() => readBusNotifierPid(scope), error => error === denied);
  } finally {
    read.mock.restore();
    syncBuiltinESMExports();
  }
});
