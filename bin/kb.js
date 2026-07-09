#!/usr/bin/env node
// bin/kb.js — CLI entry point
// Commands: start, stop, mcp, register, ingest <path>, search <query>, status, setup, bus-send, bus-read, bus-status, bus-session, bus-gateway, bus-agent, bus-agentd, bus-hook, bus-bind, bus-unbind, bus-hook-current, bus-notifier

import { lockPreferredNodeRuntime } from '../src/cli/runtime-node.js';
import 'dotenv/config';

await lockPreferredNodeRuntime(import.meta.url);

const command = process.argv[2];
const args = process.argv.slice(3);

const commands = {
  start:    () => import('../src/server.js').then(m => m.start()),
  stop:     () => import('../src/cli/stop.js').then(m => m.stop()),
  mcp:      () => import('../src/mcp.js').then(m => m.start()),
  register: () => import('../src/cli/register.js').then(m => m.register(args)),
  ingest:   () => import('../src/cli/ingest-cli.js').then(m => m.ingest(args[0])),
  search:   () => import('../src/cli/search-cli.js').then(m => m.search(args.join(' '))),
  status:   () => import('../src/cli/status.js').then(m => m.status()),
  'wakeup-hook': () => import('../src/cli/wakeup-hook.js').then(m => m.wakeupHook()),
  'prompt-hint': () => import('../src/cli/prompt-hint.js').then(m => m.promptHint()),
  'link-backfill': () => import('../src/cli/link-backfill.js').then(m => m.linkBackfill()),
  harvest: () => import('../src/harvest.js').then(m => m.runHarvestCli(args)),
  'consolidate-state': () => import('../src/state.js').then(m => m.runConsolidateStateCli(args)),
  'entity-merge': () => import('../src/facts.js').then(m => {
    if (args.length < 2) { console.error('Usage: kb entity-merge <from> <to>'); process.exit(1); }
    console.log(JSON.stringify(m.mergeEntity(args[0], args[1]), null, 2));
  }),
  'bus-send': () => import('../src/bus/cli.js').then(m => m.runBusSendCli(args)),
  'bus-read': () => import('../src/bus/cli.js').then(m => m.runBusReadCli(args)),
  'bus-status': () => import('../src/bus/cli.js').then(m => m.runBusStatusCli(args)),
  'bus-session': () => import('../src/bus/cli.js').then(m => m.runBusSessionCli(args)),
  'bus-gateway': () => import('../src/bus/cli.js').then(m => m.runBusGatewayCli(args)),
  'bus-agent': () => import('../src/bus/cli.js').then(m => m.runBusAgentCli(args)),
  'bus-agentd': () => import('../src/bus/cli.js').then(m => m.runBusAgentdCli(args)),
  'bus-hook': () => import('../src/bus/cli.js').then(m => m.runBusHookCli(args)),
  'bus-bind': () => import('../src/bus/cli.js').then(m => m.runBusBindCli(args)),
  'bus-unbind': () => import('../src/bus/cli.js').then(m => m.runBusUnbindCli(args)),
  'bus-hook-current': () => import('../src/bus/cli.js').then(m => m.runBusHookCurrentCli(args)),
  'bus-notifier': () => import('../src/bus/cli.js').then(m => m.runBusNotifierCli(args)),
  'capture-x': () => import('../src/capture/x-bookmarks.js').then(m => {
    const bookmarksPath = args[0] || (process.env.HOME + '/knowledgebase/x_bookmarks.md');
    const vaultPath = process.env.OBSIDIAN_VAULT_PATH;
    if (!vaultPath) { console.error('OBSIDIAN_VAULT_PATH not set'); process.exit(1); }
    const result = m.captureXBookmarks(bookmarksPath, vaultPath);
    console.log(`X bookmarks: ${result.created} created, ${result.skipped} skipped (${result.total} total)`);
  }),
  classify: () => {
    const dryRun = args.includes('--dry-run');
    return import('../src/classify/processor.js').then(async m => {
      const vaultPath = process.env.OBSIDIAN_VAULT_PATH;
      if (!vaultPath) { console.error('OBSIDIAN_VAULT_PATH not set'); process.exit(1); }
      const result = await m.processNewClippings(vaultPath, { dryRun });
      console.log(`\nClassified: ${result.processed}/${result.total} notes`);
      if (result.errors) console.log(`Errors: ${result.errors}`);
      if (dryRun) console.log('(dry run — no changes written)');
    });
  },
  summarize: () => {
    const dryRun = args.includes('--dry-run');
    const limitFlag = args.find(a => a.startsWith('--limit='));
    const limit = limitFlag ? parseInt(limitFlag.split('=')[1]) : 0;
    return import('../src/classify/summarizer.js').then(async m => {
      const vaultPath = process.env.OBSIDIAN_VAULT_PATH;
      if (!vaultPath) { console.error('OBSIDIAN_VAULT_PATH not set'); process.exit(1); }
      const result = await m.summarizeUnsummarized(vaultPath, { dryRun, limit });
      console.log(`\nSummarized: ${result.summarized}/${result.total} notes`);
      if (result.errors) console.log(`Errors: ${result.errors}`);
      if (dryRun) console.log('(dry run — no changes written)');
    });
  },
  setup:    () => import('../src/cli/setup.js').then(m => m.setup(args)),
  'safety-check': () => {
    const action = args.join(' ');
    if (!action) { console.error('Usage: kb safety-check <action description>'); process.exit(1); }
    return import('../src/safety/review.js').then(async m => {
      const result = await m.reviewDestructiveAction(action);
      console.log(JSON.stringify(result, null, 2));
      if (!result.safe) process.exit(1);
    });
  },
  vault:    () => {
    const sub = args[0];
    if (sub === 'reindex') return import('../src/cli/vault-cli.js').then(m => m.vaultReindex());
    console.log('Usage: kb vault reindex');
    process.exit(1);
  },
};

if (!command || !commands[command]) {
  console.log(`Usage: kb <command>

Commands:
  start              Start the dashboard server (default :3838)
  stop               Stop the running server
  mcp                Start MCP stdio server (used by AI tools)
  register           Register MCP server with Claude/Codex/Gemini (--agents=claude,codex)
  ingest <path>      Ingest a file or directory
  search <query>     Search documents
  status             Show stats and server status
  wakeup-hook        Print compact KB briefing (for SessionStart hooks)
  prompt-hint        Read hook JSON on stdin, print KB hint for the prompt (for UserPromptSubmit hooks)
  bus-send           Send a local message bus message
  bus-read           Read messages using a stored per-reader cursor
  bus-status         Show channel readers, backlog, heartbeats, and latest control
  bus-session        Register/list routable bus sessions
  bus-gateway        Deliver important bus messages to registered sessions
  bus-agent          Register/list executable bus workers
  bus-agentd         Launch executable workers for bus tasks
  bus-hook           Emit hook-friendly digests for unread bus messages
  bus-bind           Add/list workspace bus subscriptions for an agent
  bus-unbind         Clear one or all workspace bus subscriptions for an agent
  bus-hook-current   Resolve the current workspace binding and emit hook digests
  bus-notifier       Maintain a background pending-digest notifier for the current workspace binding
  vault reindex      Reindex Obsidian vault (embeddings on; --no-embeddings to skip)
  harvest            Auto-debrief session transcripts (--dry-run, --since-hours=N, --path=<transcript>)
  consolidate-state  Fold session notes into per-workstream state notes (--project=X, --dry-run)
  link-backfill      Connect existing docs via embedding neighbors (doc_links + Related sections)
  entity-merge       Merge a fact-graph entity into a canonical one (<from> <to>)
  classify           Auto-classify new clippings/inbox notes (--dry-run to preview)
  summarize          Add AI summaries to docs without them (--dry-run, --limit=N)
  capture-x [path]   Capture X/Twitter bookmarks to vault
  setup              Interactive setup wizard (--auto for agent mode)
`);
  process.exit(command ? 1 : 0);
}

commands[command]().catch(err => {
  console.error(`Error: ${err.message}`);
  process.exit(1);
});
