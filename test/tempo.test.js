'use strict';
const test = require('node:test');
const assert = require('node:assert');
const Tempo = require('../src/shared/tempo');

const RATE = 48000;

function clickTrack(bpm, offset, seconds) {
  const out = new Int16Array(RATE * seconds);
  const beat = 60 / bpm;
  for (let k = 0; offset + k * beat < seconds - 0.1; k++) {
    const start = Math.round((offset + k * beat) * RATE);
    for (let i = 0; i < 0.02 * RATE; i++) {
      out[start + i] = Math.round(Math.sin((2 * Math.PI * (k % 4 === 0 ? 2000 : 1000) * i) / RATE) * Math.exp(-i / (0.004 * RATE)) * 26000);
    }
  }
  return out;
}

// Kick on the beat, quieter hat on the off-beat, a little noise floor: stereo.
function drumLoop(bpm, offset, seconds) {
  const out = new Int16Array(RATE * seconds * 2);
  let seed = 7;
  const noise = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x3fffffff - 1;
  };
  for (let i = 0; i < out.length; i++) out[i] = Math.round(noise() * 60);
  const beat = 60 / bpm;
  for (let k = 0; offset + (k * beat) / 2 < seconds - 0.2; k++) {
    const start = Math.round((offset + (k * beat) / 2) * RATE);
    const kick = k % 2 === 0;
    const len = (kick ? 0.12 : 0.03) * RATE;
    for (let i = 0; i < len; i++) {
      const env = Math.exp(-i / ((kick ? 0.03 : 0.008) * RATE));
      const v = kick ? Math.sin((2 * Math.PI * 60 * i) / RATE) * 20000 : noise() * 5000;
      out[(start + i) * 2] += Math.round(v * env);
      out[(start + i) * 2 + 1] += Math.round(v * env);
    }
  }
  return out;
}

test('click stem: tempo and first beat', () => {
  const r = Tempo.detect(clickTrack(128, 1.234, 90), 1, RATE);
  assert.strictEqual(r.bpm, 128);
  assert.ok(Math.abs(r.offset - 1.234) < 0.003, `offset ${r.offset}`);
});

test('slow click stem is not doubled', () => {
  const r = Tempo.detect(clickTrack(69, 0, 120), 1, RATE);
  assert.strictEqual(r.bpm, 69);
  assert.ok(r.offset < 0.003, `offset ${r.offset}`);
});

test('half-BPM tempos are kept', () => {
  const r = Tempo.detect(clickTrack(97.5, 0.4, 120), 1, RATE);
  assert.strictEqual(r.bpm, 97.5);
});

test('drum stem with off-beat hats', () => {
  const r = Tempo.detect(drumLoop(142, 0.75, 120), 2, RATE);
  assert.ok(r.bpm === 142 || r.bpm === 71, `bpm ${r.bpm}`);
  const beat = 60 / 142;
  const phase = (((r.offset - 0.75) % beat) + beat) % beat;
  assert.ok(Math.min(phase, beat - phase) < 0.006, `offset ${r.offset}`);
});

test('silence gives no result', () => {
  assert.strictEqual(Tempo.detect(new Int16Array(RATE * 10), 1, RATE), null);
});

// The click stem of a real multitrack ("Washed opener", 139 BPM): it ticks
// eighth notes, louder on every fourth tick, and stops before the file ends.
test('a click stem that ticks eighth notes gives the tempo, not two thirds of it', () => {
  const seconds = 67;
  const out = new Int16Array(RATE * seconds);
  const tick = 60 / 139 / 2;
  for (let k = 0; k * tick < 58.5; k++) {
    const start = Math.round(k * tick * RATE);
    const level = k % 4 === 0 ? 0.68 : 0.52;
    for (let i = 0; i < 0.02 * RATE; i++) out[start + i] = Math.round(Math.sin((2 * Math.PI * 1500 * i) / RATE) * Math.exp(-i / (0.004 * RATE)) * level * 32767);
  }
  const r = Tempo.detect(out, 1, RATE);
  assert.strictEqual(r.bpm, 139);
  assert.strictEqual(r.offset, 0);
});
