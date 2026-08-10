import './helpers/tmp-kb.js';
import { describe, it } from 'node:test';
import assert from 'node:assert';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { recordSessionMap, resolveMapEntry, SESSION_MAP_DIR } from '../src/session-map.js';

const entryFor = (pid) => JSON.parse(readFileSync(join(SESSION_MAP_DIR, `${pid}.json`), 'utf8'));

describe('recordSessionMap', () => {
  it('writes pid, pid_start, session_id and ts atomically (no .tmp file left behind)', () => {
    const ok = recordSessionMap('sess-write-1', {
      resolve: () => ({ claudePid: 1001, pidStart: 'Sun Aug  9 20:00:00 2026' }),
    });
    assert.strictEqual(ok, true);
    const entry = entryFor(1001);
    assert.strictEqual(entry.pid, 1001);
    assert.strictEqual(entry.pid_start, 'Sun Aug  9 20:00:00 2026');
    assert.strictEqual(entry.session_id, 'sess-write-1');
    assert.ok(entry.ts);
    assert.ok(!readdirSync(SESSION_MAP_DIR).some(f => f.includes('.tmp')));
  });

  it('overwrites an existing entry for the same pid (a session id that changed under one pid)', () => {
    recordSessionMap('sess-a', { resolve: () => ({ claudePid: 1002, pidStart: 'START' }) });
    recordSessionMap('sess-b', { resolve: () => ({ claudePid: 1002, pidStart: 'START' }) });
    assert.strictEqual(entryFor(1002).session_id, 'sess-b');
  });

  it('keeps two concurrent pids in separate files', () => {
    recordSessionMap('sess-x', { resolve: () => ({ claudePid: 1003, pidStart: 'START-X' }) });
    recordSessionMap('sess-y', { resolve: () => ({ claudePid: 1004, pidStart: 'START-Y' }) });
    assert.strictEqual(entryFor(1003).session_id, 'sess-x');
    assert.strictEqual(entryFor(1004).session_id, 'sess-y');
  });

  it('does not write when ancestry resolution finds no claude pid', () => {
    const before = existsSync(SESSION_MAP_DIR) ? readdirSync(SESSION_MAP_DIR).length : 0;
    const ok = recordSessionMap('sess-orphan', { resolve: () => ({ claudePid: null, pidStart: null }) });
    assert.strictEqual(ok, false);
    assert.strictEqual(existsSync(SESSION_MAP_DIR) ? readdirSync(SESSION_MAP_DIR).length : 0, before);
  });

  it('does not write without a session id', () => {
    const ok = recordSessionMap(null, { resolve: () => ({ claudePid: 1005, pidStart: 'START' }) });
    assert.strictEqual(ok, false);
    assert.strictEqual(existsSync(join(SESSION_MAP_DIR, '1005.json')), false);
  });

  it('never throws — a resolve() failure is swallowed and reported as a non-write', () => {
    assert.doesNotThrow(() => {
      const ok = recordSessionMap('sess-x', { resolve: () => { throw new Error('ps exploded'); } });
      assert.strictEqual(ok, false);
    });
  });
});

describe('resolveMapEntry', () => {
  it('returns the entry with pidStartOk true when pid_start matches', () => {
    recordSessionMap('sess-match', { resolve: () => ({ claudePid: 2001, pidStart: 'START' }) });
    const { entry, pidStartOk } = resolveMapEntry(2001, 'START');
    assert.strictEqual(entry.session_id, 'sess-match');
    assert.strictEqual(pidStartOk, true);
  });

  it('reports a pid_start mismatch as a plain miss — entry null, pidStartOk false — and leaves the file alone', () => {
    recordSessionMap('sess-stale', { resolve: () => ({ claudePid: 2002, pidStart: 'OLD-START' }) });
    const path = join(SESSION_MAP_DIR, '2002.json');
    assert.deepStrictEqual(resolveMapEntry(2002, 'NEW-START'), { entry: null, pidStartOk: false });
    // Read-side never deletes: this resolver's own ancestry cache can itself
    // be the stale side of the comparison (a long-lived orphaned server), and
    // a delete driven by that would erase a DIFFERENT, live process's current
    // mapping after pid reuse. Cleanup is the hygiene slice's sweeper's job.
    assert.strictEqual(existsSync(path), true, 'a mismatched entry must survive a failed resolve');
    assert.strictEqual(entryFor(2002).session_id, 'sess-stale', 'and still read back exactly as written');
  });

  it('returns entry null when no file exists for the pid', () => {
    assert.deepStrictEqual(resolveMapEntry(2003, 'ANY'), { entry: null, pidStartOk: false });
  });

  it('treats a corrupt map file as missing rather than throwing', () => {
    mkdirSync(SESSION_MAP_DIR, { recursive: true });
    writeFileSync(join(SESSION_MAP_DIR, '2004.json'), 'not json', 'utf8');
    assert.deepStrictEqual(resolveMapEntry(2004, 'ANY'), { entry: null, pidStartOk: false });
  });
});
