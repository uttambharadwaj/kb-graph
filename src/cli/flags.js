// `--help` must print help and do nothing else, and a mistyped flag must not be
// read as consent to run with defaults against the real database. Both rules
// live here so every entry point answers the same way instead of each one
// hand-rolling a check it can forget.
//
// This validates the argv the commands already parse for themselves rather than
// parsing it. node:util parseArgs would do the parsing and rejects unknown
// options in strict mode, but it reads `--flag value` for every string option,
// while several commands here accept only `--flag=value`; adopting it would
// silently change what those commands do with the separated spelling, which is
// the failure this file exists to prevent.

export class UsageError extends Error {
  constructor(message, usage = null) {
    super(message);
    this.name = 'UsageError';
    this.usage = usage;
  }
}

const HELP_FLAGS = new Set(['--help', '-h']);
// A flag looks like -x or --x. Free text ("-- done", "-5") is a positional.
const FLAG_TOKEN = /^--?[A-Za-z]/;
const END_OF_FLAGS = '--';

export function wantsHelp(args) {
  for (const arg of args) {
    if (arg === END_OF_FLAGS) return false;
    if (HELP_FLAGS.has(arg)) return true;
  }
  return false;
}

// `value` flags take the next token or an =value; `valueEq` flags only parse the
// =value form, so the separated spelling is rejected rather than dropped;
// `boolean` flags take none. Anything else that looks like a flag is a typo, and
// a typo that reaches the command as "run with defaults" is how an unintended
// run starts.
export function assertKnownFlags(
  args,
  { usage = null, value = [], valueEq = [], boolean: booleans = [] } = {},
) {
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === END_OF_FLAGS) return;
    if (!FLAG_TOKEN.test(arg)) continue;

    const name = arg.split('=')[0];
    if (HELP_FLAGS.has(name)) continue;
    if (booleans.includes(name)) {
      if (arg.includes('=')) throw new UsageError(`${name} takes no value`, usage);
      continue;
    }
    if (valueEq.includes(name)) {
      if (!arg.includes('=')) throw new UsageError(`${name} needs a value: ${name}=<value>`, usage);
      continue;
    }
    if (value.includes(name)) {
      if (!arg.includes('=')) i += 1;  // its value is the next token, not a flag
      continue;
    }
    throw new UsageError(`Unknown flag: ${name}`, usage);
  }
}

// Returns true when help was printed and the caller must return without doing
// any work. Split out for commands whose flags depend on a subcommand, which
// still have to answer --help before they pick one.
export function showHelp(args, usage) {
  if (!wantsHelp(args)) return false;
  console.log(usage);
  return true;
}

// The one gate every entry point calls first. Returns false when help was
// printed and the caller must return without doing any work.
export function acceptFlags(args, spec) {
  if (showHelp(args, spec.usage)) return false;
  assertKnownFlags(args, spec);
  return true;
}

// The value of a `--flag value` or `--flag=value` argument, or undefined when
// absent. Callers validate the value; this only finds it.
export function readFlagValue(args, name) {
  const index = args.findIndex(arg => arg === name || arg.startsWith(`${name}=`));
  if (index === -1) return undefined;
  const arg = args[index];
  return arg.includes('=') ? arg.split('=').slice(1).join('=') : args[index + 1];
}

// Shared exit handling so a usage mistake is distinguishable from a failure:
// exit 2 for "you typed it wrong", exit 1 for "it went wrong".
function exitOnUsageError(err) {
  if (!(err instanceof UsageError)) return;
  console.error(err.message);
  if (err.usage) console.error(`\n${err.usage}`);
  process.exit(2);
}

export async function runEntryPoint(run) {
  try {
    await run();
  } catch (err) {
    exitOnUsageError(err);
    console.error(`Error: ${err.message}`);
    process.exit(1);
  }
}

// For top-level scripts that have no function to wrap: exits on --help or a bad
// flag, and returns only when the script should go on to do its work.
export function gateOrExit(args, spec) {
  try {
    if (!acceptFlags(args, spec)) process.exit(0);
  } catch (err) {
    exitOnUsageError(err);
    throw err;
  }
}
