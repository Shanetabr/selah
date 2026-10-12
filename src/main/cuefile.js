'use strict';
const fs = require('fs');
const path = require('path');
const Cues = require('../engine/cues');

// Reads a cue clip from the owner's Ableton sets and turns it into what a
// Selah song needs: tempo, meter and sections, each with the count that leads
// into it. A cue clip is a MIDI file exported from the "Count In" track: every
// note plays one spoken word of the drum rack ("Intro", "2", "1", "2", "3",
// "4"). Selah does not replay the notes. It works out where each section
// starts and which of its own count-ins says the same words, so the song can
// be edited and jumped around in like any other.
//
// A word the clip says on its own with no count ("All In", "Last Time") and a
// count with no name become callouts: the guide says them where they stand.
// `left` lists the little that cannot be kept (a word before the song starts).

// The drum rack: MIDI note -> word. An older rack had only notes 40 to 51 and
// three of them said something else.
const RACK = { 36: 'Bridge', 37: 'Build', 38: 'Last Time', 39: 'All In', 40: '5', 41: '6', 42: 'Pre Chorus', 43: 'Outro', 44: '1', 45: '2', 46: '3', 47: '4', 48: 'Intro', 49: 'Verse', 50: 'Chorus', 51: 'Interlude', 121: 'Bridge 2', 122: 'Vamp', 124: 'Hits', 125: 'Tag', 126: 'Instrumental', 127: 'Breakdown' };
const OLD_RACK = Object.assign({}, RACK, { 42: 'Interlude', 43: 'Build', 51: 'Bridge' });
const COUNTS = new Set(['1', '2', '3', '4', '5', '6']);
// Directions to the band, not parts of the song.
const DYNAMIC = new Set(['All In', 'Build', 'Last Time', 'Hits']);
// Only ever a callout, said alone (owner, 2026-10-04): never a section, and a
// count the clip gave it is dropped.
const ALONE = new Set(['Breakdown']);

function isCueFile(file) {
  return /\.midi?$/i.test(file) && !path.basename(file).startsWith('.');
}

// A Standard MIDI File as { notes: [{ q, pitch }], end, bpm }, times in
// quarter notes. All tracks are merged; only where notes start matters.
function parseMidi(buf) {
  if (buf.length < 14 || buf.toString('latin1', 0, 4) !== 'MThd') throw new Error('Not a MIDI file');
  const tracks = buf.readUInt16BE(10);
  const div = buf.readUInt16BE(12);
  if (div & 0x8000) throw new Error('MIDI files timed in frames are not supported');
  const notes = [];
  let end = 0;
  let bpm = null;
  let i = 8 + buf.readUInt32BE(4);
  for (let t = 0; t < tracks && i + 8 <= buf.length; t++) {
    const stop = i + 8 + buf.readUInt32BE(i + 4);
    if (buf.toString('latin1', i, i + 4) !== 'MTrk') {
      i = stop;
      continue;
    }
    i += 8;
    const vlq = () => {
      let v = 0;
      for (;;) {
        const c = buf[i++];
        v = v * 128 + (c & 0x7f);
        if (!(c & 0x80)) return v;
      }
    };
    let tick = 0;
    let status = 0;
    while (i < stop) {
      tick += vlq();
      if (buf[i] === 0xff) {
        const type = buf[i + 1];
        i += 2;
        const len = vlq();
        if (type === 0x51 && len === 3 && bpm === null) bpm = 60000000 / buf.readUIntBE(i, 3);
        i += len;
      } else if (buf[i] === 0xf0 || buf[i] === 0xf7) {
        i += 1;
        i += vlq();
      } else {
        if (buf[i] & 0x80) status = buf[i++];
        const kind = status & 0xf0;
        if (kind === 0x90 && buf[i + 1] > 0) notes.push({ q: tick / div, pitch: buf[i] });
        i += kind === 0xc0 || kind === 0xd0 ? 1 : 2;
      }
      if (tick / div > end) end = tick / div;
    }
    i = stop;
  }
  notes.sort((a, b) => a.q - b.q);
  return { notes, end, bpm };
}

// The reverse, for the tests and the self-test: [{ q, pitch }] as a MIDI file.
function encode(notes, end) {
  const DIV = 96;
  const ev = [];
  for (const n of notes) ev.push({ t: Math.round(n.q * DIV), bytes: [0x90, n.pitch, 100] }, { t: Math.round(n.q * DIV) + 24, bytes: [0x80, n.pitch, 0] });
  ev.sort((a, b) => a.t - b.t);
  const last = Math.max(Math.round((end || 0) * DIV), ev.length ? ev[ev.length - 1].t : 0);
  ev.push({ t: last, bytes: [0xff, 0x2f, 0x00] });
  const vlq = (v) => {
    const out = [v & 0x7f];
    while ((v >>= 7)) out.unshift((v & 0x7f) | 0x80);
    return out;
  };
  const body = [];
  let at = 0;
  for (const e of ev) {
    body.push(...vlq(e.t - at), ...e.bytes);
    at = e.t;
  }
  const head = Buffer.alloc(22);
  head.write('MThd', 0, 'latin1');
  head.writeUInt32BE(6, 4);
  head.writeUInt16BE(0, 8);
  head.writeUInt16BE(1, 10);
  head.writeUInt16BE(DIV, 12);
  head.write('MTrk', 14, 'latin1');
  head.writeUInt32BE(body.length, 18);
  return Buffer.concat([head, Buffer.from(body)]);
}

// "BE PRAISED - CUE 67.mid" -> { name: 'Be Praised', bpm: 67 }. The owner
// writes the scene's tempo into the file name; "127/2" (which the file system
// stores as "127:2") is 63.5.
function fromName(file) {
  let base = path.basename(file).replace(/\.midi?$/i, '');
  let bpm = null;
  const found = Array.from(base.matchAll(/(\d+(?:\.\d+)?)(?:\s*[:\/]\s*(\d+))?/g)).pop();
  if (found) {
    const v = parseFloat(found[1]) / (found[2] ? parseFloat(found[2]) : 1);
    if (v >= 20 && v <= 300) {
      bpm = Math.round(v * 100) / 100;
      base = base.slice(0, found.index) + ' ' + base.slice(found.index + found[0].length);
    }
  }
  const name = base
    .replace(/\b(cue|bpm)\b/gi, ' ')
    .replace(/[-_]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
    .replace(/(^|\s)\S/g, (c) => c.toUpperCase());
  return { name: name || 'Cue Clip', bpm };
}

const toEighth = (q) => Math.floor(q * 2 + 0.5) / 2;

// midi: from parseMidi. has(word): whether the guide's voice has that word.
// Returns { num, den, speed, bars, sections: [{ name, bar, len, cue? }],
// callouts: [{ bar, word }], left: [word], older }. Bar 0 is where the first
// section starts; the count-in before it becomes the song's own count-in.
function convert(midi, has) {
  const older = midi.notes.every((n) => n.pitch >= 40 && n.pitch <= 51);
  const rack = older ? OLD_RACK : RACK;
  const ev = midi.notes.filter((n) => rack[n.pitch]).map((n) => ({ q: toEighth(n.q), word: rack[n.pitch] }));
  if (!ev.some((e) => !COUNTS.has(e.word))) throw new Error('No cue words in this MIDI file');
  // Counting to six means a bar of three quarter notes, counted in eighths.
  const six = ev.some((e) => e.word === '5' || e.word === '6');
  const bar = six ? 3 : 4;

  // Phrases: a name and the counts that follow it within a bar of each other.
  const all = [];
  for (const e of ev) {
    const p = all[all.length - 1];
    if (!COUNTS.has(e.word)) all.push({ at: e.q, name: e.word, counts: [], last: e.q });
    else if (p && e.q - p.last <= bar && !(e.word === '1' && p.counts.some((c) => c.word === '1'))) {
      p.counts.push(e);
      p.last = e.q;
    } else all.push({ at: e.q, name: null, counts: [e], last: e.q });
  }
  // A breakdown goes straight to the callouts, without its count if it had one.
  const calls = []; // { q, word }: said where they stand
  const phrases = all.filter((p) => {
    if (!ALONE.has(p.name)) return true;
    calls.push({ q: p.at, word: p.name });
    return false;
  });
  // A phrase with a run of counts lands one count after its last one.
  for (const p of phrases) {
    const c = p.counts;
    p.lands = c.length >= 2 ? c[c.length - 1].q + (c[c.length - 1].q - c[c.length - 2].q) : null;
  }
  const counted = phrases.filter((p) => p.lands !== null);
  // Counts on eighth notes in a song counted to four: the guide at double
  // speed. Most of the counts have to be, so one stray pair does not decide it.
  const quick = counted.filter((p) => p.counts[p.counts.length - 1].q - p.counts[p.counts.length - 2].q === 0.5).length;
  const double = !six && quick > counted.length / 2;

  const sections = [];
  const used = new Set();
  // The bare count of one bar, "1 2 3 4" at the guide's speed, is one callout
  // on the bar line it leads to. Any other run of numbers is said as it is.
  const step = (bar / (six ? 6 : 4)) * (double ? 0.5 : 1);
  const bareCount = (p) => {
    const c = p.counts;
    const whole = c.length === (six ? 6 : 4) && c.every((x, i) => x.word === String(i + 1) && Math.abs(x.q - (p.lands - (c.length - i) * step)) < 1e-6);
    if (whole) calls.push({ q: p.lands, word: 'count' });
    else for (const x of c) calls.push(x);
  };
  const starts = (q) => sections.some((s) => Math.abs(s.q - q) < 1e-6);
  for (const p of counted) {
    let name = p.name;
    // A name said during the two bars before the landing is part of this cue:
    // "Bridge, All In, 2, 1 2 3 4" counts into a bridge.
    for (const w of phrases) {
      if (w === p || w.lands !== null || !(w.at >= p.lands - 2 * bar * (double ? 0.5 : 1) && w.at < p.lands)) continue;
      used.add(w);
      if (!w.name) continue;
      if (!DYNAMIC.has(w.name) && (!name || DYNAMIC.has(name))) {
        if (name) calls.push({ q: p.at, word: name });
        name = w.name;
      } else calls.push({ q: w.at, word: w.name });
    }
    if (!name) bareCount(p);
    else if (!starts(p.lands)) sections.push({ name, q: p.lands });
  }
  // A section name said alone on a bar line starts a section too (the bridge
  // coming round again), and so does a tag wherever it is, which the guide
  // keeps silent as the owner wants. Any other word on its own is a callout.
  const lands = sections.map((s) => s.q).sort((a, b) => a - b);
  for (const w of phrases) {
    if (w.lands !== null || used.has(w) || !w.name) continue;
    const from = lands.filter((x) => x <= w.at).pop();
    const onLine = from === undefined ? !lands.length : (w.at - from) % bar === 0;
    const tag = /^tag\b/i.test(w.name);
    if (!starts(w.at) && (tag || (!DYNAMIC.has(w.name) && onLine))) sections.push({ name: w.name, q: w.at, alone: true });
    else if (!tag) calls.push({ q: w.at, word: w.name });
  }
  if (!sections.length) throw new Error('No sections in this cue clip');
  sections.sort((a, b) => a.q - b.q);
  const t0 = sections[0].q;
  sections.forEach((s, i) => {
    const next = sections[i + 1];
    s.bar = (s.q - t0) / bar;
    s.len = next ? (next.q - s.q) / bar : Math.max(8, Math.ceil((midi.end - s.q) / bar));
  });

  // Which of Selah's count-ins says what the clip says before each section:
  // the one whose words match the clip's best, at the same moments. At 60 BPM
  // a quarter note is a second, so the clip's times can be compared directly.
  const g = { bpm: 60, num: six ? 3 : 4, den: 4, offset: 0, beatUnit: 'quarter' };
  const cfg = { enabled: true, start: 'auto', section: 'auto', speed: double ? 'double' : undefined };
  const said = ev.map((e) => ({ sec: e.q - t0, word: Cues.normalize(e.word) }));
  const score = (lo, hi) => {
    const within = (e) => e.sec >= lo - 1e-6 && e.sec < hi - 1e-6;
    const mine = Cues.plan(g, sections, cfg, has).filter((e) => e.word && within(e));
    const theirs = said.filter(within);
    const same = mine.filter((e) => theirs.some((t) => t.word === e.word && Math.abs(t.sec - e.sec) < 0.02)).length;
    // Identical words first; on a tie, the count-in that adds fewest of its own.
    return same * 2 - (mine.length - same) * 1.01 - (theirs.length - same);
  };
  sections.forEach((s, i) => {
    if (s.alone) {
      // Said alone, one beat ahead. A tag stays silent, as the owner wants.
      if (!/^tag\b/i.test(s.name)) s.cue = { n: 1, unit: 'beats' };
      return;
    }
    const t = s.bar * bar;
    const lo = i ? sections[i - 1].bar * bar : -Infinity;
    const named = said.filter((e) => e.sec < t - 1e-6 && e.sec >= lo - 1e-6 && e.word === Cues.normalize(s.name)).pop();
    const choices = [undefined, 'two', 'one', 'half'];
    if (named) choices.push({ n: Math.round((t - named.sec) * (double ? 2 : 1) * 2) / 2, unit: 'beats' });
    let best = null;
    for (const c of choices) {
      s.cue = c;
      const sc = score(lo, t + 1e-6);
      if (!best || sc > best.sc) best = { sc, c };
    }
    s.cue = best.c;
  });

  const lastOne = sections[sections.length - 1];
  return {
    num: g.num,
    den: 4,
    speed: double ? 'double' : null,
    bars: Math.ceil(lastOne.bar + lastOne.len),
    sections: sections.map((s) => Object.assign({ name: s.name, bar: s.bar, len: s.len }, s.cue ? { cue: s.cue } : null)),
    callouts: calls.filter((c) => c.q >= t0).sort((a, b) => a.q - b.q).map((c) => ({ bar: (c.q - t0) / bar, word: c.word })),
    left: calls.filter((c) => c.q < t0).map((c) => c.word),
    // Worth telling the user only when the two racks would have said different words.
    older: older && midi.notes.some((n) => n.pitch === 42 || n.pitch === 43 || n.pitch === 51),
  };
}

// A cue file as a song draft: { name, bpm (null when the file name has none),
// num, den, speed, bars, sections, left, older }.
function read(file, has) {
  const midi = parseMidi(fs.readFileSync(file));
  const named = fromName(file);
  return Object.assign({ name: named.name, bpm: named.bpm || (midi.bpm ? Math.round(midi.bpm * 100) / 100 : null) }, convert(midi, has));
}

module.exports = { isCueFile, parseMidi, encode, fromName, convert, read, RACK, OLD_RACK };
