import { describe, it } from 'node:test';
import assert from 'node:assert';
import { readdirSync, readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

function sourceFiles() {
  return ['src', 'bin'].flatMap((dir) =>
    readdirSync(join(root, dir), { recursive: true, withFileTypes: true })
      .filter((e) => e.isFile() && /\.(js|mjs|cjs)$/.test(e.name))
      .map((e) => join(e.parentPath ?? e.path, e.name)),
  );
}

describe('source hygiene', () => {
  // A raw 0x00 makes the whole file binary to grep, rg, git diff and the Bash
  // tool, which then report "no match" instead of an error. Write \0 instead.
  it('has no literal NUL bytes in tracked sources', () => {
    const offenders = sourceFiles().filter((f) => readFileSync(f, 'utf8').includes('\0'));
    assert.deepStrictEqual(offenders, [], `literal NUL byte in: ${offenders.join(', ')}`);
  });
});
