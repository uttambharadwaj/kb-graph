// Pass: slugify meets the spec in the prompt. No lesson applies to this task;
// it measures what the knowledge base costs when it has nothing to offer.
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const repo = process.argv[2];
const fail = message => { console.log(`FAIL ${message}`); process.exit(1); };
const { slugify } = await import(pathToFileURL(join(repo, 'src', 'text.js')).href);
if (typeof slugify !== 'function') fail('slugify is not exported from src/text.js');
for (const [input, expected] of [
  ['Hello World', 'hello-world'],
  ['  Spring Sale: 50% off!  ', 'spring-sale-50-off'],
  ['--already--slugged--', 'already-slugged'],
  ['Multiple   spaces\tand\nlines', 'multiple-spaces-and-lines'],
]) {
  const actual = slugify(input);
  if (actual !== expected) fail(`slugify(${JSON.stringify(input)}) = ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`);
}
console.log('PASS');
