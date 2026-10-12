'use strict';
// Selah against the owner's Ableton set. The
// note times below are copied from that set's clips, in Ableton beats (quarter
// notes) from the start of the clip. A song set up the same way in Selah, with
// the same tempo typed in, has to put every click and every spoken word at
// the same moment.
const test = require('node:test');
const assert = require('node:assert');
const { Mixer } = require('../src/engine/mixer');
const Grid = require('../src/shared/grid');

const RATE = 8000;
const WORD = { intro: 0.5, verse: 0.3 };
for (let i = 1; i <= 7; i++) WORD[i] = i / 100;

function sounds() {
  const one = (v) => Float32Array.of(v);
  return { click: { main: one(0.8), sub: one(0.2) }, words: new Map(Object.entries(WORD).map(([k, v]) => [k, one(v)])) };
}

// Plays the song from the top and returns what started when, in seconds from
// the moment Play was pressed: { click: [[sec, 'M' | 's']], voice: [[sec, word]] }.
function play(grid, sections, seconds) {
  const m = new Mixer({ sampleRate: RATE, channels: 4 });
  m.setSounds(sounds());
  m.setBuses({ band: { mode: 'stereo', ch: 0, gain: 1 }, cue: { mode: 'stereo', ch: 2, gain: 1 } });
  m.setSong({
    id: 's',
    grid,
    bars: 64,
    click: { enabled: true, gain: 1, bus: 'band', sound: 'ew', sub: true, main: 2 },
    cues: { enabled: true, gain: 1, start: 'auto', section: 'auto', sections },
    tracks: [],
  });
  m.clickCur = 1;
  m.cueCur = 1;
  m.play();
  m.tGain = 1;
  const n = Math.round(seconds * RATE);
  const buf = new Float32Array(n * 4);
  m.render(buf, n);
  const click = [];
  const voice = [];
  const name = (v) => Object.keys(WORD).find((k) => Math.abs(WORD[k] - v) < 1e-6);
  for (let i = 0; i < n; i++) {
    if (buf[i * 4] !== 0) click.push([i / RATE, Math.abs(buf[i * 4] - 0.8) < 1e-6 ? 'M' : 's']);
    if (buf[i * 4 + 2] !== 0) voice.push([i / RATE, name(buf[i * 4 + 2])]);
  }
  return { click, voice };
}

// Ableton's side: a looping click pattern and a list of spoken notes, both in beats.
function ableton(tempo, loopBeats, mainAt, subAt, spoken, seconds) {
  const beat = 60 / tempo;
  const click = [];
  for (let loop = 0; loop * loopBeats * beat < seconds; loop++) {
    for (const b of mainAt) click.push([(loop * loopBeats + b) * beat, 'M']);
    for (const b of subAt) click.push([(loop * loopBeats + b) * beat, 's']);
  }
  click.sort((a, b) => a[0] - b[0]);
  return { click: click.filter((c) => c[0] < seconds - 1e-9), voice: spoken.map(([b, w]) => [b * beat, String(w)]).filter((c) => c[0] < seconds - 1e-9) };
}

function same(got, want, what) {
  assert.strictEqual(got.map((e) => e[1]).join(' '), want.map((e) => e[1]).join(' '), `${what}: the same sounds in the same order`);
  for (let i = 0; i < want.length; i++) {
    assert.ok(Math.abs(got[i][0] - want[i][0]) < 0.002, `${what}: "${want[i][1]}" at ${want[i][0].toFixed(3)} s in Ableton, ${got[i][0].toFixed(3)} s in Selah`);
  }
}

test('4/4 at 71 (TUM SA): click, count-in and the cue into the verse match Ableton', () => {
  const tempo = 71;
  const seconds = (44 * 60) / tempo; // 11 Ableton bars
  const want = ableton(tempo, 2, [0], [0.5, 1, 1.5], [[0, 'intro'], [2, 2], [4, 1], [5, 2], [6, 3], [7, 4], [36, 'verse'], [37, 2], [38, 3], [39, 4]], seconds);
  // In Ableton the song proper starts at beat 8 and the verse at beat 40: bars 1 and 9 of the song.
  const got = play({ bpm: tempo, num: 4, den: 4, beatUnit: 'quarter', offset: 0 }, [{ bar: 0, name: 'Intro' }, { bar: 8, name: 'Verse' }], seconds);
  same(got.click, want.click, 'click');
  same(got.voice, want.voice, 'voice');
});

test('3/4 at 45 (the 3/4 and COMMUNION scenes): click, count-in and the cue into the verse match Ableton', () => {
  const tempo = 45;
  const seconds = (33 * 60) / tempo; // 11 Ableton bars
  const want = ableton(
    tempo,
    1.5,
    [0],
    [0.5, 1],
    [[0, 'intro'], [1.5, 2], [3, 1], [3.5, 2], [4, 3], [4.5, 4], [5, 5], [5.5, 6], [24, 'verse'], [25.5, 2], [27, 1], [27.5, 2], [28, 3], [28.5, 4], [29, 5], [29.5, 6]],
    seconds
  );
  // The song starts at beat 6 and the verse at beat 30: bars 1 and 9 of the song.
  const got = play({ bpm: tempo, num: 3, den: 4, beatUnit: 'quarter', offset: 0 }, [{ bar: 0, name: 'Intro' }, { bar: 8, name: 'Verse' }], seconds);
  same(got.click, want.click, 'click');
  same(got.voice, want.voice, 'voice');
});

test('6/8 at 70 (JESUS PAID IT ALL): the tempo box means the same, and click and count-in match Ableton', () => {
  const tempo = 70;
  const seconds = (15 * 60) / tempo; // 5 Ableton bars
  const want = ableton(tempo, 3, [0], [0.5, 1, 1.5, 2, 2.5], [[3, 'intro'], [4.5, 4], [5, 5], [5.5, 6]], seconds);
  const grid = { bpm: tempo, num: 6, den: 8, beatUnit: 'quarter', offset: 0 };
  assert.ok(Math.abs(Grid.barSeconds(grid) - (3 * 60) / tempo) < 1e-12, 'a 6/8 bar is three quarter notes long');
  assert.strictEqual(Grid.beatsPerBar(grid), 6, 'and shows six beats, as Ableton does');
  const got = play(grid, [{ bar: 0, name: 'Intro' }], seconds);
  same(got.click, want.click, 'click');
  same(got.voice, want.voice, 'voice');
});

test('the tempo box counts quarter notes in every signature, as Ableton does', () => {
  const bar = (num, den, bpm) => Grid.barSeconds({ bpm, num, den, beatUnit: 'quarter', offset: 0 });
  const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-9, `${a} vs ${b}`);
  near(bar(4, 4, 120), 2);
  near(bar(3, 4, 45), 4);
  near(bar(6, 8, 70), 180 / 70);
  near(bar(12, 8, 60), 6);
  near(bar(7, 8, 140), 1.5);
  near(bar(2, 2, 100), 2.4);
  // The older settings still mean what they meant.
  near(Grid.barSeconds({ bpm: 60, num: 6, den: 8, beatUnit: 'auto', offset: 0 }), 2);
  near(Grid.barSeconds({ bpm: 120, num: 6, den: 8, beatUnit: 'den', offset: 0 }), 3);
});
