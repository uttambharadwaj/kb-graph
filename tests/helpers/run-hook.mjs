// wakeupHook/promptHint call process.exit() themselves — correct for a real
// hook invocation, but it would kill the test runner if called in-process.
// Run one in a fresh child instead, fed stdin the same way Claude Code does.
const name = process.argv[2];
const mod = name === 'wakeup-hook'
  ? await import('../../src/cli/wakeup-hook.js')
  : await import('../../src/cli/prompt-hint.js');
const fn = name === 'wakeup-hook' ? mod.wakeupHook : mod.promptHint;
await fn();
