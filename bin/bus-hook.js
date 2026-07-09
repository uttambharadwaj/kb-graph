#!/usr/bin/env node

import { lockPreferredNodeRuntime } from '../src/cli/runtime-node.js';
import 'dotenv/config';

await lockPreferredNodeRuntime(import.meta.url);

const { runBusHookCli } = await import('../src/bus/cli.js');
runBusHookCli(process.argv.slice(2)).catch(err => {
  console.error(`Error: ${err.message}`);
  process.exit(1);
});
