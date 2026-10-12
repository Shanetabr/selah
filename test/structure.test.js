'use strict';
const test = require('node:test');
const assert = require('node:assert');
const S = require('../src/shared/structure');

// Intro 0-4, Verse 4-12, Chorus 12-20, Bridge 20-28
const song = () => [
  { id: 'i', bar: 0, len: 4 },
  { id: 'v', bar: 4, len: 8 },
  { id: 'c', bar: 12, len: 8 },
  { id: 'b', bar: 20, len: 8 },
];
const opts = (o) => Object.assign({ min: 0, limit: Infinity, step: 1 }, o);
const show = (list) => (list ? list.map((s) => `${s.id}:${s.bar}-${s.bar + s.len}`).join(' ') : 'null');

test('markers saved without a length run to the next marker, the last to the end', () => {
  const old = [{ id: 'c', bar: 12 }, { id: 'i', bar: 0 }, { id: 'v', bar: 4 }];
  assert.strictEqual(show(S.normalize(old, 20)), 'i:0-4 v:4-12 c:12-20');
  // An existing length is kept, unless it would overlap the next block.
  assert.strictEqual(show(S.normalize([{ id: 'a', bar: 0, len: 2 }, { id: 'b', bar: 4, len: 99 }, { id: 'c', bar: 8 }], 10)), 'a:0-2 b:4-8 c:8-10');
});

test('moving a block right pushes the blocks it runs into; they keep their lengths', () => {
  const before = song();
  assert.strictEqual(show(S.move(before, 'v', 6, opts())), 'i:0-4 v:6-14 c:14-22 b:22-30');
  assert.strictEqual(show(before), 'i:0-4 v:4-12 c:12-20 b:20-28', 'the input is not changed');
  // Into a gap nothing else moves.
  const gap = [{ id: 'a', bar: 0, len: 2 }, { id: 'b', bar: 8, len: 2 }];
  assert.strictEqual(show(S.move(gap, 'a', 4, opts())), 'a:4-6 b:8-10');
  assert.strictEqual(show(S.move(gap, 'a', 7, opts())), 'a:7-9 b:9-11');
});

test('moving a block left stops at the block before it, and at the start', () => {
  assert.strictEqual(show(S.move(song(), 'c', 2, opts())), 'i:0-4 v:4-12 c:12-20 b:20-28');
  const gap = [{ id: 'a', bar: 2, len: 2 }, { id: 'b', bar: 8, len: 2 }];
  assert.strictEqual(show(S.move(gap, 'b', 1, opts())), 'a:2-4 b:4-6');
  assert.strictEqual(show(S.move(gap, 'a', -3, opts())), 'a:0-2 b:8-10');
});

test('a push is refused when it would move a block past the end of the song', () => {
  assert.strictEqual(S.move(song(), 'v', 14, opts({ limit: 27 })), null);
  assert.strictEqual(show(S.move(song(), 'v', 11, opts({ limit: 27 }))), 'i:0-4 v:11-19 c:19-27 b:27-35');
  // A block already past the end (the audio got shorter) does not freeze the others.
  assert.strictEqual(show(S.move(song(), 'i', 0, opts({ limit: 10 }))), 'i:0-4 v:4-12 c:12-20 b:20-28');
  assert.strictEqual(show(S.resizeEnd(song(), 'i', 3, opts({ limit: 10 }))), 'i:0-3 v:3-11 c:11-19 b:19-27');
  assert.strictEqual(S.resizeEnd(song(), 'i', 5, opts({ limit: 10 })), null, 'but it cannot be pushed further out');
});

test('the right edge changes the length and everything after follows', () => {
  assert.strictEqual(show(S.resizeEnd(song(), 'v', 16, opts())), 'i:0-4 v:4-16 c:16-24 b:24-32');
  assert.strictEqual(show(S.resizeEnd(song(), 'v', 8, opts())), 'i:0-4 v:4-8 c:8-16 b:16-24');
  // Never shorter than one step.
  assert.strictEqual(show(S.resizeEnd(song(), 'v', 0, opts())), 'i:0-4 v:4-5 c:5-13 b:13-21');
});

test('the left edge moves the start only and stops at the block before', () => {
  const gap = [{ id: 'a', bar: 0, len: 2 }, { id: 'b', bar: 8, len: 4 }];
  assert.strictEqual(show(S.resizeStart(gap, 'b', 5, opts())), 'a:0-2 b:5-12');
  assert.strictEqual(show(S.resizeStart(gap, 'b', 1, opts())), 'a:0-2 b:2-12');
  assert.strictEqual(show(S.resizeStart(gap, 'b', 99, opts())), 'a:0-2 b:11-12');
});

test('holding the free-move key works in beats', () => {
  const q = opts({ step: 0.25 });
  assert.strictEqual(show(S.move(song(), 'v', 4.5, q)), 'i:0-4 v:4.5-12.5 c:12.5-20.5 b:20.5-28.5');
  assert.strictEqual(show(S.resizeEnd(song(), 'b', 20.1, q)), 'i:0-4 v:4-12 c:12-20 b:20-20.25');
});

test('a new section splits the block it lands in, or fills a gap', () => {
  assert.strictEqual(show(S.insert(song(), 'x', 8, 8)), 'i:0-4 v:4-8 x:8-12 c:12-20 b:20-28');
  assert.strictEqual(S.insert(song(), 'x', 12, 8), null, 'a block already starts there');
  const gap = [{ id: 'a', bar: 0, len: 2 }, { id: 'b', bar: 6, len: 2 }];
  assert.strictEqual(show(S.insert(gap, 'x', 3, 8)), 'a:0-2 x:3-6 b:6-8');
  assert.strictEqual(show(S.insert(gap, 'x', 10, 8)), 'a:0-2 b:6-8 x:10-18');
});

test('end and at', () => {
  assert.strictEqual(S.end(song()), 28);
  assert.strictEqual(S.end([]), 0);
  assert.strictEqual(S.at(song(), 12).id, 'c');
  assert.strictEqual(S.at(song(), 11.99).id, 'v');
  assert.strictEqual(S.at([{ id: 'a', bar: 0, len: 2 }, { id: 'b', bar: 6, len: 2 }], 4), null);
});
