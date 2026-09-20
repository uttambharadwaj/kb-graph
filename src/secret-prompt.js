export function askHidden(rl, prompt, defaultValue = '', { trim = true } = {}) {
  const originalWrite = rl._writeToOutput;
  let muted = false;
  let settled = false;

  const restoreOutput = (writeNewline) => {
    if (typeof originalWrite !== 'function') return;
    muted = false;
    rl._writeToOutput = originalWrite;
    if (writeNewline) originalWrite.call(rl, '\n');
  };

  if (typeof originalWrite === 'function') {
    rl._writeToOutput = function writeHiddenPromptOutput(value) {
      if (!muted) originalWrite.call(this, value);
    };
  }

  return new Promise((resolve, reject) => {
    try {
      rl.question(prompt, answer => {
        settled = true;
        restoreOutput(true);
        const value = trim ? answer.trim() : answer;
        resolve(value || defaultValue);
      });
      if (!settled) muted = true;
    } catch (err) {
      restoreOutput(false);
      reject(err);
    }
  });
}
