'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const samples = require('../src/engine/samples');
const Cues = require('../src/engine/cues');

function writeWav(file, rate, channels, frames, fn) {
  const b = Buffer.alloc(44 + frames * channels * 2);
  b.write('RIFF', 0);
  b.writeUInt32LE(36 + frames * channels * 2, 4);
  b.write('WAVEfmt ', 8);
  b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20);
  b.writeUInt16LE(channels, 22);
  b.writeUInt32LE(rate, 24);
  b.writeUInt32LE(rate * channels * 2, 28);
  b.writeUInt16LE(channels * 2, 32);
  b.writeUInt16LE(16, 34);
  b.write('data', 36);
  b.writeUInt32LE(frames * channels * 2, 40);
  for (let i = 0; i < frames; i++) for (let c = 0; c < channels; c++) b.writeInt16LE(Math.round(fn(i, c) * 32767), 44 + (i * channels + c) * 2);
  fs.writeFileSync(file, b);
}

test('a WAV is read as mono and resampled without changing pitch, length or level', () => {
  const file = path.join(os.tmpdir(), `selah-sample-${process.pid}.wav`);
  // 0.5 s of a 1 kHz tone at 44.1 kHz, then 0.5 s of silence.
  writeWav(file, 44100, 2, 44100, (i) => (i < 22050 ? 0.5 * Math.sin((2 * Math.PI * 1000 * i) / 44100) : 0));
  try {
    const wav = samples.readWav(file);
    assert.strictEqual(wav.rate, 44100);
    assert.strictEqual(wav.data.length, 44100);
    const out = samples.loadSample(file, 48000);
    // The silent tail is dropped: about 0.5 s plus the 30 ms that is kept.
    assert.ok(Math.abs(out.length / 48000 - 0.53) < 0.005, `length ${out.length / 48000}`);
    // Compare the middle with the same tone generated at 48 kHz.
    let err = 0;
    for (let i = 4800; i < 19200; i++) err = Math.max(err, Math.abs(out[i] - 0.5 * Math.sin((2 * Math.PI * 1000 * i) / 48000)));
    assert.ok(err < 0.005, `worst error ${err}`);
  } finally {
    fs.rmSync(file, { force: true });
  }
});

test('the shipped click sounds and voice load, with every word the cues need', () => {
  const set = samples.load(48000);
  assert.ok(set.click.main.length > 480 && set.click.sub.length > 480);
  for (let i = 1; i <= Cues.MAX_COUNT; i++) assert.ok(set.words.has(String(i)), `count ${i}`);
  const has = (w) => set.words.has(w);
  for (const name of ['Intro', 'Verse 1', 'Verse 2', 'Verse 3', 'Verse 4', 'Pre-Chorus', 'Chorus', 'Bridge', 'Instrumental', 'Interlude', 'Tag', 'Vamp', 'Outro']) {
    assert.ok(Cues.word(name, has), `voice sample for "${name}"`);
  }
  for (const [word, snd] of set.words) {
    let peak = 0;
    for (let i = 0; i < snd.length; i++) peak = Math.max(peak, Math.abs(snd[i]));
    assert.ok(snd.length > 4800 && snd.length < 2 * 48000 && peak > 0.1 && peak <= 1, `${word}: ${snd.length} frames, peak ${peak}`);
  }
});

test('every click sound has a main hit and one for the notes between, at a level like the owner\'s own', () => {
  const sets = samples.clickSets();
  // The owner's own click is sealed (test/vault.test.js); these are the rest.
  assert.ok(sets.length >= 8 && !sets.some((x) => x.id === 'ew'), sets.map((x) => x.id).join());
  const loaded = samples.load(48000);
  assert.strictEqual(loaded.click, loaded.clicks[samples.STAND_IN]);
  const peak = (snd) => snd.reduce((p, v) => Math.max(p, Math.abs(v)), 0);
  for (const s of sets) {
    const c = loaded.clicks[s.id];
    assert.ok(c && c.main.length > 480 && c.sub.length > 480, `${s.id} loads`);
    // One short hit each, trimmed of the silence the files are padded with.
    assert.ok(c.main.length < 0.5 * 48000 && c.sub.length < 0.5 * 48000, `${s.id} is trimmed`);
    assert.ok(peak(c.main) > 0.3 && peak(c.main) <= 1 && peak(c.sub) > 0.3 && peak(c.sub) <= 1, `${s.id}: peaks ${peak(c.main).toFixed(2)} and ${peak(c.sub).toFixed(2)}`);
    assert.ok(/^[A-Z]/.test(s.name));
  }
});
