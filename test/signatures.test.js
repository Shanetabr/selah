'use strict';
// Every time signature has to give a click that restarts on each bar line and
// cues that end on the section's bar line. These tests sweep the signatures a
// worship set can meet rather than checking one or two by hand.
const test = require('node:test');
const assert = require('node:assert');
const { Mixer } = require('../src/engine/mixer');
const Cues = require('../src/engine/cues');
const Grid = require('../src/shared/grid');

const RATE = 4000;
const SIGS = [
  [1, 4], [2, 4], [3, 4], [4, 4], [5, 4], [6, 4], [7, 4], [9, 4], [11, 4], [12, 4],
  [2, 2], [3, 2],
  [3, 8], [5, 8], [6, 8], [7, 8], [9, 8], [12, 8],
];
const grids = [];
for (const [num, den] of SIGS) {
  grids.push({ bpm: 90, num, den, beatUnit: 'quarter', offset: 0.25 });
  if (den !== 4) grids.push({ bpm: 90, num, den, beatUnit: 'auto', offset: 0.25 });
  if (den === 8 && num % 3 === 0 && num >= 6) grids.push({ bpm: 180, num, den, beatUnit: 'den', offset: 0 });
}
const label = (g, extra) => `${g.num}/${g.den} (BPM counts ${g.beatUnit === 'quarter' ? 'quarter notes' : g.beatUnit === 'den' ? 'the signature note' : 'the old way'})${extra ? ' ' + extra : ''}`;

function sounds() {
  const one = (v) => Float32Array.of(v);
  const words = new Map([['verse', one(0.5)]]);
  for (let i = 1; i <= 7; i++) words.set(String(i), one(i / 100));
  return { click: { main: one(0.8), sub: one(0.2) }, words };
}

// Click hits of bars 2 to 5 as [{ frame, main }], after rendering from the top.
function clickHits(g, click) {
  const m = new Mixer({ sampleRate: RATE, channels: 2 });
  m.setSounds(sounds());
  m.setSong({ id: 's', grid: g, bars: 8, click: Object.assign({ enabled: true, gain: 1, bus: 'cue', sound: 'ew', sub: true, main: 2 }, click), cues: { enabled: false, sections: [] }, tracks: [] });
  m.clickCur = 1;
  m.play();
  m.tGain = 1;
  const total = Grid.barToFrame(g, 6, RATE);
  const buf = new Float32Array(total * 2);
  for (let done = 0; done < total; ) {
    const n = Math.min(257, total - done);
    const part = new Float32Array(n * 2);
    m.render(part, n);
    buf.set(part, done * 2);
    done += n;
  }
  const hits = [];
  for (let i = Grid.barToFrame(g, 1, RATE); i < Grid.barToFrame(g, 5, RATE); i++) {
    if (buf[i * 2] !== 0) hits.push({ frame: i, main: Math.abs(buf[i * 2] - 0.8) < 1e-6 });
  }
  return hits;
}

test('click: every signature, feel and setting restarts on the bar line with the main sound', () => {
  for (const g of grids) {
    for (const feel of [undefined, 'half', 'double']) {
      for (const sub of [true, false]) {
        for (const main of [1, 2, 'bar']) {
          const what = label(g, `feel ${feel || 'normal'}, eighths ${sub ? 'on' : 'off'}, main ${main}`);
          const hits = clickHits(g, { feel, sub, main });
          const perBar = [];
          for (let bar = 1; bar < 5; bar++) {
            const from = Grid.barToFrame(g, bar, RATE);
            const to = Grid.barToFrame(g, bar + 1, RATE);
            const mine = hits.filter((h) => h.frame >= from && h.frame < to);
            assert.ok(mine.length >= 1, `${what}: bar ${bar + 1} has a click`);
            assert.strictEqual(mine[0].frame, from, `${what}: a click exactly on the line of bar ${bar + 1}`);
            assert.ok(mine[0].main, `${what}: and it is the main sound`);
            perBar.push(mine.map((h) => (h.main ? 'M' : 's')).join(''));
            // Evenly spaced through the bar.
            const step = (to - from) / mine.length;
            mine.forEach((h, i) => assert.ok(Math.abs(h.frame - (from + i * step)) <= 1, `${what}: pulse ${i + 1} of bar ${bar + 1} is on its spot`));
          }
          assert.ok(perBar.every((p) => p === perBar[0]), `${what}: every bar has the same pattern (${perBar.join(' | ')})`);
        }
      }
    }
  }
});

test('click: where the main sound falls by default, signature by signature', () => {
  // M = main sound, s = second sound; one bar of the default click.
  const pattern = (num, den, beatUnit) => {
    const g = { bpm: 90, num, den, beatUnit: beatUnit || 'auto', offset: 0 };
    return clickHits(g, {})
      .filter((h) => h.frame < Grid.barToFrame(g, 2, RATE))
      .map((h) => (h.main ? 'M' : 's'))
      .join('');
  };
  assert.strictEqual(pattern(4, 4), 'MsssMsss', '4/4: twice a bar, as in the Ableton sets');
  assert.strictEqual(pattern(3, 4), 'MssMss', '3/4: two groups of three eighths, as in the Ableton 3/4 sets');
  assert.strictEqual(pattern(2, 4), 'MsMs', '2/4: every beat, as in the Ableton 2/4 set');
  assert.strictEqual(pattern(6, 8), 'Msssss', '6/8: once a bar, as in the Ableton 6/8 sets');
  assert.strictEqual(pattern(6, 8, 'den'), 'Msssss', '6/8 with an eighth-note beat is the same click');
  assert.strictEqual(pattern(6, 8, 'quarter'), 'Msssss', 'and so is 6/8 with the tempo in quarter notes');
  assert.strictEqual(pattern(2, 2, 'quarter'), 'MsssMsss', '2/2 in quarter-note tempo ticks eighths, like 4/4');
  // "Eighth notes: off" leaves the meter's own beats, however the tempo is written.
  const beatsOnly = (num, den, beatUnit) => {
    const g = { bpm: 90, num, den, beatUnit, offset: 0 };
    return clickHits(g, { sub: false })
      .filter((h) => h.frame < Grid.barToFrame(g, 2, RATE))
      .map((h) => (h.main ? 'M' : 's'))
      .join('');
  };
  assert.strictEqual(beatsOnly(6, 8, 'quarter'), 'Ms', '6/8: two dotted-quarter beats');
  assert.strictEqual(beatsOnly(6, 8, 'auto'), 'Ms');
  assert.strictEqual(beatsOnly(6, 8, 'den'), 'Ms');
  assert.strictEqual(beatsOnly(4, 4, 'quarter'), 'MsMs');
  assert.strictEqual(beatsOnly(3, 4, 'quarter'), 'Mss', '3/4: ONE two three');
  assert.strictEqual(pattern(12, 8), 'MsssssMsssss');
  assert.strictEqual(pattern(9, 8), 'Mssssssss', '9/8 cannot be halved: once a bar');
  assert.strictEqual(pattern(5, 4), 'MssssMssss');
  assert.strictEqual(pattern(7, 8), 'Mssssss');
});

test('cues: in every signature the count ends one count before the bar line and never passes 7', () => {
  const has = (w) => w === 'verse' || /^[1-7]$/.test(w);
  for (const g of grids) {
    const u = Cues.units(g);
    assert.ok(u.n >= 1 && u.n <= 7, `${label(g)}: ${u.n} counts to the bar`);
    const barSec = Grid.barSeconds(g);
    for (const speed of [undefined, 'half', 'double']) {
      const k = speed === 'half' ? 2 : speed === 'double' ? 0.5 : 1;
      const unit = (barSec / u.n) * k;
      for (const style of ['two', 'one', 'half', { n: 1, unit: 'beats' }, { n: 3, unit: 'bars' }]) {
        const what = label(g, `speed ${speed || 'original'}, lead ${typeof style === 'string' ? style : style.n + ' ' + style.unit}`);
        const line = Grid.barToSeconds(g, 40);
        const plan = Cues.plan(g, [{ bar: 0, name: 'x', cue: 'off' }, { bar: 40, name: 'Verse', cue: style }], { enabled: true, speed, start: 'off', section: 'off' }, has);
        assert.ok(plan.length >= 1, `${what}: something is said`);
        assert.strictEqual(plan[0].word, 'verse', `${what}: the name comes first`);
        for (const e of plan) assert.ok(e.sec < line - 1e-9, `${what}: nothing on or after the bar line`);
        const times = plan.map((e) => e.sec.toFixed(6));
        assert.strictEqual(new Set(times).size, times.length, `${what}: no two words at once`);
        // Every word sits on a whole number of counts before the line.
        for (const e of plan) {
          const counts = (line - e.sec) / unit;
          assert.ok(Math.abs(counts - Math.round(counts)) < 1e-6, `${what}: "${e.word}" is ${counts} counts before the line`);
        }
        // When there are counts after the name, the last one is the bar's last count, one count before the line.
        const last = plan[plan.length - 1];
        if (plan.length > 1 && last.word !== 'verse') {
          assert.ok(Math.abs(line - last.sec - unit) < 1e-6, `${what}: the last count is one count before the line`);
          assert.strictEqual(last.word, String(u.n), `${what}: and it is "${u.n}"`);
        }
      }
    }
  }
});

test('cues: 3/4 is counted in six, like the Ableton 3/4 sets', () => {
  const has = (w) => w === 'verse' || /^[1-7]$/.test(w);
  const g = { bpm: 60, num: 3, den: 4, beatUnit: 'auto', offset: 0 }; // a bar is 3 s, an eighth 0.5 s
  const say = (style) => Cues.plan(g, [{ bar: 0, name: 'x', cue: 'off' }, { bar: 4, name: 'Verse', cue: style }], { enabled: true, start: 'off', section: 'off' }, has).map((e) => `${e.sec}:${e.word}`).join(' ');
  assert.strictEqual(say('two'), '6:verse 7.5:2 9:1 9.5:2 10:3 10.5:4 11:5 11.5:6');
  assert.strictEqual(say('one'), '9:verse 10.5:4 11:5 11.5:6');
  assert.strictEqual(say('half'), '10.5:verse');
});
