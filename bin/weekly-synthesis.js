#!/usr/bin/env node
// Weekly synthesis job — run via launchd or manually.
// Reads the week's notes, asks the LLM for the synthesis (themes,
// contradictions, merge candidates, stale entries, gaps), and writes the
// ANSWER into the vault — not the prompt.

import 'dotenv/config';
import {
  getRecentNotes, generateSynthesisPrompt, generateAnalysisRequest,
  getNearDupPairs, writeSynthesisNote,
} from '../src/synthesis/weekly-review.js';
import { runClaude } from '../src/claude-cli.js';
import { strongestTunnels } from '../src/tunnels.js';
import { setMeta, getDb } from '../src/db.js';

import { homedir } from 'os';
import { join } from 'path';

const vaultPath = process.env.OBSIDIAN_VAULT_PATH || join(homedir(), '.claude', 'kb-index');
const notes = getRecentNotes(vaultPath, 7);

if (notes.length === 0) {
  console.log('No recent notes to synthesize');
  process.exit(0);
}

let tunnels = [];
try { tunnels = strongestTunnels(getDb(), { limit: 10 }); } catch { /* synthesis proceeds without tunnels */ }

const prompt = generateSynthesisPrompt(notes, { tunnels }) + generateAnalysisRequest(getNearDupPairs());

// Synthesis is weekly and small — worth a stronger model than the classifier default.
const model = process.env.SYNTHESIS_MODEL || 'claude-sonnet-5';
const stdout = await runClaude(prompt, { model, timeout: 240000 });
const synthesis = JSON.parse(stdout).result || '';

if (!synthesis.trim()) {
  console.error('Synthesis came back empty — not writing a note');
  process.exit(1);
}

const result = writeSynthesisNote(synthesis, vaultPath);
setMeta('last_synthesis', result.path);
console.log('Synthesis note created:', result.path);
