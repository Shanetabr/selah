// Reads a recorded click stem: where every tick falls, and from that the
// tempo, where bar 1 is and, when the accents say so, the time signature.
// A click is the cleanest thing in a song to measure: short hits with nothing
// between them. What it cannot say by itself is which tick is "the beat"
// (ticks at 254 a minute are eighth notes at 127 or quarters at 254), so the
// tempo is taken in the usual range and a number from a file name decides.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.ClickTrack = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const MIN_BPM = 70; // the tempo is taken in [MIN_BPM, 2 * MIN_BPM)
  const GAP = 0.04; // seconds of quiet that separate two ticks
  const LOOK = 0.02; // seconds of a tick that are measured

  // samples: Int16Array or Float32Array, interleaved when channels > 1.
  // Every tick as { t (seconds), p (peak, 0 to 1 of the loudest), hz (how fast it wiggles) }.
  function ticks(samples, channels, rate) {
    const frames = Math.floor(samples.length / channels);
    const at = (i) => {
      let s = 0;
      for (let c = 0; c < channels; c++) s += samples[i * channels + c];
      return s / channels;
    };
    let peak = 0;
    for (let i = 0; i < frames; i++) {
      const a = Math.abs(at(i));
      if (a > peak) peak = a;
    }
    if (peak <= 0) return [];
    const th = peak * 0.1;
    const quiet = Math.round(rate * GAP);
    const look = Math.round(rate * LOOK);
    const out = [];
    let last = -quiet;
    for (let i = 0; i < frames; i++) {
      const v = at(i);
      if (Math.abs(v) < th) continue;
      if (i - last >= quiet) {
        let p = 0;
        let zc = 0;
        let prev = v;
        const end = Math.min(frames, i + look);
        for (let j = i; j < end; j++) {
          const w = at(j);
          if (Math.abs(w) > p) p = Math.abs(w);
          if (w >= 0 !== prev >= 0) zc++;
          prev = w;
        }
        out.push({ t: i / rate, p: p / peak, hz: zc / 2 / LOOK });
      }
      last = i;
    }
    return out;
  }

  const median = (list) => list.slice().sort((a, b) => a - b)[list.length >> 1];

  // Which ticks are the accented ones, or null when they all sound alike:
  // the louder ones, or failing that the higher ones.
  function accents(list) {
    for (const key of ['p', 'hz']) {
      const v = list.map((x) => x[key]);
      const lo = Math.min(...v);
      const hi = Math.max(...v);
      if (hi - lo < hi * 0.12) continue;
      const mid = (lo + hi) / 2;
      const marks = v.map((x) => x > mid);
      const n = marks.filter(Boolean).length;
      if (n >= 2 && n <= list.length * 0.75) return marks;
    }
    return null;
  }

  // The usual number of ticks from one accent to the next.
  function accentEvery(marks) {
    const counts = new Map();
    let last = -1;
    marks.forEach((m, i) => {
      if (!m) return;
      if (last >= 0) counts.set(i - last, (counts.get(i - last) || 0) + 1);
      last = i;
    });
    let best = 0;
    for (const [gap, n] of counts) if (n > (counts.get(best) || 0)) best = gap;
    return best;
  }

  // `hint`: a tempo read from a file name, or nothing.
  // Returns null when the audio is not a click, else
  // { bpm, offset, num, den, perMinute, count, steady, changes, signature }:
  // `steady` is false when the tempo changes (`changes`: the seconds where),
  // `signature` is 'heard' when the accents gave it and 'assumed' when not.
  function analyze(samples, channels, rate, hint) {
    const list = ticks(samples, channels, rate);
    if (list.length < 8) return null;
    const gaps = list.slice(1).map((x, i) => x.t - list[i].t);
    const tick = median(gaps);
    // A gap is in time when it is as long as the tick so far, or a whole
    // number of them (a rest in the click). One that is not starts a new
    // tempo, which the following gaps are then measured against.
    const changes = [];
    let now = gaps[0];
    let wild = 0;
    gaps.forEach((g, i) => {
      const n = Math.max(1, Math.round(g / now));
      if (Math.abs(g / now - n) <= 0.04 * n) return;
      // Two changes in a row are not a tempo, they are not a click.
      if (changes.length && changes[changes.length - 1].i === i - 1) wild++;
      changes.push({ i, t: list[i + 1].t });
      now = g;
    });
    if (wild > gaps.length * 0.2) return null;
    const steady = changes.length === 0;
    // With a steady click the first and last tick give the tempo far more
    // exactly than any one gap.
    const span = list[list.length - 1].t - list[0].t;
    const whole = gaps.reduce((n, g) => n + Math.max(1, Math.round(g / tick)), 0);
    const period = steady ? span / whole : tick;
    const perMinute = 60 / period;

    let bpm = perMinute;
    while (bpm >= MIN_BPM * 2) bpm /= 2;
    while (bpm < MIN_BPM) bpm *= 2;
    if (hint > 0) {
      for (const k of [0.25, 0.5, 1, 2, 4]) if (Math.abs(perMinute * k - hint) < hint * 0.01) bpm = perMinute * k;
    }
    const perBeat = perMinute / bpm; // ticks to a quarter note
    bpm = Math.round(bpm * 100) / 100;
    if (Math.abs(bpm - Math.round(bpm * 2) / 2) < 0.03) bpm = Math.round(bpm * 2) / 2;

    // Three quarters, or three eighths, from accent to accent is a bar of
    // three or of six; anything else says nothing about the bar.
    let num = 4;
    let den = 4;
    let signature = 'assumed';
    const marks = accents(list);
    const beats = marks ? accentEvery(marks) / perBeat : 0;
    if (beats === 3) {
      num = 3;
      signature = 'heard';
    } else if (beats === 1.5) {
      num = 6;
      den = 8;
      signature = 'heard';
    } else if (beats === 4) signature = 'heard';

    return { bpm, offset: list[0].t < 0.004 ? 0 : list[0].t, num, den, perMinute, count: list.length, steady, changes: steady ? [] : changes.map((c) => c.t), signature };
  }

  // A tempo written in a file or folder name: "Victory-B-127.00bpm", "Bb 139 bpm".
  function hintFrom(names) {
    for (const n of names) {
      const m = /(\d{2,3}(?:\.\d+)?)\s*bpm/i.exec(n || '');
      if (m) return parseFloat(m[1]);
    }
    return 0;
  }

  return { ticks, analyze, hintFrom };
});
