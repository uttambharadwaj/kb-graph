function isOutputClosed(output) {
  return output.destroyed || output.closed || output.writableEnded;
}

function validateReadline(rl) {
  if (typeof rl._writeToOutput !== 'function') {
    throw new Error('cannot securely prompt for a secret: readline output muting is unavailable');
  }
  if (
    typeof rl.question !== 'function'
    || typeof rl.once !== 'function'
    || typeof rl.removeListener !== 'function'
    || typeof rl.close !== 'function'
    || rl.closed
  ) {
    throw new Error('cannot securely prompt for a secret: readline input handling is unavailable');
  }
  if (
    typeof rl.output?.once !== 'function'
    || typeof rl.output?.removeListener !== 'function'
  ) {
    throw new Error('cannot securely prompt for a secret: readline output handling is unavailable');
  }
  if (isOutputClosed(rl.output)) {
    throw new Error('cannot securely prompt for a secret: readline output is closed');
  }
}

export function askHidden(rl, prompt, defaultValue = '', { trim = true } = {}) {
  validateReadline(rl);

  const originalWrite = rl._writeToOutput;
  const { output } = rl;
  let muted = false;
  let lineTerminated = false;
  let answered = false;
  let settled = false;

  const restoreOutput = () => {
    muted = false;
    rl._writeToOutput = originalWrite;
  };

  rl._writeToOutput = function writeHiddenPromptOutput(value) {
    if (!muted) {
      originalWrite.call(this, value);
    } else if (!lineTerminated && /^[\r\n]+$/.test(value)) {
      lineTerminated = true;
      originalWrite.call(this, value);
    }
  };

  return new Promise((resolve, reject) => {
    const removePromptListeners = () => {
      rl.removeListener('error', onReadlineError);
      rl.removeListener('close', onClose);
      rl.removeListener('SIGINT', onCancel);
      output.removeListener('error', onOutputError);
      output.removeListener('close', onOutputClose);
    };

    const rejectPrompt = (error, { close = false } = {}) => {
      if (settled) return;
      settled = true;
      removePromptListeners();
      restoreOutput();
      reject(error);
      if (close) rl.close();
    };

    const onReadlineError = error => {
      if (!answered) rejectPrompt(error, { close: true });
    };
    const onOutputError = error => rejectPrompt(error, { close: true });
    const onClose = () => {
      if (!answered) {
        rejectPrompt(new Error('secret prompt closed before input was received'));
      }
    };
    const onOutputClose = () => rejectPrompt(
      new Error('secret prompt output closed before input was received'),
      { close: true },
    );
    const onCancel = () => {
      const error = new Error('secret prompt canceled');
      error.name = 'AbortError';
      error.code = 'ABORT_ERR';
      rejectPrompt(error, { close: true });
    };

    rl.once('error', onReadlineError);
    rl.once('close', onClose);
    rl.once('SIGINT', onCancel);
    output.once('error', onOutputError);
    output.once('close', onOutputClose);

    try {
      rl.question(prompt, answer => {
        answered = true;
        setImmediate(() => {
          if (settled) return;
          if (isOutputClosed(output)) {
            rejectPrompt(
              new Error('secret prompt output closed before input was received'),
              { close: true },
            );
            return;
          }
          let value;
          try {
            value = trim ? answer.trim() : answer;
            restoreOutput();
          } catch (error) {
            rejectPrompt(error, { close: true });
            return;
          }
          settled = true;
          removePromptListeners();
          resolve(value || defaultValue);
        });
      });
      muted = true;
    } catch (error) {
      rejectPrompt(error, { close: true });
    }
  });
}
