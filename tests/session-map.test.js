import './helpers/tmp-kb.js';
import { describe, it } from 'node:test';
import assert from 'node:assert';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'fs';
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

// Backdates a file's mtime by `days` so the sweeper's age check treats it as
// stale without waiting a week for a real one.
function age(path, days) {
  const past = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  utimesSync(path, past, past);
}

describe('recordSessionMap — session-map retention sweep', () => {
  it('unlinks a sibling entry older than 7 days on a successful write', () => {
    recordSessionMap('sess-old', { resolve: () => ({ claudePid: 3001, pidStart: 'START' }) });
    const stale = join(SESSION_MAP_DIR, '3001.json');
    age(stale, 8);

    recordSessionMap('sess-new', { resolve: () => ({ claudePid: 3002, pidStart: 'START' }) });

    assert.strictEqual(existsSync(stale), false, 'an 8-day-old sibling should have been swept');
    assert.strictEqual(existsSync(join(SESSION_MAP_DIR, '3002.json')), true);
  });

  it('leaves a sibling entry younger than 7 days alone', () => {
    recordSessionMap('sess-recent', { resolve: () => ({ claudePid: 3003, pidStart: 'START' }) });
    const recent = join(SESSION_MAP_DIR, '3003.json');
    age(recent, 6);

    recordSessionMap('sess-trigger', { resolve: () => ({ claudePid: 3004, pidStart: 'START' }) });

    assert.strictEqual(existsSync(recent), true, 'a 6-day-old sibling is not stale yet');
  });

  it('does not delete the entry it just wrote, in the same pass that wrote it', () => {
    // A fresh write's own file has mtime = now, well inside the retention
    // window, so this also exercises the ordinary "not stale" path — the
    // sweep runs against this exact file in this exact call.
    const before = readdirSync(SESSION_MAP_DIR).length;
    recordSessionMap('sess-fresh', { resolve: () => ({ claudePid: 3007, pidStart: 'START' }) });
    assert.strictEqual(existsSync(join(SESSION_MAP_DIR, '3007.json')), true);
    assert.strictEqual(readdirSync(SESSION_MAP_DIR).length, before + 1);
  });

  it('survives a sibling it cannot stat (broken symlink) without throwing, and still completes the write', () => {
    mkdirSync(SESSION_MAP_DIR, { recursive: true });
    const brokenLink = join(SESSION_MAP_DIR, '9999.json');
    try {
      symlinkSync('/does/not/exist', brokenLink);
    } catch {
      return; // symlinks unavailable in this environment — nothing to assert
    }

    let ok;
    assert.doesNotThrow(() => {
      ok = recordSessionMap('sess-despite-broken-sibling', { resolve: () => ({ claudePid: 3008, pidStart: 'START' }) });
    });
    assert.strictEqual(ok, true, 'a sweep failure must not fail the write it rides on');
    rmSync(brokenLink, { force: true });
  });

});
