// Tempo grid math shared by the audio engine (Node) and the UI (browser).
// A song has one constant tempo: bpm, time signature num/den, and `offset`,
// the time in seconds of the first downbeat (bar 0). Bars are 0-based here;
// the UI shows bar + 1.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Grid = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // What the BPM counts (beatUnit):
  //   'quarter'  quarter notes, whatever the signature, as Ableton does. A
  //              beat is one note of the signature: six to the bar in 6/8,
  //              each half a quarter long. This is what new songs use.
  //   'auto'     one note of the signature, except in compound meters (6/8,
  //              9/8, 12/8), where it is the dotted quarter, two to a 6/8 bar.
  //   'den'      one note of the signature, always.
  function isCompound(g) {
    return g.den === 8 && g.num >= 6 && g.num % 3 === 0;
  }

  // True when a beat is a dotted quarter: three eighths long.
  function isDotted(g) {
    return isCompound(g) && (g.beatUnit || 'auto') === 'auto';
  }

  function beatsPerBar(g) {
    return isDotted(g) ? g.num / 3 : g.num;
  }

  function beatSeconds(g) {
    if (g.beatUnit === 'quarter') return (60 / g.bpm) * (4 / g.den);
    return 60 / g.bpm;
  }

  function barSeconds(g) {
    return beatsPerBar(g) * beatSeconds(g);
  }

  function barToSeconds(g, bar) {
    return g.offset + bar * barSeconds(g);
  }

  function secondsToBar(g, sec) {
    return (sec - g.offset) / barSeconds(g);
  }

  // Always derived from the bar index, never accumulated, so bar lines do not
  // drift from rounding.
  function barToFrame(g, bar, rate) {
    return Math.round(barToSeconds(g, bar) * rate);
  }

  function beatToFrame(g, beat, rate) {
    return Math.round((g.offset + beat * beatSeconds(g)) * rate);
  }

  // Index of the first bar whose line is at least `minLead` frames after `frame`.
  function nextBar(g, frame, rate, minLead) {
    const lead = minLead || 1;
    let k = Math.floor(secondsToBar(g, frame / rate)) + 1;
    while (barToFrame(g, k - 1, rate) - frame >= lead) k--;
    while (barToFrame(g, k, rate) - frame < lead) k++;
    return k;
  }

  // Bar and beat (both 0-based) containing a time in seconds.
  function locate(g, sec) {
    const barF = secondsToBar(g, sec);
    const bar = Math.floor(barF + 1e-9);
    const beat = Math.floor((barF - bar) * beatsPerBar(g) + 1e-6);
    return { bar, beat: Math.max(0, beat) };
  }

  return { isCompound, isDotted, beatsPerBar, beatSeconds, barSeconds, barToSeconds, secondsToBar, barToFrame, beatToFrame, nextBar, locate };
});
