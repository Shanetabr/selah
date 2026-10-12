// Tempo and first-beat detection for stems recorded to a click (one constant
// tempo). Works best on a click or drum stem.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Tempo = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const ENV_RATE = 250; // onset envelope points per second
  const MIN_BPM = 50;
  const MAX_BPM = 220;

  // How strongly the envelope lines up with a beat grid of period T (in
  // envelope points), at the best phase. Returns [score, phase].
  function comb(on, T) {
    const n = on.length;
    const phases = Math.ceil(T);
    let best = -1;
    let bestPhase = 0;
    for (let p = 0; p < phases; p++) {
      let s = 0;
      for (let x = p; x < n - 1; x += T) {
        const i = x | 0;
        const f = x - i;
        s += on[i] * (1 - f) + on[i + 1] * f;
      }
      if (s > best) {
        best = s;
        bestPhase = p;
      }
    }
    return [best / (n / T), bestPhase];
  }

  // samples: Int16Array or Float32Array, interleaved when channels > 1.
  // Returns { bpm, offset } with offset in seconds, or null if nothing rhythmic was found.
  function detect(samples, channels, rate) {
    const frames = Math.floor(samples.length / channels);
    const hop = Math.max(1, Math.round(rate / ENV_RATE));
    const fps = rate / hop;
    const n = Math.floor(frames / hop);
    if (n < fps * 4) return null;

    const env = new Float32Array(n);
    let peak = 0;
    for (let i = 0; i < n; i++) {
      let s = 0;
      const base = i * hop * channels;
      for (let j = 0; j < hop; j++) {
        const v = samples[base + j * channels];
        s += v * v;
      }
      env[i] = Math.sqrt(s / hop);
      if (env[i] > peak) peak = env[i];
    }
    if (peak <= 0) return null;

    // Onset strength: rises in log energy, lightly blurred so a grid that is a
    // hair off still scores.
    // Silence is assumed before the file, so a hit on the very first sample
    // still counts as an onset.
    const raw = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const d = Math.log(1 + (100 * env[i]) / peak) - (i ? Math.log(1 + (100 * env[i - 1]) / peak) : 0);
      raw[i] = d > 0 ? d : 0;
    }
    const on = new Float32Array(n);
    let onMax = 0;
    for (let i = 0; i < n - 1; i++) {
      on[i] = 0.25 * (i ? raw[i - 1] : 0) + 0.5 * raw[i] + 0.25 * raw[i + 1];
      if (on[i] > onMax) onMax = on[i];
    }
    if (onMax <= 0) return null;

    // Coarse tempo from autocorrelation, weighted toward typical song tempos
    // to settle half/double-time ties.
    const lagMin = Math.floor((fps * 60) / MAX_BPM);
    const lagMax = Math.ceil((fps * 60) / MIN_BPM);
    const ac = (lag) => {
      let s = 0;
      const m = n - lag;
      for (let i = 0; i < m; i++) s += on[i] * on[i + lag];
      return s / m;
    };
    const weight = (lag) => {
      const octaves = Math.log2((fps * 60) / lag / 110);
      return Math.exp(-0.5 * (octaves / 0.8) * (octaves / 0.8));
    };
    let bestLag = 0;
    let bestScore = -1;
    for (let lag = lagMin; lag <= lagMax; lag++) {
      const score = ac(lag) * weight(lag);
      if (score > bestScore) {
        bestScore = score;
        bestLag = lag;
      }
    }
    if (bestLag === 0) return null;

    // A click stem that ticks eighth notes lines up equally well at every
    // multiple of its tick, and the weighting above can then settle on three
    // ticks: two thirds of the real tempo (92.67 for a 139 BPM click). Find
    // the tick itself, the shortest period the onsets repeat at, and when the
    // choice is not a doubling of it, take the best doubling instead.
    const top = ac(bestLag);
    let tick = bestLag;
    for (let lag = Math.max(3, Math.floor((fps * 60) / 720)); lag < bestLag; lag++) {
      const a = ac(lag);
      if (a >= 0.6 * top && a >= ac(lag - 1) && a >= ac(lag + 1)) {
        tick = lag;
        break;
      }
    }
    const ratio = bestLag / tick;
    const whole = Math.round(ratio);
    if (whole >= 3 && Math.abs(ratio - whole) < 0.08 && (whole & (whole - 1)) !== 0) {
      let pick = 0;
      let pickScore = -1;
      for (let m = 1; m <= 8; m *= 2) {
        const lag = Math.round(tick * m);
        if (lag < lagMin || lag > lagMax) continue;
        const score = ac(lag) * weight(lag);
        if (score > pickScore) {
          pickScore = score;
          pick = lag;
        }
      }
      if (pick) bestLag = pick;
    }

    // Refine the period against the whole file: over hundreds of beats even a
    // tiny tempo error walks the grid off the onsets.
    let T = bestLag;
    for (const [span, steps] of [[0.03, 60], [0.0015, 60], [0.0001, 40]]) {
      let top = -1;
      let topT = T;
      for (let k = -steps / 2; k <= steps / 2; k++) {
        const cand = T * (1 + (span * k) / (steps / 2));
        const [score] = comb(on, cand);
        if (score > top) {
          top = score;
          topT = cand;
        }
      }
      T = topT;
    }

    let bpm = (fps * 60) / T;
    // Tracks made to a click are almost always at a whole or half BPM.
    const half = Math.round(bpm * 2) / 2;
    if (Math.abs(bpm - half) < 0.06) bpm = half;
    else bpm = Math.round(bpm * 100) / 100;
    T = (fps * 60) / bpm;

    const phase = comb(on, T)[1];

    // The first clear onset is taken as the first beat.
    let first = 0;
    for (let i = 0; i < n; i++) {
      if (on[i] > onMax * 0.3) {
        first = i;
        break;
      }
    }
    const k = Math.round((first - phase) / T);
    let offset = ((phase + k * T) * hop) / rate;

    // Sharpen to the transient itself when one sits right at that beat.
    const centre = Math.round(offset * rate);
    const from = Math.max(0, centre - 3 * hop);
    const to = Math.min(frames, centre + 6 * hop);
    let localPeak = 0;
    for (let i = from; i < to; i++) {
      const v = Math.abs(samples[i * channels]);
      if (v > localPeak) localPeak = v;
    }
    for (let i = from; i < to; i++) {
      if (Math.abs(samples[i * channels]) > localPeak * 0.2) {
        if (Math.abs(i - centre) <= 3 * hop) offset = i / rate;
        break;
      }
    }
    // A first beat within a few milliseconds of the start is the start.
    offset = Math.max(0, Math.round(offset * 1000) / 1000);
    return { bpm, offset: offset < 0.004 ? 0 : offset };
  }

  return { detect };
});
