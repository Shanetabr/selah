'use strict';

// Short decaying sine bursts used for the generated click. `accent` marks the
// downbeat, `beat` every other pulse.
function burst(rate, freq, seconds, decay) {
  const n = Math.round(seconds * rate);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / rate;
    out[i] = Math.sin(2 * Math.PI * freq * t) * Math.exp(-t / decay) * 0.9;
  }
  // Fade the tail so the burst ends at zero.
  const tail = Math.min(n, Math.round(0.004 * rate));
  for (let i = 0; i < tail; i++) out[n - 1 - i] *= i / tail;
  return out;
}

function makeClickSounds(rate) {
  return {
    accent: burst(rate, 1760, 0.05, 0.009),
    beat: burst(rate, 1100, 0.04, 0.007),
  };
}

module.exports = { makeClickSounds };
