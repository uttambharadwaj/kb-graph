#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { EXTRACT_RULE_EVALS, extractPromptRules } from '../../src/extract.js';

const requested = process.argv.find(arg => arg.startsWith('--rule='));
const onlyRule = requested === undefined ? null : Number(requested.slice('--rule='.length)) - 1;
if (requested !== undefined && (!Number.isInteger(onlyRule) || onlyRule < 0 || onlyRule >= EXTRACT_RULE_EVALS.length)) {
  console.error(`--rule must be between 1 and ${EXTRACT_RULE_EVALS.length}`);
  process.exit(2);
}

const rules = extractPromptRules();
const indexes = onlyRule === null ? rules.map((_, index) => index) : [onlyRule];
const passedBaselines = new Set();

const runCase = (name, omittedRule) => spawnSync(process.execPath, [
  '--test',
  `--test-name-pattern=${name}`,
  'tests/extract-eval.test.js',
], {
  cwd: new URL('../..', import.meta.url),
  env: {
    ...process.env,
    KB_EVAL: '1',
    ...(omittedRule === null ? {} : { KB_EXTRACT_OMIT_RULE: String(omittedRule) }),
  },
  encoding: 'utf8',
  stdio: 'pipe',
});

for (const ruleIndex of indexes) {
  let killed = false;
  for (const caseName of EXTRACT_RULE_EVALS[ruleIndex]) {
    if (!passedBaselines.has(caseName)) {
      const baseline = runCase(caseName, null);
      if (baseline.status !== 0) {
        process.stderr.write(baseline.stdout);
        process.stderr.write(baseline.stderr);
        throw new Error(`baseline eval failed before mutating rule ${ruleIndex + 1}: ${caseName}`);
      }
      passedBaselines.add(caseName);
    }

    const mutant = runCase(caseName, ruleIndex);
    if (mutant.status !== 0) {
      killed = true;
      console.log(`KILLED rule ${ruleIndex + 1} by ${caseName}`);
      break;
    }
  }

  if (!killed) {
    throw new Error(`SURVIVED rule ${ruleIndex + 1}: ${rules[ruleIndex]}`);
  }
}

console.log(`All ${indexes.length} prompt rule mutation(s) were killed.`);
