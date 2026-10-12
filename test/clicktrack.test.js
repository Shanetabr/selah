'use strict';
const test = require('node:test');
const assert = require('node:assert');
const C = require('../src/shared/clicktrack');

const RATE = 8000;

// A click stem: a short burst at each of `times` (seconds); `accent(i)` makes
// tick i louder and higher.
function click(times, accent, secs) {
  const out = new Float32Array(Math.round(secs * RATE));
  times.forEach((t, i) => {
    const big = accent && accent(i);
    const start = Math.round(t * RATE);
    for (let j = 0; j < 80 && start + j < out.length; j++) out[start + j] = (big ? 0.8 : 0.5) * Math.sin((2 * Math.PI * (big ? 2000 : 1500) * j) / RATE) * (1 - j / 80);
  });
  return out;
}
const every = (period, from, to) => Array.from({ length: Math.floor((to - from) / period) + 1 }, (_, i) => from + i * period);

test('eighth-note ticks with an accent every half bar: the tempo is the quarter note', () => {
  // 278 ticks a minute, as in the owner's "Washed opener": 139.
  const r = C.analyze(click(every(60 / 278, 0, 30), (i) => i % 4 === 0, 31), 1, RATE);
  assert.deepStrictEqual([r.bpm, r.offset, r.num, r.den, r.steady, r.signature], [139, 0, 4, 4, true, 'assumed']);
  assert.ok(Math.abs(r.perMinute - 278) < 0.05);
});

test('a count-in before bar 1 is not guessed at: bar 1 is the first tick', () => {
  const r = C.analyze(click(every(60 / 254, 1.25, 40), (i) => i % 2 === 0, 41), 1, RATE);
  assert.strictEqual(r.bpm, 127);
  assert.ok(Math.abs(r.offset - 1.25) < 0.001);
});

test('a number in a file name decides which tick is the beat', () => {
  const ticks = click(every(60 / 144, 0, 30), null, 31);
  assert.strictEqual(C.analyze(ticks, 1, RATE).bpm, 72, 'alone, 144 a minute could be 72 or 144');
  assert.strictEqual(C.analyze(ticks, 1, RATE, 144).bpm, 144);
  assert.strictEqual(C.analyze(ticks, 1, RATE, 90).bpm, 72, 'a name that does not fit is ignored');
  assert.strictEqual(C.hintFrom(['Guide [Washed opener Bb 139 bpm].wav']), 139);
  assert.strictEqual(C.hintFrom(['Drums.wav', 'Victory-Victory-B-127.00bpm']), 127);
  assert.strictEqual(C.hintFrom(['Keys 2.wav']), 0);
});

test('accents three beats apart are 3/4, three eighths apart 6/8', () => {
  const three = C.analyze(click(every(60 / 120, 0, 30), (i) => i % 3 === 0, 31), 1, RATE);
  assert.deepStrictEqual([three.bpm, three.num, three.den, three.signature], [120, 3, 4, 'heard']);
  // Eighths at 180 a minute are quarters at 90, the way Selah counts 6/8.
  const six = C.analyze(click(every(60 / 180, 0, 30), (i) => i % 3 === 0, 31), 1, RATE);
  assert.deepStrictEqual([six.bpm, six.num, six.den, six.signature], [90, 6, 8, 'heard']);
});

test('a rest in the click is still steady; a change of tempo is found and said', () => {
  const rest = every(0.5, 0, 30).filter((t) => t < 10 || t >= 14);
  assert.strictEqual(C.analyze(click(rest, null, 31), 1, RATE).steady, true);
  const faster = every(0.5, 0, 20).concat(every(0.4, 20.4, 40));
  const r = C.analyze(click(faster, null, 41), 1, RATE);
  assert.strictEqual(r.steady, false);
  assert.ok(r.changes.length > 0 && Math.abs(r.changes[0] - 20.4) < 0.01);
});

test('a stem that is not a click is not read as one', () => {
  const noise = new Float32Array(RATE * 20);
  let seed = 7;
  for (let i = 0; i < noise.length; i++) noise[i] = ((seed = (seed * 16807) % 2147483647) / 2147483647 - 0.5) * (0.3 + 0.7 * Math.abs(Math.sin(i / 9000)));
  assert.strictEqual(C.analyze(noise, 1, RATE), null);
  assert.strictEqual(C.analyze(new Float32Array(RATE * 5), 1, RATE), null);
  // Stereo is read the same as mono.
  const mono = click(every(0.5, 0, 20), null, 21);
  const stereo = new Float32Array(mono.length * 2);
  for (let i = 0; i < mono.length; i++) stereo[i * 2] = stereo[i * 2 + 1] = mono[i];
  assert.strictEqual(C.analyze(stereo, 2, RATE).bpm, 120);
});
