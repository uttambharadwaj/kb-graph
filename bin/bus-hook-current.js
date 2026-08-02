#!/usr/bin/env node

import { lockPreferredNodeRuntime } from '../src/cli/runtime-node.js';
import { runEntryPoint } from '../src/cli/flags.js';
import 'dotenv/config';

await lockPreferredNodeRuntime(import.meta.url);

const { runBusHookCurrentCli } = await import('../src/bus/cli.js');
await runEntryPoint(() => runBusHookCurrentCli(process.argv.slice(2)));
