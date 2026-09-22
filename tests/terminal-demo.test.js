import './helpers/tmp-kb.js';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import {
  generateTerminalDemo,
  renderTerminalDemo,
} from '../scripts/generate-terminal-demo.mjs';

const read = path => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const committedJson = read('docs/assets/terminal-demo.json');
const committedSvg = read('docs/assets/terminal-demo.svg');
const fixture = read('docs/demo/terminal-demo-note.json');
const readme = read('README.md');

describe('real-process terminal demo', () => {
  it('is reproduced byte for byte by real commands in isolated fresh processes', {
    timeout: 180_000,
  }, () => {
    const liveTestKbBefore = readdirSync(process.env.KB_DIR).sort();
    const generated = generateTerminalDemo();

    assert.equal(generated.json, committedJson);
    assert.equal(generated.svg, committedSvg);
    assert.equal(renderTerminalDemo(generated.capture), committedSvg);
    assert.deepEqual(readdirSync(process.env.KB_DIR).sort(), liveTestKbBefore);
    assert.deepEqual(generated.capture.proof, {
      output: 'captured, not authored',
      processes: 3,
      state: 'isolated temporary KB_DIR and vault',
      externalAgentCli: false,
    });
    assert.match(generated.capture.panels[0].output, /^Note #1 saved /);
    assert.match(generated.capture.panels[1].output, /Found 1 result\(s\)/);
    assert.match(generated.capture.panels[2].output, /^KB BRIEFING /);
    assert.match(generated.capture.panels[2].output, /Deploys reset shared retry budgets/);
  });

  it('contains only public synthetic input and normalized captured output', () => {
    const publicBytes = `${fixture}\n${committedJson}\n${committedSvg}`;
    const forbidden = [
      /\/(?:Users|home)\//i,
      /\b(?:tinyfish|mino)\b/i,
      /\bPF-\d+\b/i,
      /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i,
      /\b(?:Bearer\s+|sk-|ghp_|phc_|xox[baprs]-)[A-Za-z0-9._-]{8,}/i,
    ];
    for (const pattern of forbidden) assert.doesNotMatch(publicBytes, pattern);
    assert.doesNotMatch(publicBytes, /\d{4}-\d{2}-\d{2}-deploys-reset/);
  });

  it('is the README hero without pretending to record cross-agent UI', () => {
    const badges = readme.indexOf('](LICENSE)');
    const image = readme.indexOf('](docs/assets/terminal-demo.svg)');
    const intro = readme.indexOf('Storage and retrieval are local.');

    assert.ok(badges < image);
    assert.ok(image < intro);
    assert.match(readme, /three actual kb-graph commands, three fresh Node processes/i);
    assert.match(readme, /not a cross-agent UI recording/i);
    assert.match(readme, /Temporary paths, the note date.+normalized/i);
  });

  it('uses a safe GitHub-renderable SVG subset', () => {
    assert.match(committedSvg, /role="img" aria-labelledby="terminal-title terminal-desc"/);
    assert.doesNotMatch(committedSvg, /<(?:script|foreignObject|image|use|a)\b|(?:href|xlink:href)=/i);
    assert.ok(Buffer.byteLength(committedSvg) < 40_000);
    const tags = [...committedSvg.matchAll(/<\/?([A-Za-z][\w:-]*)\b/g)].map(match => match[1]);
    const supported = new Set(['svg', 'title', 'desc', 'g', 'rect', 'circle', 'text']);
    for (const tag of tags) assert.ok(supported.has(tag), `unsupported SVG element <${tag}>`);
  });
});
