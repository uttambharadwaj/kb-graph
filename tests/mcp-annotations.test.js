import './helpers/tmp-kb.js';
import { describe, it } from 'node:test';
import assert from 'node:assert';
import { spawn } from 'child_process';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const SERVER = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'mcp.js');

// Codex under approval_policy=never auto-approves only tools advertising
// readOnlyHint; everything else is denied outright. A read tool that loses its
// annotation silently vanishes from Codex workers, so pin the wire contract.
function listTools() {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [SERVER], {
      stdio: ['pipe', 'pipe', 'inherit'],
      env: { ...process.env, KB_SUPERVISED: '1' },
    });
    const timer = setTimeout(() => { child.kill(); reject(new Error('timed out waiting for tools/list')); }, 10_000);
    let buf = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      buf += chunk;
      const lines = buf.split('\n');
      buf = lines.pop();
      for (const line of lines) {
        if (!line.trim()) continue;
        const msg = JSON.parse(line);
        if (msg.id === 2) {
          clearTimeout(timer);
          child.stdin.end();
          child.kill();
          resolve(msg.result.tools);
        }
      }
    });
    child.on('error', reject);
    const send = (o) => child.stdin.write(`${JSON.stringify(o)}\n`);
    send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'annotations-test', version: '1.0.0' } } });
    send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
  });
}

describe('MCP tool annotations', () => {
  it('read tools advertise readOnlyHint; write tools stay unannotated', async () => {
    const tools = await listTools();
    const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
    for (const name of ['kb_search', 'kb_read', 'kb_context', 'kb_fact_query', 'bus_status']) {
      assert.deepStrictEqual(byName[name].annotations, { readOnlyHint: true, destructiveHint: false }, name);
    }
    for (const name of ['kb_write', 'kb_supersede', 'kb_fact_add', 'bus_send', 'kb_classify', 'kb_extract', 'bus_read']) {
      assert.strictEqual(byName[name].annotations, undefined, name);
    }
  });
});
