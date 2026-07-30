import { describe, it } from 'node:test';
import assert from 'node:assert';
import { readdirSync, readFileSync } from 'fs';
import { dirname, join, relative } from 'path';
import { fileURLToPath } from 'url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

const sourceFiles = () =>
  ['src', 'bin'].flatMap((dir) =>
    readdirSync(join(root, dir), { recursive: true })
      .filter((f) => /\.(js|mjs|cjs)$/.test(f))
      .map((f) => join(root, dir, f)),
  );

describe('source hygiene', () => {
  // A raw 0x00 makes the whole file binary to grep, rg, git diff and the Bash
  // tool, which then report "no match" instead of an error. Write \0 instead.
  it('has no literal NUL bytes in sources', () => {
    const offenders = sourceFiles()
      .filter((f) => readFileSync(f, 'utf8').includes('\0'))
      .map((f) => relative(root, f));
    assert.deepStrictEqual(offenders, [], `literal NUL byte in: ${offenders.join(', ')}`);
  });
});
