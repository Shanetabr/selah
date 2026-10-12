'use strict';
const test = require('node:test');
const assert = require('node:assert');
const Cues = require('../src/engine/cues');

const WORDS = new Set(['intro', 'verse', 'verse 1', 'verse 2', 'chorus', 'pre chorus', 'bridge', 'instrumental', 'build', '1', '2', '3', '4', '5', '6', '7']);
const has = (w) => WORDS.has(w);
const grid = (g) => Object.assign({ bpm: 120, num: 4, den: 4, beatUnit: 'auto', offset: 0 }, g); // 4/4 at 120: a beat is 0.5 s, a bar 2 s
const cfg = (c) => Object.assign({ enabled: true, start: 'two', section: 'one' }, c);
const show = (plan) => plan.map((e) => `${Math.round(e.sec * 1000) / 1000}:${e.word}`).join(' ');

test('section names map to voice samples', () => {
  assert.strictEqual(Cues.word('Verse 1', has), 'verse 1');
  assert.strictEqual(Cues.word('Pre-Chorus', has), 'pre chorus');
  assert.strictEqual(Cues.word('  CHORUS ', has), 'chorus');
  assert.strictEqual(Cues.word('Verse 9', has), 'verse', 'falls back to the name without its number');
  assert.strictEqual(Cues.word('V2', has), 'verse 2');
  assert.strictEqual(Cues.word('PC', has), 'pre chorus');
  assert.strictEqual(Cues.word('Inst', has), 'instrumental');
  assert.strictEqual(Cues.word('Altar call', has), null);
  assert.strictEqual(Cues.word('', has), null);
});

test('4/4: two-bar count for the first section, one bar for the rest', () => {
  const sections = [
    { bar: 2, name: 'Intro' },
    { bar: 10, name: 'Verse 1' },
    { bar: 18, name: 'Chorus' },
  ];
  const plan = Cues.plan(grid(), sections, cfg(), has);
  // Intro at bar 3 (4 s): "Intro . 2 . | 1 2 3 4" over bars 1 and 2.
  // Verse 1 at bar 11 (20 s): "Verse 1, 2, 3, 4" in bar 10. Chorus at 36 s.
  assert.strictEqual(show(plan), '0:intro 1:2 2:1 2.5:2 3:3 3.5:4 18:verse 1 18.5:2 19:3 19.5:4 34:chorus 34.5:2 35:3 35.5:4');
});

test('6/8 counts eighths and gives the name half the bar', () => {
  // 6/8 at 60 dotted-quarter BPM: a bar is 2 s, an eighth 1/3 s.
  const g = grid({ bpm: 60, num: 6, den: 8 });
  const one = Cues.plan(g, [{ bar: 0, name: 'x' }, { bar: 4, name: 'Verse' }], cfg({ start: 'off' }), has);
  assert.strictEqual(show(one), '6:verse 7:4 7.333:5 7.667:6');
  const two = Cues.plan(g, [{ bar: 2, name: 'Intro' }], cfg(), has);
  assert.strictEqual(show(two), '0:intro 1:2 2:1 2.333:2 2.667:3 3:4 3.333:5 3.667:6');
});

test('half-bar cue, and counts stand in for a name with no sample', () => {
  const sections = [
    { bar: 0, name: 'x' },
    { bar: 4, name: 'Bridge', cue: 'half' },
    { bar: 8, name: 'Altar call' },
    { bar: 12, name: 'Altar call', cue: 'half' },
    { bar: 16, name: 'Chorus', cue: 'off' },
  ];
  const plan = Cues.plan(grid(), sections, cfg({ start: 'off' }), has);
  assert.strictEqual(show(plan), '7:bridge 7.5:4 14:1 14.5:2 15:3 15.5:4 23:3 23.5:4');
});

test('a first section with no room gets its count-in before time 0', () => {
  const plan = Cues.plan(grid(), [{ bar: 0, name: 'Intro' }, { bar: 1, name: 'Verse' }], cfg({ section: 'two' }), has);
  // Intro: two bars before 0. Verse at bar 2 has room for one bar only.
  assert.strictEqual(show(plan), '-4:intro -3:2 -2:1 -1.5:2 -1:3 -0.5:4 0:verse 0.5:2 1:3 1.5:4');
});

test('cues off gives no events', () => {
  assert.deepStrictEqual(Cues.plan(grid(), [{ bar: 4, name: 'Verse' }], cfg({ enabled: false }), has), []);
  assert.deepStrictEqual(Cues.plan(grid(), [{ bar: 4, name: 'Verse' }], cfg({ start: 'off', section: 'off' }), has), []);
});

test('a jump says the name on the next count, then counts the rest of the bar', () => {
  const g = grid();
  // Bar line at 8 s. Tapped just after beat 1 of the bar before it.
  assert.strictEqual(show(Cues.jumpPlan(g, 6.1, 8, 'Chorus', has)), '6.5:chorus 7:3 7.5:4');
  // Tapped during beat 3: only beat 4 is left, and the name takes it.
  assert.strictEqual(show(Cues.jumpPlan(g, 7.2, 8, 'Chorus', has)), '7.5:chorus');
  // Tapped during beat 4: nothing left, so the name is said at once.
  assert.strictEqual(show(Cues.jumpPlan(g, 7.7, 8, 'Chorus', has)), '7.7:chorus');
  // More than a bar away (tapped right on a bar line): a full one-bar cue.
  assert.strictEqual(show(Cues.jumpPlan(g, 5.999, 8, 'Chorus', has)), '6:chorus 6.5:2 7:3 7.5:4');
  // No sample for the name: counts only.
  assert.strictEqual(show(Cues.jumpPlan(g, 6.1, 8, 'Altar call', has)), '6.5:2 7:3 7.5:4');
  // At another cue speed the counts keep that spacing, still ending on the bar line.
  assert.strictEqual(show(Cues.jumpPlan(g, 5.9, 8, 'Chorus', has, 'half')), '6:chorus 7:4');
  assert.strictEqual(show(Cues.jumpPlan(g, 7.1, 8, 'Chorus', has, 'double')), '7.25:chorus 7.5:3 7.75:4');
});

test('lead time can be given in bars or beats', () => {
  const sections = [{ bar: 0, name: 'x' }, { bar: 4, name: 'Verse' }];
  const at = (lead) => show(Cues.plan(grid(), sections, cfg({ start: 'off', section: lead }), has));
  assert.strictEqual(at({ n: 1, unit: 'bars' }), '6:verse 6.5:2 7:3 7.5:4');
  assert.strictEqual(at({ n: 2, unit: 'beats' }), '7:verse 7.5:4');
  assert.strictEqual(at({ n: 3, unit: 'beats' }), '6.5:verse 7:3 7.5:4');
  assert.strictEqual(at({ n: 0.5, unit: 'bars' }), '7:verse 7.5:4');
  // A bar and a half: the name, the end of that bar, then a full count.
  assert.strictEqual(at({ n: 6, unit: 'beats' }), '5:verse 5.5:4 6:1 6.5:2 7:3 7.5:4');
  assert.strictEqual(at({ n: 2, unit: 'bars' }), '4:verse 5:2 6:1 6.5:2 7:3 7.5:4');
  // Three bars: the name early, then the two-bar count.
  assert.strictEqual(at({ n: 3, unit: 'bars' }), '2:verse 4:1 5:2 6:1 6.5:2 7:3 7.5:4');
  assert.strictEqual(at({ n: 0, unit: 'bars' }), '');
  assert.strictEqual(at('off'), '');
  // In 6/8 a beat is a dotted quarter: three counts.
  const g68 = grid({ bpm: 60, num: 6, den: 8 });
  assert.strictEqual(show(Cues.plan(g68, sections, cfg({ start: 'off', section: { n: 1, unit: 'beats' } }), has)), '7:verse');
  // The same 6/8 with the tempo written in quarter notes (90) or in eighths (180): still a dotted quarter.
  for (const g of [{ bpm: 90, beatUnit: 'quarter' }, { bpm: 180, beatUnit: 'den' }]) {
    assert.strictEqual(show(Cues.plan(grid(Object.assign({ num: 6, den: 8 }, g)), sections, cfg({ start: 'off', section: { n: 1, unit: 'beats' } }), has)), '7:verse');
  }
});

test('cue speed stretches or squeezes the whole cue and still ends on the bar line', () => {
  const sections = [{ bar: 0, name: 'x' }, { bar: 4, name: 'Verse' }];
  const at = (speed, lead) => show(Cues.plan(grid(), sections, cfg({ start: 'off', section: lead || 'one', speed }), has));
  assert.strictEqual(at(undefined), '6:verse 6.5:2 7:3 7.5:4');
  // Half-time: the full "Verse 2 3 4", one count every two beats, over two bars.
  assert.strictEqual(at('half'), '4:verse 5:2 6:3 7:4');
  // Double-time: the same four counts inside half a bar.
  assert.strictEqual(at('double'), '7:verse 7.25:2 7.5:3 7.75:4');
  assert.strictEqual(at('half', 'two'), '0:verse 2:2 4:1 5:2 6:3 7:4');
  // A half-time cue that would start before the song is cut to one count-bar,
  // and dropped when even that does not fit.
  const early = [{ bar: 0, name: 'x' }, { bar: 1, name: 'Chorus' }, { bar: 2, name: 'Verse' }];
  assert.strictEqual(show(Cues.plan(grid(), early, cfg({ start: 'off', section: 'two', speed: 'half' }), has)), '0:verse 1:2 2:3 3:4');
  // The first section's count-in is longer too: four real bars before the song.
  assert.strictEqual(show(Cues.plan(grid(), [{ bar: 0, name: 'Intro' }], cfg({ speed: 'half' }), has)), '-8:intro -6:2 -4:1 -3:2 -2:3 -1:4');
});

test('a tag is not announced unless it is given a guide of its own', () => {
  const WITH_TAG = (w) => has(w) || w === 'tag';
  const sections = [{ bar: 0, name: 'x', cue: 'off' }, { bar: 4, name: 'Chorus' }, { bar: 8, name: 'Tag' }, { bar: 12, name: 'tag 2' }];
  const auto = Cues.plan(grid(), sections, cfg({ start: 'auto', section: 'auto' }), WITH_TAG);
  assert.strictEqual(show(auto), '6:chorus 6.5:2 7:3 7.5:4');
  assert.strictEqual(Cues.silent({ name: 'Tag' }), true);
  assert.strictEqual(Cues.silent({ name: 'Chorus' }), false);
  assert.strictEqual(Cues.silent({ name: 'Chorus', cue: 'off' }), true);
  const own = Cues.plan(grid(), [{ bar: 0, name: 'x', cue: 'off' }, { bar: 8, name: 'Tag', cue: 'one' }], cfg({ start: 'auto', section: 'auto' }), WITH_TAG);
  assert.strictEqual(show(own), '14:tag 14.5:2 15:3 15.5:4');
  assert.strictEqual(Cues.silent({ name: 'Tag', cue: 'one' }), false);
});

test('callouts: a word where it stands, or a bare count into a bar line', () => {
  const list = [{ bar: 3, word: 'count' }, { bar: 1.5, word: 'Build' }, { bar: 2, word: 'Hold' }, { bar: 0, word: 'count' }];
  // A bar is 2 s. "Hold" is not in this voice; a count before the song starts is left out.
  assert.strictEqual(show(Cues.callouts(grid(), list, cfg(), has)), '3:build 4:1 4.5:2 5:3 5.5:4');
  assert.strictEqual(show(Cues.callouts(grid(), list, cfg({ enabled: false }), has)), '');
  assert.strictEqual(show(Cues.callouts(grid(), undefined, cfg(), has)), '');
  // The bare count follows the cue speed; the word does not move.
  assert.strictEqual(show(Cues.callouts(grid(), list, cfg({ speed: 'double' }), has)), '3:build 5:1 5.25:2 5.5:3 5.75:4');
  // Six eighths in 6/8.
  assert.strictEqual(show(Cues.callouts(grid({ num: 6, den: 8, bpm: 60 }), [{ bar: 1, word: 'count' }], cfg(), has)), '0:1 0.333:2 0.667:3 1:4 1.333:5 1.667:6');
});
