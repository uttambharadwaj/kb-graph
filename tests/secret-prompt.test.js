import { EventEmitter, once } from 'node:events';
import { createInterface } from 'node:readline';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { askHidden } from '../src/secret-prompt.js';

function createReadlineDouble(question = () => {}) {
  const rl = new EventEmitter();
  rl.output = new EventEmitter();
  const writes = [];
  rl.output.write = (value, callback) => {
    writes.push(value);
    callback?.();
    return true;
  };
  const originalWrite = value => rl.output.write(value);
  rl._writeToOutput = originalWrite;
  rl.question = question;
  rl.close = () => {
    if (rl.closed) return;
    rl.closed = true;
    rl.emit('close');
  };
  return { rl, originalWrite, writes };
}

function assertPromptCleanedUp(rl, originalWrite) {
  assert.equal(rl._writeToOutput, originalWrite);
  assert.equal(rl.listenerCount('error'), 0);
  assert.equal(rl.listenerCount('close'), 0);
  assert.equal(rl.listenerCount('SIGINT'), 0);
  assert.equal(rl.output.listenerCount('error'), 0);
  assert.equal(rl.output.listenerCount('close'), 0);
}

for (const [missingCapability, removeCapability, expectedMessage] of [
  ['_writeToOutput', rl => { rl._writeToOutput = undefined; }, /output muting is unavailable/],
  ['question', rl => { rl.question = undefined; }, /input handling is unavailable/],
  ['once', rl => { rl.once = undefined; }, /input handling is unavailable/],
  ['removeListener', rl => { rl.removeListener = undefined; }, /input handling is unavailable/],
  ['close', rl => { rl.close = undefined; }, /input handling is unavailable/],
  ['output', rl => { rl.output = undefined; }, /output handling is unavailable/],
  ['output.once', rl => { rl.output.once = undefined; }, /output handling is unavailable/],
  [
    'output.removeListener',
    rl => { rl.output.removeListener = undefined; },
    /output handling is unavailable/,
  ],
]) {
  test(`secret prompts fail synchronously without ${missingCapability}`, () => {
    let questionCalled = false;
    const { rl } = createReadlineDouble(() => {
      questionCalled = true;
    });
    removeCapability(rl);

    assert.throws(
      () => askHidden(rl, 'Synthetic prompt: ', 'synthetic-default'),
      expectedMessage,
    );
    assert.equal(questionCalled, false);
  });
}

test('secret prompts fail synchronously when readline is already closed', () => {
  const { rl } = createReadlineDouble();
  rl.close();

  assert.throws(
    () => askHidden(rl, 'Synthetic prompt: ', 'synthetic-default'),
    /input handling is unavailable/,
  );
});

test('secret prompts fail synchronously when output is already closed', async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  const rl = createInterface({ input, output, terminal: true });
  output.destroy();
  await once(output, 'close');

  assert.throws(
    () => askHidden(rl, 'Synthetic prompt: ', 'synthetic-default'),
    /output is closed/,
  );
  rl.close();
});

for (const state of ['destroyed', 'closed', 'writableEnded']) {
  test(`secret prompts fail synchronously when output.${state} is true`, () => {
    const { rl } = createReadlineDouble();
    rl.output[state] = true;

    assert.throws(
      () => askHidden(rl, 'Synthetic prompt: ', 'synthetic-default'),
      /output is closed/,
    );
  });
}

for (const [name, answer, options, expected] of [
  ['preserve whitespace', '  synthetic-entered  ', { trim: false }, '  synthetic-entered  '],
  ['trim whitespace', '  synthetic-entered  ', { trim: true }, 'synthetic-entered'],
  ['default whitespace-only input', '   ', { trim: true }, 'synthetic-default'],
]) {
  test(`secret prompts ${name}`, async () => {
    const { rl, originalWrite } = createReadlineDouble((_prompt, submit) => submit(answer));

    assert.equal(
      await askHidden(rl, 'Synthetic prompt: ', 'synthetic-default', options),
      expected,
    );
    assertPromptCleanedUp(rl, originalWrite);
  });
}

test('secret prompts terminate the prompt line without rendering secret values', async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  const entered = 'synthetic entered value';
  let rendered = '';
  output.on('data', chunk => {
    rendered += chunk;
  });
  const rl = createInterface({ input, output, terminal: true });
  const originalWrite = rl._writeToOutput;
  const initialCloseListeners = rl.listenerCount('close');
  const result = askHidden(rl, 'Synthetic prompt: ', 'synthetic-default');

  input.write(`${entered}\n`);

  assert.equal(await result, entered);
  assert.equal(rendered, 'Synthetic prompt: \r\n');
  assert.equal(rl._writeToOutput, originalWrite);
  assert.equal(rl.listenerCount('error'), 0);
  assert.equal(rl.listenerCount('close'), initialCloseListeners);
  assert.equal(rl.listenerCount('SIGINT'), 0);
  assert.equal(output.listenerCount('error'), 0);
  assert.equal(output.listenerCount('close'), 0);
  rl.close();
});

test('secret prompts reveal only one line break from multi-line input', async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  let rendered = '';
  output.on('data', chunk => {
    rendered += chunk;
  });
  const rl = createInterface({ input, output, terminal: true });
  const originalWrite = rl._writeToOutput;
  const initialCloseListeners = rl.listenerCount('close');
  const result = askHidden(rl, 'Synthetic prompt: ', 'synthetic-default');

  input.write('synthetic-first\nsynthetic-tail\nsynthetic-last\n');

  assert.equal(await result, 'synthetic-first');
  assert.equal(rendered, 'Synthetic prompt: \r\n');
  assert.equal(rl._writeToOutput, originalWrite);
  assert.equal(rl.listenerCount('error'), 0);
  assert.equal(rl.listenerCount('close'), initialCloseListeners);
  assert.equal(rl.listenerCount('SIGINT'), 0);
  assert.equal(output.listenerCount('error'), 0);
  assert.equal(output.listenerCount('close'), 0);
  rl.close();
});

test('secret prompts reject question failures and restore output', async () => {
  const failure = new Error('synthetic terminal failure');
  const { rl, originalWrite } = createReadlineDouble(() => {
    throw failure;
  });

  await assert.rejects(
    askHidden(rl, 'Synthetic prompt: ', 'synthetic-default'),
    error => error === failure,
  );
  assertPromptCleanedUp(rl, originalWrite);
});

for (const [name, lateAnswer] of [
  ['blank input', ''],
  ['partial input', 'synthetic-partial'],
]) {
  test(`secret prompts reject input errors before late ${name}`, async () => {
    let submit;
    const failure = new Error('synthetic input failure');
    const { rl, originalWrite, writes } = createReadlineDouble((_prompt, answer) => {
      submit = answer;
    });

    const result = askHidden(rl, 'Synthetic prompt: ', 'synthetic-default');
    rl.emit('error', failure);
    submit(lateAnswer);

    await assert.rejects(result, error => error === failure);
    assertPromptCleanedUp(rl, originalWrite);
    assert.doesNotMatch(writes.join(''), /synthetic-(?:default|partial)/);
  });
}

test('secret prompts reject close before receiving input', async () => {
  const { rl, originalWrite } = createReadlineDouble();
  const result = askHidden(rl, 'Synthetic prompt: ', 'synthetic-default');

  rl.emit('close');

  await assert.rejects(result, /closed before input was received/);
  assertPromptCleanedUp(rl, originalWrite);
});

test('secret prompts preserve explicit cancellation as an abort', async () => {
  const { rl, originalWrite } = createReadlineDouble();
  const result = askHidden(rl, 'Synthetic prompt: ', 'synthetic-default');

  rl.emit('SIGINT');

  await assert.rejects(
    result,
    error => error.name === 'AbortError' && error.code === 'ABORT_ERR',
  );
  assert.equal(rl.closed, true);
  assertPromptCleanedUp(rl, originalWrite);
});

test('secret prompts ignore close after successful input', async () => {
  let submit;
  const { rl, originalWrite } = createReadlineDouble((_prompt, answer) => {
    submit = answer;
  });
  const result = askHidden(rl, 'Synthetic prompt: ', 'synthetic-default');

  submit('synthetic-entered');
  rl.close();

  assert.equal(await result, 'synthetic-entered');
  assertPromptCleanedUp(rl, originalWrite);
});

test('secret prompts ignore readline errors after complete input', async () => {
  let submit;
  const { rl, originalWrite } = createReadlineDouble((_prompt, answer) => {
    submit = answer;
  });
  const result = askHidden(rl, 'Synthetic prompt: ', 'synthetic-default');

  submit('synthetic-entered');
  rl.emit('error', new Error('synthetic late input failure'));

  assert.equal(await result, 'synthetic-entered');
  assertPromptCleanedUp(rl, originalWrite);
});

test('secret prompts keep the first complete input', async () => {
  let submit;
  const { rl, originalWrite } = createReadlineDouble((_prompt, answer) => {
    submit = answer;
  });
  const result = askHidden(rl, 'Synthetic prompt: ', 'synthetic-default');

  submit('synthetic-first');
  submit('synthetic-second');

  assert.equal(await result, 'synthetic-first');
  assertPromptCleanedUp(rl, originalWrite);
});

test('secret prompts keep same-turn trailing input muted', async () => {
  let submit;
  const { rl, originalWrite, writes } = createReadlineDouble((_prompt, answer) => {
    submit = answer;
  });
  const result = askHidden(rl, 'Synthetic prompt: ', 'synthetic-default');

  submit('synthetic-entered');
  rl._writeToOutput('post-answer output');

  assert.equal(await result, 'synthetic-entered');
  assert.doesNotMatch(writes.join(''), /post-answer output/);
  assertPromptCleanedUp(rl, originalWrite);
});

test('secret prompts let SIGINT cancel pending complete input', async () => {
  let submit;
  const { rl, originalWrite, writes } = createReadlineDouble((_prompt, answer) => {
    submit = answer;
  });
  const result = askHidden(rl, 'Synthetic prompt: ', 'synthetic-default');

  submit('synthetic-entered');
  rl.emit('SIGINT');

  await assert.rejects(
    result,
    error => error.name === 'AbortError' && error.code === 'ABORT_ERR',
  );
  assert.equal(writes.length, 0);
  assert.equal(rl.closed, true);
  assertPromptCleanedUp(rl, originalWrite);
});

test('secret prompts do not normalize input after cancellation', async () => {
  let submit;
  let trimCalls = 0;
  const { rl, originalWrite } = createReadlineDouble((_prompt, answer) => {
    submit = answer;
  });
  const result = askHidden(rl, 'Synthetic prompt: ', 'synthetic-default');
  const answer = {
    trim() {
      trimCalls += 1;
      return 'synthetic-entered';
    },
  };

  submit(answer);
  rl.emit('SIGINT');

  await assert.rejects(result, error => error.code === 'ABORT_ERR');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(trimCalls, 0);
  assertPromptCleanedUp(rl, originalWrite);
});

test('secret prompts reject malformed readline answers', async () => {
  let submit;
  const { rl, originalWrite } = createReadlineDouble((_prompt, answer) => {
    submit = answer;
  });
  const result = askHidden(rl, 'Synthetic prompt: ', 'synthetic-default');

  submit(null);

  await assert.rejects(result, TypeError);
  assert.equal(rl.closed, true);
  assertPromptCleanedUp(rl, originalWrite);
});

test('secret prompts recheck output state after complete input', async () => {
  let submit;
  const { rl, originalWrite } = createReadlineDouble((_prompt, answer) => {
    submit = answer;
  });
  const result = askHidden(rl, 'Synthetic prompt: ', 'synthetic-default');

  submit('');
  rl.output.destroyed = true;

  await assert.rejects(result, /output closed before input was received/);
  assert.equal(rl.closed, true);
  assertPromptCleanedUp(rl, originalWrite);
});

test('secret prompts reject real readline input errors', async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  const rl = createInterface({ input, output, terminal: true });
  const originalWrite = rl._writeToOutput;
  const failure = new Error('synthetic stream failure');
  const result = askHidden(rl, 'Synthetic prompt: ', 'synthetic-default');

  input.destroy(failure);

  await assert.rejects(result, error => error === failure);
  assertPromptCleanedUp(rl, originalWrite);
});

test('secret prompts reject real readline output errors', async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  const rl = createInterface({ input, output, terminal: true });
  const originalWrite = rl._writeToOutput;
  const failure = new Error('synthetic stream failure');
  const result = askHidden(rl, 'Synthetic prompt: ', 'synthetic-default');

  output.destroy(failure);

  await assert.rejects(result, error => error === failure);
  assertPromptCleanedUp(rl, originalWrite);
});

test('secret prompts reject output destruction before same-turn input', async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  const rl = createInterface({ input, output, terminal: true });
  const originalWrite = rl._writeToOutput;
  const failure = new Error('synthetic stream failure');
  const result = askHidden(rl, 'Synthetic prompt: ', 'synthetic-default');

  output.destroy(failure);
  input.write('\n');

  await assert.rejects(result, error => error === failure);
  assertPromptCleanedUp(rl, originalWrite);
});

test('secret prompts reject output close before receiving input', async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  const rl = createInterface({ input, output, terminal: true });
  const originalWrite = rl._writeToOutput;
  const result = askHidden(rl, 'Synthetic prompt: ', 'synthetic-default');

  output.destroy();

  await assert.rejects(result, /output closed before input was received/);
  assertPromptCleanedUp(rl, originalWrite);
});
