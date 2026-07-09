#!/usr/bin/env node
import { lockPreferredNodeRuntime } from '../src/cli/runtime-node.js';
await lockPreferredNodeRuntime(import.meta.url);
const { runBusAgentdCli } = await import('../src/bus/cli.js');
runBusAgentdCli(process.argv.slice(2)).catch(error => {
  console.error(`Error: ${error.message}`);
  process.exit(1);
});
