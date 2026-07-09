#!/usr/bin/env node
import { lockPreferredNodeRuntime } from '../src/cli/runtime-node.js';
await lockPreferredNodeRuntime(import.meta.url);
const { runBusSessionCli } = await import('../src/bus/cli.js');
runBusSessionCli(process.argv.slice(2)).catch(error => {
  console.error(`Error: ${error.message}`);
  process.exit(1);
});
