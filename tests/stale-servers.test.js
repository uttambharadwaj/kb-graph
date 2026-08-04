import { describe, it } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, utimesSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const { staleServers, sourceMtime, staleRemedy } = await import('../src/cli/stale-servers.js');

const CUTOFF = Date.parse('Wed Jul 29 22:43:07 2026');
const at = () => CUTOFF;
const ps = (...lines) => ['  PID  PPID STARTED                          ARGS', ...lines].join('\n');
const server = (pid, lstart, root = '/repo', ppid = 1) =>
  `${String(pid).padStart(5)} ${String(ppid).padStart(5)} ${lstart} /opt/node/bin/node ${root}/bin/kb.js mcp`;
const child = (pid, lstart, root = '/repo', ppid = 1) =>
  `${String(pid).padStart(5)} ${String(ppid).padStart(5)} ${lstart} /opt/node/bin/node ${root}/src/mcp.js`;

describe('staleServers', () => {
  it('reports a server started before the last source change', () => {
    const { stale } = staleServers(ps(server(69752, 'Mon Jul  6 10:14:20 2026')), at);
    assert.deepStrictEqual(stale.map(s => s.pid), [69752]);
    assert.strictEqual(stale[0].ageDays, 23);
  });

  it('ignores a server started after the change', () => {
    assert.deepStrictEqual(staleServers(ps(server(67122, 'Wed Jul 29 23:00:54 2026')), at).stale, []);
  });

  // A worktree's src/ is newer than the deploy checkout the servers run from,
  // so one global cutoff would report every running server as stale.
  it('judges each server against its own checkout', () => {
    const mtimes = { '/deploy/src': CUTOFF, '/worktree/src': Date.parse('Wed Jul 29 23:59:00 2026') };
    const { stale } = staleServers(ps(
      server(100, 'Wed Jul 29 23:00:00 2026', '/deploy'),
      server(200, 'Wed Jul 29 23:00:00 2026', '/worktree'),
    ), (dir) => mtimes[dir]);
    assert.deepStrictEqual(stale.map(s => s.pid), [200]);
  });

  // Worktrees get pruned out from under running servers. Answering "none stale"
  // when the check could not run is the invisible staleness this command exists
  // to end, so an unjudgeable server is reported rather than dropped.
  it('reports, rather than drops, a server whose checkout no longer exists', () => {
    const { stale, unknown } = staleServers(ps(server(300, 'Mon Jul  6 10:14:20 2026', '/gone')), () => {
      throw new Error('ENOENT: no such file');
    });
    assert.deepStrictEqual(stale, []);
    assert.deepStrictEqual(unknown.map(u => u.pid), [300]);
    assert.match(unknown[0].why, /\/gone: ENOENT/);
  });

  it('reports an mcp server whose ps line does not parse', () => {
    const { stale, unknown } = staleServers('node /repo/bin/kb.js mcp', at);
    assert.deepStrictEqual(stale, []);
    assert.deepStrictEqual(unknown.map(u => u.why), ['unparseable']);
  });

  // The oldest process is the one whose session has been writing wrong facts
  // longest, so it has to be the first line a human reads.
  it('sorts oldest first', () => {
    const { stale } = staleServers(ps(
      server(56351, 'Wed Jul 22 19:24:22 2026'),
      server(69752, 'Mon Jul  6 10:14:20 2026'),
      server(87003, 'Tue Jul 28 00:31:18 2026'),
    ), at);
    assert.deepStrictEqual(stale.map(s => s.pid), [69752, 56351, 87003]);
  });

  // bus-notifier runs from the same bin/kb.js and is far more numerous than the
  // MCP servers; matching it would bury the processes that actually matter.
  it('does not match other kb.js subcommands', () => {
    const line = '  2975     1 Sat Jul 25 22:45:32 2026 /opt/node/bin/node /repo/bin/kb.js bus-notifier --agent claude';
    assert.deepStrictEqual(staleServers(ps(line), at).stale, []);
  });

  // Started in the same millisecond the file was written: unknowable which side
  // of the write it loaded, so it is reported as current rather than alarming.
  it('treats a server started exactly at the change as current', () => {
    assert.deepStrictEqual(staleServers(ps(server(400, 'Wed Jul 29 22:43:07 2026')), at).stale, []);
  });

  it('ignores lines that are not processes', () => {
    assert.deepStrictEqual(staleServers("total garbage\n\n", at).stale, []);
  });

  // A supervisor never reloads itself, so its start time keeps receding past
  // every future change. Judging it would report a session that is in fact
  // serving current code, every single time, until the report meant nothing.
  it('judges a supervisor through its child, not by its own start time', () => {
    const { stale } = staleServers(ps(
      server(500, 'Mon Jul  6 10:14:20 2026'),
      child(501, 'Wed Jul 29 23:00:54 2026', '/repo', 500),
    ), at);
    assert.deepStrictEqual(stale, []);
  });

  it('reports a supervised child that is serving older code', () => {
    const { stale } = staleServers(ps(
      server(600, 'Mon Jul  6 10:14:20 2026'),
      child(601, 'Mon Jul  6 10:14:21 2026', '/repo', 600),
    ), at);
    assert.deepStrictEqual(stale.map(s => s.pid), [601]);
  });

  // Until every session has reconnected once, plain `kb.js mcp` servers from
  // before the supervisor shipped are still running — and they are the ones
  // that will never notice a change on their own.
  it('still reports a pre-supervisor server that has no child', () => {
    const { stale } = staleServers(ps(server(700, 'Mon Jul  6 10:14:20 2026')), at);
    assert.deepStrictEqual(stale.map(s => s.pid), [700]);
  });

  // predicates.json is read once at import, so a server predating a change to it
  // is as stale as one predating a .js change — and the watcher agrees, because
  // both read SOURCE_FILE.
  it('sourceMtime takes the newest source file under src/, json included', () => {
    const dir = mkdtempSync(join(tmpdir(), 'kb-stale-'));
    try {
      mkdirSync(join(dir, 'cli'));
      writeFileSync(join(dir, 'old.js'), '');
      writeFileSync(join(dir, 'cli', 'new.js'), '');
      writeFileSync(join(dir, 'cli', 'predicates.json'), '{}');
      writeFileSync(join(dir, 'README.md'), '');
      const t = Date.parse('2026-07-29T00:00:00Z') / 1000;
      utimesSync(join(dir, 'old.js'), t, t);
      utimesSync(join(dir, 'cli', 'new.js'), t + 3600, t + 3600);
      utimesSync(join(dir, 'cli', 'predicates.json'), t + 7200, t + 7200);
      utimesSync(join(dir, 'README.md'), t + 99999, t + 99999);
      assert.strictEqual(sourceMtime(dir), (t + 7200) * 1000);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('staleRemedy', () => {
  it('says reconnect when nothing is holding the reload back', () => {
    const advice = staleRemedy(null);
    assert.match(advice, /Reconnect/);
    assert.doesNotMatch(advice, /kb migrate/);
  });

  // Reconnecting during a held reload kills the server that is still working
  // and restarts into the error the hold exists to avoid, so the advice has to
  // change with the reason — a server held on purpose is not a broken one.
  it('says migrate, not reconnect, when a database is behind', () => {
    const advice = staleRemedy('knowledge base  /kb.db  behind by 1: 12. late');
    assert.match(advice, /12\. late/);
    assert.match(advice, /kb migrate/);
    assert.match(advice, /Reconnecting first only restarts into the same error/);
  });
});
