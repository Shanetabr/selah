'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Chart = require('../src/shared/chart');
const ChartFile = require('../src/main/chartfile');
const Cues = require('../src/engine/cues');

function draft() {
  return { name: 'Test', bpm: 64, num: 4, den: 4, offset: 0.25, key: 'G', warnings: [], sections: [
    { id: 'v', name: 'Verse', len: 8, callouts: [{ id: 'build', word: 'Build', at: 6, enabled: true }] },
    { id: 'c', name: 'Chorus', len: 4, callouts: [{ id: 'hold', word: 'Hold', at: 2, enabled: false }] },
  ] };
}

test('reordering and repeating sections carry approved directions with their section', () => {
  const d = draft();
  const repeat = Chart.duplicate(d, 'v', 'v2');
  repeat.len = 6;
  repeat.callouts[0].at = 4;
  d.sections.unshift(d.sections.pop());
  const s = Chart.setup(d);
  assert.deepEqual(s.sections.map((s) => [s.name, s.bar, s.len]), [['Chorus', 0, 4], ['Verse', 4, 8], ['Verse', 12, 6]]);
  assert.deepEqual(s.callouts.map((c) => [c.word, c.bar]), [['Build', 10], ['Build', 16]]);
  assert.notEqual(s.callouts[0].id, s.callouts[1].id);
  assert.equal(s.bars, 18);
  assert.equal(d.sections[1].callouts[0].at, 6);
});

test('approval blocks unresolved chart notes, invalid lengths, and directions past section end', () => {
  const d = draft();
  d.warnings.push({ text: 'Repeat as desired', reviewed: false });
  assert.throws(() => Chart.setup(d), /chart notes/);
  d.warnings[0].reviewed = true;
  d.sections[0].len = 4;
  assert.throws(() => Chart.setup(d), /inside its section/);
  d.sections[0].callouts[0].enabled = false;
  assert.equal(Chart.validate(d), null);
  d.sections[0].len = NaN;
  assert.match(Chart.validate(d), /length/);
  assert.equal(Chart.layout(d)[0].len, 1, 'invalid edits remain safe to display and repair');
  d.sections = [];
  assert.match(Chart.validate(d), /at least one section/);
});

test('a separate repeat keeps its bars and directions but suppresses its spoken guide', () => {
  const d = draft();
  const repeated = Chart.duplicate(d, 'v', 'v2');
  const setup = Chart.setup(d);
  const cfg = { enabled: true, start: 'auto', section: 'auto' };
  const guide = Cues.plan(setup, setup.sections, cfg, () => true);
  assert.equal(setup.sections[1].cue, 'off');
  assert.ok(guide.some((e) => e.bar === 0), 'original count-in stays');
  assert.ok(!guide.some((e) => e.bar === 8), 'repeat has no name or count');
  assert.ok(guide.some((e) => e.bar === 16), 'next section still announced');
  assert.equal(Cues.silent(setup.sections[1]), true, 'jump guide respects the override');
  assert.equal(setup.bars, 20);
  assert.deepEqual(setup.callouts.map((c) => c.bar), [6, 14]);
  delete repeated.cue;
  const restored = Chart.setup(d);
  assert.ok(Cues.plan(restored, restored.sections, cfg, () => true).some((e) => e.bar === 8));
});

test('merging matching neighbours keeps total timing, first cue and all direction positions', () => {
  const d = draft();
  d.sections[0].cue = 'two';
  Chart.duplicate(d, 'v', 'v2');
  const before = Chart.setup(d);
  assert.equal(Chart.canMerge(d, 'v'), false);
  assert.equal(Chart.canMerge(d, 'c'), false);
  assert.equal(Chart.mergePrevious(d, 'c'), null);
  assert.equal(Chart.mergePrevious(d, 'v2').id, 'v');
  const after = Chart.setup(d);
  assert.equal(after.bars, before.bars);
  assert.equal(after.sections[0].len, 16);
  assert.equal(after.sections[0].cue, 'two');
  assert.deepEqual(after.callouts, before.callouts);
  assert.deepEqual(after.sections[1], before.sections[2]);
  Chart.duplicate(d, 'v', 'v3');
  d.sections[0].len = 3999;
  assert.equal(Chart.canMerge(d, 'v3'), false, 'merged length must remain editable');
});

// A tiny original score fixture: four measures, printed section labels, tempo,
// and a band direction. No licensed charts are checked into the repository.
function pdfFixture(first = 'INTRO', second = 'CHORUS') {
  let commands = '0.5 w\n';
  for (const y of [500, 505, 510, 515, 520]) commands += `50 ${y} m 550 ${y} l S\n`;
  for (const x of [50, 175, 300, 425, 550]) commands += `${x} 500 m ${x} 520 l S\n`;
  const text = (x, y, size, s) => `BT /F1 ${size} Tf ${x} ${y} Td (${s}) Tj ET\n`;
  commands += text(210, 720, 20, 'Original Test Song') + text(50, 570, 12, '=64') + text(50, 550, 12, first) + text(300, 550, 12, second) + text(425, 540, 10, 'BUILD');
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Count 1 /Kids [3 0 R] >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 600 800] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${Buffer.byteLength(commands)} >>\nstream\n${commands}endstream`,
  ];
  let result = '%PDF-1.4\n', offsets = [0];
  for (const [i, object] of objects.entries()) { offsets.push(Buffer.byteLength(result)); result += `${i + 1} 0 obj\n${object}\nendobj\n`; }
  const start = Buffer.byteLength(result);
  result += `xref\n0 6\n0000000000 65535 f \n${offsets.slice(1).map((o) => String(o).padStart(10, '0') + ' 00000 n \n').join('')}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${start}\n%%EOF`;
  return result;
}

test('PDF reader maps real drawing and text positions into sections and unapproved directions', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'selah-chart-test-'));
  const file = path.join(dir, 'Original-lead-G.pdf');
  try {
    fs.writeFileSync(file, pdfFixture());
    const d = await ChartFile.read(file);
    assert.equal(d.name, 'Original Test Song');
    assert.equal(d.bpm, 64);
    assert.equal(d.key, 'G');
    assert.deepEqual(d.sections.map((s) => [s.name, s.sourceMeasure, s.len]), [['Intro', 1, 2], ['Chorus', 3, 2]]);
    assert.deepEqual(d.sections[1].callouts.map((c) => [c.word, c.at, c.enabled]), [['Build', 1, false]]);
    assert.ok(d.warnings.some((w) => /time signature/.test(w.text)));
    assert.ok(d.warnings.every((w) => !w.reviewed));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('SongSelect part labels: "VERSE 1a" is Verse 1, and "CHORUS 1b" after "CHORUS 1a" continues it', async () => {
  // Firm Foundation's chart labels its parts this way; the reader used to skip
  // them, so Verse 1 vanished and the chorus came straight after the intro.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'selah-chart-test-'));
  const file = path.join(dir, 'Parts-lead-G.pdf');
  try {
    fs.writeFileSync(file, pdfFixture('VERSE 1a', 'CHORUS 2b'));
    assert.deepEqual((await ChartFile.read(file)).sections.map((s) => [s.name, s.sourceMeasure, s.len]), [['Verse 1', 1, 2], ['Chorus 2', 3, 2]]);
    fs.writeFileSync(file, pdfFixture('CHORUS 1a', 'CHORUS 1b'));
    assert.deepEqual((await ChartFile.read(file)).sections.map((s) => [s.name, s.sourceMeasure, s.len]), [['Chorus 1', 1, 4]]);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('unreadable sheets and unsupported inputs fail with an actionable error', async () => {
  await assert.rejects(ChartFile.read('relative.pdf'), /Choose a PDF/);
  assert.throws(() => ChartFile.convert([{ number: 1, items: [], lines: [] }], 'scan.pdf'), /Scans/);
});

module.exports = { pdfFixture };
