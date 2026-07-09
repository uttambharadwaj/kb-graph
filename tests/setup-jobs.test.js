// tests/setup-jobs.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync, readFileSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { JOBS, renderPlist, renderSystemdUnits, installJobs } from '../src/cli/setup-jobs.js';

const OPTS = { nodeBin: '/usr/local/bin/node', kbRoot: '/opt/kb', vaultPath: '/home/u/kb-vault', claudePath: '/usr/local/bin/claude' };

test('JOBS defines harvest, reindex, synthesis', () => {
  assert.deepEqual(JOBS.map(j => j.name), ['harvest', 'reindex', 'synthesis']);
});

test('renderPlist mirrors the reference install', () => {
  const harvest = renderPlist(JOBS[0], OPTS);
  assert.match(harvest, /<string>com\.kb\.harvest<\/string>/);
  assert.match(harvest, /<string>\/opt\/kb\/bin\/kb\.js<\/string>\s*<string>harvest<\/string>/);
  assert.match(harvest, /<key>Hour<\/key><integer>3<\/integer><key>Minute<\/key><integer>30<\/integer>/);
  assert.match(harvest, /<key>OBSIDIAN_VAULT_PATH<\/key>\s*<string>\/home\/u\/kb-vault<\/string>/);
  assert.match(harvest, /<key>CLAUDE_PATH<\/key>\s*<string>\/usr\/local\/bin\/claude<\/string>/);

  const reindex = renderPlist(JOBS[1], OPTS);
  assert.match(reindex, /<key>StartInterval<\/key>\s*<integer>300<\/integer>/);
  assert.match(reindex, /<string>vault<\/string>\s*<string>reindex<\/string>/);

  const synthesis = renderPlist(JOBS[2], OPTS);
  assert.match(synthesis, /<key>Weekday<\/key><integer>0<\/integer>/);
  assert.match(synthesis, /<string>\/opt\/kb\/bin\/weekly-synthesis\.js<\/string>/);
});

test('renderSystemdUnits produces service+timer with matching cadences', () => {
  const { service, timer } = renderSystemdUnits(JOBS[0], OPTS);
  assert.match(service, /ExecStart=\/usr\/local\/bin\/node \/opt\/kb\/bin\/kb\.js harvest/);
  assert.match(service, /Environment="OBSIDIAN_VAULT_PATH=\/home\/u\/kb-vault"/);
  assert.match(timer, /OnCalendar=\*-\*-\* 03:30:00/);
  const reindexTimer = renderSystemdUnits(JOBS[1], OPTS).timer;
  assert.match(reindexTimer, /OnUnitActiveSec=300/);
  const synthTimer = renderSystemdUnits(JOBS[2], OPTS).timer;
  assert.match(synthTimer, /OnCalendar=Sun \*-\*-\* 04:00:00/);
});

test('renderPlist escapes XML special characters in values', () => {
  const out = renderPlist(JOBS[0], { ...OPTS, vaultPath: '/home/u/Docs & Notes' });
  assert.match(out, /Docs &amp; Notes/);
  assert.doesNotMatch(out, / & /);
});

test('renderSystemdUnits escapes % in Environment values', () => {
  const { service } = renderSystemdUnits(JOBS[0], { ...OPTS, vaultPath: '/home/u/100%vault' });
  assert.match(service, /100%%vault/);
});

test('installJobs surfaces mkdir failure as an error step, never throws', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'kbjobs-blocked-'));
  writeFileSync(join(tmp, 'blocker'), 'not a dir');
  const home = join(tmp, 'blocker', 'home');
  const result = installJobs({ home, ...OPTS, load: false });
  assert.ok(Array.isArray(result.steps));
  assert.ok(result.steps.some(s => s.error));
});

test('installJobs with load:false writes files and never shells out', () => {
  const home = mkdtempSync(join(tmpdir(), 'kbjobs-'));
  const result = installJobs({ home, ...OPTS, load: false });
  assert.equal(result.steps.filter(s => !s.error).length, 3);
  if (process.platform === 'darwin') {
    assert.ok(existsSync(join(home, 'Library', 'LaunchAgents', 'com.kb.harvest.plist')));
    assert.match(readFileSync(join(home, 'Library', 'LaunchAgents', 'com.kb.reindex.plist'), 'utf8'), /StartInterval/);
  } else {
    assert.ok(existsSync(join(home, '.config', 'systemd', 'user', 'kb-harvest.timer')));
  }
});
