import './helpers/tmp-kb.js';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import {
  createExternalAgentCliSentinel,
  EXPECTED_FRESH_STORE_WARNINGS,
  generateTerminalDemo,
  normalizeFreshStoreHealth,
  renderTerminalDemo,
} from '../scripts/generate-terminal-demo.mjs';
import { assertPublicArtifactSafe } from './helpers/public-artifact-policy.js';

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
    assertPublicArtifactSafe(publicBytes);
    assert.doesNotMatch(publicBytes, /\d{4}-\d{2}-\d{2}-deploys-reset/);
  });

  it('refuses to hide an unexpected health warning', () => {
    const expected = `health: ⚠ ${EXPECTED_FRESH_STORE_WARNINGS.join(' | ')}`;
    assert.equal(
      normalizeFreshStoreHealth(expected),
      'health: ⚠ <expected fresh-store maintenance warnings omitted>',
    );
    assert.throws(
      () => normalizeFreshStoreHealth(`${expected} | unexpected provider failure`),
      /fresh-store health warnings changed.+unexpected provider failure/,
    );
  });

  it('fails if the external-agent invocation sentinel is called', () => {
    const tempRoot = mkdtempSync(join(tmpdir(), 'kb-demo-agent-sentinel-test-'));
    try {
      const sentinel = createExternalAgentCliSentinel(tempRoot);
      sentinel.assertNotInvoked();
      const invoked = spawnSync(sentinel.executable, [], {
        env: { ...process.env, ...sentinel.environment },
      });
      assert.equal(invoked.status, 97);
      assert.throws(
        () => sentinel.assertNotInvoked(),
        /external agent CLI was invoked/,
      );
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
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
