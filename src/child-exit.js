// When a spawned child is finished, for callers that need its output.
//
// 'close' waits for the stdio pipes rather than for the process, so a child
// that leaves a descendant holding stdout never fires it, and a caller awaiting
// only 'close' waits forever with nothing left to kill — a spawn timeout
// signals the direct child, which by then is already gone. Measured on the
// shape that hung a debrief for 1800s: 'exit' at 213ms, 'close' never.
//
// Shared rather than copied because both callers here settle a promise and one
// also writes a row: the ordering is subtle enough that the second hand-written
// copy is the one that gets it wrong.

// How long a dead process's pipes get to drain before the caller is told
// anyway. Long enough that a normal exit is never cut short — its 'close'
// follows within a tick — short enough not to leave the caller on an orphan.
const PIPE_FLUSH_MS = 1000;

export function onChildDone(child, done, flushMs = PIPE_FLUSH_MS) {
  let flushing;
  let settled = false;
  const settle = (code, signal) => {
    // Both events fire on a healthy child, and the caller may be writing a row
    // rather than resolving a promise, where twice is not free.
    if (settled) return;
    settled = true;
    clearTimeout(flushing);
    done(code, signal);
  };

  child.on('close', settle);
  child.on('exit', (code, signal) => {
    flushing = setTimeout(() => {
      settle(code, signal);
      // Releases the handles the orphan is holding, so a CLI caller can exit.
      child.stdout?.destroy();
      child.stderr?.destroy();
    }, flushMs);
  });
}
