import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { wrapLine, xmlEscape } from './render-loop-figure.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const FIXTURE = 'docs/demo/terminal-demo-note.json';
const JSON_OUTPUT = resolve(ROOT, 'docs/assets/terminal-demo.json');
const SVG_OUTPUT = resolve(ROOT, 'docs/assets/terminal-demo.svg');
const WIDTH = 1200;
const OUTER_MARGIN = 24;
const PANEL_GAP = 18;
const PANEL_WIDTH = 372;
const PANEL_HEADER_HEIGHT = 78;
const PANEL_PADDING = 18;
const BODY_TOP_SPACING = 28;
const FIRST_LINE_BASELINE = 29;
const BODY_BOTTOM_PADDING = 20;
const LINE_HEIGHT = 18;
const MAX_LINE_CHARS = 43;
export const EXPECTED_FRESH_STORE_WARNINGS = Object.freeze([
  'reindex heartbeat never recorded — check com.kb.reindex launchd job',
  'harvest never ran — check com.kb.harvest launchd job',
  'synthesis never recorded — check com.kb.synthesis launchd job',
  'reconcile heartbeat never recorded — check com.kb.reconcile launchd job',
]);
const NORMALIZED_FRESH_STORE_HEALTH =
  'health: ⚠ <expected fresh-store maintenance warnings omitted>';
const FORWARDED_ENVIRONMENT_VARIABLES = [
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'NO_PROXY',
  'http_proxy',
  'https_proxy',
  'no_proxy',
  'HF_ENDPOINT',
];

function childEnvironment(tempRoot, externalAgentEnvironment) {
  const forwardedEnvironment = Object.fromEntries(
    FORWARDED_ENVIRONMENT_VARIABLES
      .filter(name => process.env[name] != null)
      .map(name => [name, process.env[name]]),
  );

  return {
    PATH: process.env.PATH,
    HOME: join(tempRoot, 'home'),
    TMPDIR: tempRoot,
    LANG: 'C',
    LC_ALL: 'C',
    TZ: 'UTC',
    NODE_OPTIONS: '',
    KB_DIR: join(tempRoot, 'kb'),
    OBSIDIAN_VAULT_PATH: join(tempRoot, 'vault'),
    KB_EMBEDDING_CACHE_DIR: resolve(ROOT, '.cache/test-embedding'),
    ...forwardedEnvironment,
    ...externalAgentEnvironment,
  };
}

export function normalizeFreshStoreHealth(output) {
  const healthLines = output.match(/^health: .*$/gm) ?? [];
  if (healthLines.length !== 1 || !healthLines[0].startsWith('health: ⚠ ')) {
    throw new Error(
      `expected exactly one fresh-store warning line, found ${healthLines.length}`,
    );
  }

  const warnings = healthLines[0].slice('health: ⚠ '.length).split(' | ');
  const expected = new Set(EXPECTED_FRESH_STORE_WARNINGS);
  const actual = new Set(warnings);
  const missing = EXPECTED_FRESH_STORE_WARNINGS.filter(warning => !actual.has(warning));
  const unexpected = warnings.filter(warning => !expected.has(warning));
  if (
    warnings.length !== EXPECTED_FRESH_STORE_WARNINGS.length
    || missing.length
    || unexpected.length
  ) {
    throw new Error(
      `fresh-store health warnings changed; missing: ${missing.join('; ') || 'none'}; `
      + `unexpected: ${unexpected.join('; ') || 'none'}`,
    );
  }

  return output.replace(healthLines[0], NORMALIZED_FRESH_STORE_HEALTH);
}

function normalizeOutput(output, tempRoot, { expectFreshStoreHealth = false } = {}) {
  const portable = output
    .replaceAll(ROOT, '<repo>')
    .replaceAll(tempRoot, '<isolated>')
    .replace(/\b\d{4}-\d{2}-\d{2}-(?=[a-z0-9-]+\.md\b)/g, '<date>-');
  return (expectFreshStoreHealth ? normalizeFreshStoreHealth(portable) : portable)
    .trimEnd();
}

function runKb(args, {
  env,
  tempRoot,
  input,
  expectFreshStoreHealth = false,
}) {
  const child = spawnSync(process.execPath, ['bin/kb.js', ...args], {
    cwd: ROOT,
    env,
    encoding: 'utf8',
    input,
    timeout: 120_000,
  });
  if (child.error) throw child.error;
  if (child.status !== 0) {
    throw new Error(
      `kb ${args.join(' ')} exited ${child.status}\n${child.stdout}${child.stderr}`,
    );
  }
  if (child.stderr.trim()) {
    throw new Error(`kb ${args.join(' ')} wrote to stderr\n${child.stderr}`);
  }
  return normalizeOutput(child.stdout, tempRoot, { expectFreshStoreHealth });
}

export function createExternalAgentCliSentinel(tempRoot) {
  const binDir = join(tempRoot, 'external-agent-sentinel-bin');
  const marker = join(tempRoot, 'external-agent-cli-invoked');
  const executable = join(binDir, 'claude');
  const markerLiteral = marker.replaceAll("'", "'\"'\"'");
  mkdirSync(binDir, { recursive: true });
  writeFileSync(
    executable,
    `#!/bin/sh\nprintf invoked > '${markerLiteral}'\nexit 97\n`,
    { mode: 0o700 },
  );

  return {
    executable,
    environment: {
      CLAUDE_PATH: executable,
      PATH: `${binDir}:${process.env.PATH ?? ''}`,
    },
    assertNotInvoked() {
      if (existsSync(marker)) {
        throw new Error('external agent CLI was invoked during terminal demo generation');
      }
    },
  };
}

export function captureTerminalDemo() {
  const tempRoot = mkdtempSync(join(tmpdir(), 'kb-graph-terminal-demo-'));
  const externalAgent = createExternalAgentCliSentinel(tempRoot);
  const env = childEnvironment(tempRoot, externalAgent.environment);
  mkdirSync(env.HOME, { recursive: true });
  mkdirSync(env.OBSIDIAN_VAULT_PATH, { recursive: true });

  try {
    const write = runKb(
      ['tool', 'kb_write', '--input', FIXTURE],
      { env, tempRoot },
    );
    const search = runKb(
      ['search', 'shared retry budgets'],
      { env, tempRoot },
    );
    const briefing = runKb(
      ['wakeup-hook'],
      { env, tempRoot, input: '{}\n', expectFreshStoreHealth: true },
    );
    externalAgent.assertNotInvoked();

    return {
      title: 'One process learns; fresh processes retrieve it',
      description: 'Captured output from three real kb-graph commands using one temporary KB_DIR and vault. Each command ran in a separate Node process; temporary paths, the note date, and fresh-store maintenance warnings are normalized.',
      proof: {
        output: 'captured, not authored',
        processes: 3,
        state: 'isolated temporary KB_DIR and vault',
        externalAgentCli: false,
      },
      panels: [
        {
          id: 'write',
          step: '01',
          title: 'Write',
          subtitle: 'process A · kb_write',
          command: `node bin/kb.js tool kb_write --input ${FIXTURE}`,
          output: write,
        },
        {
          id: 'retrieve',
          step: '02',
          title: 'Retrieve',
          subtitle: 'fresh process B · FTS5',
          command: 'node bin/kb.js search "shared retry budgets"',
          output: search,
        },
        {
          id: 'briefing',
          step: '03',
          title: 'Brief',
          subtitle: 'fresh process C · SessionStart hook',
          command: "printf '{}\\n' | node bin/kb.js wakeup-hook",
          output: briefing,
        },
      ],
    };
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
}

function panelLines(panel) {
  return [
    { kind: 'command', text: `$ ${panel.command}` },
    { kind: 'spacer', text: '' },
    ...panel.output.split('\n').map(text => ({ kind: 'output', text })),
  ].flatMap(line =>
    line.kind === 'spacer'
      ? [line]
      : wrapLine(line.text, MAX_LINE_CHARS).map(text => ({ ...line, text }))
  );
}

function renderPanelBody(lines, x) {
  return lines
    .map((line, lineIndex) => {
      if (line.kind === 'spacer') return '';
      const color = line.kind === 'command' ? '#f8f8f2' : '#d6dae4';
      const y =
        OUTER_MARGIN
        + PANEL_HEADER_HEIGHT
        + FIRST_LINE_BASELINE
        + lineIndex * LINE_HEIGHT;
      return `    <text x="${x + PANEL_PADDING}" y="${y}" fill="${color}" style="font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace; font-size: 12px;" xml:space="preserve">${xmlEscape(line.text)}</text>`;
    })
    .filter(Boolean)
    .join('\n');
}

function renderPanel(panel, lines, index, panelHeight) {
  const x = OUTER_MARGIN + index * (PANEL_WIDTH + PANEL_GAP);
  const body = renderPanelBody(lines, x);

  return [
    `  <g id="panel-${xmlEscape(panel.id)}">`,
    `    <rect x="${x}" y="${OUTER_MARGIN}" width="${PANEL_WIDTH}" height="${panelHeight}" rx="14" fill="#151821" stroke="#303746"/>`,
    `    <circle cx="${x + 22}" cy="${OUTER_MARGIN + 24}" r="5" fill="#ff5f57"/>`,
    `    <circle cx="${x + 38}" cy="${OUTER_MARGIN + 24}" r="5" fill="#febc2e"/>`,
    `    <circle cx="${x + 54}" cy="${OUTER_MARGIN + 24}" r="5" fill="#28c840"/>`,
    `    <text x="${x + PANEL_PADDING}" y="${OUTER_MARGIN + 51}" fill="#f8f8f2" style="font-family: -apple-system, BlinkMacSystemFont, &quot;Segoe UI&quot;, sans-serif; font-size: 15px; font-weight: 700;">${xmlEscape(panel.step)} · ${xmlEscape(panel.title)}</text>`,
    `    <text x="${x + PANEL_PADDING}" y="${OUTER_MARGIN + 67}" fill="#8b93a7" style="font-family: -apple-system, BlinkMacSystemFont, &quot;Segoe UI&quot;, sans-serif; font-size: 10px;">${xmlEscape(panel.subtitle)}</text>`,
    `    <rect x="${x + 1}" y="${OUTER_MARGIN + PANEL_HEADER_HEIGHT - 1}" width="${PANEL_WIDTH - 2}" height="1" fill="#303746"/>`,
    body,
    '  </g>',
  ].join('\n');
}

export function renderTerminalDemo(capture) {
  const linesByPanel = capture.panels.map(panelLines);
  const lineCount = Math.max(...linesByPanel.map(lines => lines.length));
  const panelHeight =
    PANEL_HEADER_HEIGHT
    + BODY_TOP_SPACING
    + lineCount * LINE_HEIGHT
    + BODY_BOTTOM_PADDING;
  const height = OUTER_MARGIN * 2 + panelHeight;
  const panels = capture.panels
    .map((panel, index) =>
      renderPanel(panel, linesByPanel[index], index, panelHeight)
    )
    .join('\n');

  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${height}" viewBox="0 0 ${WIDTH} ${height}" role="img" aria-labelledby="terminal-title terminal-desc">`,
    `  <title id="terminal-title">${xmlEscape(capture.title)}</title>`,
    `  <desc id="terminal-desc">${xmlEscape(capture.description)}</desc>`,
    `  <rect width="${WIDTH}" height="${height}" rx="18" fill="#0b0d12"/>`,
    panels,
    '</svg>',
    '',
  ].join('\n');
}

function serializeCapture(capture) {
  return `${JSON.stringify(capture, null, 2)}\n`;
}

export function generateTerminalDemo() {
  const capture = captureTerminalDemo();
  return {
    capture,
    json: serializeCapture(capture),
    svg: renderTerminalDemo(capture),
  };
}

function main() {
  const args = process.argv.slice(2);
  const checkMode = args.length === 1 && args[0] === '--check';
  if (args.length > 0 && !checkMode) {
    throw new Error('Usage: node scripts/generate-terminal-demo.mjs [--check]');
  }
  const generated = generateTerminalDemo();
  if (checkMode) {
    if (
      readFileSync(JSON_OUTPUT, 'utf8') !== generated.json
      || readFileSync(SVG_OUTPUT, 'utf8') !== generated.svg
    ) {
      throw new Error(
        'terminal demo is out of date; run node scripts/generate-terminal-demo.mjs',
      );
    }
    return;
  }
  writeFileSync(JSON_OUTPUT, generated.json);
  writeFileSync(SVG_OUTPUT, generated.svg);
}

if (fileURLToPath(import.meta.url) === resolve(process.argv[1] ?? '')) main();
