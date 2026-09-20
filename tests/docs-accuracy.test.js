import './helpers/tmp-kb.js';
import { existsSync, readFileSync } from 'fs';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
import { describe, it } from 'node:test';
import assert from 'node:assert';
import { JOBS } from '../src/jobs.js';
import { renderPlist, renderSystemdUnits } from '../src/cli/setup-jobs.js';
import { getHttpToolDefinitions, getToolDefinitions } from '../src/tools.js';

const read = path => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const readme = read('README.md');
const onboarding = read('docs/ONBOARDING.md');
const pkg = JSON.parse(read('package.json'));

describe('public documentation contract', () => {
  it('keeps the README concise and honest about data egress', () => {
    assert.doesNotMatch(readme, /Nothing leaves your machine|No external services/i);
    assert.match(readme, /may send selected transcript or note content/i);
    assert.match(readme, /not currently published on npm/i);
    assert.match(readme, /register --force/);
  });

  it('documents the shipped runtimes and every scheduled writer', () => {
    assert.strictEqual(pkg.engines.node, '22.x || 24.x || 26.x');
    for (const doc of [readme, onboarding]) {
      assert.match(doc, /Node(?:\.js)? 22(?:,\s*|\/)24(?:,\s*or\s*|\/)26/i);
      for (const { name } of JOBS) assert.match(doc, new RegExp(`\\b${name}\\b`, 'i'));
    }
    assert.doesNotMatch(onboarding, /Node\s*(?:≥|>=)\s*18|\/tmp\/kb-/i);
  });

  it('keeps the resident daemon and HTTP server as separate processes', () => {
    assert.match(readme, /`kb serve` is the optional resident MCP and hook daemon/);
    assert.match(readme, /It does not host the\s+dashboard/);
    assert.match(readme, /`kb start` is the separate HTTP process/);
  });

  it('discloses current scheduler and HTTP boundaries', () => {
    const opts = {
      nodeBin: '/usr/bin/node',
      kbRoot: '/opt/kb',
      vaultPath: '/home/user/vault',
      claudePath: '/usr/bin/claude',
      logsDir: '/home/user/.knowledge-base/logs',
      harvestSdkSessions: '1',
    };
    const scheduled = `${renderPlist(JOBS[0], opts)}\n${renderSystemdUnits(JOBS[0], opts).service}`;
    assert.match(scheduled, /KB_HARVEST_SDK_SESSIONS/);
    assert.doesNotMatch(readme, /scheduled jobs do not currently\s+carry that flag/i);
    for (const doc of [readme, onboarding]) {
      assert.match(doc, /KB_HARVEST_SDK_SESSIONS/);
      assert.match(doc, /rerun setup/i);
    }
    assert.match(readme, /Linux jobs use the\s+systemd journal/i);
    assert.match(
      readme,
      new RegExp(`Nineteen non-admin tools[\\s\\S]+seven administrative tools`, 'i'),
    );
    assert.strictEqual(getToolDefinitions().length, 26);
    assert.strictEqual(getHttpToolDefinitions().length, 19);
  });

  it('keeps local Markdown links resolvable', () => {
    for (const [path, doc] of [['README.md', readme], ['docs/ONBOARDING.md', onboarding]]) {
      const base = dirname(resolve(root, path));
      for (const match of doc.matchAll(/\]\((?!https?:|#)([^)#]+)(?:#[^)]*)?\)/g)) {
        assert.ok(existsSync(resolve(base, match[1])), `${path}: missing ${match[1]}`);
      }
    }
  });
});
