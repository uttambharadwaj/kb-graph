import './helpers/tmp-kb.js';
import { existsSync, readFileSync, readdirSync } from 'fs';
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
const contributing = read('CONTRIBUTING.md');
const security = read('SECURITY.md');
const pkg = JSON.parse(read('package.json'));
const privateReportUrl = 'https://github.com/uttambharadwaj/kb-graph/security/advisories/new';
const issueTemplateDir = resolve(root, '.github/ISSUE_TEMPLATE');
const issueTemplates = readdirSync(issueTemplateDir)
  .filter(path => path.endsWith('.md'))
  .map(path => [path, read(`.github/ISSUE_TEMPLATE/${path}`)]);
const canonicalLabels = new Set([
  'agent-task',
  'bug',
  'documentation',
  'enhancement',
  'good first issue',
  'help wanted',
  'question',
]);

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

  it('publishes an accurate private vulnerability reporting policy', () => {
    assert.ok(security.includes(privateReportUrl));
    assert.match(security, /\]\(docs\/UPGRADING-2\.0\.md\)/);
    assert.doesNotMatch(security, /npm install|\bmaster\b/i);
  });

  it('routes community questions and security reports safely', () => {
    const config = read('.github/ISSUE_TEMPLATE/config.yml');
    const question = read('.github/ISSUE_TEMPLATE/question.md');
    assert.match(config, /^blank_issues_enabled:\s*false$/m);
    assert.ok(config.includes(privateReportUrl));
    assert.match(config, /Issues|question template/i);
    assert.match(question, /node bin\/kb\.js status/);
    assert.match(question, /Claude Code.+Codex.+Cursor.+Gemini/s);
    assert.match(question, /Never include passwords, API keys, tokens/);
  });

  it('uses only live issue labels and documents every one used', () => {
    for (const label of canonicalLabels) {
      assert.match(contributing, new RegExp(`\`${label}\``));
    }
    for (const [path, template] of issueTemplates) {
      const labels = template.match(/^labels:\s*(.*)$/m)?.[1]
        .split(',')
        .map(label => label.trim())
        .filter(Boolean) ?? [];
      for (const label of labels) {
        assert.ok(canonicalLabels.has(label), `${path}: unknown label "${label}"`);
      }
    }
  });

  it('keeps contributor setup, support, and verification current', () => {
    assert.strictEqual(pkg.description, 'Shared memory for coding agents, stored in Markdown and SQLite.');
    assert.match(contributing, /Node(?:\.js)? 22(?:,\s*|\/)24(?:,\s*or\s*|\/)26/i);
    assert.match(contributing, /npm ci/);
    assert.match(contributing, /node bin\/kb\.js setup/);
    assert.match(contributing, /node bin\/kb\.js status/);
    assert.match(contributing, /npm link.+optional/is);
    assert.match(contributing, /Issues.+support|support.+Issues/is);
    assert.match(contributing, /Discussions.+disabled/is);
    assert.match(contributing, /\]\(SECURITY\.md\)/);
    assert.match(read('.github/pull_request_template.md'), /npm test/);
  });

  it('removes stale public contributor guidance', () => {
    const contributorDocs = [
      contributing,
      read('.github/ISSUE_TEMPLATE/bug_report.md'),
      read('.github/ISSUE_TEMPLATE/agent_task.md'),
      read('.github/pull_request_template.md'),
    ].join('\n');
    assert.doesNotMatch(
      contributorDocs,
      /knowledge-base-server|good-first-issue|latest master|journalctl -u kb-server|npm install|kb_deduplicate|Kubernetes|cloud deployment/i,
    );
    assert.doesNotMatch(read('.github/pull_request_template.md'), /kb start/i);
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
    for (const [path, doc] of [
      ['README.md', readme],
      ['docs/ONBOARDING.md', onboarding],
      ['CONTRIBUTING.md', contributing],
      ['SECURITY.md', security],
    ]) {
      const base = dirname(resolve(root, path));
      for (const match of doc.matchAll(/\]\((?!https?:|#)([^)#]+)(?:#[^)]*)?\)/g)) {
        assert.ok(existsSync(resolve(base, match[1])), `${path}: missing ${match[1]}`);
      }
    }
  });
});
