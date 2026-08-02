#!/usr/bin/env node

import { lockPreferredNodeRuntime } from '../src/cli/runtime-node.js';
import { runEntryPoint } from '../src/cli/flags.js';
import 'dotenv/config';

await lockPreferredNodeRuntime(import.meta.url);

const { runBusBindCli } = await import('../src/bus/cli.js');
await runEntryPoint(() => runBusBindCli(process.argv.slice(2)));
