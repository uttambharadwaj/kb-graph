// wakeupHook/promptHint/triggerHook call process.exit() themselves — correct
// for a real hook invocation, but it would kill the test runner if called
// in-process. Run one in a fresh child instead, fed stdin the same way
// Claude Code does.
const name = process.argv[2];
// Everything after the hook name is the hook's own argv (e.g. --agent codex),
// forwarded exactly as bin/kb.js hands it to the same entry function.
const args = process.argv.slice(3);
const HOOKS = {
  'wakeup-hook': async () => (await import('../../src/cli/wakeup-hook.js')).wakeupHook,
  'prompt-hint': async () => (await import('../../src/cli/prompt-hint.js')).promptHint,
  'trigger-hook': async () => (await import('../../src/cli/trigger-hook.js')).triggerHook,
  'precompact-hook': async () => (await import('../../src/cli/precompact-hook.js')).precompactHook,
  'session-capture-hook': async () => (await import('../../src/cli/session-capture-hook.js')).sessionCaptureHook,
};
const fn = await HOOKS[name]();
await fn(args);
