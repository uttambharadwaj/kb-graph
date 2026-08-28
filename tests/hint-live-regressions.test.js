import './helpers/tmp-kb.js';
import { before, describe, it } from 'node:test';
import assert from 'node:assert';
import { getDb } from '../src/db.js';
import { filterAliases, relevantNotes } from '../src/hint-relevance.js';

const TITLES = {
  hook: 'Prompt hook hints expose contaminated channels',
  browser: 'Browser harness hookup prompt validated',
  latency: 'Prompt latency tests show generation cost',
  genericHook: 'A resolvability check finds the corpse; only a property check finds the ones about to die',
  timeout: 'KB extract timeout in Claude CLI',
  reconnect: 'MCP reconnect restores a dead server connection',
  enterprise: 'NEC blocked on onboarding',
};

before(() => {
  const insert = getDb().prepare(
    'INSERT INTO documents (title, content, doc_type, tags, aliases) VALUES (?, ?, ?, ?, ?)'
  );

  insert.run(TITLES.hook, 'The prompt hook meters hints and separates user traffic from harness traffic.', 'lesson', 'knowledge-base-server, instrumentation', null);
  insert.run(TITLES.browser, 'A browser harness hookup prompt starts a remote browser session.', 'research', 'browser, harness', null);
  insert.run(TITLES.latency, 'A prompt that asks the model to emit more facts takes longer to finish.', 'lesson', 'performance, testing', null);
  insert.run(TITLES.genericHook, 'A property check detects the last valid reference.', 'lesson', 'hooks, runtime', null);
  const timeoutContent = `The nested Claude process timed out while extracting facts. ${'timeout diagnostics '.repeat(45)}Restarting the KB server only refreshes loaded code.`;
  insert.run(TITLES.timeout, timeoutContent, 'fix', 'knowledge-base, timeout', null);
  insert.run(TITLES.reconnect, 'Reconnect the MCP transport after a server process exits.', 'lesson', 'knowledge-base, cli', null);
  insert.run(TITLES.enterprise, 'NEC onboarding is blocked while the enterprise identity provider is selected.', 'decision', 'enterprise-onboarding, workos', null);

  // The live scorer drops prompt terms with document frequency one as likely
  // identifiers. These siblings put every subject term in the same statistical
  // regime as the live corpus without creating competing identity matches.
  insert.run('Hook audit sibling', 'the hook fires once per prompt', 'note', 'misc', null);
  insert.run('Show command sibling', 'show the current state', 'note', 'misc', null);
  insert.run('Restart operations sibling', 'restart only after draining calls', 'note', 'misc', null);
  insert.run('Blocked queue sibling', 'blocked work stays visible', 'note', 'misc', null);
  insert.run('Work queue sibling', 'work enters the queue here', 'note', 'misc', null);
  insert.run('Transport vocabulary sibling', 'mcp reconnect is the transport lifecycle', 'note', 'misc', null);

  for (let i = 0; i < 260; i++) {
    insert.run(`Filler ${i}`, `unremarkable prose zq${i}xj${i}kv`, 'note', 'misc', null);
  }

  const timeoutAlias = filterAliases(['restart'], {
    title: TITLES.timeout,
    tags: 'knowledge-base, timeout',
    content: timeoutContent,
  });
  getDb().prepare('UPDATE documents SET aliases = ? WHERE title = ?').run(timeoutAlias || null, TITLES.timeout);
});

describe('observed prompt-hint false positives', () => {
  it('does not treat hook as an inflection of hookup or generic show as subject evidence', () => {
    const hits = relevantNotes('how good have the prompt hook hints been? I have seen some random ones show up');
    const titles = hits.map(hit => hit.title);

    assert.ok(titles.includes(TITLES.hook), `the actual hook note disappeared: ${titles.join(' | ')}`);
    assert.ok(!titles.includes(TITLES.browser), `hook matched hookup: ${titles.join(' | ')}`);
    assert.ok(!titles.includes(TITLES.latency), `prompt + show cleared the subject gate: ${titles.join(' | ')}`);
    assert.ok(!titles.includes(TITLES.genericHook), `generic ones + hook cleared the subject gate: ${titles.join(' | ')}`);
  });

  it('does not let a generic restart alias combine with cli to surface a timeout note', () => {
    const hits = relevantNotes('connected again to kb? why do I need to restart the cli to connect? so lame');
    assert.ok(!hits.some(hit => hit.title === TITLES.timeout), JSON.stringify(hits));
  });

  it('does not let work match workos beside an otherwise relevant word', () => {
    const hits = relevantNotes('doesnt need to be blocked especially on kb related work');
    assert.ok(!hits.some(hit => hit.title === TITLES.enterprise), JSON.stringify(hits));
  });

  it('preserves explicit MCP reconnect recall', () => {
    const hits = relevantNotes('how do I reconnect mcp on here');
    assert.ok(hits.some(hit => hit.title === TITLES.reconnect), JSON.stringify(hits));
  });

  it('can explain matched families without changing the default result shape', () => {
    const plain = relevantNotes('how do I reconnect mcp on here');
    const explained = relevantNotes('how do I reconnect mcp on here', { explain: true });
    const hit = explained.find(row => row.title === TITLES.reconnect);

    assert.ok(hit?.evidence?.families?.length >= 2, JSON.stringify(hit));
    assert.equal(typeof hit.evidence.min_mass, 'number');
    assert.equal(typeof hit.evidence.total_mass, 'number');
    assert.ok(hit.evidence.families.every(family => Array.isArray(family.sources)));
    assert.ok(plain.every(row => !('evidence' in row)), JSON.stringify(plain));
  });
});
