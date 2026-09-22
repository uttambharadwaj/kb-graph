import './helpers/tmp-kb.js';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import {
  computeLayout,
  hasRenderDrift,
  renderLoopFigure,
} from '../scripts/render-loop-figure.mjs';
import { assertPublicArtifactSafe } from './helpers/public-artifact-policy.js';

function readText(path) {
  return readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
}

function getLineText(panel) {
  return panel.lines.map(line => line.text);
}

const fixtureText = readText('docs/assets/loop-demo.json');
const fixture = JSON.parse(fixtureText);
const committedSvg = readText('docs/assets/loop-demo.svg');
const readme = readText('README.md');
const wakeupSource = readText('src/cli/wakeup-hook.js');
const hintSource = readText('src/cli/prompt-hint.js');
const toolsSource = readText('src/tools.js');

describe('README knowledge-loop figure', () => {
  it('matches the deterministic JSON rendering byte for byte', () => {
    assert.equal(renderLoopFigure(fixture), committedSvg);
    assert.equal(hasRenderDrift(fixture, committedSvg), false);
    assert.equal(hasRenderDrift(fixture, `${committedSvg}<!-- stale -->\n`), true);
  });

  it('escapes every fixture string before placing it in XML', () => {
    const hostile = structuredClone(fixture);
    hostile.title = `A < B & "quoted" 'once'`;
    hostile.panels[0].lines[0].text = `<script>&"'`;

    const svg = renderLoopFigure(hostile);

    assert.match(svg, /A &lt; B &amp; &quot;quoted&quot; &apos;once&apos;/);
    assert.match(svg, /&lt;script&gt;&amp;&quot;&apos;/);
    assert.doesNotMatch(svg, /<script>/);
  });

  it('excludes known private-data patterns from the fixture and SVG', () => {
    assertPublicArtifactSafe(`${fixtureText}\n${committedSvg}`);
  });

  it('uses current runtime prefixes and handler response shape', () => {
    const briefing = getLineText(fixture.panels.find(panel => panel.id === 'briefing'));
    assert.ok(briefing[0].startsWith('KB BRIEFING ('));
    assert.match(wakeupSource, /`KB BRIEFING \(knowledge-base MCP;/);
    assert.ok(briefing.includes('Active workstreams (kb_read for current state):'));
    assert.ok(briefing.includes('Recently updated:'));
    assert.ok(briefing.some(line => line.startsWith('Before non-trivial work: kb_search(query, tags)')));
    assert.ok(briefing.some(line => line.startsWith('At a durable boundary, call kb_write directly;')));
    assert.ok(briefing.some(line => line.endsWith('…')));
    assert.ok(briefing.some(line => line.includes('synthetic example')));
    assert.match(briefing[0], /2 current facts/);
    assert.ok(briefing.includes('- #41 example-app launch state (as of 2026-09-18)'));
    assert.ok(briefing.includes('- Retry boundaries [example-app] (lesson)'));
    assert.ok(!briefing.some(line => line.startsWith('standing: ')));
    assert.doesNotMatch(briefing.join('\n'), /\b(?:verified|inferred|standing:)\b/i);
    assert.doesNotMatch(briefing.join('\n'), /⚠/);

    const hint = getLineText(fixture.panels.find(panel => panel.id === 'hint'));
    assert.ok(hint.some(line => line.startsWith('KB HINT: the knowledge base has entries relevant to this prompt:')));
    assert.match(hintSource, /`KB HINT: the knowledge base has entries relevant to this prompt:/);
    assert.ok(hint.some(line => line.includes('#42 "Retry boundaries" (lesson).')));
    assert.ok(hint.includes('(no hint)'));
    assert.doesNotMatch(hint.join('\n'), /\b(?:verified|inferred|standing:)\b/i);
    assert.doesNotMatch(hint.join('\n'), /⚠|unconfirmed model conclusion|treat it as a lead/i);

    const capture = fixture.panels.find(panel => panel.id === 'capture');
    assert.equal(capture.subtitle, 'kb_write · synthetic input');
    assert.deepEqual(capture.input, {
      title: 'Deploys reset retry budgets',
      content: 'Reset per-worker retry counters when a deployment activates.',
      type: 'lesson',
      project: 'example-app',
      tier: 'verified',
      tier_ref: '#88',
    });
    assert.equal(
      capture.lines.at(-1).text,
      'Note #43 saved to agents/lessons/2026-09-18-deploys-reset-retry-budgets.md as verified; indexed 1 changed, 0 unchanged',
    );
    assert.match(toolsSource, /`Note\$\{idNote\} saved to \$\{result\.path\} as \$\{result\.tier\}/);
  });

  it('keeps the synthetic asset with the loop documentation', () => {
    const loopHeading = readme.indexOf('## The loop');
    const image = readme.indexOf(
      '[![Three-step kb-graph loop: session briefing, targeted prompt hint, and durable capture](docs/assets/loop-demo.svg)](docs/assets/loop-demo.svg)',
    );
    const caption = readme.indexOf(
      '*Deterministic documentation illustration with synthetic data.',
    );
    const retrieve = readme.indexOf('### Retrieve');

    assert.ok(loopHeading < image);
    assert.ok(image < caption);
    assert.ok(caption < retrieve);
  });

  it('stays compact, accessible, and within the supported SVG subset', () => {
    const { width, height } = computeLayout(fixture);
    assert.equal(width, 1200);
    assert.match(
      committedSvg,
      new RegExp(
        `<svg[^>]+width="${width}"[^>]+height="${height}"[^>]+viewBox="0 0 ${width} ${height}"`,
      ),
    );
    assert.match(committedSvg, /role="img" aria-labelledby="loop-title loop-desc"/);
    assert.match(committedSvg, /<title id="loop-title">/);
    assert.match(committedSvg, /<desc id="loop-desc">/);
    assert.doesNotMatch(committedSvg, /<(?:script|foreignObject|image|use|a)\b|(?:href|xlink:href)=/i);
    assert.ok(Buffer.byteLength(committedSvg) < 30_000, 'SVG should remain under 30 KB');

    const tags = [...committedSvg.matchAll(/<\/?([A-Za-z][\w:-]*)\b/g)].map(match => match[1]);
    const supported = new Set(['svg', 'title', 'desc', 'g', 'rect', 'circle', 'text', 'tspan']);
    for (const tag of tags) assert.ok(supported.has(tag), `unsupported SVG element <${tag}>`);
  });
});
