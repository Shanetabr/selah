'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { Mixer } = require('../src/engine/mixer');
const Grid = require('../src/shared/grid');

const RATE = 1000; // tiny rate keeps frame numbers readable; nothing depends on it

function track(id, frames, fill, extra) {
  const ch = (extra && extra.ch) || 1;
  const data = new Int16Array(frames * ch);
  for (let i = 0; i < frames; i++) for (let c = 0; c < ch; c++) data[i * ch + c] = fill(i, c);
  return Object.assign({ id, data, ch, frames, gain: 1, mute: false, solo: false, bus: 'band' }, extra);
}

function song(tracks, grid, click) {
  return {
    id: 's',
    grid: Object.assign({ bpm: 120, num: 4, den: 4, beatUnit: 'auto', offset: 0 }, grid),
    click: Object.assign({ enabled: false, gain: 1, bus: 'cue' }, click),
    tracks,
  };
}

// Renders `total` frames in blocks of `block`, returning one Float32Array per channel.
function run(mixer, total, block, onBlock) {
  const C = mixer.channels;
  const chans = Array.from({ length: C }, () => new Float32Array(total));
  const buf = new Float32Array(block * C);
  for (let done = 0; done < total; done += block) {
    const n = Math.min(block, total - done);
    if (onBlock) onBlock(done);
    mixer.render(buf, n);
    for (let i = 0; i < n; i++) for (let c = 0; c < C; c++) chans[c][done + i] = buf[i * C + c];
  }
  return chans;
}

// Skips the transport fade-in so tests can compare exact sample values.
function playNow(mixer) {
  mixer.play();
  mixer.tGain = 1;
}

test('stems stay sample-aligned regardless of block size', () => {
  const make = () => {
    const m = new Mixer({ sampleRate: RATE, channels: 2 });
    const impulse = (at) => (i) => (i === at ? 8000 : 0);
    m.setSong(song([track('a', 5000, impulse(1234)), track('b', 5000, impulse(1234)), track('c', 5000, impulse(1234))]));
    playNow(m);
    return m;
  };
  const one = run(make(), 4000, 4000);
  const small = run(make(), 4000, 64);
  const odd = run(make(), 4000, 333);
  for (let i = 0; i < 4000; i++) {
    const want = i === 1234 ? (3 * 8000) / 32768 : 0;
    assert.ok(Math.abs(one[0][i] - want) < 1e-6, `frame ${i}`);
    assert.strictEqual(small[0][i], one[0][i]);
    assert.strictEqual(odd[0][i], one[0][i]);
    assert.strictEqual(one[1][i], one[0][i]);
  }
});

test('mute silences a track and solo silences the others', () => {
  const m = new Mixer({ sampleRate: RATE, channels: 2 });
  m.setSong(song([track('a', 3000, () => 1000), track('b', 3000, () => 2000), track('c', 3000, () => 4000)]));
  playNow(m);
  let out = run(m, 200, 100);
  assert.ok(Math.abs(out[0][199] - 7000 / 32768) < 1e-6);
  m.setTrack('b', { mute: true });
  out = run(m, 200, 100);
  assert.ok(Math.abs(out[0][199] - 5000 / 32768) < 1e-6);
  m.setTrack('c', { solo: true });
  out = run(m, 200, 100);
  assert.ok(Math.abs(out[0][199] - 4000 / 32768) < 1e-6);
  m.setTrack('c', { solo: false });
  m.setTrack('b', { mute: false });
  out = run(m, 200, 100);
  assert.ok(Math.abs(out[0][199] - 7000 / 32768) < 1e-6);
});

test('volume changes ramp instead of stepping', () => {
  const m = new Mixer({ sampleRate: RATE, channels: 2 });
  m.setSong(song([track('a', 3000, () => 10000)]));
  playNow(m);
  run(m, 100, 100);
  m.setTrack('a', { gain: 0 });
  const out = run(m, 100, 100);
  let maxStep = 0;
  for (let i = 1; i < 100; i++) maxStep = Math.max(maxStep, Math.abs(out[0][i] - out[0][i - 1]));
  assert.ok(maxStep < (10000 / 32768) * 0.2, `largest step ${maxStep}`);
  assert.ok(out[0][99] < 0.01);
  assert.strictEqual(run(m, 100, 100)[0][0], 0);
});

test('band and cue buses reach separate output pairs', () => {
  const m = new Mixer({ sampleRate: RATE, channels: 4 });
  m.setBuses({ band: { mode: 'stereo', ch: 0 }, cue: { mode: 'stereo', ch: 2 } });
  m.setSong(
    song([
      track('drums', 2000, (i, c) => (c === 0 ? 3000 : 5000), { ch: 2 }),
      track('guide', 2000, () => 7000, { bus: 'cue' }),
    ])
  );
  playNow(m);
  const out = run(m, 100, 50);
  assert.ok(Math.abs(out[0][50] - 3000 / 32768) < 1e-6);
  assert.ok(Math.abs(out[1][50] - 5000 / 32768) < 1e-6);
  assert.ok(Math.abs(out[2][50] - 7000 / 32768) < 1e-6);
  assert.ok(Math.abs(out[3][50] - 7000 / 32768) < 1e-6);
});

test('mono split puts cue left and band right on a stereo device', () => {
  const m = new Mixer({ sampleRate: RATE, channels: 2 });
  m.setBuses({ band: { mode: 'mono', ch: 1 }, cue: { mode: 'mono', ch: 0 } });
  m.setSong(
    song([
      track('drums', 2000, (i, c) => (c === 0 ? 2000 : 4000), { ch: 2 }),
      track('guide', 2000, () => 7000, { bus: 'cue' }),
    ])
  );
  playNow(m);
  const out = run(m, 100, 50);
  assert.ok(Math.abs(out[0][50] - 7000 / 32768) < 1e-6);
  assert.ok(Math.abs(out[1][50] - 3000 / 32768) < 1e-6);
});

test('a bus routed to channels the device lacks is silent, not rerouted', () => {
  const m = new Mixer({ sampleRate: RATE, channels: 2 });
  m.setBuses({ band: { mode: 'stereo', ch: 0 }, cue: { mode: 'stereo', ch: 2 } });
  m.setSong(song([track('drums', 2000, () => 3000), track('click', 2000, () => 9000, { bus: 'cue' })], {}, { enabled: true }));
  playNow(m);
  const out = run(m, 1000, 100);
  for (let i = 0; i < 1000; i++) assert.ok(Math.abs(out[0][i] - 3000 / 32768) < 1e-6, `frame ${i}`);
});

test('generated click lands on exact beat frames with the accent on beat 1', () => {
  const m = new Mixer({ sampleRate: RATE, channels: 4 });
  m.setBuses({ band: { mode: 'stereo', ch: 0 }, cue: { mode: 'stereo', ch: 2 } });
  // 3/4 at 100 BPM, first downbeat at 0.25 s: beats every 600 frames from 250.
  const g = { bpm: 100, num: 3, den: 4, offset: 0.25 };
  m.setSong(song([track('pad', 8000, () => 0)], g, { enabled: true }));
  m.clickCur = 1;
  playNow(m);
  const out = run(m, 6000, 128);
  const cue = out[2];
  const onsets = [];
  for (let i = 1; i < 6000; i++) {
    let quietBefore = true;
    for (let j = Math.max(0, i - 100); j < i; j++) if (Math.abs(cue[j]) > 1e-4) quietBefore = false;
    if (quietBefore && Math.abs(cue[i]) > 1e-4) onsets.push(i);
  }
  // A sine burst starts at zero, so the first audible sample is one frame late.
  assert.deepStrictEqual(onsets, [251, 851, 1451, 2051, 2651, 3251, 3851, 4451, 5051, 5651]);
  const energy = (at) => {
    let e = 0;
    for (let i = at; i < at + 60; i++) e += cue[i] * cue[i];
    return e;
  };
  // The accent burst is longer and rings longer than the plain beat.
  assert.ok(energy(250) > energy(850) * 1.1);
  assert.ok(Math.abs(energy(250) - energy(2050)) < 1e-9);
  assert.ok(Math.abs(energy(850) - energy(1450)) < 1e-9);
  for (let i = 0; i < 6000; i++) assert.strictEqual(out[0][i], 0);
});

test('6/8 counts two dotted-quarter beats per bar', () => {
  const g = { bpm: 69, num: 6, den: 8, beatUnit: 'auto', offset: 0 };
  assert.strictEqual(Grid.beatsPerBar(g), 2);
  assert.ok(Math.abs(Grid.barSeconds(g) - 120 / 69) < 1e-12);
  assert.strictEqual(Grid.beatsPerBar(Object.assign({}, g, { beatUnit: 'den' })), 6);
});

test('a section jump waits for the bar line and lands on it exactly', () => {
  const m = new Mixer({ sampleRate: RATE, channels: 2 });
  // Sample value == frame index, so the output says which frame was read.
  // 120 BPM 4/4 at 1 kHz: a bar is 2000 frames.
  m.setSong(song([track('ramp', 30000, (i) => i)]));
  playNow(m);
  const out = run(m, 6000, 97, (done) => {
    if (done > 2500 && !m._asked) {
      m._asked = true;
      m.jumpToBar(10); // frame 20000; the next bar line is frame 4000
    }
  });
  const v = (i) => Math.round(out[0][i] * 32768);
  const xf = m.xfFrames;
  for (let i = 0; i < 4000 - xf; i++) assert.strictEqual(v(i), i, `before the jump, frame ${i}`);
  for (let i = 4000; i < 6000; i++) assert.strictEqual(v(i), 20000 + (i - 4000), `after the jump, frame ${i}`);
  // During the crossfade the level moves monotonically from old to new.
  for (let i = 4000 - xf + 1; i < 4000; i++) assert.ok(out[0][i] >= out[0][i - 1], `crossfade frame ${i}`);
  assert.deepStrictEqual(m.takeEvents(), [{ type: 'jumped', bar: 10 }]);
});

test('a jump asked too close to the bar line takes the following one', () => {
  const m = new Mixer({ sampleRate: RATE, channels: 2 });
  m.setSong(song([track('ramp', 30000, (i) => i)]));
  playNow(m);
  run(m, 1995, 1995);
  m.jumpToBar(10);
  assert.strictEqual(m.pending.at, 4000);
});

test('jump while stopped moves the playhead immediately', () => {
  const m = new Mixer({ sampleRate: RATE, channels: 2 });
  m.setSong(song([track('ramp', 30000, (i) => i)]));
  m.jumpToBar(3);
  assert.strictEqual(m.pos, 6000);
  assert.strictEqual(m.pending, null);
});

test('playback stops at the end of the longest track and reports it', () => {
  const m = new Mixer({ sampleRate: RATE, channels: 2 });
  m.setSong(song([track('a', 500, () => 1000), track('b', 800, () => 1000)]));
  playNow(m);
  const out = run(m, 1200, 100);
  assert.ok(Math.abs(out[0][499] - 2000 / 32768) < 1e-6);
  assert.ok(Math.abs(out[0][799] - 1000 / 32768) < 1e-6);
  assert.strictEqual(out[0][800], 0);
  assert.strictEqual(m.playing, false);
  assert.deepStrictEqual(m.takeEvents(), [{ type: 'ended' }]);
});

test('pause fades out and stop rewinds', () => {
  const m = new Mixer({ sampleRate: RATE, channels: 2 });
  m.setSong(song([track('a', 5000, () => 10000)]));
  m.play();
  let out = run(m, 100, 100);
  assert.ok(out[0][0] < 0.01, 'starts from silence');
  assert.ok(Math.abs(out[0][99] - 10000 / 32768) < 1e-6);
  m.pause();
  out = run(m, 100, 100);
  assert.strictEqual(out[0][99], 0);
  assert.strictEqual(m.playing, false);
  assert.ok(m.pos > 100 && m.pos < 200);
  m.play();
  run(m, 100, 100);
  m.stop();
  run(m, 100, 100);
  assert.strictEqual(m.pos, 0);
});

test('output is clamped to full scale', () => {
  const m = new Mixer({ sampleRate: RATE, channels: 2 });
  m.setSong(song([track('a', 500, () => 30000), track('b', 500, () => 30000), track('c', 500, () => -30000, { mute: true })]));
  playNow(m);
  const out = run(m, 100, 100);
  assert.strictEqual(out[0][50], 1);
  assert.strictEqual(m.takePeaks()[0], 1);
});

// ---------- sampled click, spoken cues, click-only songs ----------

// One-sample "sounds" with distinct values, so a frame's value says which
// sound started there.
function sounds() {
  const one = (v) => Float32Array.of(v);
  const words = new Map(Object.entries({ intro: 0.5, verse: 0.3, chorus: 0.4, 1: 0.01, 2: 0.02, 3: 0.03, 4: 0.04, 5: 0.05, 6: 0.06 }).map(([k, v]) => [k, one(v)]));
  return { click: { main: one(0.8), sub: one(0.2) }, words };
}

// Frames where channel `c` is non-zero, as "frame:value".
function hits(chan) {
  const out = [];
  for (let i = 0; i < chan.length; i++) if (chan[i] !== 0) out.push(`${i}:${Math.round(chan[i] * 100) / 100}`);
  return out.join(' ');
}

function clickOnly(grid, click, cues, bars) {
  const s = song([], grid, Object.assign({ enabled: true, gain: 1, bus: 'cue', sound: 'ew', sub: true, main: 2 }, click));
  s.bars = bars || 8;
  s.cues = Object.assign({ enabled: false, gain: 1, start: 'two', section: 'one', sections: [] }, cues);
  return s;
}

function cueMixer(s) {
  const m = new Mixer({ sampleRate: RATE, channels: 2 });
  m.setSounds(sounds());
  m.setSong(s);
  m.clickCur = s.click.enabled ? 1 : 0;
  m.cueCur = s.cues.enabled ? 1 : 0;
  return m;
}

test('sampled click: eighth notes, main sound every two beats', () => {
  // 4/4 at 120: beats every 500 frames, eighths every 250, bar 2000.
  const m = cueMixer(clickOnly());
  playNow(m);
  const out = run(m, 2000, 128);
  assert.strictEqual(hits(out[0]), '0:0.8 250:0.2 500:0.2 750:0.2 1000:0.8 1250:0.2 1500:0.2 1750:0.2');
});

test('sampled click: main sound placement and subdivision can be changed', () => {
  const m = cueMixer(clickOnly({}, { main: 1, sub: false }));
  playNow(m);
  assert.strictEqual(hits(run(m, 2000, 128)[0]), '0:0.8 500:0.8 1000:0.8 1500:0.8');
  const b = cueMixer(clickOnly({}, { main: 'bar' }));
  playNow(b);
  assert.strictEqual(hits(run(b, 2000, 128)[0]), '0:0.8 250:0.2 500:0.2 750:0.2 1000:0.2 1250:0.2 1500:0.2 1750:0.2');
});

test('sampled click in 6/8: six eighths, main sound once a bar', () => {
  // 60 dotted-quarter BPM: beat 1000 frames, eighth 333.3, bar 2000.
  const m = cueMixer(clickOnly({ bpm: 60, num: 6, den: 8 }));
  playNow(m);
  assert.strictEqual(hits(run(m, 2000, 128)[0]), '0:0.8 333:0.2 667:0.2 1000:0.2 1333:0.2 1667:0.2');
});

test('without samples the click falls back to the generated one', () => {
  const m = new Mixer({ sampleRate: RATE, channels: 2 });
  m.setSong(clickOnly());
  m.clickCur = 1;
  playNow(m);
  const out = run(m, 1000, 100);
  assert.ok(Math.abs(out[0][0]) + Math.abs(out[0][1]) > 0, 'click at beat 1');
  assert.ok(Math.abs(out[0][500]) + Math.abs(out[0][501]) > 0, 'click at beat 2');
  assert.strictEqual(out[0][250], 0, 'no eighth-note pulse');
});

test('a song with no stems plays for its length in bars and grows instead of ending', () => {
  const m = cueMixer(clickOnly({}, {}, {}, 2));
  assert.strictEqual(m.song.length, 4000);
  playNow(m);
  run(m, 3900, 128);
  assert.deepStrictEqual(m.takeEvents(), []);
  run(m, 300, 128);
  assert.strictEqual(m.playing, true);
  assert.deepStrictEqual(m.takeEvents(), [{ type: 'extended', bars: 18 }]);
  assert.strictEqual(m.song.length, 36000);
  // Tempo changes move the end with the bars.
  m.setGrid(Object.assign({}, m.song.grid, { bpm: 60 }));
  assert.strictEqual(m.song.length, 72000);
  m.setBars(4);
  assert.strictEqual(m.song.length, 16000);
});

test('spoken cues start on their counts, on the cue bus, whatever the block size', () => {
  const mk = () => {
    const m = new Mixer({ sampleRate: RATE, channels: 4 });
    m.setSounds(sounds());
    const s = clickOnly({}, { enabled: false }, { enabled: true, sections: [{ bar: 2, name: 'Intro' }, { bar: 4, name: 'Verse 1' }] }, 8);
    m.setSong(s);
    m.cueCur = 1;
    m.setBuses({ band: { mode: 'stereo', ch: 0, gain: 1 }, cue: { mode: 'stereo', ch: 2, gain: 1 } });
    playNow(m);
    return m;
  };
  const a = run(mk(), 8000, 8000);
  const b = run(mk(), 8000, 100);
  const c = run(mk(), 8000, 333);
  // "Intro . 2 . | 1 2 3 4" in bars 1-2, then "Verse 2 3 4" in bar 4 ("verse 1" has no sample here, so "verse").
  const want = '0:0.5 1000:0.02 2000:0.01 2500:0.02 3000:0.03 3500:0.04 6000:0.3 6500:0.02 7000:0.03 7500:0.04';
  assert.strictEqual(hits(a[2]), want);
  assert.strictEqual(hits(b[2]), want);
  assert.strictEqual(hits(c[2]), want);
  assert.strictEqual(hits(a[3]), want);
  assert.strictEqual(hits(a[0]), '', 'nothing on the band outputs');
});

test('a first section at bar 1 gets its count-in before the song starts', () => {
  const s = clickOnly({}, { enabled: false }, { enabled: true, sections: [{ bar: 0, name: 'Intro' }] }, 8);
  const m = cueMixer(s);
  playNow(m);
  assert.strictEqual(m.pos, -4000, 'two bars of count-in');
  const out = run(m, 4500, 128);
  assert.strictEqual(hits(out[0]), '0:0.5 1000:0.02 2000:0.01 2500:0.02 3000:0.03 3500:0.04');
  assert.strictEqual(m.pos, 500);
  // Stop rewinds to 0; pausing in the count-in and resuming does not restart it.
  m.stop();
  run(m, 100, 100);
  assert.strictEqual(m.pos, 0);
  playNow(m);
  run(m, 1500, 100);
  m.pause();
  run(m, 100, 100);
  assert.strictEqual(m.pos < 0 && !m.playing, true);
  const at = m.pos;
  playNow(m);
  assert.strictEqual(m.pos, at);
  // With cues off there is no count-in.
  const off = cueMixer(clickOnly({}, { enabled: false }, { enabled: false, sections: [{ bar: 0, name: 'Intro' }] }, 8));
  playNow(off);
  assert.strictEqual(off.pos, 0);
});

test('a jump is announced, replaces the cue of the section being left, and is not cut by the jump', () => {
  const mk = () => {
    const s = clickOnly(
      {},
      { enabled: false },
      { enabled: true, start: 'off', sections: [{ bar: 0, name: 'Intro' }, { bar: 2, name: 'Verse' }, { bar: 6, name: 'Chorus' }] },
      12
    );
    const m = cueMixer(s);
    // A long "chorus" sample: it must keep sounding across the jump.
    const snd = sounds();
    snd.words.set('chorus', Float32Array.from({ length: 900 }, () => 0.4));
    m.setSounds(snd);
    playNow(m);
    return m;
  };
  // Bar 2 (frames 2000-4000) says "Verse 2 3 4" on the way to the verse.
  // Tap Chorus at frame 2100, after "Verse": "Chorus" on beat 2 (2500), then
  // "3" and "4" instead of the verse's counts; the jump lands at 4000 and
  // continues from bar 7 (12000).
  for (const block of [100, 64, 333]) {
    const m = mk();
    const a = run(m, 2100, block);
    assert.strictEqual(hits(a[0]), '2000:0.3', '"Verse" was already said');
    m.jumpToBar(6);
    assert.deepStrictEqual(m.pending, { at: 4000, to: 12000, bar: 6 }, 'lands on the next bar line');
    const b = run(m, 2300, block);
    // Offsets are from frame 2100. "Chorus" from 400 for 900 frames, with "3" at 900 on top, then "4" at 1400.
    assert.ok(b[0][399] === 0 && Math.abs(b[0][400] - 0.4) < 1e-6, 'name on the next beat');
    assert.ok(Math.abs(b[0][900] - 0.43) < 1e-6, '"3" on beat 3, over the name');
    assert.ok(Math.abs(b[0][1299] - 0.4) < 1e-6 && b[0][1300] === 0, 'the name plays to its end');
    assert.ok(Math.abs(b[0][1400] - 0.04) < 1e-6, '"4" on beat 4');
    assert.strictEqual(m.pos, 12000 + 400, 'landed on bar 7 at the bar line');
    assert.deepStrictEqual(m.takeEvents(), [{ type: 'jumped', bar: 6 }]);
  }

  // Tapped on the last beat: the name starts at once and rings past the jump.
  const late = mk();
  run(late, 3700, 100);
  late.jumpToBar(6);
  const c = run(late, 1000, 100);
  assert.ok(Math.abs(c[0][0] - 0.4) < 1e-6 && Math.abs(c[0][899] - 0.4) < 1e-6 && c[0][900] === 0, 'whole name heard across the jump');

  // Cancelling the jump brings back the cue of the section ahead.
  const cancel = mk();
  run(cancel, 2100, 100);
  cancel.jumpToBar(6);
  cancel.cancelJump();
  const d = run(cancel, 1900, 100);
  assert.strictEqual(hits(d[0]), '400:0.02 900:0.03 1400:0.04', 'the counts of "Verse 2 3 4" that are still ahead');
});

// The owner's check: a 120 BPM song played from the top to the end. Every
// section is announced exactly once, the count ends one count before the
// section's bar line, and the click's half-time changes none of it.
test('120 BPM walk-through: each cue fires once, on time, with half-time on or off', () => {
  const BAR = 2000; // 4/4 at 120 with RATE 1000
  const layout = [['Intro', 0], ['Verse', 4], ['Chorus', 12], ['Verse', 20], ['Chorus', 28], ['Outro', 36]];
  const play = (click, cues) => {
    const s = clickOnly({}, Object.assign({ bus: 'band' }, click), Object.assign({ enabled: true, sections: layout.map(([name, bar]) => ({ name, bar })) }, cues), 40);
    const m = new Mixer({ sampleRate: RATE, channels: 4 });
    m.setSounds(sounds());
    m.setSong(s);
    m.setBuses({ band: { mode: 'stereo', ch: 0, gain: 1 }, cue: { mode: 'stereo', ch: 2, gain: 1 } });
    m.clickCur = 1;
    m.cueCur = 1;
    playNow(m);
    const start = m.pos; // negative: the count-in before bar 1
    const out = run(m, -start + 40 * BAR, 256);
    // Each word is one sample long, so every non-zero frame on the cue bus is one word starting.
    const fired = [];
    for (let i = 0; i < out[2].length; i++) if (out[2][i] !== 0) fired.push([start + i, Math.round(out[2][i] * 100) / 100]);
    return { start, fired, click: out[0] };
  };
  const NAME = { 0.5: 'intro', 0.3: 'verse', 0.4: 'chorus' };
  const check = (run_, unit, startLead, lead, label) => {
    const names = run_.fired.filter(([, v]) => NAME[v]);
    assert.strictEqual(names.length, 5, `${label}: one name per section that the voice knows (Outro is counted in)`);
    for (const [name, bar] of layout) {
      const line = bar * BAR;
      const mine = run_.fired.filter(([f]) => f < line && f >= line - (bar === 0 ? startLead : lead));
      assert.ok(mine.length > 0, `${label}: ${name} at bar ${bar + 1} is announced`);
      assert.strictEqual(mine[0][0], line - (bar === 0 ? startLead : lead), `${label}: ${name} starts its full lead ahead`);
      assert.strictEqual(mine[mine.length - 1][0], line - unit, `${label}: ${name}'s last count is one count before the bar line`);
      assert.strictEqual(mine[mine.length - 1][1], 0.04, `${label}: and it is "4"`);
    }
    const frames = run_.fired.map(([f]) => f);
    assert.strictEqual(new Set(frames).size, frames.length, `${label}: nothing fires twice`);
    // 2-bar start (name, "2", then 1 2 3 4) and 1-bar cues (name or "1", then 2 3 4) for the other five.
    assert.strictEqual(run_.fired.length, 6 + 5 * 4, `${label}: no extra words`);
  };
  const normal = play({}, {});
  check(normal, 500, 4000, 2000, 'original');
  assert.strictEqual(normal.start, -4000);
  // Half-time click: the same cue frames exactly, and a click that ticks half as often.
  const halfClick = play({ feel: 'half' }, {});
  assert.deepStrictEqual(halfClick.fired, normal.fired);
  const ticks = (r) => r.click.reduce((n, v) => n + (v !== 0 ? 1 : 0), 0);
  assert.strictEqual(ticks(halfClick) * 2, ticks(normal));
  // Half-time cues: the same words, one every two beats, starting twice as early, still ending on the line.
  const halfCue = play({}, { speed: 'half' });
  check(halfCue, 1000, 8000, 4000, 'half-time cues');
  assert.deepStrictEqual(halfCue.fired.map(([, v]) => v), normal.fired.map(([, v]) => v), 'the same words in the same order');
  // Double-time cues: the same words inside half the time.
  const dbl = play({}, { speed: 'double' });
  check(dbl, 250, 2000, 1000, 'double-time cues');
  // Both at half-time, as the owner had it set.
  assert.deepStrictEqual(play({ feel: 'half' }, { speed: 'half' }).fired, halfCue.fired);
});

test('playing from a section starts at its cue, so the band is counted in', () => {
  const mk = (cues) => cueMixer(clickOnly({}, { enabled: false }, Object.assign({ enabled: true, sections: [{ bar: 0, name: 'Intro' }, { bar: 4, name: 'Verse' }] }, cues), 12));
  const m = mk();
  m.playFromBar(4);
  m.tGain = 1;
  assert.strictEqual(m.pos, 6000, 'one bar before the verse at 8000');
  assert.strictEqual(hits(run(m, 2500, 128)[0]), '0:0.3 500:0.02 1000:0.03 1500:0.04');
  assert.strictEqual(m.pos, 8500);
  // The first section: its two-bar count-in, before the song.
  const first = mk();
  first.playFromBar(0);
  assert.strictEqual(first.pos, -4000);
  // The song's own guide off: the tap brings its own one-bar count.
  const off = mk({ enabled: false });
  off.cueCur = 0;
  off.playFromBar(4);
  off.tGain = 1;
  assert.strictEqual(off.pos, 6000);
  assert.strictEqual(hits(run(off, 2500, 128)[0]), '0:0.3 500:0.02 1000:0.03 1500:0.04');
  // But not into the first section, where a recorded guide has its count-in.
  const top = mk({ enabled: false });
  top.playFromBar(0);
  assert.strictEqual(top.pos, 0);
  top.tGain = 1;
  assert.strictEqual(hits(run(top, 2000, 128)[0]), '');
  // The count belongs to that tap only: playing from the top later says nothing.
  off.stop();
  run(off, 200, 100);
  playNow(off);
  assert.strictEqual(hits(run(off, 8000, 128)[0]), '');
  // A tag is not counted in.
  const tag = mk({ sections: [{ bar: 0, name: 'Intro' }, { bar: 4, name: 'Tag' }] });
  tag.playFromBar(4);
  assert.strictEqual(tag.pos, 8000);
});

test('half-time and double-time click change the click only, not the song', () => {
  // 4/4 at 120: bar 2000 frames. Half-time is the 60 BPM pattern: a pulse
  // every quarter note, the main sound once a bar.
  const half = cueMixer(clickOnly({}, { feel: 'half' }));
  playNow(half);
  assert.strictEqual(hits(run(half, 4000, 128)[0]), '0:0.8 500:0.2 1000:0.2 1500:0.2 2000:0.8 2500:0.2 3000:0.2 3500:0.2');
  assert.strictEqual(half.song.length, 16000, 'eight bars are still eight bars');
  // Double-time: sixteenths, the main sound on every beat.
  const dbl = cueMixer(clickOnly({}, { feel: 'double' }));
  playNow(dbl);
  assert.strictEqual(hits(run(dbl, 1000, 128)[0]), '0:0.8 125:0.2 250:0.2 375:0.2 500:0.8 625:0.2 750:0.2 875:0.2');
  // 3/4 with beats only: half-time cannot split three beats evenly, so the
  // pulses are spread over the bar and still restart on every bar line.
  const three = cueMixer(clickOnly({ num: 3 }, { feel: 'half', sub: false, main: 'bar' }));
  playNow(three);
  assert.strictEqual(hits(run(three, 3000, 128)[0]), '0:0.8 750:0.2 1500:0.8 2250:0.2');
});

test('half-time click with original-speed cues: the count stays at the song tempo', () => {
  const s = clickOnly({}, { feel: 'half' }, { enabled: true, gain: 0.5, start: 'off', sections: [{ bar: 0, name: 'x' }, { bar: 2, name: 'Verse' }] }, 8);
  const m = cueMixer(s);
  m.setBuses({ band: { mode: 'mono', ch: 1, gain: 1 }, cue: { mode: 'mono', ch: 0, gain: 1 } });
  playNow(m);
  const out = run(m, 4000, 128);
  // Bar 2 (2000-4000): click on quarters at half-time, "Verse 2 3 4" (at half
  // level here) on every beat of the song.
  const near = (i, want) => assert.ok(Math.abs(out[0][i] - want) < 1e-6, `frame ${i}: ${out[0][i]}`);
  near(2000, 0.8 + 0.15);
  near(2500, 0.2 + 0.01);
  near(3000, 0.2 + 0.015);
  near(3500, 0.2 + 0.02);
  // The same song with half-time cues says it over bars 1 and 2 instead.
  const h = cueMixer(clickOnly({}, { enabled: false }, { enabled: true, speed: 'half', start: 'off', sections: [{ bar: 0, name: 'x' }, { bar: 2, name: 'Verse' }] }, 8));
  playNow(h);
  assert.strictEqual(hits(run(h, 4000, 128)[0]), '0:0.3 1000:0.02 2000:0.03 3000:0.04');
});

test('2x bars: a song written at double tempo sounds exactly like the tempo that was typed', () => {
  // The same song twice: at 60 BPM, and at 120 BPM with every bar number doubled and scale 2.
  const layout = [['Intro', 0, 2], ['Verse', 2, 4], ['Chorus', 6, 4]];
  const make = (bpm, k) => {
    const s = clickOnly({ bpm }, { scale: k }, { enabled: true, scale: k, sections: layout.map(([name, bar]) => ({ name, bar: bar * k })) }, 10 * k);
    const m = cueMixer(s);
    playNow(m);
    return m;
  };
  const typed = make(60, 1);
  const doubled = make(120, 2);
  assert.strictEqual(doubled.pos, typed.pos, 'the same count-in');
  assert.strictEqual(doubled.song.length, typed.song.length);
  const total = -typed.pos + typed.song.length;
  const a = run(typed, total, 128);
  const b = run(doubled, total, 128);
  assert.deepStrictEqual(Array.from(b[0]), Array.from(a[0]), 'click and cues are identical, sample for sample');
  // The owner's earlier way of getting there, double tempo with the click and
  // the count both at half-time, is the same thing again.
  const s = clickOnly({ bpm: 120 }, { feel: 'half' }, { enabled: true, speed: 'half', sections: layout.map(([name, bar]) => ({ name, bar: bar * 2 })) }, 20);
  const manual = cueMixer(s);
  playNow(manual);
  assert.deepStrictEqual(Array.from(run(manual, total, 128)[0]), Array.from(a[0]));
  // What does change: bar lines are twice as close, so a jump can land sooner.
  const t = make(60, 1);
  const d = make(120, 2);
  run(t, -t.pos + 4100, 100);
  run(d, -d.pos + 4100, 100);
  t.jumpToBar(6);
  d.jumpToBar(12);
  assert.strictEqual(t.pending.at, 8000);
  assert.strictEqual(d.pending.at, 6000);
});

test('a counted jump waits for a full bar of count and only its own cue is heard', () => {
  const mk = () => {
    const s = clickOnly(
      {},
      { enabled: false },
      { enabled: true, start: 'off', sections: [{ bar: 0, name: 'Intro' }, { bar: 2, name: 'Verse' }, { bar: 6, name: 'Chorus' }] },
      12
    );
    const m = cueMixer(s);
    playNow(m);
    return m;
  };
  // Bar 2 (2000-4000) says "Verse 2 3 4". Tap Chorus at 2100, after "Verse":
  // there is no full bar left before 4000, so the jump lands at 6000.
  // The verse's own "2 3 4" is dropped; "Chorus 2 3 4" fills bar 3.
  for (const block of [100, 64, 333]) {
    const m = mk();
    assert.strictEqual(hits(run(m, 2100, block)[0]), '2000:0.3');
    m.jumpToBar(6, true);
    assert.deepStrictEqual(m.pending, { at: 6000, to: 12000, bar: 6 });
    const b = run(m, 4400, block);
    assert.strictEqual(hits(b[0]), '1900:0.4 2400:0.02 2900:0.03 3400:0.04', 'offsets from frame 2100: one cue, in the bar before the landing');
    assert.strictEqual(m.pos, 12000 + 500);
  }
  // Tapped on a bar line the whole bar is free: it lands on the next line.
  const onLine = mk();
  run(onLine, 2000, 100);
  onLine.jumpToBar(6, true);
  assert.strictEqual(onLine.pending.at, 4000);
  // The song's own guide off (it has a recorded guide stem, say): a tap is
  // still counted in, at the guide's level, and nothing else is said.
  const off = mk();
  off.song.cues.enabled = false;
  off.song.cues.gain = 0.5;
  off.cueCur = 0;
  assert.strictEqual(hits(run(off, 2100, 100)[0]), '', 'the song\'s own guide stays quiet');
  off.jumpToBar(6, true);
  assert.strictEqual(off.pending.at, 6000);
  assert.strictEqual(hits(run(off, 4400, 100)[0]), '1900:0.2 2400:0.01 2900:0.01 3400:0.02', '"Chorus 2 3 4" at half level');
  // A section whose own guide is switched off, and a tag, say nothing: no
  // count, so no wait.
  for (const sections of [
    [{ bar: 0, name: 'Intro' }, { bar: 2, name: 'Verse' }, { bar: 6, name: 'Chorus', cue: 'off' }],
    [{ bar: 0, name: 'Intro' }, { bar: 2, name: 'Verse' }, { bar: 6, name: 'Tag' }],
  ]) {
    const quiet = mk();
    quiet.setCues(Object.assign({}, quiet.song.cues, { sections }));
    run(quiet, 2100, 100);
    quiet.jumpToBar(6, true);
    assert.strictEqual(quiet.pending.at, 4000);
    const q = run(quiet, 1900, 100);
    assert.strictEqual(hits(q[0]), '', 'and nothing is said on the way');
  }
  // Not counted: the next bar line, as always.
  const plain = mk();
  run(plain, 2100, 100);
  plain.jumpToBar(6);
  assert.strictEqual(plain.pending.at, 4000);
});

test('callouts are said where they stand, beside the section cues, and not while a jump is waiting', () => {
  // "Chorus" stands in for a direction such as "All In": a word the test voice has.
  const mk = (cues) => {
    const s = clickOnly({}, { enabled: false }, Object.assign({ enabled: true, sections: [{ bar: 0, name: 'Intro' }, { bar: 4, name: 'Verse' }], callouts: [{ bar: 1.5, word: 'Chorus' }, { bar: 3, word: 'count' }, { bar: 2, word: 'No Such Word' }] }, cues), 12);
    return cueMixer(s);
  };
  const m = mk();
  playNow(m);
  assert.strictEqual(m.pos, -4000, 'the count-in is the first section\'s, whatever the callouts are');
  run(m, 4000, 100);
  // Bar 2 beat 3: the callout. Bar 3: its bare count "1 2 3 4". Bar 4: "Verse 2 3 4" as always.
  assert.strictEqual(hits(run(m, 8000, 128)[0]), '3000:0.4 4000:0.01 4500:0.02 5000:0.03 5500:0.04 6000:0.3 6500:0.02 7000:0.03 7500:0.04');
  // With the guide off they are silent too.
  const off = mk({ enabled: false });
  playNow(off);
  assert.strictEqual(hits(run(off, 8000, 128)[0]), '');
  // A jump waiting to land has the voice to itself.
  const j = mk();
  playNow(j);
  run(j, 4000 + 2100, 100);
  j.jumpToBar(8);
  assert.strictEqual(hits(run(j, 1900, 100)[0]).includes('0.4'), false, 'the callout in the bar being left is not said');
  // Changing the callouts takes effect at once.
  const c = mk();
  c.setCues(Object.assign({}, c.song.cues, { callouts: [{ bar: 0.5, word: 'Chorus' }] }));
  playNow(c);
  run(c, 4000, 100);
  assert.strictEqual(hits(run(c, 2000, 128)[0]), '1000:0.4');
});

test('fading out lowers the whole song evenly, then stops rewound and says so', () => {
  const m = new Mixer({ sampleRate: RATE, channels: 2 });
  m.setSong(song([track('a', 20000, () => 16384)])); // a steady 0.5
  playNow(m);
  run(m, 1000, 100);
  m.fadeOut(2000);
  const out = run(m, 2500, 128);
  assert.ok(Math.abs(out[0][0] - 0.5) < 0.002, 'starts from full level');
  assert.ok(Math.abs(out[0][1000] - 0.25) < 0.002, 'halfway down halfway through');
  assert.ok(out[0][1990] > 0 && out[0][1990] < 0.01, 'almost gone at the end');
  assert.strictEqual(out[0][2100], 0);
  assert.strictEqual(m.playing, false);
  assert.strictEqual(m.pos, 0, 'rewound, like Stop');
  assert.deepStrictEqual(m.takeEvents(), [{ type: 'stopped' }]);

  // An ordinary stop afterwards is as quick as ever, and reports the same way.
  playNow(m);
  run(m, 500, 100);
  m.stop();
  const quick = run(m, 100, 10);
  assert.strictEqual(quick[0][30], 0);
  assert.deepStrictEqual(m.takeEvents(), [{ type: 'stopped' }]);

  // Pressing play during a fade takes over: back to full level at once.
  playNow(m);
  run(m, 200, 100);
  m.fadeOut(2000);
  run(m, 500, 100);
  m.play();
  const again = run(m, 100, 10);
  assert.ok(Math.abs(again[0][60] - 0.5) < 0.002);
  assert.strictEqual(m.playing, true);
  assert.deepStrictEqual(m.takeEvents(), []);
  // Fading something that is not playing does nothing.
  m.stop();
  run(m, 100, 10);
  m.takeEvents();
  m.fadeOut(2000);
  assert.strictEqual(m.playing, false);
});

test('a song with no stems that is told where it ends, ends there instead of growing', () => {
  // 4/4 at 120: a bar is 2000 frames.
  const s = clickOnly({}, { enabled: false }, {}, 8);
  s.endBar = 2;
  const m = cueMixer(s);
  assert.strictEqual(s.length, 4000);
  playNow(m);
  run(m, 4100, 100);
  assert.strictEqual(m.playing, false);
  assert.deepStrictEqual(m.takeEvents(), [{ type: 'ended' }]);
  assert.strictEqual(s.bars, 8, 'and it has not grown');
  // The end can be moved, and taken away again.
  m.setBars(8, 3.5);
  assert.strictEqual(s.length, 7000);
  m.setBars(8);
  assert.strictEqual(s.length, 16000);
  playNow(m);
  run(m, 16100, 100);
  assert.strictEqual(m.playing, true, 'with no end set it grows as before');
  assert.deepStrictEqual(m.takeEvents(), [{ type: 'extended', bars: 24 }]);
});

test('a song with stems ends where its end was dragged to: cut short, or carried on past its audio', () => {
  // 4/4 at 120: a bar is 2000 frames. The stem is 5000 frames, two and a half bars.
  const make = (endBar) => {
    const m = new Mixer({ sampleRate: RATE, channels: 2 });
    const s = song([track('a', 5000, () => 8000)]);
    s.endBar = endBar;
    m.setSong(s);
    return { m, s };
  };
  const cut = make(2);
  assert.strictEqual(cut.s.length, 4000);
  playNow(cut.m);
  let out = run(cut.m, 4100, 100);
  assert.strictEqual(cut.m.playing, false);
  assert.deepStrictEqual(cut.m.takeEvents(), [{ type: 'ended' }]);
  assert.ok(out[0][3999] !== 0 && out[0][4000] === 0, 'the audio stops at the bar line');
  // Longer than the audio: nothing after the stem, and the song goes on to its end.
  const long = make(4);
  assert.strictEqual(long.s.length, 8000);
  playNow(long.m);
  out = run(long.m, 7900, 100);
  assert.strictEqual(long.m.playing, true);
  assert.ok(out[0][4999] !== 0 && out[0][5000] === 0 && out[0][7000] === 0);
  run(long.m, 200, 100);
  assert.strictEqual(long.m.playing, false);
  assert.deepStrictEqual(long.m.takeEvents(), [{ type: 'ended' }]);
  // With the end taken away the song is as long as its audio again.
  long.m.setBars(undefined, null);
  assert.strictEqual(long.s.length, 5000);
});

test('with more outputs: click, guide and each group of tracks on channels of their own', () => {
  // 4/4 at 120. Eight outputs, as on the Dante rig: 1 click, 2 guide, then groups.
  const m = new Mixer({ sampleRate: RATE, channels: 8 });
  m.setSounds(sounds());
  m.setBuses({ click: { mode: 'mono', ch: 0, gain: 1 }, guide: { mode: 'mono', ch: 1, gain: 1 }, g1: { mode: 'mono', ch: 2, gain: 1 }, g2: { mode: 'stereo', ch: 3, gain: 1 } });
  const s = song([track('drums', 9000, () => 8000, { bus: 'g1' }), track('keys', 9000, () => 4000, { bus: 'g2' }), track('lost', 9000, () => 8000, { bus: 'g9' })], {}, { enabled: true, gain: 1, bus: 'click', sound: 'ew', sub: true, main: 2 });
  s.cues = { enabled: true, gain: 1, start: 'one', section: 'one', sections: [{ bar: 0, name: 'Intro' }, { bar: 2, name: 'Verse' }] };
  m.setSong(s);
  m.clickCur = 1;
  m.cueCur = 1;
  m.pos = 0;
  playNow(m);
  const out = run(m, 6000, 100);
  const loud = out.map((c) => c.some((v) => v !== 0));
  assert.deepStrictEqual(loud, [true, true, true, true, true, false, false, false], 'a track on a group that does not exist is silent, never on outputs 1-2');
  // Output 1 carries the click and nothing else: its ticks, no track, no voice.
  assert.deepStrictEqual([...new Set(Array.from(out[0]).filter((v) => v !== 0).map((v) => Math.round(v * 100) / 100))].sort(), [0.2, 0.8]);
  // Output 2 carries the voice: "Verse" and its count, before bar 3.
  assert.ok(Array.from(out[1]).some((v) => Math.abs(v - 0.3) < 1e-6) && !Array.from(out[1]).some((v) => Math.abs(v - 0.8) < 1e-6 || Math.abs(v - 0.2) < 1e-6));
  const level = (c) => Math.round(Math.max(...out[c]) * 1000) / 1000;
  assert.deepStrictEqual([level(2), level(3), level(4)], [Math.round((8000 / 32768) * 1000) / 1000, Math.round((4000 / 32768) * 1000) / 1000, Math.round((4000 / 32768) * 1000) / 1000]);
  // Taking the extra outputs away again leaves the two that are always there.
  m.setBuses({ band: { mode: 'stereo', ch: 0, gain: 1 }, cue: { mode: 'stereo', ch: 2, gain: 1 } });
  assert.deepStrictEqual(Object.keys(m.buses).sort(), ['band', 'cue']);
  assert.strictEqual(m.voiceBus, 'cue');
});

test('a song plays the click sound it names, and falls back to the standard one', () => {
  const mk = (sound) => {
    const m = new Mixer({ sampleRate: RATE, channels: 2 });
    const s = sounds();
    s.clicks = { ew: s.click, wood: { main: Float32Array.of(0.7), sub: Float32Array.of(0.1) } };
    m.setSounds(s);
    const song = clickOnly({}, { sound });
    m.setSong(song);
    m.clickCur = 1;
    playNow(m);
    return hits(run(m, 2000, 128)[0]);
  };
  assert.strictEqual(mk('wood'), '0:0.7 250:0.1 500:0.1 750:0.1 1000:0.7 1250:0.1 1500:0.1 1750:0.1');
  assert.strictEqual(mk('ew'), '0:0.8 250:0.2 500:0.2 750:0.2 1000:0.8 1250:0.2 1500:0.2 1750:0.2');
  // A sound this copy of Selah does not have is never silence.
  assert.strictEqual(mk('gone'), mk('ew'));
  // The beep is generated, and ticks where the others do: eighth notes, its
  // higher pulse on the main hits. It once ticked half as often as the rest.
  // Where each pulse starts: the first sounding frame after a silence. (A
  // generated pulse is a short burst that begins at zero, so one frame late.)
  const starts = (s) => {
    const f = s.split(' ').map((x) => Number(x.split(':')[0]));
    return f.filter((x, i) => i === 0 || x - f[i - 1] > 100);
  };
  const beep = mk('beep');
  assert.deepStrictEqual(starts(beep).map((x) => x - 1), starts(mk('ew')));
  assert.deepStrictEqual(starts(mk('ew')), [0, 250, 500, 750, 1000, 1250, 1500, 1750]);
  assert.notStrictEqual(beep, mk('ew'));
});

test('each track reports the level it is being heard at, for its meter', () => {
  const m = new Mixer({ sampleRate: RATE, channels: 2 });
  m.setSong(song([track('loud', 5000, () => 16384), track('soft', 5000, () => 16384, { gain: 0.5 }), track('muted', 5000, () => 16384, { mute: true }), track('stereo', 5000, (i, c) => (c ? -8192 : 4096), { ch: 2 })]));
  playNow(m);
  for (const t of m.song.tracks) t.cur = m._trackTarget(t, false);
  run(m, 1000, 128);
  const p = m.takeTrackPeaks();
  assert.ok(Math.abs(p.loud - 0.5) < 0.001, 'full scale of the track itself');
  assert.ok(Math.abs(p.soft - 0.25) < 0.001, 'after its fader');
  assert.ok(Math.abs(p.stereo - 0.25) < 0.001, 'the louder side of a stereo track');
  assert.strictEqual(p.muted, undefined, 'a muted track shows nothing');
  // Taking the levels clears them; a stopped song shows nothing.
  assert.deepStrictEqual(m.takeTrackPeaks(), {});
  m.stop();
  run(m, 200, 100);
  m.takeTrackPeaks();
  run(m, 200, 100);
  assert.deepStrictEqual(m.takeTrackPeaks(), {});
  // Solo: only that track is heard, so only it shows.
  m.setTrack('soft', { solo: true });
  playNow(m);
  run(m, 400, 100);
  m.takeTrackPeaks();
  run(m, 400, 100);
  assert.deepStrictEqual(Object.keys(m.takeTrackPeaks()), ['soft']);
});
