'use strict';
const Grid = require('../shared/grid');

// Decides which spoken cue plays when: the section name and a count before
// each section marker. Pure functions of the tempo grid and the markers, so
// cues move with the markers and stay right when the tempo is corrected.
//
// Words are keys into the voice sample set: a section name ("verse 2") or a
// number ("1" to "7"). `has(word)` says whether the voice has that sample.

const MAX_COUNT = 7; // the voice has spoken numbers 1 to 7

function normalize(name) {
  return String(name || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

const SHORT = [
  [/^pc ?(\d*)$/, 'pre chorus'],
  [/^pre ?chorus ?(\d*)$/, 'pre chorus'],
  [/^v ?(\d*)$/, 'verse'],
  [/^c ?(\d*)$/, 'chorus'],
  [/^b ?(\d*)$/, 'bridge'],
  [/^inst ?(\d*)$/, 'instrumental'],
  [/^end ?(\d*)$/, 'ending'],
  [/^turn ?(\d*)$/, 'turnaround'],
];

// The voice sample for a section name, or null. "Verse 7" falls back to
// "Verse" when there is no numbered sample; "V2" and "Pre-Chorus" are understood.
function word(name, has) {
  let w = normalize(name);
  if (!w) return null;
  for (const [re, full] of SHORT) {
    const m = re.exec(w);
    if (m) {
      w = full + (m[1] ? ' ' + m[1] : '');
      break;
    }
  }
  if (has(w)) return w;
  const base = w.replace(/ \d+$/, '');
  return base !== w && has(base) ? base : null;
}

// How a bar is counted. `n` counts per bar; the name takes `block` counts to
// say; `half` is the count the second half of the bar starts on (0-based).
// 4/4 counts four beats. 6/8 counts six eighths, with the name over three.
// 3/4 is counted like the owner's Ableton 3/4 sets: six eighths as well,
// "1 2 3 4 5 6", in two groups of three. Other meters count their beats.
// The voice only counts to 7, so a bar with more beats than that is counted
// in bigger steps: 9/8 and 12/8 by their dotted beats, anything else by the
// largest number of equal parts up to 7 that the bar divides into.
function units(g) {
  let beats = Math.max(1, Math.round(Grid.beatsPerBar(g)));
  if (Grid.isCompound(g)) {
    if (g.num <= MAX_COUNT) return { n: g.num, block: 3, half: Math.ceil(g.num / 6) * 3 };
    beats = g.num / 3;
  }
  if (g.num === 3 && g.den === 4) return { n: 6, block: 3, half: 3 };
  if (beats > MAX_COUNT) {
    let parts = MAX_COUNT;
    while (beats % parts !== 0) parts--;
    beats = parts;
  }
  return { n: beats, block: 1, half: Math.ceil(beats / 2) };
}

// One section's cue as [{ off, word }], `off` in counts relative to the
// section's bar line (negative: before it). With no sample for the name, the
// count takes its place.
//   two:  "Intro . 2 . | 1 2 3 4"   time to set up before a song starts
//   one:  "Verse 2 3 4"             the bar before the section
//   half: ". . Verse 4"             the half bar before the section
function sectionCue(u, style, name, has) {
  const ev = [];
  const count = (i) => (i < MAX_COUNT && has(String(i + 1)) ? String(i + 1) : null);
  const add = (off, w) => {
    if (w) ev.push({ off, word: w });
  };
  // A bar counted as a single count has no half: its slow bar is just the
  // name, and its half-bar cue is the whole bar.
  const half = u.half < u.n ? u.half : 0;
  if (style === 'two') {
    add(-2 * u.n, name || count(0));
    if (half) add(-2 * u.n + half, count(1));
    for (let i = 0; i < u.n; i++) add(-u.n + i, count(i));
  } else if (style === 'one' || style === 'pickup') {
    // 'pickup' is the count-in of the owner's Ableton 6/8 sets: a bar of
    // click on its own, then the one-bar cue. The silent event marks where
    // that first bar starts.
    if (style === 'pickup') ev.push({ off: -2 * u.n, word: null });
    add(-u.n, name || count(0));
    for (let i = name ? u.block : 1; i < u.n; i++) add(-u.n + i, count(i));
  } else if (style === 'half') {
    add(-u.n + half, name || count(half));
    for (let i = half + (name ? u.block : 1); i < u.n; i++) add(-u.n + i, count(i));
  }
  return ev;
}

// A lead typed in by the user, { n, unit: 'bars' | 'beats' }, in counts.
function leadCounts(lead, u, g) {
  const n = lead && typeof lead === 'object' ? Number(lead.n) : 0;
  if (!(n > 0)) return 0;
  // A beat here is the meter's own: a dotted quarter in 6/8, whatever the BPM counts.
  const beats = Grid.isCompound(g) ? g.num / 3 : Math.max(1, Math.round(Grid.beatsPerBar(g)));
  const per = lead.unit === 'beats' ? u.n / beats : u.n;
  return Math.max(1, Math.round(n * per));
}

// The cue for a typed-in lead of L counts: the name first, then the count up
// to the bar line, numbered by its place in the bar. Two bars or more end
// with the same slow bar and full count as `two`. The three named styles
// above never come through here.
function customCue(u, L, name, has) {
  const ev = [];
  const count = (i) => (i < MAX_COUNT && has(String(i + 1)) ? String(i + 1) : null);
  const add = (off, w) => {
    if (w) ev.push({ off, word: w });
  };
  const inBar = (off) => ((off % u.n) + u.n) % u.n;
  if (L >= 2 * u.n) {
    if (name) add(-L, name);
    if (!name || L >= 2 * u.n + u.block) add(-2 * u.n, count(0));
    if (u.half < u.n) add(-2 * u.n + u.half, count(1));
    for (let i = 0; i < u.n; i++) add(-u.n + i, count(i));
  } else if (L > 0) {
    add(-L, name || count(inBar(-L)));
    for (let off = -L + (name ? u.block : 1); off < 0; off++) add(off, count(inBar(off)));
  }
  return ev;
}

// The cue setting that applies to a section: its own, or the song's for the
// first section or for the others. A named style, a typed-in lead, 'auto' or
// 'off'.
function styleFor(cfg, s, first) {
  return s.cue || (first ? cfg.start : cfg.section) || 'off';
}

// A tag is not announced: the owner does not want a name or a count for one.
function isTag(name) {
  return /^tag\b/.test(normalize(name));
}

// A section that says nothing of its own: its guide was switched off, or it
// is a tag left on automatic. A pad tap is not counted into one either.
function silent(s) {
  return s.cue ? isOff(s.cue) : isTag(s.name);
}

// 'auto' is "as the owner's Ableton sets do it", which depends on the meter:
//   song start   two bars, "Intro . 2 . | 1 2 3 4"; in 6/8 a bar of click,
//                then "Intro . . 4 5 6"
//   sections     one bar, "Verse 2 3 4"; in 3/4 the same two bars as the start
//   a tag        nothing
function resolve(style, g, first, name) {
  if (style !== 'auto') return style;
  if (isTag(name)) return 'off';
  if (first) return Grid.isCompound(g) ? 'pickup' : 'two';
  return g.num === 3 && g.den === 4 ? 'two' : 'one';
}

function isOff(style) {
  return typeof style === 'object' ? !(Number(style.n) > 0) : !(style === 'auto' || style === 'two' || style === 'one' || style === 'half' || style === 'pickup');
}

function cueFor(u, g, style, name, has) {
  return typeof style === 'object' ? customCue(u, leadCounts(style, u, g), name, has) : sectionCue(u, style, name, has);
}

// Cue speed: how long one count lasts against the song. Original is the
// song's own count. Half-time and double-time stretch or squeeze the whole
// cue around the section's bar line, where it always ends; nothing else
// about a cue depends on the speed.
const SPEED = { half: 2, double: 0.5 };

// `scale` is the song's own multiplier on top of the speed: 2 for a song
// whose bars are written at double tempo ("2x bars"), so that it is counted
// at the tempo the owner typed.
function countSeconds(g, u, speed, scale) {
  return (Grid.barSeconds(g) / u.n) * (SPEED[speed] || 1) * (scale > 0 ? scale : 1);
}

// Every cue of a song as [{ sec, word, bar }] in time order; `bar` is the
// section the cue announces.
// cfg: { enabled, speed, scale, start, section }: the style for the first
// section and for the others. A section's own `cue` overrides it. The first section's
// cue may start before time 0; the mixer plays that part as a count-in.
function plan(g, sections, cfg, has) {
  const out = [];
  if (!cfg || !cfg.enabled) return out;
  const u = units(g);
  const unitSec = countSeconds(g, u, cfg.speed, cfg.scale);
  const sorted = sections.slice().sort((a, b) => a.bar - b.bar);
  sorted.forEach((s, i) => {
    let style = resolve(styleFor(cfg, s, i === 0), g, i === 0, s.name);
    if (i > 0) {
      if (style === 'two' && Grid.barToSeconds(g, s.bar - 2) < -1e-6) style = 'one';
      if (Grid.barToSeconds(g, s.bar - 1) < -1e-6) return;
    }
    const t0 = Grid.barToSeconds(g, s.bar);
    const name = word(s.name, has);
    let ev = cueFor(u, g, style, name, has);
    // Only the first section may start before the song does. A slowed or
    // typed-in cue that would is cut to one bar of count, or left out.
    const early = () => i > 0 && ev.length > 0 && t0 + ev[0].off * unitSec < -1e-6;
    if (early()) ev = sectionCue(u, 'one', name, has);
    if (early()) return;
    for (const e of ev) out.push({ sec: t0 + e.off * unitSec, word: e.word, bar: s.bar });
  });
  return out.sort((a, b) => a.sec - b.sec);
}

// Callouts: words said at a point of the song that are not a section, the
// directions in the owner's Ableton clips ("All In", "Last Time"). They are
// separate from the section cues above and never change them.
// list: [{ bar, word }] -> [{ sec, word }]. A callout is said at `bar` itself.
// The word "count" is the bare count of one bar, "1 2 3 4", ending on the bar
// line at `bar`, at the song's cue speed. A word the voice does not have, and
// anything before the song starts, is left out.
function callouts(g, list, cfg, has) {
  const out = [];
  if (!cfg || !cfg.enabled) return out;
  const u = units(g);
  const unitSec = countSeconds(g, u, cfg.speed, cfg.scale);
  for (const c of list || []) {
    const t = Grid.barToSeconds(g, c.bar);
    if (normalize(c.word) === 'count') {
      for (let i = 0; i < u.n && i < MAX_COUNT; i++) if (has(String(i + 1))) out.push({ sec: t - (u.n - i) * unitSec, word: String(i + 1) });
    } else {
      const w = word(c.word, has);
      if (w) out.push({ sec: t, word: w });
    }
  }
  return out.filter((e) => e.sec > -1e-6).sort((a, b) => a.sec - b.sec);
}

// The cue for a jump tapped at `nowSec` that lands on the bar line at `atSec`:
// the name on the next count, then whatever counts are left in the bar. With
// no count left, the name is said straight away.
function jumpPlan(g, nowSec, atSec, name, has, speed, scale) {
  const u = units(g);
  const unitSec = countSeconds(g, u, speed, scale);
  const w = word(name, has);
  const left = Math.floor((atSec - nowSec) / unitSec + 1e-6);
  const first = Math.max(0, u.n - left);
  if (first >= u.n) return w ? [{ sec: nowSec, word: w }] : [];
  const ev = [];
  const count = (i) => (i < MAX_COUNT && has(String(i + 1)) ? String(i + 1) : null);
  const add = (i, x) => {
    if (x) ev.push({ sec: atSec - (u.n - i) * unitSec, word: x });
  };
  add(first, w || count(first));
  for (let i = first + (w ? u.block : 1); i < u.n; i++) add(i, count(i));
  return ev;
}

// A counted jump: the owner's "panic" tap. The jump is announced with a full
// one-bar cue, "Chorus 2 3 4", so it has to land on a bar line at least
// `lead` seconds away. Returns { lead, events(atSec) }.
function countedJump(g, name, has, speed, scale) {
  const u = units(g);
  const unitSec = countSeconds(g, u, speed, scale);
  const cue = sectionCue(u, 'one', word(name, has), has);
  return { lead: u.n * unitSec, events: (atSec) => cue.map((e) => ({ sec: atSec + e.off * unitSec, word: e.word })) };
}

module.exports = { normalize, word, units, styleFor, isOff, silent, plan, callouts, jumpPlan, countedJump, MAX_COUNT };
