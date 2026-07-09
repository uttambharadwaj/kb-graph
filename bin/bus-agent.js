#!/usr/bin/env node
import { lockPreferredNodeRuntime } from '../src/cli/runtime-node.js';
await lockPreferredNodeRuntime(import.meta.url);
const { runBusAgentCli } = await import('../src/bus/cli.js');
runBusAgentCli(process.argv.slice(2)).catch(error => {
  console.error(`Error: ${error.message}`);
  process.exit(1);
});
