import { test } from 'node:test';
import assert from 'node:assert';
import { truncate } from '../src/text.js';

test('truncate keeps short text', () => {
  assert.strictEqual(truncate('hi', 5), 'hi');
});
