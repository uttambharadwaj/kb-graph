// The opposing force to hint-relevance.test.js.
//
// That file does assert that the hint fires, five times — but each is one prompt
// against one fixture note built from words the rest of its corpus does not use.
// Cases like that survive almost any tightening, and measurably do: raise the
// mass bar by 47% and all five still pass while natural-phrasing recall falls by
// a third. What is missing is not a fire case, it is a RATE, because only a rate
// can fall.
//
// So this file measures the other side — of the notes a prompt is genuinely
// about, how many does the hint surface? — and asserts a floor on that rate, not
// on any individual prompt. Per-prompt assertions would freeze this corpus into
// the specification: the scorer would then be tuned to satisfy these exact
// phrasings, which is the failure this file exists to catch, wearing a different
// hat. A rate lets a pair start failing on a legitimate change and only trips
// when recall actually collapses.
import './helpers/tmp-kb.js';
import { describe, it, before } from 'node:test';
import assert from 'node:assert';
import { getDb } from '../src/db.js';
import { relevantNotes } from '../src/hint-relevance.js';

// Two notes per subject, sharing vocabulary: a term found in exactly one
// document is treated as a one-off identifier and dropped before the query is
// built, so a lone note is unreachable by design and would measure that instead.
//
// `ask` raises the subject the way someone would who has not memorised the
// title — the probe a body cannot supply, since a body is the note's own words.
const SUBJECTS = [
  {
    tags: 'timekeeping',
    notes: [
      ['Sundial calibration drifts after a leap second',
        'The gnomon offset is reapplied only on restart, so any reading taken between the leap second and the next sync carries the stale calibration.'],
      ['Leap second handling in the sundial exporter',
        'Calibration offsets are emitted alongside each reading so a consumer can tell which leap second a given sundial sample predates.'],
    ],
    ask: 'every sundial is reading a second off since the leap second last night, is that calibration supposed to reapply itself',
  },
  {
    tags: 'horticulture',
    notes: [
      ['Greenhouse humidity sensors drift in summer',
        'Above thirty degrees the capacitive element in a humidity sensor reads consistently high, and the greenhouse controller vents against a number that is not real.'],
      ['Recalibrating a greenhouse humidity sensor',
        'Two-point calibration against a salt reference restores the humidity sensor; a single point leaves the summer drift in place.'],
    ],
    ask: 'the greenhouse keeps venting at night for no reason, could the humidity sensor be drifting',
  },
  {
    tags: 'apiary',
    notes: [
      ['Hive weight telemetry misreads during a nectar flow',
        'Load cells under a hive expand with the afternoon heat, so hive weight climbs on a hot day whether or not the bees brought anything in.'],
      ['Temperature compensation for hive weight scales',
        'Pairing each hive weight sample with a plate temperature lets the daily gain be computed without the thermal component.'],
    ],
    ask: 'the scales say the colony gained four kilos this afternoon and that cannot be right, what would make hive weight jump like that',
  },
  {
    tags: 'ceramics',
    notes: [
      ['Kiln ramp rate governs glaze crazing more than peak temperature',
        'A fast ramp through quartz inversion crazes the glaze even when the kiln reaches the correct peak, because the body and the glaze contract at different rates.'],
      ['Holding the kiln at peak does not fix a bad ramp',
        'Soaking evens out the peak temperature across the kiln but does nothing about crazing introduced during the ramp.'],
    ],
    ask: 'glaze came out crazed again even though the kiln hit the right cone, what else would do that',
  },
  {
    tags: 'hydrography',
    notes: [
      ['Tide gauge datum shifts after a pier rebuild',
        'The gauge is referenced to the structure it hangs from, so rebuilding the pier moves the datum and every tide reading after it sits on a new zero.'],
      ['Re-levelling a tide gauge against the benchmark',
        'Running a level from the benchmark to the gauge recovers the datum offset, which is then applied to the tide series as a step correction.'],
    ],
    ask: 'water levels jumped eight centimetres overnight and stayed there, what would shift a datum like that',
  },
  {
    tags: 'baking',
    notes: [
      ['Starter hydration changes how a sourdough loaf reads as underproofed',
        'A wetter starter ferments faster, so the same rise time leaves the sourdough further along than the recipe assumes and the crumb reads dense.'],
      ['Converting a recipe between starter hydration levels',
        'Adjust flour and water in the final dough to hold total hydration constant when the sourdough starter changes.'],
    ],
    ask: 'my loaves have been coming out dense since I started keeping the starter wetter, are those connected',
  },
  {
    tags: 'mapping',
    notes: [
      ['Label collision worsens after a projection change',
        'A projection change moves every label anchor, so a map that was hand-tuned for collisions is retuned from scratch rather than patched.'],
      ['Automatic label placement leaves collisions near the map edge',
        'The placement solver has no room to displace a label at the map boundary, so edge collisions survive a pass that clears the interior.'],
    ],
    ask: 'half the place names are sitting on top of each other now that we switched projection, is that expected',
  },
  {
    tags: 'cycling',
    notes: [
      ['Dynamo voltage spikes at speed and kills the lamp',
        'A hub dynamo is a current source, so its voltage rises with speed until something clamps it, and an unregulated lamp fails on a fast descent.'],
      ['Choosing a regulator for a hub dynamo lamp',
        'A shunt regulator across the dynamo holds lamp voltage flat and dissipates the surplus as heat.'],
    ],
    ask: 'my light blew on a long descent, second one this year, is there something about the hub dynamo doing that',
  },
  {
    tags: 'acoustics',
    notes: [
      ['Rehearsal room reverberation flatters a choir into singing flat',
        'A long reverberation tail masks the attack, so the choir tunes to the decaying chord rather than to each other and the pitch sags.'],
      ['Treating a rehearsal room without deadening it',
        'Broadband absorption on the rear wall shortens the reverberation tail while leaving the room live enough for a choir to hear itself.'],
    ],
    ask: 'we go flat every time we rehearse in the big room but not in the small one, what is different about the space',
  },
  {
    tags: 'navigation',
    notes: [
      ['Lighthouse lamp rotation slows as the gearing wears',
        'The characteristic flash interval lengthens as the rotation gearing wears, and a light identified by its interval becomes a different light.'],
      ['Measuring lamp rotation against the published characteristic',
        'Timing twenty flashes and comparing to the published rotation interval catches gearing wear long before the drift is visible by eye.'],
    ],
    ask: 'the flash interval is reading long against the chart, what wears out to cause that',
  },
  {
    tags: 'coffee',
    notes: [
      ['Grind distribution matters more than grind size for espresso',
        'A burr set past its life produces fines alongside the target particle size, and those fines choke the puck however the grind size is dialled.'],
      ['Diagnosing worn burrs from a particle distribution',
        'A sieve stack separates the fines from the target particle size and shows the bimodal distribution a worn burr produces.'],
    ],
    ask: 'shots choke no matter where I set the grinder, is it worth checking the burrs',
  },
  {
    tags: 'milling',
    notes: [
      ['Windmill brake pads glaze rather than wear in light use',
        'A brake applied gently and often polishes the pad instead of abrading it, and a glazed pad on a windmill holds far less than a worn one.'],
      ['Deglazing a windmill brake without replacing the pad',
        'Scoring the glazed surface restores the friction the brake had when the pad was new.'],
    ],
    ask: 'the brake slips even though the pads look nearly new, how does that happen',
  },
  {
    tags: 'aquaria',
    notes: [
      ['Nitrate accumulates once the aquarium filter is established',
        'A cycled filter converts ammonia through to nitrate and stops there, so nitrate climbs until a water change removes it.'],
      ['Water change volume needed to hold aquarium nitrate steady',
        'The change replaces a fraction of the nitrate, so holding it steady needs a volume matched to the rate the filter produces it.'],
    ],
    ask: 'ammonia is zero and nitrite is zero but the last number keeps climbing every week, is the tank fine',
  },
  {
    tags: 'astronomy',
    notes: [
      ['Mirror collimation shifts when the telescope changes altitude',
        'The mirror cell flexes under its own weight, so a telescope collimated at the zenith is out by the time it is pointed low.'],
      ['Collimating a telescope at the altitude you observe from',
        'Setting the mirror at the working altitude leaves the collimation error where it matters least.'],
    ],
    ask: 'stars go comet-shaped when I point low but look fine overhead, what moves between those two positions',
  },
  {
    tags: 'sensors',
    notes: [
      ['Seed germination bands are narrower than the packet suggests',
        'Most seed fails at the edges of the published germination band, so a propagator held at the edge produces a thin and uneven stand.'],
      ['Logging propagator temperature against germination rate',
        'A logger in the propagator shows how much of the night sits outside the germination band that the daytime average hides.'],
    ],
    ask: 'only about half the tray came up and the thermostat says it held temperature, what am I missing',
  },
  {
    tags: 'transit',
    notes: [
      ['Ferry timetable rounding compounds across a day',
        'Each published departure is rounded to the minute, and a timetable that rounds the same way every leg accumulates the error until the last ferry is genuinely late.'],
      ['Publishing a ferry timetable without accumulating rounding',
        'Rounding each departure from the true schedule rather than from the previous published one keeps the timetable error bounded.'],
    ],
    ask: 'the last sailing of the day runs about four minutes behind but the first is on time, does the timetable itself do that',
  },
];

const singleton = (i) => `zq${i}xj${i}kv`;
const FILLER = 1200;

// How many filler notes mention each subject in passing, worst-covered subject
// first. A real store's subject words are not rare — measured on the live graph,
// "harvest" sits in 3% of documents and "profiles" in 28% — and the bar a note
// must clear is a sum of ln(N/df) over the words the prompt covers. A fixture
// whose every subject appears in two documents therefore scores each of them far
// above any plausible threshold, and measures a regime the scorer never runs in:
// with all subjects at df=2 this file did not notice the bar being raised 47%.
// Mentions land in filler bodies, never in a filler's title or tags, so they move
// df without creating a note that could be recalled instead of the real one.
const PREVALENCE = [2, 4, 7, 12, 18, 26, 38, 55, 75, 100, 130, 170, 215, 270, 330, 400];

before(() => {
  const insert = getDb().prepare('INSERT INTO documents (title, content, doc_type, tags) VALUES (?, ?, ?, ?)');
  for (const subject of SUBJECTS) {
    for (const [title, body] of subject.notes) insert.run(title, body, 'lesson', subject.tags);
  }
  // Each filler also carries one token found nowhere else — the fixture's stand-in
  // for the hashes, paths and ids a real prompt is full of.
  for (let i = 0; i < FILLER; i++) {
    const mentions = SUBJECTS
      .filter((_, s) => i < PREVALENCE[s])
      .map(subject => `${subject.notes[0][0]} ${subject.tags}`)
      .join('. ');
    insert.run(`Filler ${i}`, `unremarkable prose ${singleton(i)}. ${mentions}`, 'note', 'misc');
  }
});

// A subject is recalled when the hint surfaces either of its notes: someone
// asking about leap seconds is served by whichever of the pair comes back.
// `label` names the probe rather than the subject, so a failure says which of
// the two notes was being asked about — reporting the subject's first note for
// every miss both misattributes and prints the same title twice.
function recall(probes) {
  const missed = [];
  for (const { prompt, subject, label } of probes) {
    const titles = new Set(subject.notes.map(([title]) => title));
    if (!relevantNotes(prompt).some(hit => titles.has(hit.title))) missed.push(label);
  }
  return { rate: (probes.length - missed.length) / probes.length, missed };
}

// One line: node:test escapes newlines in a diagnostic, so a multi-line report
// arrives as literal \n and is unreadable in exactly the failure it explains.
const report = ({ rate, missed }) =>
  `recall ${(rate * 100).toFixed(0)}% — missed: ${missed.join(' · ') || '(none)'}`;

describe('hint recall', () => {
  // The mechanical half: the prompt is the note's own body, which nobody wrote
  // for this test. Identity is read from title and tags, so a body is still an
  // independent probe — it is the subject stated in other words, which is what a
  // person types. If tightening the bar makes a note unfindable by its own
  // content, that is not a precision win.
  it('surfaces a note from a prompt that is its own body', (t) => {
    const probes = SUBJECTS.flatMap(subject =>
      subject.notes.map(([title, body]) => ({ prompt: body, subject, label: title })));
    const result = recall(probes);
    // Printed on success too: a floor with unknown slack above it is a floor
    // nobody can tell has nearly been reached.
    t.diagnostic(report(result));
    assert.ok(result.rate >= 0.70, report(result));
  });

  // The authored half: the subject named in passing, amid words that are not
  // about it. Measured 38% — 6 of 16 — which is the finding and not the
  // baseline: the same shape of prompt ("why is the harvest job not writing
  // anything") declines on the live store against six notes whose titles carry
  // the word.
  //
  // The floor comes from a mutation rather than from taste. Raising the scorer's
  // mass bar by 47% drops this to 25% while every "fires" case in
  // hint-relevance.test.js still passes, so the floor is set to fail there. It
  // leaves one probe of headroom, deliberately: the fixture is deterministic, so
  // a change that costs a probe is a real change and wants looking at.
  it('surfaces a note from a prompt that raises the subject without quoting it', (t) => {
    const probes = SUBJECTS.map(subject => ({ prompt: subject.ask, subject, label: subject.tags }));
    const result = recall(probes);
    t.diagnostic(report(result));
    assert.ok(result.rate >= 0.30, report(result));
  });

  // Without this the floors above are satisfiable by returning every note for
  // every prompt, which is the behaviour the decline tests exist to prevent —
  // stated here too so this file cannot be made to pass by removing the bar.
  it('declines a prompt about none of the corpus', () => {
    assert.deepStrictEqual(relevantNotes('what is the weather forecast for tomorrow afternoon'), []);
  });
});
