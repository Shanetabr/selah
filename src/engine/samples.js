'use strict';
const fs = require('fs');
const path = require('path');
const { normalize } = require('./cues');

// The click sounds and the spoken cue voice that ship in assets/. They are
// short, so they are decoded to mono Float32 at the output's sample rate when
// an output opens, and kept in RAM for the mixer.

const ASSETS = path.join(__dirname, '..', '..', 'assets');
const VOICE = 'english-female';
const TAPS = 16; // sinc half-width, in source samples at unity cutoff
const MAX_PHASES = 1024;

// Mono Float32 from a PCM WAV file (or its bytes, already read): 16, 24 or
// 32-bit integer, or 32-bit float.
function readWav(file) {
  const b = Buffer.isBuffer(file) ? file : fs.readFileSync(file);
  if (Buffer.isBuffer(file)) file = 'sound';
  if (b.length < 12 || b.toString('latin1', 0, 4) !== 'RIFF' || b.toString('latin1', 8, 12) !== 'WAVE') throw new Error('Not a WAV file: ' + file);
  let fmt = null;
  let data = null;
  for (let p = 12; p + 8 <= b.length; ) {
    const id = b.toString('latin1', p, p + 4);
    const size = b.readUInt32LE(p + 4);
    const body = p + 8;
    if (id === 'fmt ') {
      let tag = b.readUInt16LE(body);
      // WAVE_FORMAT_EXTENSIBLE keeps the real format in the sub-format field.
      if (tag === 0xfffe && size >= 26) tag = b.readUInt16LE(body + 24);
      fmt = { tag, channels: b.readUInt16LE(body + 2), rate: b.readUInt32LE(body + 4), bits: b.readUInt16LE(body + 14) };
    } else if (id === 'data') {
      data = { start: body, size: Math.min(size, b.length - body) };
    }
    p = body + size + (size & 1);
  }
  if (!fmt || !data) throw new Error('Unreadable WAV file: ' + file);
  const bytes = fmt.bits / 8;
  const float = fmt.tag === 3 && fmt.bits === 32;
  if (!float && !(fmt.tag === 1 && (fmt.bits === 16 || fmt.bits === 24 || fmt.bits === 32))) throw new Error('Unsupported WAV format: ' + file);
  const frames = Math.floor(data.size / (bytes * fmt.channels));
  const out = new Float32Array(frames);
  for (let i = 0, p = data.start; i < frames; i++) {
    let sum = 0;
    for (let c = 0; c < fmt.channels; c++, p += bytes) {
      if (float) sum += b.readFloatLE(p);
      else if (bytes === 2) sum += b.readInt16LE(p) / 32768;
      else if (bytes === 3) sum += b.readIntLE(p, 3) / 8388608;
      else sum += b.readInt32LE(p) / 2147483648;
    }
    out[i] = sum / fmt.channels;
  }
  return { rate: fmt.rate, data: out };
}

// Windowed-sinc resampler with the filter precomputed per fractional phase.
function resample(data, from, to) {
  if (from === to) return data;
  const ratio = to / from;
  const fc = Math.min(1, ratio); // cutoff, relative to the source Nyquist
  const half = Math.ceil(TAPS / fc);
  const width = 2 * half;
  const gcd = (a, b) => (b ? gcd(b, a % b) : a);
  const phases = Math.min(MAX_PHASES, to / gcd(from, to));
  const table = new Float32Array(phases * width);
  for (let ph = 0; ph < phases; ph++) {
    const frac = ph / phases;
    for (let j = 0; j < width; j++) {
      const d = frac - (j - half + 1); // distance from the source sample
      const x = Math.PI * fc * d;
      const sinc = Math.abs(x) < 1e-9 ? 1 : Math.sin(x) / x;
      const w = 0.42 + 0.5 * Math.cos((Math.PI * d) / half) + 0.08 * Math.cos((2 * Math.PI * d) / half);
      table[ph * width + j] = Math.abs(d) >= half ? 0 : sinc * fc * w;
    }
  }
  const n = Math.floor(data.length * ratio);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const x = i / ratio;
    const c = Math.floor(x);
    const t = Math.min(phases - 1, Math.round((x - c) * phases)) * width;
    const j0 = c - half + 1;
    let acc = 0;
    for (let j = Math.max(0, -j0), end = Math.min(width, data.length - j0); j < end; j++) acc += data[j0 + j] * table[t + j];
    out[i] = acc;
  }
  return out;
}

// Drops the silence after the sound, with a short fade so the cut is clean.
function trimTail(data, rate) {
  let peak = 0;
  for (let i = 0; i < data.length; i++) if (Math.abs(data[i]) > peak) peak = Math.abs(data[i]);
  if (peak === 0) return data.subarray(0, 0);
  let last = data.length - 1;
  while (last > 0 && Math.abs(data[last]) < peak * 0.003) last--;
  const end = Math.min(data.length, last + Math.round(0.03 * rate));
  const out = data.slice(0, end);
  const fade = Math.min(end, Math.round(0.01 * rate));
  for (let i = 0; i < fade; i++) out[end - 1 - i] *= i / fade;
  return out;
}

function loadSample(file, rate) {
  const wav = readWav(file);
  return resample(trimTail(wav.data, wav.rate), wav.rate, rate);
}

// "English Female - Pre Chorus 1.wav" -> "pre chorus 1"
function wordOf(fileName) {
  return normalize(path.basename(fileName, path.extname(fileName)).replace(/^.* - /, ''));
}

// The words the voice can say, without loading any of the audio.
function names() {
  const out = new Set();
  const root = path.join(ASSETS, 'cues', VOICE);
  for (const dir of fs.readdirSync(root)) {
    const full = path.join(root, dir);
    if (!fs.statSync(full).isDirectory()) continue;
    for (const f of fs.readdirSync(full)) if (/\.wav$/i.test(f)) out.add(wordOf(f));
  }
  return out;
}

const cache = new Map();

// The owner's own click: { 'main.wav': Buffer, 'eighth.wav': Buffer } once it
// has been opened with the full key (see vault.js and assets/clicks/ew.lock),
// else null, and then there is no "ew" among the sounds.
let ew = null;
const STAND_IN = 'classic';
const EW_LOCK = path.join(ASSETS, 'clicks', 'ew.lock');

function setEw(files) {
  ew = files && files['main.wav'] && files['eighth.wav'] ? files : null;
  cache.clear();
}

// The click sounds a song can choose from, without loading any audio:
// [{ id, name, main, sub }], `main` and `sub` being files. "ew" is the owner's
// own pair (main.wav and eighth.wav in assets/clicks). Every folder beside
// them is one more sound, a set of single hits from a click pack: its main
// hit is quarter.wav (else accents.wav), and the notes in between take
// eighth.wav (else sixteenth.wav, else the main hit again). Drop a folder of
// such WAVs in and it shows up in the Sound list.
function clickSets() {
  const root = path.join(ASSETS, 'clicks');
  const sets = ew ? [{ id: 'ew', name: 'EW click', main: ew['main.wav'], sub: ew['eighth.wav'] }] : [];
  for (const dir of fs.readdirSync(root).sort()) {
    const full = path.join(root, dir);
    if (!/^[a-z0-9_-]+$/.test(dir) || !fs.statSync(full).isDirectory()) continue;
    const have = (n) => (fs.existsSync(path.join(full, n + '.wav')) ? path.join(full, n + '.wav') : null);
    const main = have('quarter') || have('accents');
    if (main) sets.push({ id: dir, name: dir.charAt(0).toUpperCase() + dir.slice(1), main, sub: have('eighth') || have('sixteenth') || main });
  }
  return sets;
}

// { click: { main, sub }, clicks: { id: { main, sub } }, words: Map(word ->
// Float32Array) } at `rate`. `click` is the "ew" pair, as it always was.
function load(rate) {
  if (cache.has(rate)) return cache.get(rate);
  const clicks = {};
  for (const s of clickSets()) clicks[s.id] = { main: loadSample(s.main, rate), sub: loadSample(s.sub, rate) };
  // Without the owner's click, the pair that stands in for it everywhere.
  const click = clicks.ew || clicks[STAND_IN] || Object.values(clicks)[0];
  const words = new Map();
  const root = path.join(ASSETS, 'cues', VOICE);
  for (const dir of fs.readdirSync(root)) {
    const full = path.join(root, dir);
    if (!fs.statSync(full).isDirectory()) continue;
    for (const f of fs.readdirSync(full)) {
      if (/\.wav$/i.test(f)) words.set(wordOf(f), loadSample(path.join(full, f), rate));
    }
  }
  const set = { click, clicks, words };
  cache.set(rate, set);
  return set;
}

module.exports = { readWav, resample, trimTail, loadSample, wordOf, names, clickSets, load, setEw, EW_LOCK, STAND_IN };
