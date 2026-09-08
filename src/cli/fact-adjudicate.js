import { readFileSync } from 'fs';
import { getDb } from '../db.js';
import { FactReviewError, reviewFactGroup } from '../fact-reviews.js';
import { UsageError, readFlagValue } from './flags.js';

export const FACT_ADJUDICATE_USAGE = 'Usage: kb fact-adjudicate --subject <name> --predicate <name> --reviewer <name> --items <json-file|-> [--note <text>] [--json]';
const MAX_ITEMS_FILE_BYTES = 1024 * 1024;

function requiredFlag(args, name) {
  const value = readFlagValue(args, name);
  if (value === undefined || !String(value).trim() || String(value).startsWith('--')) {
    throw new UsageError(`${name} is required`, FACT_ADJUDICATE_USAGE);
  }
  return String(value).trim();
}

function readItems(path) {
  let raw;
  try {
    raw = readFileSync(path === '-' ? 0 : path, 'utf8');
  } catch (error) {
    throw new UsageError(`could not read --items ${path}: ${error.message}`, FACT_ADJUDICATE_USAGE);
  }
  if (Buffer.byteLength(raw, 'utf8') > MAX_ITEMS_FILE_BYTES) {
    throw new UsageError('--items must be at most 1 MiB', FACT_ADJUDICATE_USAGE);
  }
  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new UsageError(`--items must contain valid JSON: ${error.message}`, FACT_ADJUDICATE_USAGE);
  }
}

export function runFactAdjudicateCli(args = []) {
  const subject = requiredFlag(args, '--subject');
  const predicate = requiredFlag(args, '--predicate');
  const reviewer = requiredFlag(args, '--reviewer');
  const itemsPath = requiredFlag(args, '--items');
  const note = readFlagValue(args, '--note') ?? null;

  let review;
  try {
    review = reviewFactGroup(getDb(), {
      subject,
      predicate,
      reviewer,
      items: readItems(itemsPath),
      note,
    });
  } catch (error) {
    if (error instanceof FactReviewError) {
      throw new UsageError(error.message, FACT_ADJUDICATE_USAGE);
    }
    throw error;
  }

  if (args.includes('--json')) {
    console.log(JSON.stringify(review, null, 2));
    return review;
  }
  console.log(
    `Recorded fact review #${review.id}: ${review.subject} / ${review.predicate} `
    + `(${review.fact_count} facts, ${review.policy}, reviewer ${review.reviewer})`
  );
  return review;
}
