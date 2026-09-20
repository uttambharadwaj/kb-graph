import './helpers/tmp-kb.js';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  CAPTURE_AGENT,
  CAPTURE_COHORT,
  CAPTURE_REASON,
  CAPTURE_STATE,
  CHECKPOINT_REPLAY_LABEL,
  evaluateCheckpointReplay,
} from '../src/cli/capture-follow-through.js';
import { MAINTENANCE_TOOL } from '../src/tool-names.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const CORPUS_PATH = join(HERE, '..', 'eval', 'checkpoint-replay-v1.json');

describe('checkpoint replay evaluation', () => {
  it('runs the shipped v1 cases through the actual checkpoint decision core', () => {
    const evaluation = evaluateCheckpointReplay(CORPUS_PATH);

    assert.deepEqual(evaluation, {
      version: 1,
      cases: 5,
      tp: 2,
      fp: 0,
      fn: 0,
      tn: 3,
      precision: 1,
      recall: 1,
      unsafe_capture: 0,
    });
  });

  it('ships frozen closed vocabularies shared by runtime and tests', () => {
    for (const vocabulary of [
      CAPTURE_AGENT,
      CAPTURE_COHORT,
      CAPTURE_REASON,
      CAPTURE_STATE,
      CHECKPOINT_REPLAY_LABEL,
      MAINTENANCE_TOOL,
    ]) {
      assert.equal(Object.isFrozen(vocabulary), true);
      assert.equal(
        new Set(Object.values(vocabulary)).size,
        Object.values(vocabulary).length,
      );
    }
    assert.equal(Object.values(MAINTENANCE_TOOL).length, 4);
  });

  it('keeps the corpus synthetic and never returns fixture tokens or raw payloads', () => {
    const corpusText = readFileSync(CORPUS_PATH, 'utf8');
    const corpus = JSON.parse(corpusText);
    const forbiddenInternal = [
      /TinyFish/i,
      /\/Users\//,
      /\bPF-\d+\b/i,
      new RegExp(`\\b(?:${['Ut', 'tam'].join('')}|${['Bharad', 'waj'].join('')})\\b`, 'i'),
      /tinyfish\.io/i,
    ];
    for (const pattern of forbiddenInternal) {
      assert.doesNotMatch(corpusText, pattern);
    }

    const reportText = JSON.stringify(evaluateCheckpointReplay(CORPUS_PATH));
    for (const testCase of corpus.cases) {
      if (testCase.fixture_token) {
        assert.doesNotMatch(reportText, new RegExp(testCase.fixture_token));
      }
      assert.doesNotMatch(reportText, new RegExp(testCase.input.session_id));
      assert.doesNotMatch(reportText, new RegExp(testCase.input.tool_input.command));
    }
    for (const pattern of forbiddenInternal) {
      assert.doesNotMatch(reportText, pattern);
    }
    assert.deepEqual(Object.keys(JSON.parse(reportText)).sort(), [
      'cases',
      'fn',
      'fp',
      'precision',
      'recall',
      'tn',
      'tp',
      'unsafe_capture',
      'version',
    ]);
  });
});
