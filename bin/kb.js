#!/usr/bin/env node
// bin/kb.js — CLI entry point.
// One table drives dispatch, the command list, per-command help, and flag
// validation, so a command cannot gain a flag that `--help` fails to mention.

import { lockPreferredNodeRuntime } from '../src/cli/runtime-node.js';
import { acceptFlags, runEntryPoint, wantsHelp } from '../src/cli/flags.js';
import { PENDING_EXIT } from '../src/schema.js';
import 'dotenv/config';

await lockPreferredNodeRuntime(import.meta.url);

const command = process.argv[2];
const args = process.argv.slice(3);

// Bus commands also ship as standalone bins, so they validate their own flags
// and print their own help. Declaring their flags a second time here is how the
// two copies drift.
const DELEGATED = { delegated: true };

const COMMANDS = {
  start: {
    summary: 'Start the dashboard server (default :3838)',
    run: () => import('../src/server.js').then(m => m.start()),
  },
  stop: {
    summary: 'Stop the running server',
    run: () => import('../src/cli/stop.js').then(m => m.stop()),
  },
  mcp: {
    summary: 'Start MCP stdio server (used by AI tools)',
    run: () => import('../src/mcp-supervisor.js').then(m => m.superviseMcpServer()),
  },
  serve: {
    summary: 'Run the resident MCP daemon on a unix socket (--status probes a running one, exit 1 when down)',
    boolean: ['--status'],
    valueEq: ['--socket'],
    run: a => import('../src/cli/serve.js').then(m => m.runServeCli(a)),
  },
  migrate: {
    summary: `Apply pending database schema migrations (--dry-run to preview, --check to exit ${PENDING_EXIT} when a database is behind)`,
    boolean: ['--dry-run', '--check'],
    run: a => import('../src/cli/migrate.js').then(m => m.runMigrateCli(a)),
  },
  register: {
    summary: 'Register MCP server with Claude/Codex/Gemini (--force to move an existing registration)',
    valueEq: ['--agents'],
    boolean: ['--force'],
    run: a => import('../src/cli/register.js').then(m => m.register(a)),
  },
  ingest: {
    summary: 'Ingest a file or directory',
    args: '<path>',
    run: a => import('../src/cli/ingest-cli.js').then(m => m.ingest(a[0])),
  },
  search: {
    summary: 'Search documents',
    args: '<query>',
    run: a => import('../src/cli/search-cli.js').then(m => m.search(a.join(' '))),
  },
  status: {
    summary: 'Show stats and server status',
    run: () => import('../src/cli/status.js').then(m => m.status()),
  },
  tags: {
    summary: "Show tag report; 'tags alias <a> <b>' / 'tags aliases' to manage aliases",
    args: '[alias <alias> <canonical> | aliases]',
    run: a => import('../src/cli/tags-cli.js').then(m => m.runTagsCli(a)),
  },
  tier: {
    summary: 'Show notes by epistemic tier and backfill tiers from provenance',
    boolean: ['--apply'],
    run: a => import('../src/cli/tier-cli.js').then(m => m.runTierCli(a)),
  },
  'retrieval-report': {
    summary: 'Read-path coverage: how much of the KB has ever been retrieved',
    run: () => import('../src/cli/retrieval-report.js').then(m => m.runRetrievalReportCli()),
  },
  'follow-through': {
    summary: 'Event-unit follow-through per push surface (hint/briefing), kb_search pull-rate benchmark, trigger fires, cluster-bootstrap CI (--json for machine-readable, --exclude-session <id> repeatable)',
    value: ['--exclude-session'],
    boolean: ['--json'],
    run: a => import('../src/cli/follow-through.js').then(m => m.runFollowThroughCli(a)),
  },
  promotions: {
    summary: 'Promote inferred docs that a followed hint/trigger push confirmed to observed (--dry-run to log only, --json for machine-readable)',
    boolean: ['--json', '--dry-run'],
    run: a => import('../src/cli/promotions.js').then(m => m.runPromotionsCli(a)),
  },
  'surface-report': {
    summary: 'Per-tool and per-model-caller demand, failures and latency, plus where the duplicate threshold really sits',
    run: () => import('../src/cli/surface-report.js').then(m => m.runSurfaceReportCli()),
  },
  meters: {
    summary: "'meters prune --keep-days <N>' deletes old rows from the meter tables that can be pruned safely (--dry-run to preview, --table to scope to one)",
    args: 'prune',
    value: ['--keep-days', '--table'],
    boolean: ['--dry-run'],
    run: a => {
      if (a[0] !== 'prune') { console.error(usageFor('meters')); process.exit(2); }
      return import('../src/cli/meters-cli.js').then(m => m.runMetersPruneCli(a.slice(1)));
    },
  },
  'hint-probe': {
    summary: 'Replay every prompt the hint has seen against the current scorer; diff two runs to grade a change',
    run: () => import('../src/cli/hint-probe.js').then(m => m.runHintProbeCli()),
  },
  'aliases-backfill': {
    summary: 'Propose retrieval aliases (one model call per note) for notes never asked, filter, store; --revet re-filters stored proposals with no model calls',
    value: ['--limit', '--doc'],
    boolean: ['--dry-run', '--revet'],
    run: a => import('../src/cli/aliases-backfill.js').then(m => m.runAliasesBackfillCli(a)),
  },
  'trigger-corpus': {
    summary: 'Extract the historical Bash command corpus from Claude transcripts (grades trigger noise ceilings)',
    value: ['--projects'],
    run: a => import('../src/cli/trigger-corpus.js').then(m => m.runTriggerCorpusCli(a)),
  },
  'triggers-backfill': {
    summary: 'Propose command triggers (one model call per note) for notes never asked, filter, store; --revet re-filters stored proposals with no model calls',
    value: ['--limit', '--doc'],
    boolean: ['--dry-run', '--revet'],
    run: a => import('../src/cli/triggers-backfill.js').then(m => m.runTriggersBackfillCli(a)),
  },
  'wakeup-hook': {
    summary: 'Print compact KB briefing (for SessionStart hooks)',
    run: () => import('../src/cli/wakeup-hook.js').then(m => m.wakeupHook()),
  },
  'prompt-hint': {
    summary: 'Read hook JSON on stdin, print KB hint for the prompt (for UserPromptSubmit hooks)',
    run: () => import('../src/cli/prompt-hint.js').then(m => m.promptHint()),
  },
  'trigger-hook': {
    summary: 'Read hook JSON on stdin, warn on a vetted command trigger (for PreToolUse/Bash hooks); '
      + 'emits only when <KB_DIR>/trigger-hook-enabled exists, log-only otherwise',
    run: () => import('../src/cli/trigger-hook.js').then(m => m.triggerHook()),
  },
  'link-backfill': {
    summary: 'Connect existing docs via embedding neighbors (doc_links + Related sections)',
    run: () => import('../src/cli/link-backfill.js').then(m => m.linkBackfill()),
  },
  'stale-servers': {
    summary: 'List running MCP servers that started before the last src/ change',
    run: () => import('../src/cli/stale-servers.js').then(m => m.runStaleServersCli()),
  },
  'fold-inverses': {
    summary: 'Fold pre-existing facts onto one predicate and direction per relationship',
    boolean: ['--apply'],
    run: a => import('../src/cli/fold-inverses.js').then(m => m.runFoldInversesCli(a)),
  },
  'canonicalize-entities': {
    summary: 'Merge fact-graph entities that differ only in case or separators',
    boolean: ['--apply', '--dry-run', '--verbose'],
    run: a => import('../src/cli/canonicalize-entities.js').then(m => m.runCanonicalizeEntitiesCli(a)),
  },
  harvest: {
    summary: 'Auto-debrief session transcripts',
    boolean: ['--dry-run', '--facts', '--no-facts'],
    valueEq: ['--since-hours', '--path'],
    run: a => import('../src/harvest.js').then(m => m.runHarvestCli(a)),
  },
  'consolidate-state': {
    summary: 'Fold session notes into per-workstream state notes',
    boolean: ['--dry-run'],
    valueEq: ['--project'],
    run: a => import('../src/state.js').then(m => m.runConsolidateStateCli(a)),
  },
  'entity-merge': {
    summary: 'Merge a fact-graph entity into a canonical one',
    args: '<from> <to>',
    run: a => import('../src/facts.js').then(m => {
      if (a.length < 2) { console.error(usageFor('entity-merge')); process.exit(2); }
      console.log(JSON.stringify(m.mergeEntity(a[0], a[1]), null, 2));
    }),
  },
  'capture-x': {
    summary: 'Capture X/Twitter bookmarks to vault',
    args: '[path]',
    run: a => import('../src/capture/x-bookmarks.js').then(m => {
      const bookmarksPath = a[0] || (process.env.HOME + '/knowledgebase/x_bookmarks.md');
      const vaultPath = process.env.OBSIDIAN_VAULT_PATH;
      if (!vaultPath) { console.error('OBSIDIAN_VAULT_PATH not set'); process.exit(1); }
      const result = m.captureXBookmarks(bookmarksPath, vaultPath);
      console.log(`X bookmarks: ${result.created} created, ${result.skipped} skipped (${result.total} total)`);
    }),
  },
  classify: {
    summary: 'Auto-classify new clippings/inbox notes',
    boolean: ['--dry-run'],
    run: a => import('../src/classify/processor.js').then(async m => {
      const dryRun = a.includes('--dry-run');
      const vaultPath = process.env.OBSIDIAN_VAULT_PATH;
      if (!vaultPath) { console.error('OBSIDIAN_VAULT_PATH not set'); process.exit(1); }
      const result = await m.processNewClippings(vaultPath, { dryRun });
      console.log(`\nClassified: ${result.processed}/${result.total} notes`);
      if (result.errors) console.log(`Errors: ${result.errors}`);
      if (dryRun) console.log('(dry run — no changes written)');
    }),
  },
  summarize: {
    summary: 'Add AI summaries to docs without them',
    boolean: ['--dry-run'],
    valueEq: ['--limit'],
    run: a => import('../src/classify/summarizer.js').then(async m => {
      const dryRun = a.includes('--dry-run');
      const limitFlag = a.find(arg => arg.startsWith('--limit='));
      const limit = limitFlag ? parseInt(limitFlag.split('=')[1], 10) : 0;
      const vaultPath = process.env.OBSIDIAN_VAULT_PATH;
      if (!vaultPath) { console.error('OBSIDIAN_VAULT_PATH not set'); process.exit(1); }
      const result = await m.summarizeUnsummarized(vaultPath, { dryRun, limit });
      console.log(`\nSummarized: ${result.summarized}/${result.total} notes`);
      if (result.errors) console.log(`Errors: ${result.errors}`);
      if (dryRun) console.log('(dry run — no changes written)');
    }),
  },
  setup: {
    summary: 'Interactive setup wizard (--auto for agent mode)',
    boolean: ['--auto', '--no-load-jobs'],
    valueEq: ['--port', '--password', '--vault', '--agents', '--deploy', '--brain', '--domain'],
    run: a => import('../src/cli/setup.js').then(m => m.setup(a)),
  },
  'safety-check': {
    summary: 'Review a destructive action before executing it',
    args: '<action description>',
    run: a => import('../src/safety/review.js').then(async m => {
      const action = a.join(' ');
      if (!action) { console.error(usageFor('safety-check')); process.exit(2); }
      const result = await m.reviewDestructiveAction(action);
      console.log(JSON.stringify(result, null, 2));
      if (!result.safe) process.exit(1);
    }),
  },
  vault: {
    summary: 'Reindex Obsidian vault (embeddings on; --no-embeddings to skip)',
    args: 'reindex',
    boolean: ['--no-embeddings'],
    run: a => {
      if (a[0] !== 'reindex') { console.error(usageFor('vault')); process.exit(2); }
      return import('../src/cli/vault-cli.js').then(m => m.vaultReindex());
    },
  },
  'bus-send': { summary: 'Send a local message bus message', ...DELEGATED, run: a => import('../src/bus/cli.js').then(m => m.runBusSendCli(a)) },
  'bus-read': { summary: 'Read messages using a stored per-reader cursor', ...DELEGATED, run: a => import('../src/bus/cli.js').then(m => m.runBusReadCli(a)) },
  'bus-status': { summary: 'Show channel readers, backlog, heartbeats, and latest control', ...DELEGATED, run: a => import('../src/bus/cli.js').then(m => m.runBusStatusCli(a)) },
  'bus-session': { summary: 'Register/list bus sessions and recorded hook handoffs', ...DELEGATED, run: a => import('../src/bus/cli.js').then(m => m.runBusSessionCli(a)) },
  'bus-agent': { summary: 'Register/list executable bus workers', ...DELEGATED, run: a => import('../src/bus/cli.js').then(m => m.runBusAgentCli(a)) },
  'bus-agentd': { summary: 'Launch executable workers for bus tasks', ...DELEGATED, run: a => import('../src/bus/cli.js').then(m => m.runBusAgentdCli(a)) },
  'bus-hook': { summary: 'Emit hook-friendly digests for unread bus messages', ...DELEGATED, run: a => import('../src/bus/cli.js').then(m => m.runBusHookCli(a)) },
  'bus-bind': { summary: 'Add/list workspace bus subscriptions for an agent', ...DELEGATED, run: a => import('../src/bus/cli.js').then(m => m.runBusBindCli(a)) },
  'bus-unbind': { summary: 'Clear one or all workspace bus subscriptions for an agent', ...DELEGATED, run: a => import('../src/bus/cli.js').then(m => m.runBusUnbindCli(a)) },
  'bus-hook-current': { summary: 'Resolve the current workspace binding and emit hook digests', ...DELEGATED, run: a => import('../src/bus/cli.js').then(m => m.runBusHookCurrentCli(a)) },
  'bus-notifier': { summary: 'Maintain a background pending-digest notifier for the current workspace binding', ...DELEGATED, run: a => import('../src/bus/cli.js').then(m => m.runBusNotifierCli(a)) },
};

function usageFor(name) {
  const entry = COMMANDS[name];
  const parts = [`kb ${name}`];
  if (entry.args) parts.push(entry.args);
  for (const flag of entry.valueEq || []) parts.push(`[${flag}=<value>]`);
  for (const flag of entry.value || []) parts.push(`[${flag} <value>]`);
  for (const flag of entry.boolean || []) parts.push(`[${flag}]`);
  return `Usage: ${parts.join(' ')}\n\n  ${entry.summary}`;
}

function topLevelUsage() {
  const width = Math.max(...Object.keys(COMMANDS).map(name => name.length));
  const lines = Object.entries(COMMANDS)
    .map(([name, entry]) => `  ${name.padEnd(width)}  ${entry.summary}`);
  return `Usage: kb <command> [options]\n\nCommands:\n${lines.join('\n')}\n\nRun 'kb <command> --help' for the flags a command accepts.`;
}

if (!command || wantsHelp([command])) {
  console.log(topLevelUsage());
  process.exit(0);
}

const entry = COMMANDS[command];
if (!entry) {
  console.error(`Unknown command: ${command}\n`);
  console.error(topLevelUsage());
  process.exit(2);
}

await runEntryPoint(async () => {
  if (!entry.delegated && !acceptFlags(args, { ...entry, usage: usageFor(command) })) return;
  await entry.run(args);
});
