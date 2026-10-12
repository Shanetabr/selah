'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const C = require('../src/main/cuefile');
const Cues = require('../src/engine/cues');
const names = require('../src/engine/samples').names();
const has = (w) => names.has(w);

// The rack's notes by word, and a few ways of saying a cue. Times are in
// quarter notes, as in the owner's clips.
const N = Object.fromEntries(Object.entries(C.RACK).map(([pitch, word]) => [word, Number(pitch)]));
const say = (q, ...words) => words.map((w, i) => ({ q: q + i, pitch: N[w] }));
const two = (q, name) => [{ q, pitch: N[name] }, { q: q + 2, pitch: N['2'] }, ...say(q + 4, '1', '2', '3', '4')]; // "Intro . 2 . | 1 2 3 4"
const one = (q, name) => say(q, name, '2', '3', '4'); // "Verse 2 3 4"
const draft = (notes, end) => C.convert(C.parseMidi(C.encode(notes, end)), has);
const show = (d) => d.sections.map((s) => `${s.name}@${s.bar}+${s.len}${s.cue ? ':' + (typeof s.cue === 'object' ? s.cue.n + s.cue.unit : s.cue) : ''}`).join(' ');

// What Selah's guide then says, sections and callouts, as "word@quarter" from
// the first section's start.
function spoken(d) {
  const g = { bpm: 60, num: d.num, den: d.den, offset: 0, beatUnit: 'quarter' };
  const cfg = { enabled: true, start: 'auto', section: 'auto', speed: d.speed || undefined };
  return Cues.plan(g, d.sections, cfg, has)
    .filter((e) => e.word)
    .concat(Cues.callouts(g, d.callouts, cfg, has))
    .map((e) => `${e.word}@${Math.round(e.sec * 100) / 100}`);
}
const calls = (d) => d.callouts.map((c) => `${c.word}@${c.bar}`).join(' ');
const clip = (notes, t0) => notes.map((n) => `${Cues.normalize(C.RACK[n.pitch])}@${n.q - t0}`);

test('a MIDI file survives being written and read back', () => {
  const notes = [{ q: 0, pitch: 48 }, { q: 2.5, pitch: 45 }, { q: 300.25, pitch: 127 }];
  const m = C.parseMidi(C.encode(notes, 320));
  assert.deepStrictEqual(m.notes, notes);
  assert.strictEqual(m.end, 320);
  assert.throws(() => C.parseMidi(Buffer.from('RIFF....WAVEfmt ')), /Not a MIDI file/);
});

test('the name and the tempo come from the file name', () => {
  assert.deepStrictEqual(C.fromName('/x/BE PRAISED - CUE 67.mid'), { name: 'Be Praised', bpm: 67 });
  assert.deepStrictEqual(C.fromName('GRATITUDE 78 - CUE.mid'), { name: 'Gratitude', bpm: 78 });
  assert.deepStrictEqual(C.fromName('WE PRAISE YOU - CUE 85.5.mid'), { name: 'We Praise You', bpm: 85.5 });
  // "127/2" in Finder is "127:2" on disk.
  assert.deepStrictEqual(C.fromName('PRAISE - CUE 127:2.mid'), { name: 'Praise', bpm: 63.5 });
  assert.deepStrictEqual(C.fromName('WHO ELSE 68 .MID'), { name: 'Who Else', bpm: 68 });
  assert.deepStrictEqual(C.fromName('I SPEAK Jesus.midi'), { name: 'I Speak Jesus', bpm: null });
});

test('counted cues become sections, with the count-in that says the same words', () => {
  const notes = [...two(0, 'Intro'), ...one(20, 'Verse'), ...two(40, 'Chorus'), ...one(60, 'Bridge')];
  const d = draft(notes, 96);
  // Bar 0 is where the intro starts; its count-in is the song's own.
  assert.strictEqual(show(d), 'Intro@0+4 Verse@4+6 Chorus@10+4:two Bridge@14+8');
  assert.deepStrictEqual([d.num, d.den, d.speed, d.bars, d.callouts, d.left, d.older], [4, 4, null, 22, [], [], false]);
  assert.deepStrictEqual(spoken(d).sort(), clip(notes, 8).sort());
});

test('counting to six is a bar of three quarter notes, counted in eighths', () => {
  const six = (q) => ['1', '2', '3', '4', '5', '6'].map((w, i) => ({ q: q + i / 2, pitch: N[w] }));
  const notes = [{ q: 0, pitch: N.Intro }, { q: 1.5, pitch: N['2'] }, ...six(3), { q: 24, pitch: N.Verse }, { q: 25.5, pitch: N['2'] }, ...six(27)];
  const d = draft(notes, 60);
  assert.deepStrictEqual([d.num, d.den, d.speed], [3, 4, null]);
  assert.strictEqual(show(d), 'Intro@0+8 Verse@8+10');
  assert.deepStrictEqual(spoken(d).sort(), clip(notes, 6).sort());
});

test('a count on eighth notes is the guide at double speed', () => {
  const fast = (q, name) => [{ q, pitch: N[name] }, { q: q + 1, pitch: N['2'] }, ...['1', '2', '3', '4'].map((w, i) => ({ q: q + 2 + i / 2, pitch: N[w] }))];
  const notes = [...fast(0, 'Intro'), ...fast(16, 'Verse'), { q: 34, pitch: N.Chorus }, { q: 34.5, pitch: N['2'] }, { q: 35, pitch: N['3'] }, { q: 35.5, pitch: N['4'] }];
  const d = draft(notes, 60);
  assert.strictEqual(d.speed, 'double');
  assert.strictEqual(show(d), 'Intro@0+4 Verse@4+4:two Chorus@8+8');
  assert.deepStrictEqual(spoken(d).sort(), clip(notes, 4).sort());
});

test('words on their own: a section name on a bar line starts a section, the rest are callouts', () => {
  const notes = [
    ...two(0, 'Intro'),
    ...one(20, 'Verse'),
    { q: 30, pitch: N['All In'] }, // a direction to the band
    { q: 40, pitch: N.Bridge }, // the bridge, announced on its downbeat
    { q: 54, pitch: N.Tag }, // a tag is a section wherever it is, and silent
    { q: 62, pitch: N.Breakdown }, // mid-bar
    ...say(68, '1', '2', '3', '4'), // a count into nothing named
    { q: 76, pitch: N['3'] }, // a stray number
    { q: 76.5, pitch: N['4'] },
  ];
  const d = draft(notes, 80);
  // The bridge is said alone, a beat ahead.
  assert.strictEqual(show(d), 'Intro@0+4 Verse@4+4 Bridge@8+3.5:1beats Tag@11.5+8');
  // The whole bar of count is one callout on the bar line it leads to.
  assert.strictEqual(calls(d), 'All In@5.5 Breakdown@13.5 count@16 3@17 4@17.125');
  assert.deepStrictEqual(d.left, []);
  const said = spoken(d);
  assert.ok(said.includes('bridge@31') && said.includes('all in@22') && said.includes('1@60') && said.includes('4@63') && !said.some((w) => w.startsWith('tag')));
});

test('a name said inside a count belongs to that count', () => {
  // "Bridge, All In, 2, 1 2 3 4" counts into a bridge; "Breakdown, Interlude 1 2 3 4" into an interlude.
  const notes = [...two(0, 'Intro'), { q: 24, pitch: N.Bridge }, { q: 25, pitch: N['All In'] }, { q: 26, pitch: N['2'] }, ...say(28, '1', '2', '3', '4'), { q: 42, pitch: N.Breakdown }, ...say(43, 'Interlude', '1', '2', '3', '4')];
  const d = draft(notes, 64);
  assert.strictEqual(show(d), 'Intro@0+6 Bridge@6+4:two Interlude@10+8:5beats');
  assert.strictEqual(calls(d), 'All In@4.25 Breakdown@8.5');
  // With the callouts, every word of the clip is said at the same moment.
  assert.deepStrictEqual(spoken(d).sort(), clip(notes, 8).sort());
});

test('a breakdown is only ever a callout, and a count the clip gave it is dropped', () => {
  const notes = [
    ...two(0, 'Intro'),
    ...one(20, 'Verse'),
    ...one(36, 'Breakdown'), // "Breakdown 2 3 4"
    ...one(44, 'Chorus'),
    ...two(56, 'Breakdown'), // "Breakdown . 2 . 1 2 3 4"
    { q: 72, pitch: N.Breakdown }, // alone on a bar line
    ...one(76, 'Bridge'),
  ];
  const d = draft(notes, 100);
  assert.strictEqual(show(d), 'Intro@0+4 Verse@4+6 Chorus@10+8 Bridge@18+8');
  assert.strictEqual(calls(d), 'Breakdown@7 Breakdown@12 Breakdown@16');
  // The word is said where the clip said it; the numbers after it are gone.
  const said = spoken(d);
  assert.deepStrictEqual(said.filter((w) => w.startsWith('breakdown')), ['breakdown@28', 'breakdown@48', 'breakdown@64']);
  assert.ok(!said.includes('2@29') && !said.includes('1@52') && !said.includes('4@55'));
});

test('a half bar in the song puts the sections after it mid-bar', () => {
  const d = draft([...two(0, 'Intro'), ...one(20, 'Verse'), ...one(30, 'Chorus')], 60);
  assert.strictEqual(show(d), 'Intro@0+4 Verse@4+2.5 Chorus@6.5+8');
});

test('a clip that only uses the old rack is read with the old words', () => {
  // Notes 42, 43 and 51 were Interlude, Build and Bridge on the rack that had only 40 to 51.
  const old = (q, pitch) => [{ q, pitch }, { q: q + 1, pitch: 45 }, { q: q + 2, pitch: 46 }, { q: q + 3, pitch: 47 }];
  const notes = [...two(0, 'Intro'), ...old(20, 42), ...old(36, 51), ...old(52, 43)];
  const d = draft(notes, 80);
  assert.deepStrictEqual([d.sections.map((s) => s.name).join(), d.older], ['Intro,Interlude,Bridge,Build', true]);
  // One note outside 40 to 51 and it is today's rack.
  const now = draft([...notes, { q: 70, pitch: N.Tag }], 80);
  assert.deepStrictEqual([now.sections.map((s) => s.name).join(), now.older], ['Intro,Pre Chorus,Interlude,Outro,Tag', false]);
});

test('reading a file gives a whole draft, and a file with no cue words says so', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'selah-cue-'));
  const file = path.join(dir, 'MY SONG - CUE 72.mid');
  fs.writeFileSync(file, C.encode([...two(0, 'Intro'), ...one(20, 'Verse')], 40));
  const d = C.read(file, has);
  assert.deepStrictEqual([d.name, d.bpm, d.sections.length], ['My Song', 72, 2]);
  fs.writeFileSync(file, C.encode([{ q: 0, pitch: 60 }, { q: 1, pitch: 62 }], 4));
  assert.throws(() => C.read(file, has), /No cue words/);
  fs.rmSync(dir, { recursive: true, force: true });
  assert.ok(C.isCueFile('a/b/Song.MID') && C.isCueFile('x.midi') && !C.isCueFile('x.wav') && !C.isCueFile('a/._Song.mid'));
});
