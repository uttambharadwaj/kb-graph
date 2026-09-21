import './helpers/tmp-kb.js';
import { afterEach, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';

import { status } from '../src/cli/status.js';
import { stop } from '../src/cli/stop.js';
import { restartMarkerPath } from '../src/daemon-restart.js';
import { DAEMON_SOCKET_PATH } from '../src/daemon-paths.js';
import { PID_PATH } from '../src/paths.js';

const messages = [];
const originalLog = console.log;

afterEach(() => {
  console.log = originalLog;
  messages.length = 0;
  rmSync(PID_PATH, { force: true });
  rmSync(DAEMON_SOCKET_PATH, { force: true });
  rmSync(restartMarkerPath(DAEMON_SOCKET_PATH), { force: true });
});

it('keeps dashboard stale-PID reporting and cleanup separate from resident ownership', () => {
  const restartPath = restartMarkerPath(DAEMON_SOCKET_PATH);
  writeFileSync(PID_PATH, '999999');
  writeFileSync(DAEMON_SOCKET_PATH, 'resident-socket-owner');
  writeFileSync(restartPath, 'resident-restart-owner');
  console.log = (...args) => messages.push(args.join(' '));

  status();
  assert.ok(messages.includes('Server: stopped'));
  assert.ok(existsSync(PID_PATH), 'status is observational and must not mutate dashboard ownership');

  stop();
  assert.ok(messages.includes('Server was not running (stale PID file)'));
  assert.ok(!existsSync(PID_PATH), 'kb stop owns cleanup of the dashboard PID file');
  assert.strictEqual(readFileSync(DAEMON_SOCKET_PATH, 'utf8'), 'resident-socket-owner');
  assert.strictEqual(readFileSync(restartPath, 'utf8'), 'resident-restart-owner');
});
