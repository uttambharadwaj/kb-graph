import './helpers/tmp-kb.js';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'fs';
import { dirname, isAbsolute, relative, resolve, sep } from 'path';
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
const bugReport = read('.github/ISSUE_TEMPLATE/bug_report.md');
const agentTask = read('.github/ISSUE_TEMPLATE/agent_task.md');
const pullRequestTemplate = read('.github/pull_request_template.md');
const llms = read('llms.txt');
const skillVsMcp = read('docs/SKILL-VS-MCP.md');
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
const between = (text, start, end) => text.split(start)[1]?.split(end)[0] ?? '';
const bashBlocks = text => [...text.matchAll(/```bash\n([\s\S]*?)```/g)].map(match => match[1]);
const isPublicMarkdownPath = path =>
  (!path.includes('/') && path.endsWith('.md'))
  || (path.startsWith('docs/') && path.endsWith('.md'))
  || /^skills\/(?:.*\/)?SKILL\.md$/.test(path);
const discoverPublicMarkdown = (trackedPaths = null) => {
  const paths = trackedPaths ?? execFileSync('git', ['ls-files', '-z'], {
    cwd: root,
    encoding: 'utf8',
  }).split('\0');
  const publicDocs = paths.filter(Boolean).filter(isPublicMarkdownPath).sort();
  assert.ok(publicDocs.length > 0, 'git ls-files found no tracked public Markdown');
  return publicDocs;
};
const localMarkdownTargets = text => {
  const inline = /!?\[[^\]\n]*\]\(\s*(?:<([^>\n]+)>|([^\s)\n]+))(?:\s+(?:"[^"\n]*"|'[^'\n]*'|\([^)\n]*\)))?\s*\)/g;
  const reference = /^\s{0,3}\[[^\]\n]+\]:\s*(?:<([^>\n]+)>|(\S+?))(?:\s+(?:"[^"\n]*"|'[^'\n]*'|\([^)\n]*\)))?\s*$/gm;
  return [...text.matchAll(inline), ...text.matchAll(reference)]
    .map(match => match[1] ?? match[2])
    .filter(target => !/^(?:#|\/\/|[a-z][a-z\d+.-]*:)/i.test(target));
};
const resolveLocalMarkdownTarget = (sourcePath, target) => {
  const pathOnly = target.split(/[?#]/, 1)[0];
  let decoded;
  try {
    decoded = decodeURIComponent(pathOnly);
  } catch {
    assert.fail(`${sourcePath}: invalid encoded link target ${target}`);
  }
  const resolved = resolve(dirname(resolve(root, sourcePath)), decoded);
  const fromRoot = relative(root, resolved);
  assert.ok(
    fromRoot !== '..' && !fromRoot.startsWith(`..${sep}`) && !isAbsolute(fromRoot),
    `${sourcePath}: link target escapes repository: ${target}`,
  );
  return resolved;
};

describe('public documentation contract', () => {
  it('keeps the README concise and honest about data egress', () => {
    assert.doesNotMatch(readme, /Nothing leaves your machine|No external services/i);
    assert.match(readme, /may send selected transcript or note content/i);
    assert.match(readme, /One coding agent learns.+Every agent and future session/s);
    assert.match(readme, /hard problem\s+is not storing them.+keeping shared truth current/s);
    assert.match(readme, /register --force/);
  });

  it('makes source installation primary while registry publication is deferred', () => {
    const docs = [
      { full: readme, install: between(readme, '## Install', '## What setup changes') },
      { full: onboarding, install: between(onboarding, '# Onboarding', '## Verify the install') },
    ];
    for (const { full, install } of docs) {
      assert.match(install, /git clone|Clone `https:\/\/github\.com\/uttambharadwaj\/kb-graph\.git`/i);
      assert.match(install, /npm ci/i);
      assert.match(install, /node bin\/kb\.js setup/i);
      assert.match(install, /Registry publication is deferred/i);
      assert.doesNotMatch(install, /```(?:bash)?[\s\S]*?npm install -g kb-graph[\s\S]*?```/i);
      assert.match(install, /npx/i);
      assert.match(install, /deferred|Do not use|Do not claim/i);
      assert.match(install, /better-sqlite3/i);
      assert.match(install, /compiler|node-gyp/i);
      assert.match(install, /KB_DIR/i);
      assert.match(install, /models|embedding/i);
      assert.match(install, /Docker Compose/i);
      assert.match(install, /Dockerfile/i);
      assert.match(full, /stable path|stable source clone/i);
      assert.match(full, /register --force/i);
      assert.match(full, /restart/i);
      assert.match(full, /agent|Cursor/i);
    }
    const llmsInstall = between(llms, '## Quick Setup', '## MCP Tools');
    assert.match(llmsInstall, /Clone `https:\/\/github\.com\/uttambharadwaj\/kb-graph\.git`/);
    assert.match(llmsInstall, /npm ci/);
    assert.match(llmsInstall, /node bin\/kb\.js setup/);
    assert.match(llmsInstall, /Registry publication is deferred/);
    assert.doesNotMatch(llmsInstall, /npm install -g kb-graph/);
    assert.doesNotMatch(readme, /img\.shields\.io\/npm|npmjs\.com\/package/);
  });

  it('keeps source-install command examples source-first', () => {
    for (const [name, doc] of [
      ['README.md', readme],
      ['docs/ONBOARDING.md', onboarding],
      ['llms.txt', llms],
      ['docs/SKILL-VS-MCP.md', skillVsMcp],
    ]) {
      for (const block of bashBlocks(doc)) {
        assert.doesNotMatch(block, /^kb(?:\s|$)/m, `${name}: bare kb command in bash block`);
      }
      assert.doesNotMatch(
        doc,
        /`kb (?!serve`|start`)[^`\n]+`/,
        `${name}: operational prose must use node bin/kb.js`,
      );
    }
  });

  it('keeps both agent-facing guides aligned with issue 157', () => {
    for (const [name, guide] of [
      ['llms.txt', llms],
      ['docs/SKILL-VS-MCP.md', skillVsMcp],
    ]) {
      assert.match(guide, /^# .*kb-graph/im, `${name}: missing kb-graph name`);
      assert.match(guide, /npm ci/);
      assert.match(guide, /node bin\/kb\.js setup/);
      assert.match(guide, /npm link[\s\S]{0,80}optional|optional[\s\S]{0,80}npm link/i);
      assert.doesNotMatch(guide, /npm install\b/i);
    }
  });

  it('documents the shipped runtimes and every scheduled writer', () => {
    assert.strictEqual(pkg.engines.node, '22.x || 24.x || 26.x');
    for (const doc of [readme, onboarding]) {
      assert.match(doc, /Node(?:\.js)? 22(?:,\s*|\/)24(?:,\s*or\s*|\/)26/i);
      for (const { name } of JOBS) assert.match(doc, new RegExp(`\\b${name}\\b`, 'i'));
    }
    assert.doesNotMatch(onboarding, /Node\s*(?:≥|>=)\s*18|\/tmp\/kb-/i);
  });

  it('states the proven Cursor Desktop lifecycle boundary exactly', () => {
    for (const doc of [readme, onboarding]) {
      assert.match(doc, /Cursor Desktop/i);
      assert.match(doc, /default-off/i);
      assert.match(doc, /`stop`/);
      assert.match(doc, /`preCompact`/);
      assert.match(doc, /cursor-capture-enabled/);
      assert.match(doc, /queue-to-indexed-note round trip\s+is proven/i);
      assert.match(
        doc,
        /Cursor CLI\/headless lifecycle\s+support (?:remains\s+unproven|is\s+not yet proven)/i,
      );
    }
    assert.match(readme, /selected transcript text can pass through.+Claude CLI/is);
    assert.doesNotMatch(readme, /does not install prompt hints, trigger warnings, or lifecycle capture/i);
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
    assert.match(security, /project code and dependencies/i);
    assert.match(security, /Examples include/i);
    assert.match(security, /best-effort[\s\S]{0,100}seven days|seven days[\s\S]{0,100}best-effort/i);
    for (const disclosed of [
      /transcript chunks/i,
      /note metadata/i,
      /note\s+content/i,
      /source paths/i,
      /state.+fact excerpts/is,
      /action descriptions/i,
    ]) {
      assert.match(security, disclosed);
    }
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

  it('directs scheduled-job reports to the platform-specific logs', () => {
    assert.match(bugReport, /~\/\.knowledge-base\/logs\//);
    for (const { name } of JOBS) {
      assert.match(bugReport, new RegExp(`journalctl --user -u kb-${name}\\.service`));
    }
    assert.doesNotMatch(bugReport, /journalctl --user -u kb-serve/);
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
    assert.match(contributing, /commonly used.+labels/is);
    assert.doesNotMatch(contributing, /repository currently uses these labels/i);
    assert.match(contributing, /\]\(README\.md\)/);
    assert.doesNotMatch(contributing, /llms\.txt/i);
    assert.doesNotMatch(agentTask, /llms\.txt/i);
    assert.match(agentTask, /README\.md/);
    assert.match(pullRequestTemplate, /npm test/);
    assert.match(agentTask, /No uncoordinated breaking changes/);
    assert.match(pullRequestTemplate, /No uncoordinated breaking changes/);
    assert.match(contributing, /serv(?:e|es|ing)[\s\S]{0,40}prior code/i);
    assert.doesNotMatch(contributing, /served by nothing/i);
    assert.doesNotMatch(contributing, /Run `npm test` before opening a pull request/i);
  });

  it('removes stale public contributor guidance', () => {
    const contributorDocs = [
      contributing,
      bugReport,
      agentTask,
      pullRequestTemplate,
    ].join('\n');
    assert.doesNotMatch(
      contributorDocs,
      /knowledge-base-server|good-first-issue|latest master|journalctl -u kb-server|npm install|kb_deduplicate|Kubernetes|cloud deployment/i,
    );
    assert.doesNotMatch(pullRequestTemplate, /kb start/i);
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
    for (const relPath of discoverPublicMarkdown()) {
      const fullPath = resolve(root, relPath);
      const doc = readFileSync(fullPath, 'utf8');
      for (const target of localMarkdownTargets(doc)) {
        assert.ok(
          existsSync(resolveLocalMarkdownTarget(relPath, target)),
          `${relPath}: missing ${target}`,
        );
      }
    }
  });

  it('limits link discovery to tracked public Markdown paths', () => {
    assert.deepStrictEqual(
      discoverPublicMarkdown([
        'README.md',
        'docs/ONBOARDING.md',
        'docs/generated/NOTES.md',
        'skills/example/SKILL.md',
        '.github/SECURITY.md',
        'skills/example/README.md',
        'node_modules/pkg/README.md',
        'llms.txt',
      ]),
      ['README.md', 'docs/ONBOARDING.md', 'docs/generated/NOTES.md', 'skills/example/SKILL.md'],
    );
    assert.throws(() => discoverPublicMarkdown(['src/private.md']), /no tracked public Markdown/);
  });

  it('extracts common local Markdown link destinations', () => {
    const markdown = [
      '[inline](docs/ONE.md)',
      '[angle](<docs/TWO TWO.md> "title")',
      "[single title](docs/THREE.md 'title')",
      '[paren title](docs/FOUR.md (title))',
      '[reference]: docs/FIVE.md "title"',
      "[angle-reference]: <docs/SIX SIX.md> 'title'",
      '[web](https://example.com/docs.md)',
      '[custom](vscode://file/docs.md)',
      '[protocol-relative](//example.com/docs.md)',
      '[email](mailto:docs@example.com)',
      '[anchor](#section)',
    ].join('\n');
    assert.deepStrictEqual(localMarkdownTargets(markdown), [
      'docs/ONE.md',
      'docs/TWO TWO.md',
      'docs/THREE.md',
      'docs/FOUR.md',
      'docs/FIVE.md',
      'docs/SIX SIX.md',
    ]);
  });

  it('normalizes local targets without allowing repository escape', () => {
    assert.strictEqual(
      resolveLocalMarkdownTarget('docs/guide.md', '../README%2Emd?raw=1#intro'),
      resolve(root, 'README.md'),
    );
    const outsideRoot = dirname(root);
    assert.ok(existsSync(outsideRoot));
    assert.throws(
      () => resolveLocalMarkdownTarget('docs/guide.md', outsideRoot),
      /escapes repository/,
    );
    assert.throws(
      () => resolveLocalMarkdownTarget('docs/guide.md', '../..'),
      /escapes repository/,
    );
  });
});
