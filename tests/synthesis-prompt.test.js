import { describe, it } from 'node:test';
import assert from 'node:assert';
import { generateSynthesisPrompt } from '../src/synthesis/weekly-review.js';

const notes = [
  { title: 'A note', note_type: 'session', project: 'demo', body: 'some body text' },
];

describe('generateSynthesisPrompt tunnels section', () => {
  it('includes the cross-domain tunnels section when tunnels are provided', () => {
    const prompt = generateSynthesisPrompt(notes, {
      tunnels: [{ from: 'a', to: 'b', cooccur: 3, lift: 2.5 }],
    });
    assert.match(prompt, /## Cross-domain tunnels/);
    assert.match(prompt, /a <-> b \(co-occur 3, lift 2\.5\)/);
  });

  it('omits the tunnels section when no tunnels option is given', () => {
    const prompt = generateSynthesisPrompt(notes);
    assert.ok(!prompt.includes('## Cross-domain tunnels'));
  });

  it('omits the tunnels section when tunnels is empty', () => {
    const prompt = generateSynthesisPrompt(notes, { tunnels: [] });
    assert.ok(!prompt.includes('## Cross-domain tunnels'));
  });
});
