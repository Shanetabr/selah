'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { mapRange } = require('../src/shared/structure');
const original = () => [
  { id: 'v', name: 'Verse', bar: 0, len: 8, color: '#abc', cue: 'off' },
  { id: 'c', name: 'Chorus', bar: 8, len: 8, cue: 'two' },
  { id: 'o', name: 'Outro', bar: 16, len: 4 },
];
const shape = (list) => list.map((s) => [s.name, s.bar, s.len]);

test('mapping creates sections in an empty song and closes each at the next tap', () => {
  const marks = [{ id: 'a', name: 'Verse', bar: 0 }, { id: 'b', name: 'Chorus', bar: 4 }, { id: 'c', name: 'Bridge', bar: 12 }];
  assert.deepEqual(shape(mapRange([], marks, 16, 'take')), [['Verse', 0, 4], ['Chorus', 4, 8], ['Bridge', 12, 4]]);
});

test('mapping replaces the recorded range and preserves both sides and their metadata', () => {
  const before = original();
  const out = mapRange(before, [{ id: 'new', name: 'Bridge', bar: 2 }], 5, 'take');
  assert.deepEqual(shape(out), [['Verse', 0, 2], ['Bridge', 2, 3], ['Verse', 5, 3], ['Chorus', 8, 8], ['Outro', 16, 4]]);
  assert.equal(out[0].cue, 'off');
  assert.equal(out[2].color, '#abc');
  assert.notEqual(out[0].id, out[2].id);
  assert.equal(new Set(out.map((s) => s.id)).size, out.length);
  assert.deepEqual(before, original());
});

test('growing an active section overwrites old markers and guide overrides only as it reaches them', () => {
  const marks = [{ id: 'new', name: 'Tag', bar: 4 }];
  assert.deepEqual(shape(mapRange(original(), marks, 12, 'take')), [['Verse', 0, 4], ['Tag', 4, 8], ['Chorus', 12, 4], ['Outro', 16, 4]]);
  const all = mapRange(original(), marks, 20, 'take');
  assert.deepEqual(shape(all), [['Verse', 0, 4], ['Tag', 4, 16]]);
  assert.equal(all[1].cue, undefined, 'new sections follow the song guide settings');
});

test('mapping into gaps does not shift or fill untouched structure', () => {
  const list = [{ id: 'i', name: 'Intro', bar: 0, len: 2 }, { id: 'o', name: 'Outro', bar: 10, len: 4 }];
  assert.deepEqual(shape(mapRange(list, [{ id: 'n', name: 'Verse', bar: 4 }], 8, 'take')), [['Intro', 0, 2], ['Verse', 4, 4], ['Outro', 10, 4]]);
});

test('an empty pass is unchanged and invalid or zero-length markers are rejected', () => {
  assert.deepEqual(mapRange(original(), [], 8, 'take'), original());
  assert.equal(mapRange([], [{ id: 'a', bar: 4 }], 4, 'take'), null);
  assert.equal(mapRange([], [{ id: 'a', bar: -1 }], 4, 'take'), null);
  assert.equal(mapRange([], [{ id: 'a', bar: 0 }, { id: 'b', bar: 0 }], 4, 'take'), null);
  assert.equal(mapRange([], [{ id: 'a', bar: 4 }, { id: 'b', bar: 2 }], 8, 'take'), null);
});

test('replacing exactly at old boundaries produces no empty tails', () => {
  const out = mapRange(original(), [{ id: 'n', name: 'Bridge', bar: 8 }], 16, 'take');
  assert.deepEqual(shape(out), [['Verse', 0, 8], ['Bridge', 8, 8], ['Outro', 16, 4]]);
  assert.ok(out.every((s) => s.len > 0));
});
