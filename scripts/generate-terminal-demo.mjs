import { spawnSync } from 'node:child_process';
import {
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
const MARGIN = 24;
const GAP = 18;
const PANEL_WIDTH = 372;
const HEADER_HEIGHT = 78;
const LINE_HEIGHT = 18;
const MAX_LINE_CHARS = 43;

function childEnvironment(tempRoot) {
  const optional = [
    'HTTP_PROXY',
    'HTTPS_PROXY',
    'NO_PROXY',
    'http_proxy',
    'https_proxy',
    'no_proxy',
    'HF_ENDPOINT',
  ];
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
    ...Object.fromEntries(optional.flatMap(name =>
      process.env[name] == null ? [] : [[name, process.env[name]]]
    )),
  };
}

function normalizeOutput(output, tempRoot) {
  return output
    .replaceAll(ROOT, '<repo>')
    .replaceAll(tempRoot, '<isolated>')
    .replace(/\b\d{4}-\d{2}-\d{2}-(?=[a-z0-9-]+\.md\b)/g, '<date>-')
    .replace(
      /^health: ⚠ .*$/m,
      'health: ⚠ <expected fresh-store maintenance warnings omitted>',
    )
    .trimEnd();
}

function runKb(args, { env, tempRoot, input } = {}) {
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
  return normalizeOutput(child.stdout, tempRoot);
}

export function captureTerminalDemo() {
  const tempRoot = mkdtempSync(join(tmpdir(), 'kb-graph-terminal-demo-'));
  const env = childEnvironment(tempRoot);
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
      { env, tempRoot, input: '{}\n' },
    );

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

export function renderTerminalDemo(capture) {
  const linesByPanel = capture.panels.map(panelLines);
  const lineCount = Math.max(...linesByPanel.map(lines => lines.length));
  const panelHeight = HEADER_HEIGHT + 28 + lineCount * LINE_HEIGHT + 20;
  const height = MARGIN * 2 + panelHeight;
  const panels = capture.panels.map((panel, index) => {
    const x = MARGIN + index * (PANEL_WIDTH + GAP);
    const body = linesByPanel[index].map((line, lineIndex) => {
      if (line.kind === 'spacer') return '';
      const color = line.kind === 'command' ? '#f8f8f2' : '#d6dae4';
      return `    <text x="${x + 18}" y="${MARGIN + HEADER_HEIGHT + 29 + lineIndex * LINE_HEIGHT}" fill="${color}" style="font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace; font-size: 12px;" xml:space="preserve">${xmlEscape(line.text)}</text>`;
    }).filter(Boolean).join('\n');
    return [
      `  <g id="panel-${xmlEscape(panel.id)}">`,
      `    <rect x="${x}" y="${MARGIN}" width="${PANEL_WIDTH}" height="${panelHeight}" rx="14" fill="#151821" stroke="#303746"/>`,
      `    <circle cx="${x + 22}" cy="${MARGIN + 24}" r="5" fill="#ff5f57"/>`,
      `    <circle cx="${x + 38}" cy="${MARGIN + 24}" r="5" fill="#febc2e"/>`,
      `    <circle cx="${x + 54}" cy="${MARGIN + 24}" r="5" fill="#28c840"/>`,
      `    <text x="${x + 18}" y="${MARGIN + 51}" fill="#f8f8f2" style="font-family: -apple-system, BlinkMacSystemFont, &quot;Segoe UI&quot;, sans-serif; font-size: 15px; font-weight: 700;">${xmlEscape(panel.step)} · ${xmlEscape(panel.title)}</text>`,
      `    <text x="${x + 18}" y="${MARGIN + 67}" fill="#8b93a7" style="font-family: -apple-system, BlinkMacSystemFont, &quot;Segoe UI&quot;, sans-serif; font-size: 10px;">${xmlEscape(panel.subtitle)}</text>`,
      `    <rect x="${x + 1}" y="${MARGIN + HEADER_HEIGHT - 1}" width="${PANEL_WIDTH - 2}" height="1" fill="#303746"/>`,
      body,
      '  </g>',
    ].join('\n');
  }).join('\n');

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
  const check = process.argv.slice(2);
  if (check.some(arg => arg !== '--check') || check.length > 1) {
    throw new Error('Usage: node scripts/generate-terminal-demo.mjs [--check]');
  }
  const generated = generateTerminalDemo();
  if (check[0] === '--check') {
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
