import { $, el, uid, toast, menu, modal, askText, fmtTime, gainToDb, dbToGain, fmtDb } from './ui.js';
import { decodeToCache, loadPeaks, loadPcm, trackNameFromFile, folderNameOf, guessBus } from './importer.js';
import { Timeline, sectionColor, sortedSections } from './timeline.js';
import { Mic } from './mic.js';

const G = window.Grid;
const Structure = window.Structure;
const api = window.api;

// Audio queued ahead of the device. More is safer against dropouts and only
// costs reaction time, which does not matter for playback.
const BUFFERS = {
  low: { frameSize: 256, queueBlocks: 4, label: 'Low latency' },
  normal: { frameSize: 512, queueBlocks: 6, label: 'Normal' },
  safe: { frameSize: 1024, queueBlocks: 8, label: 'Safe' },
};
// A song with no stems is click and cues only, this many bars long to begin with.
const DEFAULT_BARS = 96;
// How far ahead of its section a cue starts: { n, unit: 'bars' | 'beats' }, or
// 'off'. The names are what songs saved before leads could be typed in.
const NAMED_LEADS = { two: { n: 2, unit: 'bars' }, one: { n: 1, unit: 'bars' }, half: { n: 0.5, unit: 'bars' } };
const LEAD_PRESETS = ['two', 'one', 'half', 'off'];
const SECTION_NAMES = ['Intro', 'Verse 1', 'Verse 2', 'Verse 3', 'Verse 4', 'Pre-Chorus', 'Chorus', 'Bridge', 'Instrumental', 'Interlude', 'Tag', 'Vamp', 'Outro'];
const SWATCHES = [
  ['Grey', '#8a8f98'],
  ['Blue', '#4f8fd6'],
  ['Teal', '#3fb5a3'],
  ['Orange', '#e8963a'],
  ['Pink', '#c85fb0'],
  ['Purple', '#9a7be0'],
  ['Green', '#6fb35a'],
  ['Red', '#d65f5f'],
];
// The library format. 2: tempos count quarter notes and cue leads can follow
// the Ableton sets; older libraries are brought up to it once, on load.
const LIB_VERSION = 2;

// How a lead is stored: the three standard ones by name, which the engine
// plays exactly as it always has; anything else as typed.
function toStyle(l) {
  const x = leadOf(l);
  if (!x.n) return 'off';
  if (x.unit === 'bars') for (const [name, v] of Object.entries(NAMED_LEADS)) if (v.n === x.n) return name;
  return x;
}

function leadOf(v) {
  const l = v && typeof v === 'object' ? v : NAMED_LEADS[v];
  return l && l.n > 0 ? { n: l.n, unit: l.unit === 'beats' ? 'beats' : 'bars' } : { n: 0, unit: 'bars' };
}

function leadLabel(v) {
  const l = leadOf(v);
  if (!l.n) return 'No guide';
  return (l.n === 0.5 ? '½' : l.n) + ' ' + (l.n <= 1 ? l.unit.slice(0, -1) : l.unit);
}

function sameLead(a, b) {
  const x = leadOf(a);
  const y = leadOf(b);
  return x.n === y.n && (!x.n || x.unit === y.unit);
}

// "3 beats", "1.5 bars", "2" (bars) or "0"; null when it is none of those.
function parseLead(text) {
  const m = /^\s*(\d+(?:\.\d+)?|½)\s*(bars?|beats?)?\s*$/i.exec(text || '');
  if (!m) return null;
  const n = Math.min(16, m[1] === '½' ? 0.5 : parseFloat(m[1]));
  return n > 0 ? { n, unit: /^beat/i.test(m[2] || '') ? 'beats' : 'bars' } : 'off';
}

const state = {
  lib: null,
  song: null, // the open song; an object inside lib.songs
  peaks: new Map(), // trackId -> Int8Array, for the open song
  devices: null,
  out: null, // the last 'output' event from the engine
  eng: { songId: null, playing: false, pos: 0, at: 0, pending: null, peaks: [], underruns: 0 },
  guide: [], // where the guide voice speaks in the open song: [{ sec, bar, spoken }], from the engine
  pos: 0,
  sel: new Set(), // ids of the selected tracks of the open song; never saved
  selAnchor: null, // the track a Shift-click run starts from
  selSong: null, // the song the selection was made in
  clickSounds: [], // the sampled click sounds this copy has, asked for at start
  setSel: new Set(), // rows selected in the open setlist, by position; never saved
  setAnchor: null, // the row a Shift-click run starts from
  setSelFor: null, // the setlist the selection was made in
  voice: { on: false, names: [], level: 0, heard: null, at: 0 }, // voice control; never saved, off at every start
};

let timeline = null;
let headRefreshers = [];
let trackMeters = new Map(); // trackId -> the bar of its level meter, rebuilt with the rows
const trackHold = new Map(); // trackId -> the level its meter is falling back from
let audioDialog = null;
let prepToken = 0;
let lastReopen = 0;

// ---------- persistence ----------

function defaultLib() {
  const setId = uid('set');
  return {
    version: LIB_VERSION,
    songs: [],
    setlists: [{ id: setId, name: 'Sunday', songIds: [] }],
    currentSetlistId: setId,
    lastSongId: null,
    settings: {
      audio: { apiId: null, deviceName: null, sampleRate: 48000, buffer: 'normal' },
      buses: { band: { mode: 'stereo', ch: 0, gain: 1 }, cue: { mode: 'stereo', ch: 0, gain: 1 } },
      defaults: songDefaults(),
    },
  };
}

// What a new song starts with; editable in Settings.
function songDefaults() {
  return {
    click: { sound: 'ew', sub: true, main: 2 },
    cues: { enabled: true, gain: 1, start: 'auto', section: 'auto' },
  };
}

function isLive() {
  return !!state.lib.settings.live;
}

let saveTimer = null;
function saveSoon() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveNow, 300);
}

function saveNow() {
  clearTimeout(saveTimer);
  saveTimer = null;
  api.saveLibrary(state.lib).catch((err) => toast('Could not save: ' + err.message, 'error'));
}

window.addEventListener('beforeunload', () => {
  if (saveTimer) saveNow();
});

// ---------- song model ----------

// A click sound this copy has: the one asked for, or, when that is the
// owner's own click on a copy without it, the one that plays in its place.
function soundHere(id) {
  const have = state.clickSounds.map((s) => s.id);
  return !id || id === 'beep' || have.includes(id) ? id : have.includes('classic') ? 'classic' : have[0] || 'beep';
}

function newSong(name) {
  const click = Object.assign({ enabled: true, gain: 1, bus: 'cue' }, state.lib.settings.defaults.click);
  click.sound = soundHere(click.sound);
  return {
    id: uid('s'),
    name: name || 'New Song',
    key: '',
    bpm: 120,
    num: 4,
    den: 4,
    beatUnit: 'quarter',
    offset: 0,
    bars: DEFAULT_BARS,
    // Every level starts at 0 dB (unity) and is adjusted from there.
    click,
    cues: Object.assign({}, state.lib.settings.defaults.cues),
    tracks: [],
    sections: [],
  };
}

// Brings a song saved before Selah followed Ableton's conventions into line,
// without changing how it plays today. Done once per library (see
// LIB_VERSION), so a later choice of dotted-quarter tempo or of a fixed lead
// is left alone:
//   - the BPM is rewritten in quarter notes, which is what Ableton's tempo
//     box means in every signature (6/8 at a dotted-quarter 46.67 becomes 70)
//   - cue leads still at the old defaults become "like the Ableton sets",
//     which is the same thing in 4/4 and follows the sets in 3/4 and 6/8
function followAbleton(song) {
  if (song.beatUnit !== 'quarter') {
    const quarters = G.isDotted(song) ? 1.5 : 4 / song.den;
    if (quarters !== 1) {
      const bpm = song.bpm * quarters;
      const half = Math.round(bpm * 2) / 2;
      song.bpm = Math.abs(bpm - half) < 0.02 ? half : Math.round(bpm * 100) / 100;
    }
    song.beatUnit = 'quarter';
  }
  if (song.cues.start === 'two' && song.cues.section === 'one') {
    song.cues.start = 'auto';
    song.cues.section = 'auto';
  }
}

function hasStems(song) {
  return song.tracks.some((t) => !t.missing);
}

// With "2× bars" on, song.bpm is the tempo the bars run at and the box shows
// half of it: the tempo the owner types, which the click and the count follow.
function typedBpm(song) {
  return song.double ? song.bpm / 2 : song.bpm;
}

function scaleOf(song) {
  return song.double ? 2 : 1;
}

// A stem that is a click or a guide by its name: where it goes when the
// outputs are separate channels (see busOf).
const EAR_NAMES = { click: /\b(click|clk|metronome)\b/i, guide: /\b(guide|guia|cues?)\b/i };
const namedLike = (kind, name) => EAR_NAMES[kind].test(String(name).replace(/[_-]/g, ' '));

// What the engine is told about a track.
function trackMessage(song, t) {
  return { gain: t.gain, mute: t.mute, solo: t.solo, bus: busOf(t) };
}

function clickMessage(song) {
  return Object.assign({}, song.click, { bus: 'click', scale: scaleOf(song) });
}

function gridOf(song) {
  return { bpm: song.bpm, num: song.num, den: song.den, beatUnit: song.beatUnit, offset: song.offset };
}

function durationOf(song) {
  let d = 0;
  if (song) for (const t of song.tracks) if (!t.missing && t.duration > d) d = t.duration;
  // A song with stems ends with its audio, unless its end was dragged (`song.end`).
  if (song && d > 0 && song.end > 0) return Math.max(0, G.barToSeconds(song, song.end));
  if (song && d === 0) d = Math.max(0, G.barToSeconds(song, song.bars || DEFAULT_BARS));
  return d;
}

function currentSetlist() {
  const lib = state.lib;
  return lib.setlists.find((s) => s.id === lib.currentSetlistId) || lib.setlists[0];
}

function isAudible(t) {
  const anySolo = state.song.tracks.some((x) => x.solo);
  return !t.mute && (!anySolo || t.solo);
}

// The section the playhead is in, or null in a gap between sections.
function currentSection() {
  const song = state.song;
  if (!song) return null;
  return Structure.at(song.sections, G.secondsToBar(song, state.pos + 0.02));
}

// The last section to have started, for stepping to the one before or after.
function lastStarted() {
  const song = state.song;
  let cur = null;
  for (const s of sortedSections(song)) {
    if (G.barToSeconds(song, s.bar) <= state.pos + 0.02) cur = s;
    else break;
  }
  return cur;
}

// The bar a song ends in, for giving its last section a length.
function endBarOf(song) {
  return Math.max(1, Math.ceil(G.secondsToBar(song, durationOf(song)) - 1e-6));
}

function applyStructure(song, blocks) {
  for (const b of blocks) {
    const s = song.sections.find((x) => x.id === b.id);
    s.bar = b.bar;
    s.len = b.len;
  }
}

// Sections are blocks with a length. Songs saved with plain markers get
// theirs here: each runs to the next marker, the last to the end of the song.
function ensureLengths(song) {
  if (song.sections.every((s) => s.len > 0)) return;
  applyStructure(song, Structure.normalize(song.sections, endBarOf(song)));
}

function barLabel(bar) {
  const whole = Math.floor(bar + 1e-6);
  const beat = Math.round((bar - whole) * G.beatsPerBar(state.song));
  return beat > 0 ? `${whole + 1}.${beat + 1}` : String(whole + 1);
}

// ---------- engine ----------

function send(msg) {
  api.engine.send(msg);
}

function engineReady() {
  return !!state.song && state.eng.songId === state.song.id;
}

function openOutput() {
  const a = state.lib.settings.audio;
  const apis = state.devices ? state.devices.apis : [];
  const usable = (id) => apis.some((x) => x.id === id && x.devices.length);
  let apiId = a.apiId;
  if (!apiId || !usable(apiId)) {
    // WASAPI before ASIO by default: ASIO takes the device exclusively, so it
    // is left for the user to choose.
    const order = api.platform === 'win32' ? ['wasapi', 'asio', 'ds'] : apis.map((x) => x.id);
    apiId = order.find(usable) || 'none';
  }
  const buf = BUFFERS[a.buffer] || BUFFERS.normal;
  send({ cmd: 'openOutput', apiId, deviceName: a.deviceName, sampleRate: a.sampleRate, frameSize: buf.frameSize, queueBlocks: buf.queueBlocks });
}

// ---------- outputs ----------

// Two ways of sending sound out (owner, 2026-10-05, for the Dante rig: "8
// total channels, one is click, second guide, rest we decide", with a toggle).
// "Two feeds" is `settings.buses`: mains and ears, click and guide together
// on the ears. "Separate channels" is `settings.split`, when its `on` is set:
// the click on an output of its own, the guide on another, and the tracks in
// named groups, each group on a mono output or a stereo pair. The engine only
// knows buses by id: band, cue, click, guide and one per group.
const GROUP_NAMES = ['Drums', 'Bass', 'Keys', 'Guitars', 'Vocals', 'Other'];
// What a stem's name says about its group, most telling first.
const GROUP_WORDS = [
  ['drum', /drum|kit|perc|loop|tamb|shaker|snare|kick|hat|cymbal|tom/i],
  ['bass', /bass|sub/i],
  ['guitar', /guitar|gtr|\b[ae]g\b|acoustic|electric/i],
  ['voc', /vox|vocal|bgv|choir|soprano|alto|tenor|sing|lead/i],
  ['key', /key|piano|organ|synth|pad|rhodes|string|horn|brass|fx/i],
];

function defaultSplit(stereo) {
  const groups = stereo
    ? ['Tracks A', 'Tracks B', 'Tracks C'].map((name, i) => ({ id: 'g' + (i + 1), name, mode: 'stereo', ch: 2 + i * 2, gain: 1 }))
    : GROUP_NAMES.map((name, i) => ({ id: 'g' + (i + 1), name, mode: 'mono', ch: 2 + i, gain: 1 }));
  return { on: true, click: { mode: 'mono', ch: 0, gain: 1 }, guide: { mode: 'mono', ch: 1, gain: 1 }, groups };
}

function splitOn() {
  const s = state.lib.settings.split;
  return !!(s && s.on);
}

// The outputs in use, as the engine's buses. With two feeds the click and
// the guide are the ears; with separate channels a track sent to the ears
// goes out with the guide.
function engineBuses() {
  const st = state.lib.settings;
  if (!splitOn()) return { band: st.buses.band, cue: st.buses.cue, click: st.buses.cue, guide: st.buses.cue };
  const out = { click: st.split.click, guide: st.split.guide };
  for (const g of st.split.groups) out[g.id] = g;
  return out;
}

// The group a track plays through: the one it was given, else one guessed
// from its name, else the last group.
function groupOf(t) {
  const groups = state.lib.settings.split.groups;
  if (groups.some((g) => g.id === t.group)) return t.group;
  const name = t.name.replace(/[_-]/g, ' ').toLowerCase();
  let g = groups.find((x) => x.name && name.includes(x.name.toLowerCase()));
  if (!g) {
    for (const [key, re] of GROUP_WORDS) {
      if (!re.test(name)) continue;
      g = groups.find((x) => x.name.toLowerCase().includes(key));
      if (g) break;
    }
  }
  g = g || groups[groups.length - 1];
  return g ? g.id : 'band';
}

// With separate channels a track sent to the ears goes to the click's output
// or the guide's: the one it was given (`t.ear`), else the click's when it is
// named like a click, else the guide's.
function earOf(t) {
  return t.ear === 'click' || t.ear === 'guide' ? t.ear : namedLike('click', t.name) ? 'click' : 'guide';
}

// The bus a track is on, by the engine's ids.
function busOf(t) {
  if (t.bus === 'cue') return splitOn() ? earOf(t) : 'cue';
  return splitOn() ? groupOf(t) : 'band';
}

function busName(t) {
  if (t.bus === 'cue') return !splitOn() ? 'EARS' : earOf(t) === 'click' ? 'CLICK' : 'GUIDE';
  if (!splitOn()) return 'MAINS';
  const g = state.lib.settings.split.groups.find((x) => x.id === groupOf(t));
  return g ? g.name : '—';
}

function sendBuses() {
  send({ cmd: 'setBuses', buses: engineBuses() });
}

// After the outputs were changed: every track may be on another bus now.
function resendRouting() {
  sendBuses();
  const song = state.song;
  if (song && state.out) {
    for (const t of song.tracks) if (!t.missing && t.channels) send({ cmd: 'setTrack', songId: song.id, id: t.id, patch: trackMessage(song, t) });
    send({ cmd: 'setClick', songId: song.id, click: clickMessage(song) });
  }
  for (const fn of headRefreshers) fn();
  renderAudioButton();
  saveSoon();
}

// The outputs in use, to check them against the device and to meter them.
function activeBuses() {
  const st = state.lib.settings;
  return splitOn() ? { band: st.split.groups, cue: [st.split.click, st.split.guide] } : { band: [st.buses.band], cue: [st.buses.cue] };
}

// A bus pointed at channels this device does not have plays nothing.
function busInRange(bus) {
  if (!state.out) return true;
  return bus.mode === 'mono' ? bus.ch < state.out.channels : bus.ch + 1 < state.out.channels;
}

function busLabel(bus) {
  return bus.mode === 'mono' ? `${bus.ch + 1} (mono)` : `${bus.ch + 1}–${bus.ch + 2}`;
}

function songKey(song, rate) {
  return rate + '|' + song.tracks.map((t) => t.id + ':' + (t.stamp || 0)).join(',');
}

// The spoken-cue settings plus the section markers they are placed from.
function cueMessage(song) {
  return Object.assign({}, song.cues, { scale: scaleOf(song), sections: song.sections.map((s) => ({ bar: s.bar, name: s.name, cue: s.cue })), callouts: (song.callouts || []).map((c) => ({ bar: c.bar, word: c.word })) });
}

function sendCues() {
  send({ cmd: 'setCues', songId: state.song.id, cues: cueMessage(state.song) });
}

function loadMessage(song, preload) {
  const rate = state.out.sampleRate;
  return {
    cmd: 'loadSong',
    songId: song.id,
    rate,
    key: songKey(song, rate),
    grid: gridOf(song),
    bars: song.bars || DEFAULT_BARS,
    endBar: handoverBar(song),
    click: clickMessage(song),
    cues: cueMessage(song),
    preload: !!preload,
    tracks: song.tracks.filter((t) => !t.missing && t.channels).map((t) => Object.assign({ id: t.id, channels: t.channels }, trackMessage(song, t))),
  };
}

function progressDialog(title) {
  const text = el('div', null, '');
  const bar = el('i');
  const m = modal(title, el('div.progress', null, text, el('div.track', null, bar)), { locked: true });
  return {
    set(label, fraction) {
      text.textContent = label;
      bar.style.width = Math.round(fraction * 100) + '%';
    },
    close: m.close,
  };
}

async function decodeTracks(song, tracks, rate) {
  const dlg = progressDialog('Preparing stems');
  const failed = [];
  for (let i = 0; i < tracks.length; i++) {
    const t = tracks[i];
    dlg.set(`${i + 1} of ${tracks.length}: ${t.name}`, i / tracks.length);
    try {
      const res = await decodeToCache({ songId: song.id, trackId: t.id, file: t.file, rate });
      t.channels = res.channels;
      t.duration = res.frames / rate;
      t.stamp = Date.now();
      delete t.missing;
      if (song === state.song) state.peaks.set(t.id, res.peaks);
    } catch (err) {
      t.missing = true;
      failed.push(`${t.name} (${err.message})`);
    }
  }
  dlg.close();
  if (failed.length) toast('Could not load: ' + failed.join(', '), 'error');
  saveSoon();
}

// Make sure every stem of the song is decoded at the current output rate,
// then hand the song to the engine.
async function prepareSong(song) {
  if (!state.out) return;
  const token = ++prepToken;
  const rate = state.out.sampleRate;
  const have = await api.cache.check({ songId: song.id, tracks: song.tracks.map((t) => ({ id: t.id, channels: t.channels || 2 })), rate });
  if (token !== prepToken) return;
  const todo = song.tracks.filter((t) => !have[t.id]);
  if (todo.length) {
    await decodeTracks(song, todo, rate);
    if (token !== prepToken) return;
  }
  for (const t of song.tracks) {
    if (!state.peaks.has(t.id) && !t.missing) {
      const p = await loadPeaks(song.id, t.id);
      if (token !== prepToken) return;
      if (p) state.peaks.set(t.id, p);
    }
  }
  if (song !== state.song) return;
  send(loadMessage(song));
  renderAll();
  // With no stems the whole song would be squeezed thin: open it zoomed in
  // enough to read the sections. The Fit button still shows all of it.
  timeline.fit(hasStems(song) ? 0 : 18);
}

// Load the song that is likely to follow (one lined up by hand, else the next
// in the setlist) into the engine in the background, so switching is instant.
async function preloadNext() {
  const next = comingSong() || (state.song ? nextInSetlist(state.song) : null);
  if (!next || !state.out || !next.tracks.length) return;
  const have = await api.cache.check({ songId: next.id, tracks: next.tracks.map((t) => ({ id: t.id, channels: t.channels || 2 })), rate: state.out.sampleRate });
  if (next.tracks.every((t) => t.missing || have[t.id])) send(loadMessage(next, true));
}

// A Mac that goes to sleep, or has its lid shut, stops asking for audio.
// Nothing reports an error: the stream still counts as running, the engine
// goes on sending its state, and the song simply stands still. `at` is when
// the device last took a block, so a gap there says what has happened. It has
// to last a few reports in a row, so a busy moment is not taken for it.
const STALL_MS = 2000;
function checkDevice(m) {
  state.stallCount = state.out && Date.now() - m.at > STALL_MS ? (state.stallCount || 0) + 1 : 0;
  const stalled = state.stallCount >= 15;
  if (stalled === !!state.stalled) return;
  state.stalled = stalled;
  renderAudioButton();
  if (stalled) toast('Audio has stopped: the device is not taking sound. A closed lid or a sleeping Mac does this.', 'error');
  else toast('Audio is running again.');
}

api.engine.onEvent((m) => {
  switch (m.type) {
    case 'state':
      state.eng = m;
      checkDevice(m);
      break;
    case 'devices':
      state.devices = m;
      if (m.error) toast('Audio module failed to load: ' + m.error, 'error');
      openOutput();
      break;
    case 'output':
      state.out = m;
      sendBuses();
      renderAudioButton();
      if (audioDialog) audioDialog.refresh();
      if (m.fellBack) toast(`"${state.lib.settings.audio.deviceName}" was not found. Using ${m.deviceName}.`, 'error');
      else if (!m.ok && m.error) toast('Audio output: ' + m.error, 'error');
      if (state.song) prepareSong(state.song);
      break;
    case 'songLoaded':
      if (m.songId === state.playWhenLoaded) {
        // Rolling straight in from the song before.
        state.playWhenLoaded = null;
        send({ cmd: 'play' });
      }
      preloadNext();
      break;
    case 'ended':
      songOver(true, m.songId);
      break;
    case 'stopped':
      songOver(false, m.songId);
      break;
    case 'guide':
      if (state.song && m.songId === state.song.id) {
        state.guide = m.events;
        timeline.requestDraw();
      }
      break;
    case 'extended': {
      // A click-only song was played past its end and grew.
      const song = state.lib.songs.find((x) => x.id === m.songId);
      if (!song) break;
      song.bars = m.bars;
      if (song === state.song) lengthChanged();
      saveSoon();
      break;
    }
    case 'testOutput':
      state.testCh = m.ch;
      if (audioDialog) audioDialog.refresh();
      break;
    case 'outputError':
      toast('Audio device error: ' + m.message, 'error');
      // Try to get sound back (a replugged interface, or the default device),
      // but not in a tight loop if the device keeps failing.
      if (Date.now() - lastReopen > 3000) {
        lastReopen = Date.now();
        setTimeout(() => send({ cmd: 'getDevices' }), 800);
      }
      break;
    case 'engineRestarted':
      toast('The audio engine restarted', 'error');
      state.out = null;
      send({ cmd: 'getDevices' });
      break;
    case 'error':
      toast(m.message, 'error');
      break;
  }
});

// ---------- transport ----------

// Space and the play button. Pausing either holds its place or, when Settings
// says so, goes back to the start of the song like Stop does.
function togglePlay() {
  if (!engineReady()) return;
  if (!state.eng.playing) send({ cmd: 'play' });
  else send({ cmd: state.lib.settings.pauseRewinds ? 'stop' : 'pause' });
}

function stop() {
  send({ cmd: 'stop' });
  // Paused, nothing will report a stop: a lined-up song takes over from here.
  if (state.song && state.queued && !state.eng.playing && !state.eng.fading) songOver(false, state.song.id);
}

// Ends a song early without a hard cut: everything fades, then it stops.
const FADE_SECONDS = 4;
function fadeOut() {
  if (engineReady() && state.eng.playing) send({ cmd: 'fadeOut', seconds: FADE_SECONDS });
}

// ---------- from one song to the next ----------
// What a song does when it reaches its end: 'stop' (it stays where it is),
// 'next' (the next song in the setlist is lined up and waits for Play) or
// 'roll' (the next song starts by itself). Settings holds the usual choice
// (settings.atEnd); a song's own (song.atEnd) overrides it.
//
// A song can also be lined up by hand: a click on another song while one is
// playing does not interrupt, it sets state.queued, and that song opens when
// this one ends, is stopped or has faded out.
const AT_END = [
  ['stop', 'Stops there'],
  ['next', 'Lines up the next song, ready for Play'],
  ['roll', 'Rolls straight into the next song'],
];
const SOON_BARS = 8; // how far ahead the top bar announces a change of song

function atEndOf(song) {
  return song.atEnd || state.lib.settings.atEnd || 'stop';
}

// Where the engine is to end the song, in bars, or null. A song with stems
// ends where its audio does (null) unless its end was dragged on the timeline
// (`song.end`). A song with no stems ends after its last section when it is
// to hand over to the next song; otherwise it has no end (null) and grows
// when played past its last bar.
function handoverBar(song) {
  if (hasStems(song)) return song.end > 0 ? song.end : null;
  if (atEndOf(song) === 'stop' || !song.sections.length) return null;
  return Structure.end(song.sections);
}

// The end of the song, dragged on the timeline like the edge of a clip (owner,
// 2026-10-05: "adjust the timeline however I want"). With stems it is
// `song.end`: before the audio's end the song is cut there, after it the click
// and the guide carry on over nothing. With no stems it is the song's length,
// `song.bars`, never shorter than its sections. The timeline calls
// `moveSongEnd` as the mouse moves and `songEndMoved` when it lets go.
function moveSongEnd(bar) {
  const song = state.song;
  if (hasStems(song)) song.end = Math.max(1, bar);
  else song.bars = Math.max(1, Math.ceil(Structure.end(song.sections) - 1e-6), Math.round(bar));
  $('#clockTotal').textContent = '/ ' + fmtTime(durationOf(song));
  timeline.requestDraw();
}

function songEndMoved() {
  sendBars(state.song);
  lengthChanged();
  renderLists();
  saveSoon();
}

// How finely the end snaps while it is dragged, from a right-click on its
// line (owner, 2026-10-05: "more coarse or more precise"). One choice for the
// whole app, `settings.endSnap`: 4, 2 or 1 bars (1 when not set), 'beat', or
// 'free'. A song with no stems is always a whole number of bars long.
const END_SNAPS = [[4, '4 bars'], [2, '2 bars'], [1, '1 bar'], ['beat', '1 beat'], ['free', 'Nothing (free)']];

function endSnap(song) {
  const v = state.lib.settings.endSnap || 1;
  return v === 'free' ? 0 : v === 'beat' ? 1 / Math.max(1, Math.round(G.beatsPerBar(song))) : v;
}

function songEndMenu(x, y) {
  const song = state.song;
  const now = state.lib.settings.endSnap || 1;
  const items = END_SNAPS.map(([v, label]) => ({
    label: (v === now ? '✓ ' : '') + 'Snap to: ' + label,
    action: () => {
      state.lib.settings.endSnap = v;
      saveSoon();
    },
  }));
  if (hasStems(song) && song.end > 0) items.push('-', { label: 'Back to the end of the audio', action: resetSongEnd });
  menu(x, y, items);
}

// Double-click on the end: a song with stems ends with its audio again.
function resetSongEnd() {
  const song = state.song;
  if (!hasStems(song) || !(song.end > 0)) return;
  pushUndo();
  delete song.end;
  songEndMoved();
  toast('The song ends with its audio again');
}

function sendBars(song) {
  send({ cmd: 'setBars', songId: song.id, bars: song.bars, endBar: handoverBar(song) });
}

// The song's end in seconds, or null when it has none.
function endSeconds(song) {
  if (hasStems(song)) return durationOf(song);
  const bar = handoverBar(song);
  return bar === null ? null : G.barToSeconds(song, bar);
}

function nextInSetlist(song) {
  const set = currentSetlist();
  const i = set.songIds.indexOf(song.id);
  return (i >= 0 && state.lib.songs.find((s) => s.id === set.songIds[i + 1])) || null;
}

// The song that takes over when the open one is done: one lined up by hand,
// or the next in the setlist when the open song is set to hand over.
function comingSong() {
  const song = state.song;
  if (!song) return null;
  const byHand = state.queued && state.lib.songs.find((s) => s.id === state.queued);
  if (byHand && byHand !== song) return byHand;
  return atEndOf(song) === 'stop' ? null : nextInSetlist(song);
}

function queueSong(song) {
  state.queued = state.queued === song.id ? null : song.id;
  renderLists();
  toast(state.queued ? `"${song.name}" is lined up. It opens when this song stops or ends.` : `"${song.name}" is no longer lined up.`);
  if (state.queued) preloadNext();
}

// The open song has ended by itself (`natural`), or was stopped or faded out.
async function songOver(natural, songId) {
  const from = state.song;
  if (!from || from.id !== songId) return;
  const byHand = state.queued && state.lib.songs.find((s) => s.id === state.queued);
  state.queued = null;
  // By itself a song only hands over at its own end, never when it is stopped.
  const to = byHand && byHand !== from ? byHand : natural && atEndOf(from) !== 'stop' ? nextInSetlist(from) : null;
  if (!to) {
    if (byHand) renderLists();
    return;
  }
  state.playWhenLoaded = natural && atEndOf(from) === 'roll' ? to.id : null;
  await openSong(to.id, true);
}

function howLongFor(song, sec) {
  const bars = Math.ceil(sec / G.barSeconds(song) - 0.05);
  if (sec / G.barSeconds(song) >= 1) return `${bars} bar${bars === 1 ? '' : 's'}`;
  const beats = Math.max(1, Math.ceil(sec / G.beatSeconds(song) - 0.05));
  return `${beats} beat${beats === 1 ? '' : 's'}`;
}

// What the top bar says about the next song: its name, key and tempo, and in
// the last SOON_BARS bars of this one, that the change is coming.
function songReadout(pos) {
  const song = state.song;
  const to = comingSong();
  if (!song || !to || !engineReady()) return { text: '', name: '', detail: '', soon: false, last: false, byHand: false };
  // `name` and `detail` are the two lines of the top bar; `text` is the same in one line.
  const facts = `${to.key ? to.key + ' · ' : ''}${Math.round(typedBpm(to) * 100) / 100}`;
  const what = `${to.name} · ${facts}`;
  const byHand = state.queued === to.id;
  const end = endSeconds(song);
  const left = end === null ? -1 : end - pos;
  if (state.eng.playing && left > 0 && left <= SOON_BARS * G.barSeconds(song)) {
    const change = `Song change in ${howLongFor(song, left)}`;
    return { text: `${change} → ${what}`, name: to.name, detail: change, soon: true, last: left <= G.barSeconds(song), byHand };
  }
  const kind = byHand ? 'Lined up' : 'Next song';
  return { text: `${kind}: ${what}`, name: to.name, detail: `${kind} · ${facts}`, soon: false, last: false, byHand };
}

function seek(sec) {
  if (!engineReady()) return;
  send({ cmd: 'seek', seconds: Math.max(0, Math.min(durationOf(state.song), sec)) });
}

// Playing: queues a jump, counted in: "Chorus 2 3 4", then it lands. Stopped: moves straight away, or, when Settings says a tap
// starts playback and `launch` is set, plays from the section's count-in.
// Tapping a queued section again leaves it queued, so a nervous double tap
// cannot undo a jump; Esc or a click on the "next" readout cancels.
function jumpToSection(section, launch) {
  if (!engineReady()) return;
  if (launch && state.lib.settings.launch && !state.eng.playing) {
    send({ cmd: 'playFromBar', bar: section.bar });
    return;
  }
  send({ cmd: 'jumpToBar', bar: section.bar, count: true });
}

// ---------- voice control ----------

// Say a section's name and Selah does what a tap on its pad does (owner,
// 2026-10-05: "let's first see if voice controls work, then we tweak at
// church"). The window owns the microphone (mic.js) and sends its sound to
// the voice process (src/voice), which sends back the names it hears.
//
// It listens for the plain names only: "Verse", never "Verse 2". A spotter
// that knows both hears the short one first, so the number is left to
// `voiceTarget`: the next section of that name after the playhead.
const plainName = (name) => String(name).replace(/[\s-]*\d+$/, '').trim();
const mic = new Mic((sound) => {
  let peak = 0;
  for (let i = 0; i < sound.length; i += 8) peak = Math.max(peak, Math.abs(sound[i]));
  state.voice.level = Math.max(peak, state.voice.level);
  api.voice.send({ cmd: 'audio', samples: sound });
});

function voiceNames(song) {
  const out = [];
  for (const s of song ? sortedSections(song) : []) {
    const n = plainName(s.name);
    if (n && !out.some((x) => sameName(x, n))) out.push(n);
  }
  return out;
}

function sendVoiceNames() {
  if (state.voice.on) api.voice.send({ cmd: 'names', names: voiceNames(state.song) });
}

// `withMic` false is for the self-test, which feeds it recordings instead.
async function setVoice(on, withMic = true) {
  const v = state.voice;
  if (on === v.on) return;
  if (!on) {
    mic.stop();
    v.on = false;
    renderVoice();
    return;
  }
  try {
    if (withMic) {
      if (!(await api.voice.askMic())) throw new Error('macOS has not allowed Selah the microphone. Allow it in System Settings, Privacy & Security, Microphone.');
      v.mic = await mic.start((state.lib.settings.voice || {}).deviceId);
    }
    v.on = true;
    sendVoiceNames();
  } catch (err) {
    mic.stop();
    toast('Voice control: ' + ((err && err.message) || err), 'error');
  }
  renderVoice();
}

function renderVoice() {
  const v = state.voice;
  const btn = $('#btnVoice');
  btn.classList.toggle('on', v.on);
  btn.title = !v.on
    ? 'Voice control: say a section\'s name to jump to it. Off.'
    : `Listening${v.mic ? ' on ' + v.mic : ''} for: ${v.names.join(', ') || 'nothing (this song has no sections)'}.` + (v.skipped && v.skipped.length ? ` Cannot listen for: ${v.skipped.join(', ')}.` : '');
}

// The section a heard name means: the next one of that name after the
// playhead (after the jump that is waiting, if there is one), else the first.
function voiceTarget(name) {
  const song = state.song;
  if (!song) return null;
  const all = sortedSections(song).filter((s) => sameName(plainName(s.name), name));
  const pending = engineReady() && state.eng.pending;
  const from = pending ? pending.bar : G.secondsToBar(song, state.pos);
  return all.find((s) => s.bar > from + 1e-6) || all[0] || null;
}

function onVoice(m) {
  const v = state.voice;
  if (m.type === 'listening') {
    v.names = m.names;
    v.skipped = m.skipped;
    renderVoice();
  } else if (m.type === 'heard' && v.on) {
    // The same name twice within two seconds is one call, or its echo.
    const now = Date.now();
    if (v.heard === m.name && now - v.at < 2000) return;
    v.heard = m.name;
    v.at = now;
    const target = voiceTarget(m.name);
    if (!target) return;
    toast(`Heard "${m.name}"`);
    jumpToSection(target);
  } else if (m.type === 'error') {
    toast('Voice control: ' + m.message, 'error');
  } else if (m.type === 'stopped' && v.on) {
    // The listener died; the next message starts it again.
    sendVoiceNames();
  }
}

api.voice.onEvent(onVoice);

function stepSection(dir) {
  const song = state.song;
  if (!song || !engineReady()) return;
  const secs = sortedSections(song);
  if (!secs.length) {
    if (dir < 0) seek(0);
    return;
  }
  const pending = state.eng.pending;
  const from = pending ? secs.find((s) => s.bar === pending.bar) : lastStarted();
  const idx = from ? secs.indexOf(from) : -1;
  const target = secs[Math.max(0, Math.min(secs.length - 1, idx + dir))];
  jumpToSection(target);
}

// ---------- songs, setlists, import ----------

// While a song is playing, opening another does not interrupt it: the other
// song is lined up (see queueSong). `force` is for the hand-over itself, when
// the engine has just said the song is over.
async function openSong(id, force) {
  const song = state.lib.songs.find((s) => s.id === id);
  if (!song || song === state.song) return;
  if (state.eng.playing && !force) {
    queueSong(song);
    return;
  }
  if (state.queued === id) state.queued = null;
  state.song = song;
  state.lib.lastSongId = id;
  state.peaks = new Map();
  state.guide = [];
  ensureLengths(song);
  renderAll();
  sendVoiceNames();
  saveSoon();
  await prepareSong(song);
}

function createSong(name) {
  const song = newSong(name);
  state.lib.songs.push(song);
  currentSetlist().songIds.push(song.id);
  return song;
}

// Everything that is dropped on the window or picked with Open comes here:
//   a folder of stems   a new song named after the folder; a cue clip found
//                       with the stems gives it its tempo and sections
//   loose audio files   added to the open song
//   cue clips (MIDI)    each a new song with tempo and sections; one on its
//                       own can instead be the structure of the open song
async function importPaths(paths) {
  const { folders, files, cues } = await api.expandPaths(paths);
  if (!folders.length && !files.length && !cues.length) {
    toast('Nothing Selah can open there. It takes stems (WAV, MP3, M4A, FLAC, OGG) and cue clips (MIDI).');
    return;
  }
  if (isLive() && files.length) {
    toast('In LIVE, drop a whole song folder. Loose files would change the open song.');
    return;
  }
  if (state.eng.playing) {
    toast('Stop playback before importing');
    return;
  }
  const twins = folders.filter((f) => songNamed(f.name));
  let replace = false;
  if (twins.length && !isLive()) {
    const pick = await askDuplicates(twins.map((f) => f.name), 'your library', 'Replace: the song takes the stems in the folder. A stem it already has takes the new file and keeps its volume, mute and output; stems that are new are added. Skip: the song is left as it is.');
    if (pick < 0) return;
    replace = pick === 0;
  }
  if (twins.length && !replace) toast(`Already in your library, left as ${twins.length === 1 ? 'it is' : 'they are'}: ${twins.map((f) => f.name).join(', ')}.`, 'long');
  for (const f of folders) {
    const old = songNamed(f.name);
    if (old && !replace) continue;
    const song = old || createSong(f.name);
    state.song = song;
    state.lib.lastSongId = song.id;
    state.peaks = new Map();
    if (old) {
      state.guide = [];
      ensureLengths(old);
    }
    await addStems(f.files, old ? true : undefined);
    if (f.cues.length === 1) {
      const [d] = await readCues(f.cues);
      if (d) {
        fillFromCue(song, d);
        if (song === state.song) resendSetup(song);
        saveSoon();
        toast(`"${song.name}": ${cueNote(d)}`, 'long');
      }
    } else if (f.cues.length) toast(`"${f.name}" has ${f.cues.length} cue clips. Drop the right one on the song.`, 'long');
  }
  if (files.length) await addStems(files);
  if (cues.length) await openCues(cues, !folders.length && !files.length);
}

// ---------- duplicates ----------
// The owner does not want two of anything by accident. When something coming
// in has the name of something already there, Selah says so and asks once for
// the whole drop: Replace brings what is there up to date, Skip leaves it.

const sameName = (a, b) => a.trim().toLowerCase() === b.trim().toLowerCase();
const songNamed = (name) => state.lib.songs.find((s) => sameName(s.name, name));

// A question with buttons; the index of the one pressed, -1 for Cancel. The
// self-test queues its answers in __app.answers.
function choose(opts) {
  const queued = window.__app.answers;
  return queued.length ? Promise.resolve(queued.shift()) : api.choose(opts);
}

// 0 Replace, 1 Skip, -1 Cancel.
function askDuplicates(names, where, what) {
  return choose({
    message: names.length === 1 ? `"${names[0]}" is already in ${where}.` : `${names.length} of these are already in ${where}.`,
    detail: (names.length > 1 ? names.join(', ') + '.\n\n' : '') + what,
    buttons: ['Replace', 'Skip'],
  });
}

// ---------- cue clips ----------
// A cue clip is a MIDI file from the Count In track of the owner's Ableton
// sets. The main process turns one into a draft (see cuefile.js): name, tempo,
// meter and sections, each with the count-in that says what the clip says.

async function readCues(paths) {
  const drafts = [];
  for (const p of paths) {
    try {
      drafts.push(await api.readCue(p));
    } catch (err) {
      toast(`Could not read ${p.split(/[\\/]/).pop()}: ${err.message.replace(/^.*Error: /, '')}`, 'error');
    }
  }
  return drafts;
}

// One line on what a cue clip gave a song, and what it could not.
function cueNote(d) {
  const calls = d.callouts.length ? ` and ${d.callouts.length} ${d.callouts.length === 1 ? 'callout' : 'callouts'}` : '';
  const out = [`${d.sections.length} sections${calls}${d.bpm ? ` at ${d.bpm} BPM` : ''} in ${d.num}/${d.den}.`];
  if (!d.bpm) out.push('No tempo in the file name: set the BPM.');
  if (d.left.length) out.push(`Left out, said before the song starts: ${Array.from(new Set(d.left)).join(', ')}.`);
  if (d.older) out.push('Read as the older rack: Interlude, Build, Bridge.');
  return out.join(' ');
}

// Gives a song the tempo, meter and sections of a cue clip. A song with stems
// keeps its own tempo when the clip's is within a beat a minute of it: that
// one was matched to the audio.
function fillFromCue(song, d) {
  if (song.double) {
    delete song.double;
    song.bpm /= 2;
    song.bars = Math.max(1, Math.ceil((song.bars || DEFAULT_BARS) / 2));
  }
  if (d.bpm && !(hasStems(song) && Math.abs(song.bpm - d.bpm) < 1)) song.bpm = d.bpm;
  song.num = d.num;
  song.den = d.den;
  if (d.speed) song.cues.speed = d.speed;
  else delete song.cues.speed;
  song.sections = d.sections.map((s) => Object.assign({ id: uid('m') }, s));
  song.callouts = d.callouts.map((c) => Object.assign({ id: uid('c') }, c));
  if (!hasStems(song)) song.bars = d.bars;
}

// `alone`: nothing else came with the clips. Then a single clip, dropped
// while a song with stems is open, is most likely that song's structure.
async function openCues(paths, alone) {
  const drafts = await readCues(paths);
  if (!drafts.length) return;
  const twins = drafts.filter((d) => songNamed(d.name));
  const fresh = drafts.filter((d) => !twins.includes(d));
  let replace = false;
  if (twins.length && !isLive()) {
    const pick = await askDuplicates(twins.map((d) => d.name), 'your library', 'Replace: the song takes the tempo and sections of the cue clip, and keeps its stems and its place in your setlists. Undo puts the old ones back. Skip: the song is left as it is.');
    if (pick < 0) return;
    replace = pick === 0;
  }
  const open = state.song;
  if (alone && drafts.length === 1 && fresh.length === 1 && open && hasStems(open) && !isLive()) {
    const d = drafts[0];
    const pick = await choose({
      message: `Use "${d.name}" as the structure of "${open.name}"?`,
      detail: "Its sections, tempo and time signature are replaced by the cue clip's. Undo puts them back.",
      buttons: ['Use for This Song', 'Make a New Song'],
    });
    if (pick < 0) return;
    if (pick === 0) {
      pushUndo();
      fillFromCue(open, d);
      resendSetup(open);
      saveSoon();
      toast(`"${open.name}": ${cueNote(d)}`, 'long');
      return;
    }
  }
  const replaced = (replace ? twins : []).map((d) => {
    const song = songNamed(d.name);
    pushUndo(undefined, song);
    fillFromCue(song, d);
    if (song === state.song) resendSetup(song);
    return song;
  });
  // One clip joins the setlist like any new song. Several go to the library
  // only, so a folder of clips does not flood the setlist.
  const made = fresh.map((d) => {
    const song = drafts.length === 1 ? createSong(d.name) : newSong(d.name);
    if (drafts.length > 1) state.lib.songs.push(song);
    fillFromCue(song, d);
    return song;
  });
  saveSoon();
  renderLists();
  const show = made[0] || replaced[0];
  if (show) await openSong(show.id);
  if (drafts.length === 1) {
    toast(show ? `"${show.name}"${replaced.length ? ' replaced' : ''}: ${cueNote(drafts[0])}` : `"${drafts[0].name}" is already in your library. Left as it is.`, 'long');
    return;
  }
  const out = [];
  if (made.length) out.push(`${made.length} ${made.length === 1 ? 'song' : 'songs'} added to the Library`);
  if (replaced.length) out.push(`${replaced.length} replaced`);
  if (twins.length > replaced.length) out.push(`${twins.length - replaced.length} already there and left as ${twins.length - replaced.length === 1 ? 'it is' : 'they are'}`);
  const left = drafts.filter((d) => replace || fresh.includes(d)).reduce((n, d) => n + d.left.length, 0);
  toast(out.join(', ') + '.' + (left ? ` ${left} ${left === 1 ? 'word' : 'words'} said before a song starts left out.` : ''), 'long');
}

// `replace`: what to do with a stem whose name the song already has, from
// another file. True takes the new file and keeps the track's volume, mute
// and output; false leaves it out; not given, Selah asks.
async function addStems(files, replace) {
  let song = state.song;
  if (!song) {
    song = createSong(folderNameOf(files[0]) || 'New Song');
    state.song = song;
    state.lib.lastSongId = song.id;
    state.peaks = new Map();
  }
  const first = song.tracks.length === 0;
  const has = (file) => song.tracks.some((t) => t.file === file);
  // Only against what the song had before: two new stems may share a name.
  const before = song.tracks.slice();
  const twin = (file) => before.find((t) => sameName(t.name, trackNameFromFile(file)));
  const twins = files.filter((file) => !has(file) && twin(file));
  if (twins.length && replace === undefined) {
    const pick = await askDuplicates(twins.map(trackNameFromFile), `"${song.name}"`, 'Replace: each one takes the new file and keeps its volume, mute and output. Skip: they are left out. Stems that are new are added either way.');
    if (pick < 0) return;
    replace = pick === 0;
  }
  for (const file of files) {
    if (has(file)) continue;
    const old = twin(file);
    if (old) {
      if (!replace) continue;
      old.file = file;
      old.stamp = 0;
      delete old.missing;
      state.peaks.delete(old.id);
      await api.cache.removeTrack({ songId: song.id, trackId: old.id });
      continue;
    }
    const name = trackNameFromFile(file);
    if (!hasStems(song)) delete song.end; // the first audio brings its own end
    song.tracks.push({ id: uid('t'), name, file, gain: 1, mute: false, solo: false, bus: guessBus(name) });
  }
  if (twins.length) toast(`${twins.length} ${twins.length === 1 ? 'stem' : 'stems'} already in "${song.name}": ${replace ? 'replaced with the new files' : 'left out'}.`, 'long');
  if (first) {
    // In-ear stems on top.
    song.tracks.sort((a, b) => (a.bus === 'cue' ? 0 : 1) - (b.bus === 'cue' ? 0 : 1));
    // No generated click on top of a click stem.
    song.click.enabled = !song.tracks.some((t) => /click|clk|metronome/i.test(t.name));
    // Likewise no spoken cues on top of a recorded guide.
    song.cues.enabled = !song.tracks.some((t) => /guide|cue/i.test(t.name));
  }
  renderAll();
  saveSoon();
  await prepareSong(song);
  // A song that comes with a click stem gets its tempo from it.
  if (first && song === state.song) await detectTempo(true);
}

async function openDialog() {
  const paths = await api.pickOpen();
  if (paths.length) await importPaths(paths);
}

async function newFromFolder() {
  const paths = await api.pickFolders();
  if (paths.length) await importPaths(paths);
}

async function newEmptySong() {
  if (state.eng.playing) {
    toast('Stop playback first');
    return;
  }
  const name = await askText('New song', '');
  if (!name) return;
  const song = createSong(name);
  saveSoon();
  await openSong(song.id);
}

// A ready-made song with no stems, for seeing the click, the spoken cues and
// the section editing work without setting anything up.
async function newSampleSong() {
  if (state.eng.playing) {
    toast('Stop playback first');
    return;
  }
  const song = createSong('Sample Song');
  song.bpm = 72;
  song.key = 'C';
  let bar = 0;
  for (const [name, len] of [['Intro', 4], ['Verse 1', 8], ['Pre-Chorus', 4], ['Chorus', 8], ['Verse 2', 8], ['Pre-Chorus', 4], ['Chorus', 8], ['Bridge', 8], ['Chorus', 8], ['Tag', 4], ['Outro', 4]]) {
    song.sections.push({ id: uid('m'), name, bar, len });
    bar += len;
  }
  song.bars = bar;
  saveSoon();
  await openSong(song.id);
}

// Deleting can be undone with Cmd+Z until the app is closed: the song's
// decoded audio is only cleared at the next start.
// Deleting asks first, unless Settings says not to: the owner finds the
// question a nuisance when he knows what he wants, others will want it.
// `done` is what to say instead when nothing is asked.
async function confirmDelete(opts, done) {
  if (state.lib.settings.confirmDelete !== false) return api.confirm(opts);
  toast(done, 'long');
  return true;
}

async function deleteSong(song) {
  if (state.eng.playing && song === state.song) {
    toast('Stop playback first');
    return;
  }
  const ok = await confirmDelete({ message: `Delete "${song.name}"?`, detail: 'Its setup (tempo, sections, mix) is removed. Your stem files are not touched. Undo brings it back until you close Selah.', button: 'Delete' }, `Deleted "${song.name}". Cmd+Z brings it back.`);
  if (!ok) return;
  const places = state.lib.setlists.map((set) => ({ id: set.id, at: set.songIds.indexOf(song.id) })).filter((x) => x.at >= 0);
  undoStack.push({ kind: 'deleted', song, places });
  redoStack.length = 0;
  state.setSel.clear(); // rows are about to shift
  state.lib.songs = state.lib.songs.filter((s) => s !== song);
  for (const set of state.lib.setlists) set.songIds = set.songIds.filter((id) => id !== song.id);
  if (state.song === song) {
    state.song = null;
    state.peaks = new Map();
    state.guide = [];
    prepToken++;
  }
  send({ cmd: 'unloadSong', songId: song.id });
  renderAll();
  saveSoon();
}

// ---------- tracks ----------

// Clears the decoded audio of songs deleted and tracks removed in an earlier
// session. Run once at startup; until then both can be undone.
function pruneCache() {
  return api.cache.keepOnly(state.lib.songs.map((x) => x.id), state.lib.songs.flatMap((x) => x.tracks.map((t) => t.id)));
}

function setTrack(t, patch) {
  Object.assign(t, patch);
  send({ cmd: 'setTrack', songId: state.song.id, id: t.id, patch: trackMessage(state.song, t) });
  for (const fn of headRefreshers) fn();
  timeline.requestDraw();
  saveSoon();
}

// Tracks are selected the way files are in Finder: a click picks one, a
// Shift-click everything from the last pick to here, a Cmd-click adds or drops
// one. A drag, the ×, Delete and the right-click menu then act on all of them.
// Nothing can be selected in LIVE.
function selectedTracks() {
  return state.song && !isLive() ? state.song.tracks.filter((t) => state.sel.has(t.id)) : [];
}

// The tracks an action started on `t` applies to.
// Menu items that send a track to one of the groups, or to the ears.
function groupItems(apply, t) {
  const now = !t ? null : t.bus === 'cue' ? earOf(t) : groupOf(t);
  const sp = state.lib.settings.split;
  return [
    ...sp.groups.map((g) => ({ label: (g.id === now ? '✓ ' : '') + g.name + ' · output ' + busLabel(g), action: () => apply({ bus: 'band', group: g.id }) })),
    '-',
    { label: (now === 'click' ? '✓ ' : '') + 'With the click · output ' + busLabel(sp.click), action: () => apply({ bus: 'cue', ear: 'click' }) },
    { label: (now === 'guide' ? '✓ ' : '') + 'With the guide · output ' + busLabel(sp.guide), action: () => apply({ bus: 'cue', ear: 'guide' }) },
  ];
}

function tracksFor(t) {
  const list = selectedTracks();
  return list.length > 1 && list.includes(t) ? list : [t];
}

function selectTrack(t, e) {
  const tracks = state.song.tracks;
  const from = tracks.findIndex((x) => x.id === state.selAnchor);
  if (e.shiftKey && from >= 0) {
    const to = tracks.indexOf(t);
    state.sel = new Set(tracks.slice(Math.min(from, to), Math.max(from, to) + 1).map((x) => x.id));
  } else {
    if (!e.metaKey && !e.ctrlKey) state.sel.clear();
    if (!state.sel.delete(t.id)) state.sel.add(t.id);
    state.selAnchor = t.id;
  }
  selectionChanged();
}

function clearSelection() {
  if (!state.sel.size) return;
  state.sel.clear();
  selectionChanged();
}

function selectionChanged() {
  for (const fn of headRefreshers) fn();
  renderCorner();
}

function renderCorner() {
  const n = state.song ? state.song.tracks.length : 0;
  const picked = selectedTracks().length;
  $('#corner').textContent = !n ? '' : picked > 1 ? `${picked} of ${n} selected` : n + ' tracks';
}

async function removeTracks(list) {
  const song = state.song;
  if (!list.length) return;
  if (state.eng.playing) {
    toast('Stop playback first');
    return;
  }
  const one = list.length === 1;
  const ok = await confirmDelete({
    message: one ? `Remove "${list[0].name}" from this song?` : `Remove ${list.length} tracks from this song?`,
    detail: (one ? 'The stem file itself is not deleted.' : list.map((t) => t.name).join(', ') + '. The stem files themselves are not deleted.') + ' Undo brings ' + (one ? 'it' : 'them') + ' back until you close Selah.',
    button: 'Remove',
  }, one ? `Removed "${list[0].name}". Cmd+Z brings it back.` : `Removed ${list.length} tracks. Cmd+Z brings them back.`);
  if (!ok) return;
  // Like a deleted song, a removed track keeps its decoded audio until the
  // next start (pruneCache), so Cmd+Z can put it back.
  undoStack.push({ kind: 'removed', id: song.id, items: song.tracks.map((track, at) => ({ track, at })).filter((it) => list.includes(it.track)) });
  redoStack.length = 0;
  song.tracks = song.tracks.filter((x) => !list.includes(x));
  for (const t of list) state.sel.delete(t.id);
  renderSong();
  saveSoon();
  if (state.out) send(loadMessage(song));
}

// Moves the given tracks, keeping their order, to sit before the track now at
// index `at` (after the last one when `at` is the number of tracks). Only the
// list changes: the engine plays the same thing in any order.
function moveTracks(list, at) {
  const song = state.song;
  if (!list.length || isLive()) return;
  list = song.tracks.filter((t) => list.includes(t));
  const before = song.tracks.slice(at).find((t) => !list.includes(t));
  const rest = song.tracks.filter((t) => !list.includes(t));
  rest.splice(before ? rest.indexOf(before) : rest.length, 0, ...list);
  if (rest.every((t, i) => t === song.tracks[i])) return;
  undoStack.push({ kind: 'order', id: song.id, ids: song.tracks.map((t) => t.id) });
  redoStack.length = 0;
  song.tracks = rest;
  renderSong();
  saveSoon();
}

// Point a track at a different file (a moved or re-exported stem) while
// keeping its volume, mute and bus.
async function replaceFile(t) {
  const song = state.song;
  if (state.eng.playing) {
    toast('Stop playback first');
    return;
  }
  const paths = await api.pickStems();
  if (!paths.length) return;
  t.file = paths[0];
  t.stamp = 0;
  delete t.missing;
  state.peaks.delete(t.id);
  await api.cache.removeTrack({ songId: song.id, trackId: t.id });
  saveSoon();
  await prepareSong(song);
}

function trackHeader(t) {
  const name = el('div.tname', { title: t.file }, t.name);
  const m = el('button.m', { title: 'Mute', onclick: () => setTrack(t, { mute: !t.mute }) }, 'M');
  const s = el('button.s', { title: 'Solo', onclick: () => setTrack(t, { solo: !t.solo }) }, 'S');
  // Two feeds: the button flips between MAINS and EARS. Separate channels:
  // it opens the list of groups.
  const bus = el('button.bus', {
    title: 'Where this track plays',
    onclick: (e) => {
      if (!splitOn()) setTrack(t, { bus: t.bus === 'cue' ? 'band' : 'cue' });
      else menu(e.clientX, e.clientY, groupItems((patch) => setTrack(t, patch), t));
    },
  });
  const vol = el('input', { type: 'range', min: -60, max: 6, step: 0.5, title: 'Volume (double-click for 0 dB)' });
  const db = el('div.db');
  const rm = el('button.rm', { title: 'Remove track', onclick: () => removeTracks(tracksFor(t)) }, '×');
  // A thin level meter along the bottom edge: what this track is putting out
  // right now, after its fader, mute and solo.
  const level = el('i');
  trackMeters.set(t.id, level);
  const head = el('div.thead', null, name, m, s, bus, el('div.vol', null, vol), db, rm, el('div.tmeter', null, level));
  vol.value = Math.max(-60, gainToDb(t.gain));
  vol.addEventListener('input', () => setTrack(t, { gain: dbToGain(parseFloat(vol.value)) }));
  const rename = async () => {
    if (isLive()) return;
    const v = await askText('Rename track', t.name);
    if (v) {
      t.name = v;
      name.textContent = v;
      saveSoon();
    }
  };
  name.addEventListener('dblclick', rename);
  head.addEventListener('click', (e) => {
    if (!isLive() && !e.target.closest('button, input')) selectTrack(t, e);
  });
  // The header drags as a whole, except from its buttons and its slider.
  head.addEventListener('mousedown', (e) => {
    head.draggable = !isLive() && !e.target.closest('button, input');
  });
  head.addEventListener('dragstart', (e) => {
    if (!state.sel.has(t.id)) selectTrack(t, {});
    e.dataTransfer.setData('text/x-track', t.id);
    e.dataTransfer.effectAllowed = 'move';
  });
  head.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    if (isLive()) return;
    if (!state.sel.has(t.id)) selectTrack(t, {});
    const list = tracksFor(t);
    if (list.length > 1) {
      menu(e.clientX, e.clientY, [
        ...(splitOn()
          ? groupItems((patch) => list.forEach((x) => setTrack(x, patch)))
          : [
              { label: `Send ${list.length} tracks to MAINS`, action: () => list.forEach((x) => setTrack(x, { bus: 'band' })) },
              { label: `Send ${list.length} tracks to EARS`, action: () => list.forEach((x) => setTrack(x, { bus: 'cue' })) },
            ]),
        '-',
        { label: `Remove ${list.length} tracks`, danger: true, action: () => removeTracks(list) },
      ]);
      return;
    }
    menu(e.clientX, e.clientY, [
      { label: 'Rename…', action: rename },
      { label: 'Replace file…', action: () => replaceFile(t) },
      '-',
      { label: 'Remove track', danger: true, action: () => removeTracks([t]) },
    ]);
  });
  const refresh = () => {
    head.className = 'thead' + (t.bus === 'cue' ? ' cue' : '') + (isAudible(t) ? '' : ' off') + (!isLive() && state.sel.has(t.id) ? ' sel' : '');
    m.classList.toggle('on', t.mute);
    s.classList.toggle('on', t.solo);
    bus.textContent = busName(t);
    bus.classList.toggle('cue', t.bus === 'cue');
    db.textContent = fmtDb(t.gain) + ' dB';
  };
  headRefreshers.push(refresh);
  refresh();
  return head;
}

// ---------- sections ----------

// A new section splits the one it lands in, or fills the gap it lands in: up
// to the next section, or to the end of the song. So marking sections in
// order works as it always did, each one running until the next.
function addSection(bar, name) {
  const song = state.song;
  ensureLengths(song);
  const id = uid('m');
  const blocks = Structure.insert(song.sections, id, bar, Math.max(1, endBarOf(song) - bar));
  if (!blocks) {
    toast(`A section already starts at bar ${barLabel(bar)}`);
    return;
  }
  pushUndo();
  song.sections.push({ id, name, bar, len: 1 });
  applyStructure(song, blocks);
  sectionsChanged();
}

// A song with no stems is at least as long as its sections.
function growToFit() {
  const song = state.song;
  if (hasStems(song)) return;
  const end = Math.ceil(Structure.end(song.sections) - 1e-6);
  if (end <= song.bars) return;
  song.bars = end;
  sendBars(song);
  lengthChanged();
}

// Undo and redo. They cover a song's setup (name, key, tempo, signature,
// length, click and guide settings, sections), the order of its tracks, and
// bring back a deleted song or removed tracks. Kept for as long as the app is
// open. The mix (volume, mute, solo) is live performance control and is not
// part of it.
const SETUP = ['name', 'key', 'bpm', 'num', 'den', 'beatUnit', 'offset', 'bars', 'end', 'double', 'click', 'cues', 'sections', 'callouts', 'atEnd'];
const undoStack = [];
const redoStack = [];

function snapshot(song) {
  const o = {};
  for (const k of SETUP) if (k in song) o[k] = song[k];
  return JSON.stringify(o);
}

// Call before changing the open song's setup. Changes with the same `key`
// within a second (a slider being dragged) count as one step.
function pushUndo(key, song = state.song) {
  const last = undoStack[undoStack.length - 1];
  const now = Date.now();
  if (key && last && last.kind === 'song' && last.id === song.id && last.key === key && now - last.at < 1000) {
    last.at = now;
    return;
  }
  undoStack.push({ kind: 'song', id: song.id, key, at: now, snap: snapshot(song) });
  if (undoStack.length > 200) undoStack.shift();
  redoStack.length = 0;
}

// Puts a saved setup back on a song and brings the engine and the screen in line.
function restoreSetup(song, snap) {
  const data = JSON.parse(snap);
  for (const k of SETUP) {
    if (k in data) song[k] = data[k];
    else delete song[k];
  }
  if (song === state.song) resendSetup(song);
}

// After the open song's setup was replaced wholesale: tells the engine and
// redraws everything.
function resendSetup(song) {
  sendBars(song);
  send({ cmd: 'setClick', songId: song.id, click: clickMessage(song) });
  send({ cmd: 'setGrid', songId: song.id, grid: gridOf(song) });
  sendCues();
  sendVoiceNames();
  renderAll();
  timeline.durationChanged();
}

function stepHistory(from, to) {
  if (isLive()) {
    toast('LIVE mode. Switch to EDIT to make changes.');
    return;
  }
  const entry = from.pop();
  if (!entry) {
    toast(from === undoStack ? 'Nothing to undo' : 'Nothing to redo');
    return;
  }
  if (entry.kind === 'deleted') {
    // Only ever on the undo side: put the song back where it was.
    state.setSel.clear();
    state.lib.songs.push(entry.song);
    for (const p of entry.places) {
      const set = state.lib.setlists.find((x) => x.id === p.id);
      if (set) set.songIds.splice(Math.min(p.at, set.songIds.length), 0, entry.song.id);
    }
    renderAll();
    saveSoon();
    toast(`"${entry.song.name}" is back`);
    return;
  }
  if (entry.kind === 'setlist') {
    // The order and the songs of a setlist, as they were.
    const set = state.lib.setlists.find((x) => x.id === entry.id);
    if (!set) return stepHistory(from, to);
    to.push({ kind: 'setlist', id: set.id, songIds: set.songIds.slice() });
    set.songIds = entry.songIds.filter((id) => state.lib.songs.some((s) => s.id === id));
    state.setSel.clear();
    renderLists();
    saveSoon();
    return;
  }
  const song = state.lib.songs.find((x) => x.id === entry.id);
  if (!song) return stepHistory(from, to);
  if (entry.kind === 'removed') {
    // Only ever on the undo side, like a deleted song: put the tracks back
    // where they were, unless the same file has been added again since.
    if (song === state.song && state.eng.playing) {
      from.push(entry);
      toast('Stop playback first');
      return;
    }
    const back = entry.items.filter((it) => !song.tracks.some((t) => t.file === it.track.file));
    for (const it of back) song.tracks.splice(Math.min(it.at, song.tracks.length), 0, it.track);
    saveSoon();
    if (song === state.song) {
      renderSong();
      prepareSong(song);
    }
    toast(back.length === 1 ? `"${back[0].track.name}" is back` : `${back.length} tracks are back`);
    return;
  }
  if (entry.kind === 'order') {
    // The order the tracks were listed in. A track added since stays last.
    to.push({ kind: 'order', id: song.id, ids: song.tracks.map((t) => t.id) });
    const at = (t) => entry.ids.indexOf(t.id) + 1 || entry.ids.length + 1;
    song.tracks.sort((a, b) => at(a) - at(b));
    if (song === state.song) renderSong();
    saveSoon();
    return;
  }
  to.push({ kind: 'song', id: song.id, at: 0, snap: snapshot(song) });
  restoreSetup(song, entry.snap);
  saveSoon();
  if (song !== state.song) toast(`Changed "${song.name}" back`);
}

function sectionsChanged() {
  sendVoiceNames();
  growToFit();
  sendBars(state.song); // the end of the last section may be where the song hands over
  sendCues();
  renderPads();
  timeline.requestDraw();
  saveSoon();
}

function pickSectionName(x, y, onPick) {
  const items = SECTION_NAMES.map((n) => ({ label: n, swatch: sectionColor({ name: n }), action: () => onPick(n) }));
  items.push('-', {
    label: 'Custom…',
    action: async () => {
      const v = await askText('Section name', '');
      if (v) onPick(v);
    },
  });
  menu(x, y, items);
}

function sectionMenu(section, x, y, mode) {
  if (isLive()) return;
  const rename = async () => {
    const v = await askText('Rename section', section.name, SECTION_NAMES);
    if (v) {
      pushUndo();
      section.name = v;
      sectionsChanged();
    }
  };
  if (mode === 'rename') return rename();
  const setCue = (v) => () => {
    pushUndo();
    if (v) section.cue = toStyle(v);
    else delete section.cue;
    sectionsChanged();
  };
  const custom = !!section.cue && !LEAD_PRESETS.some((l) => sameLead(section.cue, l));
  menu(x, y, [
    { label: (section.cue ? '' : '✓ ') + 'Guide: as set for the song', action: setCue(null) },
    ...LEAD_PRESETS.map((l) => ({ label: (section.cue && sameLead(section.cue, l) ? '✓ ' : '') + (l === 'off' ? 'No guide here' : 'Guide: ' + leadLabel(l) + ' ahead'), action: setCue(l) })),
    {
      label: (custom ? '✓ Guide: ' + leadLabel(section.cue) + ' ahead. ' : '') + 'Other lead…',
      action: async () => {
        const v = await askText('How far ahead the guide starts, for example "3 beats" or "1.5 bars"', custom ? leadLabel(section.cue) : '');
        if (v === null) return;
        const l = parseLead(v);
        if (l) setCue(l)();
        else toast('Type a number and "bars" or "beats"', 'error');
      },
    },
    '-',
    ...SWATCHES.map(([label, c]) => ({
      label,
      swatch: c,
      action: () => {
        pushUndo();
        section.color = c;
        sectionsChanged();
      },
    })),
    {
      label: 'Colour by name',
      action: () => {
        pushUndo();
        delete section.color;
        sectionsChanged();
      },
    },
  ]);
}

// ---------- callouts ----------
// A callout is a word the guide says at a point of the song that is not a
// section: a direction to the band ("All In", "Last Time"). song.callouts is
// [{ id, bar, word }]; the word "count" is a bare "1 2 3 4" into the bar line
// at `bar`. They are shown as chips under the pads, where a right-click
// changes, moves or deletes one, and as white ticks on the timeline.

const CALLOUT_WORDS = ['All In', 'Build', 'Slowly Build', 'Last Time', 'Hits', 'Break', 'Breakdown', 'Drums In', 'Swell', 'Softly', 'Hold', 'Big Ending', 'Key Change Up', 'Key Change Down', 'Worship Freely'];
const calloutLabel = (c) => (c.word === 'count' ? 'Count in' : c.word);
let voiceWords = null; // what the guide's voice can say, asked for once

// The playhead as a bar position, to the nearest beat (a bare count: to the nearest bar line).
function playheadBar(wholeBar) {
  const song = state.song;
  const per = wholeBar ? 1 : Math.max(1, Math.round(G.beatsPerBar(song)));
  return Math.max(wholeBar ? 1 : 0, Math.round(G.secondsToBar(song, state.pos) * per) / per);
}

// A word typed in by hand, or null: it has to be one the voice has.
async function askCalloutWord(now) {
  const v = await askText('A word the guide says', now || '', CALLOUT_WORDS);
  if (!v) return null;
  voiceWords = voiceWords || new Set(await api.voiceWords());
  const key = v.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  if (voiceWords.has(key)) return v.trim();
  toast(`The guide's voice has no "${v.trim()}".`, 'error');
  return null;
}

function calloutMenu(x, y, now, onPick, more) {
  menu(x, y, [
    ...CALLOUT_WORDS.map((w) => ({ label: (now && sameName(w, now) ? '✓ ' : '') + w, action: () => onPick(w) })),
    { label: (now === 'count' ? '✓ ' : '') + 'Count in (1 2 3 4)', action: () => onPick('count') },
    {
      label: 'Other word…',
      action: async () => {
        const w = await askCalloutWord(now === 'count' ? '' : now);
        if (w) onPick(w);
      },
    },
    ...(more || []),
  ]);
}

function addCallout(word) {
  const song = state.song;
  pushUndo();
  song.callouts = (song.callouts || []).concat({ id: uid('c'), bar: playheadBar(word === 'count'), word });
  sectionsChanged();
}

function editCallout(c, x, y) {
  if (isLive()) return;
  const change = (fn) => () => {
    pushUndo();
    fn();
    sectionsChanged();
  };
  calloutMenu(x, y, c.word, (w) => change(() => (c.word = w))(), [
    '-',
    { label: 'Move to the playhead', action: change(() => (c.bar = playheadBar(c.word === 'count'))) },
    { label: 'Delete callout', danger: true, action: change(() => (state.song.callouts = state.song.callouts.filter((k) => k !== c))) },
  ]);
}

function removeSection(section) {
  pushUndo();
  state.song.sections = state.song.sections.filter((s) => s !== section);
  sectionsChanged();
}

// Right-click on a pad: make this part of the song something else in one
// click (a Bridge that is really a Chorus). Its guide and colour are one step
// further, in sectionMenu. The pads are the only place with a section menu;
// the strip above the bar numbers is for dragging.
function padMenu(section, x, y) {
  if (isLive()) return;
  const rename = (name) => {
    if (!name || name === section.name) return;
    pushUndo();
    section.name = name;
    sectionsChanged();
  };
  menu(x, y, [
    ...SECTION_NAMES.map((n) => ({ label: (n === section.name ? '✓ ' : '') + n, swatch: sectionColor({ name: n }), action: () => rename(n) })),
    { label: 'Other name…', action: async () => rename(await askText('Section name', section.name, SECTION_NAMES)) },
    '-',
    { label: 'Guide and colour…', action: () => sectionMenu(section, x, y) },
    { label: 'Delete section', danger: true, action: () => removeSection(section) },
  ]);
}

// ---------- rendering ----------

function renderAll() {
  renderLists();
  renderSong();
}

function songMeta(song) {
  const d = hasStems(song) ? durationOf(song) : 0;
  return (d ? fmtTime(d) + ' · ' : '') + (Math.round(typedBpm(song) * 100) / 100) + (song.key ? ' · ' + song.key : '');
}

// ---------- selecting songs in the setlist ----------
// As for tracks and for files in Finder: Shift-click takes a run, Cmd-click
// adds or drops one, and a drag or the × then acts on every selected row. A
// plain click still opens the song. state.setSel holds positions in the open
// setlist, so it is cleared whenever the rows change. Not in LIVE, where the
// setlist is fixed.
function selectInSetlist(i, e) {
  const set = currentSetlist();
  if (e.shiftKey) {
    const open = state.song ? set.songIds.indexOf(state.song.id) : -1;
    const from = state.setAnchor !== null && state.setAnchor < set.songIds.length ? state.setAnchor : open >= 0 ? open : i;
    state.setSel = new Set();
    for (let k = Math.min(from, i); k <= Math.max(from, i); k++) state.setSel.add(k);
  } else {
    if (!state.setSel.delete(i)) state.setSel.add(i);
    state.setAnchor = i;
  }
  renderLists();
}

function clearSetSel() {
  if (!state.setSel.size) return;
  state.setSel.clear();
  renderLists();
}

// The rows an action started on row `i` applies to.
function setRowsFor(i) {
  return state.setSel.size > 1 && state.setSel.has(i) ? Array.from(state.setSel).sort((a, b) => a - b) : [i];
}

// Every change to a setlist's rows comes through here, so Cmd+Z undoes it.
function changeSetlist(set, songIds, keep) {
  undoStack.push({ kind: 'setlist', id: set.id, songIds: set.songIds.slice() });
  redoStack.length = 0;
  set.songIds = songIds;
  state.setSel = new Set(keep || []);
  state.setAnchor = null;
  renderLists();
  saveSoon();
}

function removeFromSetlist(rows) {
  const set = currentSetlist();
  changeSetlist(set, set.songIds.filter((id, k) => !rows.includes(k)));
  if (rows.length > 1) toast(`${rows.length} songs taken off the setlist. They are still in the library, and Cmd+Z puts them back.`, 'long');
}

// Moves rows to where row `to` is: above it when they come from below, below
// it when they come from above, which is what dragging one row has always done.
function moveInSetlist(rows, to) {
  const set = currentSetlist();
  if (rows.includes(to)) return;
  const moving = rows.map((k) => set.songIds[k]);
  const rest = set.songIds.map((id, k) => ({ id, k })).filter((x) => !rows.includes(x.k));
  const at = rest.findIndex((x) => x.k === to) + (rows[0] < to ? 1 : 0);
  const out = rest.map((x) => x.id);
  out.splice(at, 0, ...moving);
  changeSetlist(set, out, rows.length > 1 ? moving.map((id, n) => at + n) : null);
}

function renderLists() {
  const lib = state.lib;
  const set = currentSetlist();
  if (state.setSelFor !== set.id) {
    state.setSelFor = set.id;
    state.setSel.clear();
    state.setAnchor = null;
  }
  const sel = $('#setSelect');
  sel.replaceChildren(...lib.setlists.map((s) => el('option', { value: s.id, selected: s.id === set.id }, s.name)));

  const list = $('#setlist');
  list.replaceChildren();
  set.songIds.forEach((id, i) => {
    const song = lib.songs.find((s) => s.id === id);
    if (!song) return;
    const coming = song === comingSong();
    const li = el(
      'li' + (song === state.song ? '.current' : '') + (coming ? '.coming' : '') + (coming && state.queued === id ? '.byhand' : '') + (!isLive() && state.setSel.has(i) ? '.sel' : ''),
      { draggable: !isLive(), title: (coming ? 'Up next. ' : '') + (isLive() ? 'Click to open, or to line it up while a song plays' : 'Click to open, or to line it up while a song plays. Shift-click or Cmd-click to select several. Drag to reorder.') },
      el('span.idx', null, i + 1),
      el('span.nm', null, song.name),
      el('span.meta', null, songMeta(song)),
      el(
        'button',
        {
          title: 'Remove from this setlist',
          onclick: (e) => {
            e.stopPropagation();
            removeFromSetlist(setRowsFor(i));
          },
        },
        '×'
      )
    );
    li.addEventListener('click', (e) => {
      if (!isLive() && (e.shiftKey || e.metaKey || e.ctrlKey)) return selectInSetlist(i, e);
      clearSetSel();
      state.setAnchor = i;
      openSong(id);
    });
    li.addEventListener('dragstart', (e) => e.dataTransfer.setData('text/x-setlist-index', String(i)));
    li.addEventListener('dragover', (e) => {
      if (e.dataTransfer.types.includes('text/x-setlist-index')) {
        e.preventDefault();
        li.classList.add('dragover');
      }
    });
    li.addEventListener('dragleave', () => li.classList.remove('dragover'));
    li.addEventListener('drop', (e) => {
      const from = parseInt(e.dataTransfer.getData('text/x-setlist-index'), 10);
      li.classList.remove('dragover');
      if (isNaN(from) || from === i || isLive()) return;
      e.preventDefault();
      e.stopPropagation();
      moveInSetlist(setRowsFor(from), i);
    });
    list.append(li);
  });
  if (!set.songIds.length) list.append(el('div.hint', null, 'This setlist is empty. Add songs from the library below, or drop a folder of stems on the window.'));

  const library = $('#library');
  library.replaceChildren();
  for (const song of lib.songs.slice().sort((a, b) => a.name.localeCompare(b.name))) {
    const li = el(
      'li' + (song === state.song ? '.current' : ''),
      { title: isLive() ? 'Click to add to the end of the setlist' : 'Click to open' },
      el('span.nm', null, song.name),
      el('span.meta', null, songMeta(song)),
      el(
        'button',
        {
          title: 'Add to the setlist',
          onclick: (e) => {
            e.stopPropagation();
            set.songIds.push(song.id);
            renderLists();
            saveSoon();
          },
        },
        '+'
      ),
      el(
        'button.del',
        {
          title: 'Delete song',
          onclick: (e) => {
            e.stopPropagation();
            deleteSong(song);
          },
        },
        '🗑'
      )
    );
    // In LIVE only the setlist's songs open. An unplanned song is first added
    // to the end of the setlist, which is a deliberate second step.
    li.addEventListener('click', () => {
      if (!isLive()) return openSong(song.id);
      if (set.songIds.includes(song.id)) return toast(`"${song.name}" is already in the setlist`);
      set.songIds.push(song.id);
      renderLists();
      saveSoon();
      toast(`Added "${song.name}" to the end of the setlist`);
    });
    library.append(li);
  }
  if (!lib.songs.length) library.append(el('div.hint', null, 'No songs yet. Press + Song and choose "Sample song" to see how it works.'));
}

function renderSong() {
  const song = state.song;
  // A selection belongs to the song it was made in.
  if (state.selSong !== (song && song.id)) {
    state.selSong = song && song.id;
    state.sel.clear();
  }
  $('#main').classList.toggle('nosong', !song);
  headRefreshers = [];
  trackMeters = new Map();
  const rows = $('#rows');
  rows.replaceChildren();
  const canvases = new Map();
  if (song) {
    $('#songName').value = song.name;
    $('#songBpm').value = typedBpm(song);
    $('#songNum').value = song.num;
    $('#songDen').value = song.den;
    $('#songOffset').value = song.offset;
    // Lining the bars up with the audio only means something when there is
    // audio. Without stems these would just push the count-in into the song.
    const align = hasStems(song) || song.offset !== 0;
    for (const id of ['#btnDetect', '#offsetWrap', '#btnOffsetHere']) $(id).style.display = align ? '' : 'none';
    $('#songKey').value = song.key || '';
    $('#clickOn').checked = !!song.click.enabled;
    $('#clickGain').value = Math.max(-40, gainToDb(song.click.gain));
    $('#cuesOn').checked = !!song.cues.enabled;
    renderHint();
    renderLiveInfo();
    for (const t of song.tracks) {
      const canvas = el('canvas');
      rows.append(el('div.row', null, trackHeader(t), canvas));
      canvases.set(t.id, canvas);
    }
    renderCorner();
    $('#clockTotal').textContent = '/ ' + fmtTime(durationOf(song));
  } else {
    $('#corner').textContent = '';
    $('#clockTotal').textContent = '/ 0:00';
  }
  // With no stems the section pads take the room the tracks would (see .nostems).
  $('#main').classList.toggle('nostems', !!song && !song.tracks.length);
  $('#empty').hidden = !!song;
  timeline.setCanvases(canvases);
  renderPads();
}

// Seconds between two spoken counts at the song's own tempo. 6/8 is counted
// in eighths, like the engine does.
function countSeconds(song) {
  // The same counts as the engine's cues: six eighths in 6/8 and in 3/4, beats elsewhere.
  const counts = G.isCompound(song) && song.num <= 7 ? song.num : song.num === 3 && song.den === 4 ? 6 : Math.max(1, Math.round(G.beatsPerBar(song)));
  return (G.barSeconds(song) / counts) * scaleOf(song);
}

// A song is fast for the guide when the counts come quicker than the voice
// can say them clearly; about 180 BPM in 4/4.
function cuesTooFast(song) {
  return !!song && song.cues.enabled && song.cues.speed !== 'half' && countSeconds(song) < 0.335;
}

// The Song settings button turns amber on a fast song, where the guide's count
// would blur, to suggest slowing the guide down.
function renderHint() {
  const fast = cuesTooFast(state.song);
  const btn = $('#btnSongSettings');
  btn.classList.toggle('suggest', fast);
  btn.title = (fast ? 'This song is fast, so the guide\'s count will blur. Try Half-time under Guide. ' : '') + 'Click, guide and tempo settings for this song';
}

let padEls = [];
function renderPads() {
  const pads = $('#pads');
  pads.replaceChildren();
  padEls = [];
  const song = state.song;
  if (!song) return;
  const secs = sortedSections(song);
  secs.forEach((s, i) => {
    const key = i < 9 ? String(i + 1) : i === 9 ? '0' : '';
    const pad = el('button.pad', { onclick: () => jumpToSection(s, true) }, el('span.k', null, (key ? key + ' · ' : '') + 'bar ' + barLabel(s.bar)), el('span.n', null, s.name));
    pad.style.setProperty('--c', sectionColor(s));
    pad.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      padMenu(s, e.clientX, e.clientY);
    });
    pads.append(pad);
    padEls.push({ section: s, pad });
  });
  const calls = (song.callouts || []).slice().sort((a, b) => a.bar - b.bar);
  if (calls.length) {
    const row = el('div.callouts', null, 'Callouts');
    for (const c of calls) {
      const chip = el('div.callout', { title: 'The guide says this here. Right-click to change, move or delete it.' }, el('span.k', null, 'bar ' + barLabel(c.bar)), el('span.n', null, calloutLabel(c)));
      chip.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        editCallout(c, e.clientX, e.clientY);
      });
      row.append(chip);
    }
    pads.append(row);
  }
  if (!secs.length) pads.append(el('div.hint', null, 'No sections yet. Put the playhead on a bar and press "+ Section", or double-click the strip above the bar numbers.'));
  if (!song.tracks.length) pads.append(el('div.hint', null, 'This song has no stems: Selah plays its click and guide. Drop a folder of stems on the window to add backing tracks.'));
  lastPadKey = null; // the new pads get their current and pending highlight on the next frame
}

function renderAudioButton() {
  const btn = $('#btnAudio');
  const out = state.out;
  if (!out) {
    btn.textContent = 'Audio…';
    return;
  }
  const used = activeBuses();
  const routingBad = ![...used.band, ...used.cue].every(busInRange);
  btn.className = !out.ok || state.stalled ? 'bad' : routingBad || out.fellBack ? 'warn' : '';
  btn.textContent = state.stalled ? 'Audio stopped: the device is not taking sound' : !out.ok ? 'No audio output' : `${out.deviceName} · ${out.sampleRate / 1000} kHz · ` + (splitOn() ? `click ${busLabel(used.cue[0])} · guide ${busLabel(used.cue[1])} · ${used.band.length} groups` : `mains ${busLabel(used.band[0])} · ears ${busLabel(used.cue[0])}`);
  btn.title = state.stalled
    ? 'The audio device has stopped taking sound, so the song is standing still. A sleeping Mac or a closed lid does this. It should carry on when the Mac is awake; if it does not, open this and choose the device again.'
    : routingBad
      ? 'Something is routed to outputs this device does not have, so it is silent.'
      : 'Audio device and output routing';
}

// ---------- audio settings ----------

function showAudioSettings() {
  const body = el('div.form');
  const settings = state.lib.settings;

  const apply = () => {
    saveSoon();
    openOutput();
  };

  const refresh = () => {
    const out = state.out;
    const apis = state.devices ? state.devices.apis : [];
    const activeApi = out ? out.apiId : settings.audio.apiId;
    const devices = (apis.find((a) => a.id === activeApi) || { devices: [] }).devices;
    const channels = out ? out.channels : 2;

    const apiSel = el(
      'select',
      {
        onchange: (e) => {
          settings.audio.apiId = e.target.value;
          settings.audio.deviceName = null;
          apply();
        },
      },
      apis.map((a) => el('option', { value: a.id, selected: a.id === activeApi, disabled: !a.devices.length }, `${a.name}${a.devices.length ? '' : ' (no devices)'}`))
    );
    const devSel = el(
      'select',
      {
        onchange: (e) => {
          settings.audio.apiId = activeApi;
          settings.audio.deviceName = e.target.value;
          apply();
        },
      },
      devices.map((d) => el('option', { value: d.name, selected: out && d.name === out.deviceName }, `${d.name} — ${d.channels} outputs`))
    );
    const rateSel = el(
      'select',
      {
        onchange: (e) => {
          settings.audio.sampleRate = parseInt(e.target.value, 10);
          apply();
        },
      },
      [44100, 48000, 88200, 96000].map((r) => el('option', { value: r, selected: r === settings.audio.sampleRate }, r / 1000 + ' kHz'))
    );
    const bufSel = el(
      'select',
      {
        onchange: (e) => {
          settings.audio.buffer = e.target.value;
          apply();
        },
      },
      Object.entries(BUFFERS).map(([id, b]) => el('option', { value: id, selected: id === (settings.audio.buffer || 'normal') }, `${b.label} (${Math.round(((b.frameSize * b.queueBlocks) / settings.audio.sampleRate) * 1000)} ms)`))
    );

    const routeOptions = [];
    for (let c = 0; c + 1 < channels; c += 2) routeOptions.push({ mode: 'stereo', ch: c, label: `Outputs ${c + 1}–${c + 2} (stereo)` });
    for (let c = 0; c < channels; c++) routeOptions.push({ mode: 'mono', ch: c, label: `Output ${c + 1} (mono)` });
    const setBus = (id, patch) => {
      Object.assign(settings.buses[id], patch);
      sendBuses();
      renderAudioButton();
      saveSoon();
      refresh();
    };
    const routeSel = (id) => {
      const bus = settings.buses[id];
      const opts = routeOptions.slice();
      if (!opts.some((o) => o.mode === bus.mode && o.ch === bus.ch)) opts.unshift({ mode: bus.mode, ch: bus.ch, label: `${bus.mode === 'mono' ? 'Output ' + (bus.ch + 1) : 'Outputs ' + busLabel(bus)} — not on this device` });
      return el(
        'select',
        {
          onchange: (e) => {
            const o = opts[e.target.selectedIndex];
            setBus(id, { mode: o.mode, ch: o.ch });
          },
        },
        opts.map((o) => el('option', { selected: o.mode === bus.mode && o.ch === bus.ch }, o.label))
      );
    };
    const gainRow = (id) => {
      const bus = settings.buses[id];
      const label = el('span', null, fmtDb(bus.gain) + ' dB');
      const input = el('input', { type: 'range', min: -40, max: 6, step: 0.5, title: 'Output level (double-click for 0 dB)' });
      input.value = Math.max(-40, gainToDb(bus.gain));
      input.addEventListener('input', () => {
        bus.gain = dbToGain(parseFloat(input.value) <= -40 ? -60 : parseFloat(input.value));
        label.textContent = fmtDb(bus.gain) + ' dB';
        sendBuses();
        saveSoon();
      });
      return el('div', { style: { display: 'flex', gap: '8px', alignItems: 'center' } }, input, el('span', { style: { width: '60px', textAlign: 'right' } }, label));
    };
    const preset = (label, band, cue, need) =>
      el(
        'button',
        {
          disabled: channels < need,
          onclick: () => {
            Object.assign(settings.buses.band, band);
            setBus('cue', cue);
          },
        },
        label
      );

    // Separate channels: the click, the guide, and one row for each group
    // of tracks with its name, its output (mono or a stereo pair) and a
    // button to take it away.
    const anyRoute = (bus) => {
      const opts = routeOptions.slice();
      if (!opts.some((o) => o.mode === bus.mode && o.ch === bus.ch)) opts.unshift({ mode: bus.mode, ch: bus.ch, label: `${bus.mode === 'mono' ? 'Output ' + (bus.ch + 1) : 'Outputs ' + busLabel(bus)} — not on this device` });
      return el(
        'select',
        {
          onchange: (e) => {
            const o = opts[e.target.selectedIndex];
            Object.assign(bus, { mode: o.mode, ch: o.ch });
            resendRouting();
            refresh();
          },
        },
        opts.map((o) => el('option', { selected: o.mode === bus.mode && o.ch === bus.ch }, o.label))
      );
    };
    const splitRows = () => {
      const sp = settings.split;
      const use = (next) => {
        settings.split = next;
        resendRouting();
        refresh();
      };
      const rows = [el('span.lbl', null, 'Click'), anyRoute(sp.click), el('span.lbl', null, 'Guide'), anyRoute(sp.guide)];
      sp.groups.forEach((g, i) => {
        const name = el('input', { type: 'text', value: g.name, style: { width: '90px' }, title: 'The name of this group of tracks' });
        name.addEventListener('change', () => {
          g.name = name.value.trim() || 'Group ' + (i + 1);
          resendRouting();
          refresh();
        });
        const drop = el('button', { title: 'Take this group away. Its tracks go to another group.', disabled: sp.groups.length < 2, onclick: () => use(Object.assign({}, sp, { groups: sp.groups.filter((x) => x !== g) })) }, '×');
        rows.push(el('span.lbl', null, 'Tracks ' + (i + 1)), el('div.groupRow', { style: { display: 'flex', gap: '4px' } }, name, anyRoute(g), drop));
      });
      const fresh = () => 'g' + (Math.max(0, ...sp.groups.map((g) => parseInt(g.id.slice(1), 10) || 0)) + 1);
      const next = () => Math.min(Math.max(0, channels - 1), Math.max(1, ...sp.groups.map((g) => g.ch + (g.mode === 'stereo' ? 1 : 0))) + 1);
      rows.push(
        el('span.lbl', null, ''),
        el(
          'div',
          { style: { display: 'flex', gap: '4px', flexWrap: 'wrap' } },
          el('button', { id: 'btnAddGroup', disabled: sp.groups.length >= 16, onclick: () => use(Object.assign({}, sp, { groups: sp.groups.concat({ id: fresh(), name: 'Group ' + (sp.groups.length + 1), mode: 'mono', ch: next(), gain: 1 }) })) }, '+ Group'),
          el('button', { id: 'btnDante8', title: 'Click on output 1, guide on 2, six groups of tracks on 3 to 8, one output each', onclick: () => use(defaultSplit(false)) }, '8 channels: click 1, guide 2, six groups'),
          el('button', { title: 'Click on output 1, guide on 2, three stereo groups of tracks on 3–4, 5–6 and 7–8', onclick: () => use(defaultSplit(true)) }, '8 channels: click 1, guide 2, three stereo groups')
        ),
        el('div.note.full', null, 'Each track goes out through one group: Selah picks it from the stem\'s name (Bass to Bass, Piano to Keys), and the button on a track changes it. Levels are left to the desk: everything goes out at the level of its own slider.')
      );
      return rows;
    };

    const notes = [];
    if (out && !out.ok) notes.push(el('div.note.bad.full', null, out.error || 'No audio output is open.'));
    if (out && out.fellBack) notes.push(el('div.note.warn.full', null, `The saved device "${settings.audio.deviceName}" was not found, so the default device is in use.`));
    const used = activeBuses();
    if (![...used.band, ...used.cue].every(busInRange)) notes.push(el('div.note.warn.full', null, (splitOn() ? 'Something' : 'Mains or ears') + ' is routed to outputs this device does not have. It stays silent rather than being sent to outputs 1–2.'));
    if (out && out.ok && !splitOn() && settings.buses.band.mode === settings.buses.cue.mode && settings.buses.band.ch === settings.buses.cue.ch) notes.push(el('div.note.full', null, 'Mains and ears share the same outputs, so the click is in the main mix. Fine for rehearsing on headphones; split them for a service.'));
    if (state.eng.underruns > 0) notes.push(el('div.note.warn.full', null, `${state.eng.underruns} dropout(s) since this output was opened. Try the Safe buffer.`));
    if (out && out.ok) notes.push(el('div.note.full', null, `${out.apiName} · ${out.channels} outputs · ${out.sampleRate} Hz · about ${out.latencyMs} ms buffered`));

    body.replaceChildren(
      el('h4', null, 'DEVICE'),
      el('span.lbl', null, 'Driver'),
      apiSel,
      el('span.lbl', null, 'Device'),
      devSel,
      el('span.lbl', null, 'Sample rate'),
      rateSel,
      el('span.lbl', null, 'Buffer'),
      bufSel,
      el('h4', null, 'OUTPUT ROUTING'),
      el('span.lbl', null, 'Layout'),
      pickFrom(
        [
          [false, 'Two feeds: mains and ears'],
          [true, 'Separate channels: click, guide and groups of tracks'],
        ],
        splitOn(),
        (v) => {
          if (!settings.split) settings.split = defaultSplit();
          settings.split.on = v;
          resendRouting();
          refresh();
        },
        'setLayout'
      ),
      ...(splitOn()
        ? splitRows()
        : [
            el('span.lbl', null, 'Mains (band)'),
            routeSel('band'),
            el('span.lbl', null, 'Ears (click, guide)'),
            routeSel('cue'),
            el('span.lbl', null, 'Presets'),
            el(
              'div',
              { style: { display: 'flex', gap: '4px', flexWrap: 'wrap' } },
              preset('Ears 1, mains 2 (as in the Ableton set)', { mode: 'mono', ch: 1 }, { mode: 'mono', ch: 0 }, 2),
              preset('Ears 1, mains 3–4', { mode: 'stereo', ch: 2 }, { mode: 'mono', ch: 0 }, 4),
              preset('Mains 1–2, ears 3–4', { mode: 'stereo', ch: 0 }, { mode: 'stereo', ch: 2 }, 4),
              preset('Everything to 1–2', { mode: 'stereo', ch: 0 }, { mode: 'stereo', ch: 0 }, 2)
            ),
          ]),
      el('span.lbl', null, 'Check'),
      el(
        'div',
        { style: { display: 'flex', gap: '8px', alignItems: 'center' } },
        el('button', { id: 'btnTestOutputs', disabled: !(out && out.ok) || state.eng.playing, onclick: () => send({ cmd: 'testOutputs', on: state.testCh == null }) }, state.testCh == null ? 'Check outputs' : 'Stop'),
        el('span', { id: 'testNow' }, state.testCh == null ? 'Says each output\'s number on that output, one after another, at full level past the routing above.' : `Output ${state.testCh + 1} of ${channels} is sounding`)
      ),
      ...(splitOn() ? [] : [el('h4', null, 'OUTPUT LEVELS'), el('span.lbl', null, 'Mains'), gainRow('band'), el('span.lbl', null, 'Ears'), gainRow('cue')]),
      ...notes,
      el('div.row-end.full', null, el('button', { onclick: () => send({ cmd: 'getDevices' }) }, 'Rescan devices'), el('button.primary', { onclick: () => m.close() }, 'Done'))
    );
  };

  const m = modal('AUDIO', body, {
    onClose: () => {
      audioDialog = null;
      send({ cmd: 'testOutputs', on: false });
    },
  });
  audioDialog = { refresh };
  refresh();
}

// ---------- settings ----------

function pickFrom(options, value, onPick, id) {
  return el(
    'select',
    { id, onchange: (e) => onPick(options[e.target.selectedIndex][0]) },
    options.map(([v, label]) => el('option', { selected: v === value }, label))
  );
}

// Two bars of a click on its own, in the open song's time signature and
// tempo (4/4 at 100 with no song open): what choosing a sound in the Sound
// list plays, through wherever the click goes. The song is not touched. With
// the song running there is nothing to demo: the change is heard as it is made.
function previewClick(click) {
  if (!state.out) return;
  if (state.eng.playing) {
    toast('The song is playing, so this is the click you are hearing.');
    return;
  }
  const song = state.song;
  const grid = song ? gridOf(song) : { bpm: 100, num: 4, den: 4, beatUnit: 'quarter' };
  const scale = song ? scaleOf(song) : 1;
  send({ cmd: 'previewClick', grid: Object.assign({}, grid, { offset: 0 }), click: Object.assign({ gain: 1 }, click, { bus: 'click', scale }), bars: 2 * scale });
}

// Closing the window a demo was started from cuts it short: the choice is made.
function stopPreview() {
  send({ cmd: 'stopPreview' });
}

// The click's sound and pattern, for one song or for the defaults.
// hooks: { before(key), after(redraw) } around each change.
function clickRows(click, hooks, ids) {
  const sampled = click.sound !== 'beep';
  const set = (key, v, redraw) => {
    hooks.before();
    click[key] = v;
    hooks.after(redraw);
  };
  const sounds = [...state.clickSounds.map((s) => [s.id, s.name]), ['beep', 'Beep']];
  return [
    el('span.lbl', null, 'Sound'),
    // Choosing a sound plays it, so the list can be listened through. There
    // was a Listen button beside it as well; the owner had it taken out as
    // one thing too many.
    pickFrom(
      sounds,
      click.sound ? soundHere(click.sound) : 'beep',
      (v) => {
        set('sound', v, true);
        previewClick(click);
      },
      ids && 'setClickSound'
    ),
    el('span.lbl', null, 'Eighth notes'),
    pickFrom(
      [
        [true, 'On: ticks twice per beat'],
        [false, 'Off: beats only'],
      ],
      click.sub !== false,
      (v) => set('sub', v),
      ids && 'setClickSub'
    ),
    el('span.lbl', null, 'Accent'),
    pickFrom(
      [
        [2, 'Twice a bar (standard)'],
        [1, 'Every beat'],
        ['bar', 'Once a bar'],
      ],
      click.main === 'bar' || click.main === 1 ? click.main : 2,
      (v) => set('main', v),
      ids && 'setClickMain'
    ),
  ];
}

// How far ahead of a section the guide starts.
function leadRow(cues, key, hooks, id) {
  const cur = cues[key];
  const kind = cur === 'auto' ? 'auto' : cur && typeof cur === 'object' ? 'custom' : NAMED_LEADS[cur] ? cur : 'off';
  const pick = pickFrom(
    [
      ['auto', 'Automatic (recommended)'],
      ['two', '2 bars'],
      ['one', '1 bar'],
      ['half', '½ bar'],
      ['off', 'Nothing'],
      ['custom', 'Other…'],
    ],
    kind,
    (v) => {
      hooks.before();
      cues[key] = v === 'custom' ? { n: 2, unit: 'beats' } : v;
      hooks.after(true);
    },
    id
  );
  if (kind !== 'custom') return pick;
  pick.style.width = '170px';
  const l = leadOf(cur);
  const num = el('input', { type: 'number', min: 0.5, max: 16, step: 0.5, value: l.n, style: { width: '64px' } });
  const set = () => {
    const n = Math.max(0.5, Math.min(16, parseFloat(num.value) || 1));
    num.value = n;
    hooks.before();
    cues[key] = { n, unit: unit.value };
    hooks.after();
  };
  const unit = pickFrom(
    [
      ['bars', 'bars'],
      ['beats', 'beats'],
    ],
    l.unit,
    set
  );
  unit.style.width = '90px';
  num.addEventListener('change', set);
  return el('div', { style: { display: 'flex', gap: '6px', alignItems: 'center' } }, pick, num, unit);
}

// The guide's level and count-ins, for one song or for the defaults.
function guideRows(cues, hooks, ids) {
  const level = el('span', null, fmtDb(cues.gain) + ' dB');
  const gain = el('input', { type: 'range', min: -40, max: 6, step: 0.5, title: 'Guide level (double-click for 0 dB)' });
  gain.value = Math.max(-40, gainToDb(cues.gain));
  gain.addEventListener('input', () => {
    hooks.before('guideGain');
    cues.gain = dbToGain(parseFloat(gain.value) <= -40 ? -60 : parseFloat(gain.value));
    level.textContent = fmtDb(cues.gain) + ' dB';
    hooks.after();
  });
  return [
    el('span.lbl', null, 'Level'),
    el('div', { style: { display: 'flex', gap: '8px', alignItems: 'center' } }, gain, el('span', { style: { width: '60px', textAlign: 'right' } }, level)),
    el('span.lbl', null, 'Before the song'),
    leadRow(cues, 'start', hooks, ids && 'setLeadStart'),
    el('span.lbl', null, 'Before each section'),
    leadRow(cues, 'section', hooks, ids && 'setLeadSection'),
    el('div.note.full', null, 'Automatic counts in two bars before the song ("Intro · 2 · 1 2 3 4") and one bar before each section ("Verse 2 3 4"). 3/4 and 6/8 get their own usual counts. A section called Tag gets no guide.'),
  ];
}

// Settings for the open song: tempo details, its click and its guide.
function showSongSettings() {
  const song = state.song;
  if (!song || isLive()) return;
  const body = el('div.form');
  const click = song.click;
  const cues = song.cues;
  // Each control takes its own undo step; `key` lets a dragged slider count as one.
  const before = (key) => pushUndo(key || 'settings' + Date.now());
  const clickChanged = () => {
    send({ cmd: 'setClick', songId: song.id, click: clickMessage(song) });
    saveSoon();
  };
  const cuesChanged = () => {
    sendCues();
    renderHint();
    saveSoon();
  };

  const refresh = () => {
    const rows = [el('h4', null, 'TEMPO')];
    rows.push(
      el('span.lbl', null, 'Fast song'),
      pickFrom(
        [
          [false, 'No'],
          [true, 'Yes: count bars at double speed'],
        ],
        !!song.double,
        () => {
          if (toggleDoubleBars()) refresh();
        },
        'setDouble'
      ),
      el('div.note.full', null, 'For a fast song, type the tempo the way Ableton shows it (72, not 144) and say Yes here. It sounds the same, and bars, sections and jumps follow the song\'s real, faster bars.')
    );
    if (song.den !== 4) {
      rows.push(
        el('span.lbl', null, 'BPM counts'),
        pickFrom(
          [
            ['quarter', 'Quarter notes (standard, as in Ableton)'],
            ['auto', 'Dotted quarters'],
            ['den', 'The signature\'s own note'],
          ],
          song.beatUnit || 'auto',
          (v) => {
            before();
            song.beatUnit = v;
            gridChanged();
          },
          'setBeatUnit'
        )
      );
    }
    if (!hasStems(song)) {
      const bars = el('input', { id: 'setBars', type: 'number', min: 1, max: 4000, step: 1, value: song.bars, style: { width: '80px' } });
      bars.addEventListener('change', () => {
        before();
        song.bars = Math.max(1, Math.min(4000, parseInt(bars.value, 10) || DEFAULT_BARS));
        bars.value = song.bars;
        sendBars(song);
        lengthChanged();
        saveSoon();
      });
      rows.push(el('span.lbl', null, 'Length'), el('div', { style: { display: 'flex', gap: '6px', alignItems: 'center' } }, bars, el('span.note', null, 'bars. It grows by itself if you play past the end.')));
    }

    const usual = AT_END.find(([v]) => v === (state.lib.settings.atEnd || 'stop'))[1];
    rows.push(
      el('h4', null, 'WHEN THIS SONG ENDS'),
      el('span.lbl', null, 'At the end'),
      pickFrom(
        [[null, `As in Settings: ${usual.charAt(0).toLowerCase() + usual.slice(1)}`], ...AT_END],
        song.atEnd || null,
        (v) => {
          before();
          if (v) song.atEnd = v;
          else delete song.atEnd;
          sendBars(song);
          renderLists();
          saveSoon();
        },
        'setSongEnd'
      )
    );

    rows.push(el('h4', null, 'CLICK'));
    rows.push(
      ...clickRows(
        click,
        {
          before,
          after: (redraw) => {
            clickChanged();
            if (redraw) refresh();
          },
        },
        true
      )
    );
    rows.push(
      el('span.lbl', null, 'Speed'),
      pickFrom(
        [
          ['', 'Normal'],
          ['half', 'Half-time: ticks half as often'],
          ['double', 'Double-time: ticks twice as often'],
        ],
        click.feel === 'half' || click.feel === 'double' ? click.feel : '',
        (v) => {
          before();
          if (v) click.feel = v;
          else delete click.feel;
          clickChanged();
        },
        'setClickFeel'
      )
    );

    rows.push(el('h4', null, 'GUIDE'));
    rows.push(
      ...guideRows(
        cues,
        {
          before,
          after: (redraw) => {
            cuesChanged();
            if (redraw) refresh();
          },
        },
        true
      )
    );
    rows.push(
      el('span.lbl', null, 'Speed'),
      pickFrom(
        [
          ['', 'Normal'],
          ['half', 'Half-time: counts half as fast, starts earlier'],
          ['double', 'Double-time: counts twice as fast'],
        ],
        cues.speed === 'half' || cues.speed === 'double' ? cues.speed : '',
        (v) => {
          before();
          if (v) cues.speed = v;
          else delete cues.speed;
          cuesChanged();
        },
        'setGuideSpeed'
      ),
      el('div.note.full', null, 'Speed changes only the click or only the guide. The song\'s tempo, bars and sections stay as they are. To give one section its own guide, right-click its pad.')
    );
    rows.push(
      el(
        'div.row-end.full',
        null,
        el(
          'button',
          {
            title: 'Set this song\'s click and guide to what Settings says new songs start with',
            onclick: () => {
              before();
              const d = state.lib.settings.defaults;
              Object.assign(click, d.click);
              Object.assign(cues, { gain: d.cues.gain, start: d.cues.start, section: d.cues.section });
              clickChanged();
              cuesChanged();
              refresh();
            },
          },
          'Use my defaults'
        ),
        el('button.primary', { onclick: () => m.close() }, 'Done')
      )
    );
    body.replaceChildren(...rows);
  };

  const m = modal('SONG SETTINGS: ' + song.name.toUpperCase(), body, { onClose: stopPreview });
  refresh();
}

// App-wide settings: what new songs start with and how the section pads behave.
function showSettings() {
  if (isLive()) return;
  const settings = state.lib.settings;
  const d = settings.defaults;
  const body = el('div.form');
  let micList = [];
  Mic.inputs().then((list) => {
    micList = list;
    refresh();
  });
  const refresh = () => {
    body.replaceChildren(
      el('h4', null, 'PLAYBACK'),
      el('span.lbl', null, 'Pausing'),
      pickFrom(
        [
          [false, 'Holds its place'],
          [true, 'Goes back to the start of the song'],
        ],
        !!settings.pauseRewinds,
        (v) => {
          settings.pauseRewinds = v;
          saveSoon();
        },
        'setPause'
      ),
      el('span.lbl', null, 'When a song ends'),
      pickFrom(
        AT_END,
        settings.atEnd || 'stop',
        (v) => {
          settings.atEnd = v;
          if (state.song) sendBars(state.song);
          renderLists();
          saveSoon();
        },
        'setAtEnd'
      ),
      el('div.note.full', null, 'A song with stems ends where its audio ends. A song with no stems ends after its last section when it is to hand over; set to "Stops there" it has no end and keeps going. One song can do something else: see its Song settings. While a song plays, a click on another song lines it up without interrupting.'),
      el('h4', null, 'KEY'),
      el('span.lbl', null, 'This copy'),
      el('div', { style: { display: 'flex', gap: '8px', alignItems: 'center' } }, el('span', { id: 'keyLevel' }, state.keyLevel === 'full' ? 'Full key' : 'Basic key'), el('button', { id: 'btnChangeKey', onclick: changeKey }, 'Enter another key…')),
      el('h4', null, 'VOICE CONTROL'),
      el('span.lbl', null, 'Microphone'),
      pickFrom(
        [['', 'The computer\'s own choice']].concat(micList.map((m) => [m.id, m.label || 'Microphone ' + (micList.indexOf(m) + 1)])),
        (settings.voice || {}).deviceId || '',
        (v) => {
          settings.voice = { deviceId: v };
          saveSoon();
          // Listening already: move to the new microphone.
          if (state.voice.on) setVoice(false).then(() => setVoice(true));
        },
        'setMic'
      ),
      el('div.note.full', null, 'The Voice button in the top bar switches it on; it is off every time Selah starts. Say a section\'s name, "chorus" or "bridge", and Selah does what a tap on its pad does, with the count. Say the name without its number: "verse" goes to the next verse. It listens on this computer only; nothing is sent anywhere. Use in-ears or headphones: through speakers it hears Selah\'s own guide.'),
      el('h4', null, 'DELETING'),
      el('span.lbl', null, 'Confirm delete'),
      pickFrom(
        [
          [true, 'On: ask before deleting'],
          [false, 'Off: delete straight away'],
        ],
        settings.confirmDelete !== false,
        (v) => {
          settings.confirmDelete = v;
          saveSoon();
        },
        'setConfirm'
      ),
      el('div.note.full', null, 'Asks before a song, tracks or a setlist are deleted; switched off they go at once, and Cmd+Z still brings back a song or tracks until you close Selah.'),
      el('h4', null, 'SECTION PADS'),
      el('span.lbl', null, 'Tap while stopped'),
      pickFrom(
        [
          [false, 'Moves the playhead there'],
          [true, 'Starts playing from that section\'s count-in'],
        ],
        !!settings.launch,
        (v) => {
          settings.launch = v;
          saveSoon();
        },
        'setLaunch'
      ),
      el('div.note.full', null, 'A tap while playing is always counted in: the guide says "Chorus 2 3 4" and the jump lands after that bar, even on a song whose own guide is off. A section called Tag is never announced.'),
      el('h4', null, 'NEW SONGS START WITH: CLICK'),
      ...clickRows(d.click, { before: () => {}, after: () => saveSoon() }),
      el('h4', null, 'NEW SONGS START WITH: GUIDE'),
      el('span.lbl', null, 'Guide voice'),
      pickFrom(
        [
          [true, 'On'],
          [false, 'Off'],
        ],
        d.cues.enabled !== false,
        (v) => {
          d.cues.enabled = v;
          saveSoon();
        }
      ),
      ...guideRows(d.cues, {
        before: () => {},
        after: (redraw) => {
          saveSoon();
          if (redraw) refresh();
        },
      }),
      el('div.note.full', null, 'These apply to songs you make from now on. A song that comes with its own click or guide stem starts with Selah\'s click or guide switched off.'),
      el(
        'div.row-end.full',
        null,
        el(
          'button',
          {
            onclick: async () => {
              const ok = await api.confirm({ message: 'Set every song\'s click and guide to these?', detail: 'Changes the click sound and pattern and the guide\'s level and count-ins on all songs. Whether click and guide are on or off stays as it is on each song.', button: 'Apply to every song' });
              if (!ok) return;
              for (const song of state.lib.songs) {
                Object.assign(song.click, d.click);
                Object.assign(song.cues, { gain: d.cues.gain, start: d.cues.start, section: d.cues.section });
              }
              if (state.song) {
                send({ cmd: 'setClick', songId: state.song.id, click: clickMessage(state.song) });
                sendCues();
              }
              saveSoon();
              toast('Applied to every song');
            },
          },
          'Apply to every song…'
        ),
        el('button.primary', { onclick: () => m.close() }, 'Done')
      )
    );
  };
  const m = modal('SETTINGS', body, { onClose: stopPreview });
  refresh();
}

// EDIT and LIVE. LIVE is for the service: nothing can be edited, the setlist
// is the one that was open when it started, and the keyboard always runs
// playback. The mix, the pads and moving from song to song stay live, and an
// unplanned song can still be added to the end of the setlist.
function setLive(on) {
  state.lib.settings.live = !!on;
  document.body.classList.toggle('live', !!on);
  $('#modeEdit').classList.toggle('on', !on);
  $('#modeLive').classList.toggle('on', !!on);
  if (on && document.activeElement && document.activeElement !== document.body) document.activeElement.blur();
  if (on) clearSelection();
  if (on) state.setSel.clear();
  renderLiveInfo();
  renderLists();
  timeline.durationChanged();
  saveSoon();
}

// Leaving LIVE takes a deliberate yes, so it cannot happen by a stray click.
async function leaveLive() {
  if (!isLive()) return;
  const ok = await api.confirm({ message: 'Leave LIVE?', detail: 'Editing is unlocked again. Do this after the service.', button: 'Switch to EDIT' });
  if (ok) setLive(false);
}

// In LIVE the song bar shrinks to one line saying what is loaded.
function renderLiveInfo() {
  const song = state.song;
  $('#liveInfo').textContent = song ? [song.name, Math.round(typedBpm(song) * 100) / 100 + ' BPM', song.num + '/' + song.den, song.key].filter(Boolean).join('  ·  ') : 'No song open';
}

// "Fast song" (2× bars): rewrite the song at double tempo without changing
// how it sounds or where anything is in time. The bars run twice as fast, so
// every bar number and length doubles; the click and the guide stay at the
// typed tempo. Switching it off halves them again. Returns whether it switched.
function toggleDoubleBars() {
  const song = state.song;
  if (!song) return false;
  if (state.eng.playing) {
    toast('Stop playback first');
    return false;
  }
  pushUndo();
  const k = song.double ? 0.5 : 2;
  if (k === 2) song.double = true;
  else delete song.double;
  song.bpm *= k;
  for (const s of song.sections) {
    s.bar *= k;
    if (s.len > 0) s.len *= k;
  }
  for (const c of song.callouts || []) c.bar *= k;
  if (song.end > 0) song.end *= k;
  song.bars = Math.max(1, Math.ceil((song.bars || DEFAULT_BARS) * k));
  $('#songBpm').value = typedBpm(song);
  sendBars(song);
  send({ cmd: 'setClick', songId: song.id, click: clickMessage(song) });
  gridChanged();
  sectionsChanged();
  return true;
}

// ---------- song bar ----------

// The length shown and drawn follows the tempo when a song has no stems.
function lengthChanged() {
  $('#clockTotal').textContent = '/ ' + fmtTime(durationOf(state.song));
  timeline.durationChanged();
}

function gridChanged() {
  const song = state.song;
  const wasFast = $('#btnSongSettings').classList.contains('suggest');
  renderHint();
  if (cuesTooFast(song) && !wasFast) toast('Fast song: the guide\'s count will blur at this tempo. In Song settings, try Half-time under Guide.');
  send({ cmd: 'setGrid', songId: song.id, grid: gridOf(song) });
  renderPads();
  renderLists();
  lengthChanged();
  saveSoon();
}

function setBpm(v) {
  if (!isFinite(v)) return;
  // `v` is the tempo as typed; with "2× bars" on, the bars run at twice that.
  const k = scaleOf(state.song);
  pushUndo('bpm');
  state.song.bpm = Math.max(20, Math.min(400, Math.round(v * 100) / 100)) * k;
  $('#songBpm').value = typedBpm(state.song);
  gridChanged();
}

// The Detect button, and (`quiet`) what happens by itself when stems that
// include a click are first added. A click stem is read tick by tick
// (clicktrack.js), which gives the tempo exactly; anything else goes through
// the general detector. Nothing is asked: the song is set, a note says to
// what, and Cmd+Z puts it back.
async function detectTempo(quiet) {
  const song = state.song;
  if (!song || !state.out) return;
  const usable = song.tracks.filter((t) => !t.missing && t.channels);
  const click = usable.find((t) => namedLike('click', t.name));
  if (quiet && !click) return;
  const pick = click || usable.find((t) => /drum|kit|perc|loop/i.test(t.name)) || usable.find((t) => t.bus === 'band') || usable[0];
  if (!pick) {
    toast('Import stems first');
    return;
  }
  if (!quiet) toast(`Analysing "${pick.name}"…`);
  await new Promise((r) => setTimeout(r, 40));
  try {
    const rate = state.out.sampleRate;
    const pcm = await loadPcm(song.id, pick.id, rate);
    const ticks = pick === click ? window.ClickTrack.analyze(pcm, pick.channels, rate, window.ClickTrack.hintFrom([song.name, ...song.tracks.map((t) => t.file)])) : null;
    const res = ticks || window.Tempo.detect(pcm, pick.channels, rate);
    if (!res || song !== state.song) {
      if (!quiet && !res) toast(`No steady beat found in "${pick.name}"`, 'error');
      return;
    }
    pushUndo('bpm');
    song.offset = res.offset;
    $('#songOffset').value = song.offset;
    if (ticks && ticks.signature === 'heard') {
      song.num = ticks.num;
      song.den = ticks.den;
    }
    setBpm(res.bpm / scaleOf(song));
    if (ticks && ticks.signature === 'heard') renderSong();
    const what = `${res.bpm} BPM${ticks && ticks.signature === 'heard' ? ' in ' + ticks.num + '/' + ticks.den : ''}, bar 1 at ${res.offset.toFixed(3)} s (from "${pick.name}").`;
    if (ticks && !ticks.steady) toast(`${what} Its tempo changes at ${fmtTime(ticks.changes[0])}; Selah keeps one tempo for a song, so bars after that will not line up.`, 'long');
    else toast(what + (ticks ? ' Cmd+Z if that is wrong, or type the BPM.' : ' Check the bar lines against the waveform.'), quiet ? 'long' : undefined);
  } catch (err) {
    if (!quiet) toast('Tempo detection failed: ' + err.message, 'error');
  }
}

function bindSongBar() {
  const onSong = (sel, evt, fn) =>
    $(sel).addEventListener(evt, (e) => {
      if (state.song) fn(e.target);
    });
  onSong('#songName', 'change', (t) => {
    pushUndo();
    state.song.name = t.value.trim() || 'Untitled';
    t.value = state.song.name;
    renderLists();
    saveSoon();
  });
  onSong('#songBpm', 'change', (t) => setBpm(parseFloat(t.value)));
  onSong('#songNum', 'change', (t) => {
    pushUndo();
    state.song.num = Math.max(1, Math.min(24, parseInt(t.value, 10) || 4));
    t.value = state.song.num;
    gridChanged();
  });
  onSong('#songDen', 'change', (t) => {
    pushUndo();
    state.song.den = parseInt(t.value, 10);
    gridChanged();
  });
  onSong('#songOffset', 'change', (t) => {
    pushUndo();
    state.song.offset = Math.max(0, parseFloat(t.value) || 0);
    t.value = state.song.offset;
    gridChanged();
  });
  onSong('#songKey', 'change', (t) => {
    pushUndo();
    state.song.key = t.value.trim();
    renderLists();
    saveSoon();
  });
  const clickChanged = () => {
    send({ cmd: 'setClick', songId: state.song.id, click: clickMessage(state.song) });
    saveSoon();
  };
  onSong('#clickOn', 'change', (t) => {
    pushUndo();
    state.song.click.enabled = t.checked;
    clickChanged();
  });
  onSong('#clickGain', 'input', (t) => {
    pushUndo('clickGain');
    state.song.click.gain = dbToGain(parseFloat(t.value) <= -40 ? -60 : parseFloat(t.value));
    clickChanged();
  });
  onSong('#cuesOn', 'change', (t) => {
    pushUndo();
    state.song.cues.enabled = t.checked;
    sendCues();
    renderHint();
    saveSoon();
  });
  $('#btnSongSettings').onclick = showSongSettings;
  $('#btnDetect').onclick = () => detectTempo();
  $('#btnOffsetHere').onclick = () => {
    if (!state.song) return;
    pushUndo();
    state.song.offset = Math.round(state.pos * 1000) / 1000;
    $('#songOffset').value = state.song.offset;
    gridChanged();
  };
  $('#btnAddSection').onclick = (e) => {
    const song = state.song;
    if (!song) return;
    const minBar = Math.floor(G.secondsToBar(song, 0));
    const bar = Math.max(minBar, Math.round(G.secondsToBar(song, state.pos)));
    const r = e.target.getBoundingClientRect();
    pickSectionName(r.left, r.bottom + 2, (name) => addSection(bar, name));
  };
  $('#btnAddCallout').onclick = (e) => {
    if (!state.song) return;
    const r = e.target.getBoundingClientRect();
    calloutMenu(r.left, r.bottom + 2, null, addCallout);
  };
  $('#btnImport').onclick = openDialog;
  $('#btnZoomIn').onclick = () => timeline.setZoom(timeline.pps * 1.4);
  $('#btnZoomOut').onclick = () => timeline.setZoom(timeline.pps / 1.4);
  $('#btnZoomFit').onclick = () => timeline.fit();
}

// ---------- sidebar ----------

function bindSidebar() {
  $('#setSelect').addEventListener('change', (e) => {
    state.lib.currentSetlistId = e.target.value;
    renderLists();
    saveSoon();
  });
  $('#btnSetMenu').onclick = (e) => {
    const r = e.target.getBoundingClientRect();
    const lib = state.lib;
    const set = currentSetlist();
    menu(r.left, r.bottom + 2, [
      {
        label: 'New setlist…',
        action: async () => {
          const name = await askText('New setlist', '');
          if (!name) return;
          const s = { id: uid('set'), name, songIds: [] };
          lib.setlists.push(s);
          lib.currentSetlistId = s.id;
          renderLists();
          saveSoon();
        },
      },
      {
        label: 'Duplicate',
        action: () => {
          const s = { id: uid('set'), name: set.name + ' copy', songIds: set.songIds.slice() };
          lib.setlists.push(s);
          lib.currentSetlistId = s.id;
          renderLists();
          saveSoon();
        },
      },
      {
        label: 'Rename…',
        action: async () => {
          const name = await askText('Rename setlist', set.name);
          if (!name) return;
          set.name = name;
          renderLists();
          saveSoon();
        },
      },
      '-',
      {
        label: 'Delete setlist',
        danger: true,
        action: async () => {
          if (lib.setlists.length < 2) {
            toast('This is the only setlist');
            return;
          }
          const ok = await confirmDelete({ message: `Delete the setlist "${set.name}"?`, detail: 'The songs stay in the library.', button: 'Delete' }, `Deleted the setlist "${set.name}". Its songs are still in the library.`);
          if (!ok) return;
          lib.setlists = lib.setlists.filter((s) => s !== set);
          lib.currentSetlistId = lib.setlists[0].id;
          renderLists();
          saveSoon();
        },
      },
    ]);
  };
  $('#btnNewSong').onclick = (e) => {
    const r = e.target.getBoundingClientRect();
    menu(r.left, r.bottom + 2, [
      { label: 'Open stems or a cue clip…', action: openDialog },
      // Only macOS can offer files and folders in one dialog.
      ...(api.platform === 'darwin' ? [] : [{ label: 'From a folder of stems…', action: newFromFolder }]),
      { label: 'Empty song…', action: newEmptySong },
      { label: 'Sample song', action: newSampleSong },
    ]);
  };
}

// ---------- input ----------

function bindGlobal() {
  $('#btnPlay').onclick = togglePlay;
  $('#btnStop').onclick = stop;
  $('#btnFade').onclick = fadeOut;
  $('#btnPrev').onclick = () => stepSection(-1);
  $('#btnNext').onclick = () => stepSection(1);
  $('#btnAudio').onclick = showAudioSettings;
  $('#btnVoice').onclick = () => setVoice(!state.voice.on);
  $('#btnSettings').onclick = showSettings;
  $('#modeLive').onclick = () => setLive(true);
  $('#modeEdit').onclick = leaveLive;
  $('#btnStems').onclick = () => api.openStemsFolder();
  $('#nextInfo').onclick = () => send({ cmd: 'cancelJump' });

  // Double-clicking any level slider sets it to unity, 0 dB. Every slider in
  // the app is a level in dB, so this one rule covers them all, including
  // ones added later.
  document.addEventListener('dblclick', (e) => {
    const t = e.target;
    if (t.tagName !== 'INPUT' || t.type !== 'range' || Number(t.min) > 0 || Number(t.max) < 0) return;
    t.value = 0;
    t.dispatchEvent(new Event('input', { bubbles: true }));
  });

  // A dropdown keeps the keyboard after a choice is made, which would leave
  // Space and the number keys dead. Hand it back.
  document.addEventListener('change', (e) => {
    if (e.target.tagName === 'SELECT' && $('#overlay').hidden) e.target.blur();
  });

  document.addEventListener('keydown', (e) => {
    const tag = e.target.tagName;
    // Locked, the keyboard always belongs to playback.
    const typing = !isLive() && tag === 'INPUT' && e.target.type !== 'range' && e.target.type !== 'checkbox';
    if (typing || (!isLive() && tag === 'SELECT') || !$('#overlay').hidden || e.ctrlKey || (e.metaKey && e.key !== 'Backspace') || e.altKey) {
      if (typing && e.key === 'Enter') e.target.blur();
      return;
    }
    if (e.code === 'Space') {
      e.preventDefault();
      if (document.activeElement && document.activeElement !== document.body) document.activeElement.blur();
      togglePlay();
    } else if (e.key === 'Enter') stop();
    else if (e.key === 'ArrowLeft') stepSection(-1);
    else if (e.key === 'ArrowRight') stepSection(1);
    else if (e.key === 'Home') seek(0);
    else if (e.key === 'f' || e.key === 'F') fadeOut();
    else if (e.key === 'Escape') {
      send({ cmd: 'cancelJump' });
      clearSelection();
      clearSetSel();
    } else if ((e.key === 'Backspace' || e.key === 'Delete') && selectedTracks().length) removeTracks(selectedTracks());
    else if ((e.key === 'Backspace' || e.key === 'Delete') && state.setSel.size && !isLive()) removeFromSetlist(Array.from(state.setSel));
    else if (/^[0-9]$/.test(e.key) && state.song) {
      const s = sortedSections(state.song)[e.key === '0' ? 9 : parseInt(e.key, 10) - 1];
      if (s) jumpToSection(s, true);
    } else return;
    e.preventDefault();
  });

  // Dragging the selected tracks up or down the list reorders them. A line
  // shows where they will land: above the row under the pointer's upper half.
  const rows = $('#rows');
  const dropIndex = (e) => {
    const list = Array.from(rows.children);
    const i = list.findIndex((r) => {
      const box = r.getBoundingClientRect();
      return e.clientY < box.top + box.height / 2;
    });
    return i < 0 ? list.length : i;
  };
  const markDrop = (i) => {
    Array.from(rows.children).forEach((r, k, all) => {
      r.classList.toggle('dropabove', k === i);
      r.classList.toggle('dropbelow', i === all.length && k === all.length - 1);
    });
  };
  rows.addEventListener('dragover', (e) => {
    if (!e.dataTransfer.types.includes('text/x-track')) return;
    e.preventDefault();
    markDrop(dropIndex(e));
  });
  rows.addEventListener('dragleave', (e) => {
    if (!rows.contains(e.relatedTarget)) markDrop(-1);
  });
  rows.addEventListener('drop', (e) => {
    if (!e.dataTransfer.types.includes('text/x-track')) return;
    e.preventDefault();
    markDrop(-1);
    moveTracks(selectedTracks(), dropIndex(e));
  });
  document.addEventListener('dragend', () => markDrop(-1));
  rows.addEventListener('click', (e) => {
    if (e.target === rows) clearSelection();
  });

  // Dropping stems or a folder of stems anywhere on the window imports them.
  const tl = $('#timeline');
  window.addEventListener('dragover', (e) => {
    if (e.dataTransfer.types.includes('Files')) {
      e.preventDefault();
      tl.classList.add('drop');
    }
  });
  window.addEventListener('dragleave', (e) => {
    if (!e.relatedTarget) tl.classList.remove('drop');
  });
  window.addEventListener('drop', (e) => {
    tl.classList.remove('drop');
    if (!e.dataTransfer.files.length) return;
    e.preventDefault();
    importPaths(Array.from(e.dataTransfer.files, (f) => api.pathForFile(f)).filter(Boolean));
  });

  api.onMenu(async (action) => {
    if (isLive() && action !== 'audioSettings' && action !== 'zoomIn' && action !== 'zoomOut') {
      toast('LIVE mode. Switch to EDIT to make changes.');
      return;
    }
    if (action === 'newSong') newEmptySong();
    else if (action === 'sampleSong') newSampleSong();
    else if (action === 'open') openDialog();
    else if (action === 'newFromFolder') newFromFolder();
    else if (action === 'audioSettings') showAudioSettings();
    else if (action === 'zoomIn') timeline.setZoom(timeline.pps * 1.4);
    else if (action === 'zoomOut') timeline.setZoom(timeline.pps / 1.4);
    else if (action === 'undo' || action === 'redo') {
      // In a text box, undo the typing; anywhere else, the last section edit.
      const a = document.activeElement;
      const typing = a && a.tagName === 'INPUT' && a.type !== 'range' && a.type !== 'checkbox';
      if (typing) document.execCommand(action);
      else if (action === 'undo') stepHistory(undoStack, redoStack);
      else stepHistory(redoStack, undoStack);
    }
  });
}

// ---------- per-frame updates ----------

// Each track's own meter, from the levels in the engine's last report,
// falling back between reports the way the MAINS and EARS meters do.
function updateTrackMeters() {
  const e = state.eng;
  const heard = e.tracks || {};
  for (const [id, bar] of trackMeters) {
    const hold = Math.max(heard[id] || 0, (trackHold.get(id) || 0) * 0.9);
    trackHold.set(id, hold < 0.0005 ? 0 : hold);
    const db = hold > 0.0005 ? 20 * Math.log10(hold) : -100;
    bar.style.width = Math.max(0, Math.min(100, ((db + 54) / 54) * 100)) + '%';
    bar.classList.toggle('hot', hold >= 0.999);
  }
  e.tracks = null;
}

const meterHold = { band: 0, cue: 0 };
let soonFor = null; // the song whose coming change has been announced
let lastPadKey = '';
let lastUnderruns = 0;

function busLevel(bus) {
  const p = state.eng.peaks || [];
  if (bus.mode === 'mono') return p[bus.ch] || 0;
  return Math.max(p[bus.ch] || 0, p[bus.ch + 1] || 0);
}

// The playback position right now: the engine's last report, carried forward.
function livePos() {
  const e = state.eng;
  if (!engineReady()) return 0;
  return e.playing ? Math.min(durationOf(state.song), e.pos + (Date.now() - e.at) / 1000) : e.pos;
}

// What the top bar says is coming, and when: a queued jump, or the section
// ahead, or before playing from the top, the count-in.
function nextReadout(pos) {
  const song = state.song;
  const e = state.eng;
  if (!song || !engineReady()) return { text: '', queued: false };
  const howLong = (sec) => howLongFor(song, sec);
  if (e.pending) {
    const target = sortedSections(song).find((x) => x.bar === e.pending.bar);
    return { text: `→ ${target ? target.name : 'bar ' + barLabel(e.pending.bar)} in ${howLong(Math.max(0, e.pending.at - pos))}`, queued: true };
  }
  if (e.playing) {
    const ahead = sortedSections(song).find((x) => G.barToSeconds(song, x.bar) > pos + 0.02);
    return { text: ahead ? `Next: ${ahead.name} in ${howLong(G.barToSeconds(song, ahead.bar) - pos)}` : '', queued: false };
  }
  const countIn = pos === 0 && state.guide.length && state.guide[0].sec < -0.01 ? -state.guide[0].sec : 0;
  return { text: countIn ? `Starts with a ${howLong(countIn).replace(/ (bar|beat)s?$/, '-$1')} count-in` : '', queued: false };
}

// Everything the window redraws as time passes. `tick` runs it once a frame;
// the self-test runs it by hand too, because a test window that is covered
// by other windows is not given frames.
function drawFrame() {
  const e = state.eng;
  const song = state.song;
  const ready = engineReady();
  const pos = livePos();
  state.pos = pos;
  timeline.frame(pos, ready && e.playing);

  $('#btnPlay').classList.toggle('on', ready && e.playing);
  $('#btnPlay').textContent = ready && e.playing ? '⏸' : '▶';
  $('#clockTime').textContent = fmtTime(pos, true);

  if (song) {
    const loc = G.locate(song, pos);
    $('#barBeat').textContent = loc.bar >= 0 ? `${loc.bar + 1}.${loc.beat + 1}` : `-${-loc.bar}.${loc.beat + 1}`;
    const cur = currentSection();
    const pending = ready && e.pending ? sortedSections(song).find((s) => s.bar === e.pending.bar) : null;
    $('#nowSection').textContent = pos < 0 ? 'Count-in' : cur ? cur.name : song.name;
    const coming = nextReadout(pos);
    const next = $('#nextInfo');
    next.textContent = coming.text;
    next.classList.toggle('queued', coming.queued);
    const after = songReadout(pos);
    const ns = $('#nextSong');
    const nsName = ns.querySelector('.nm');
    const nsDetail = ns.querySelector('.lbl');
    if (nsName.textContent !== after.name) nsName.textContent = after.name;
    if (nsDetail.textContent !== after.detail) nsDetail.textContent = after.detail;
    ns.className = (after.soon ? 'soon' : '') + (after.last ? ' last' : '') + (after.byHand ? ' byhand' : '');
    // Said once more, where it is hard to miss, as the last bars begin.
    if (after.soon && soonFor !== song.id) toast(after.text, 'long');
    soonFor = after.soon ? song.id : null;
    const key = (cur ? cur.id : '') + '|' + (pending ? pending.id : '');
    if (key !== lastPadKey) {
      lastPadKey = key;
      for (const p of padEls) {
        p.pad.classList.toggle('current', p.section === cur);
        p.pad.classList.toggle('pending', p.section === pending);
      }
      timeline.requestDraw();
    }
  } else {
    $('#barBeat').textContent = '1.1';
    $('#nowSection').textContent = '—';
    $('#nextInfo').textContent = '';
    $('#nextSong .nm').textContent = '';
    $('#nextSong .lbl').textContent = '';
  }
  $('#btnFade').classList.toggle('on', ready && !!e.fading);

  const used = activeBuses();
  for (const id of ['band', 'cue']) {
    const level = Math.max(0, ...used[id].map(busLevel));
    meterHold[id] = Math.max(level, meterHold[id] * 0.9);
    const db = meterHold[id] > 0 ? 20 * Math.log10(meterHold[id]) : -100;
    const bar = $(id === 'band' ? '#meterBand' : '#meterCue');
    bar.style.width = Math.max(0, Math.min(100, ((db + 54) / 54) * 100)) + '%';
    bar.classList.toggle('hot', meterHold[id] >= 0.999);
  }
  e.peaks = [];
  updateTrackMeters();
  // The Voice button's bar: how loud the microphone is, falling back.
  $('#btnVoice i').style.width = (state.voice.on ? Math.min(100, Math.round(Math.sqrt(state.voice.level) * 100)) : 0) + '%';
  state.voice.level *= 0.85;

  if (e.underruns !== lastUnderruns) {
    if (e.underruns > lastUnderruns) toast(`Audio dropout detected (${e.underruns} total). Consider the Safe buffer in Audio settings.`, 'error');
    lastUnderruns = e.underruns;
  }
}

function tick() {
  drawFrame();
  requestAnimationFrame(tick);
}

// ---------- start ----------

// Selah asks for a key once on each computer (see `key:try` in main.js) and
// does not start until it has one. There are two: the basic key, and the
// full key, which also brings the owner's own click (`state.keyLevel`).
async function askKey() {
  let level = await api.key.state();
  while (!level) {
    const key = await askText('Selah BETA: enter your key', '');
    if (key) level = await api.key.try(key);
    if (key && !level) toast('That is not a key.', 'error');
  }
  state.keyLevel = level;
}

// Settings: put in another key, to go from the basic one to the full one.
async function changeKey() {
  const key = await askText('Enter a key', '');
  if (!key) return;
  const level = await api.key.try(key);
  if (!level) {
    toast('That is not a key.', 'error');
    return;
  }
  // Start again, so every sound list and the engine agree.
  saveNow();
  setTimeout(() => location.reload(), 200);
}

async function start() {
  await askKey();
  const saved = await api.loadLibrary();
  state.lib = saved && saved.songs ? saved : defaultLib();
  state.clickSounds = await api.clickSounds().catch(() => state.clickSounds);
  if (!state.lib.setlists || !state.lib.setlists.length) Object.assign(state.lib, { setlists: defaultLib().setlists });
  if (!state.lib.settings) state.lib.settings = defaultLib().settings;
  if (!state.lib.settings.defaults) state.lib.settings.defaults = songDefaults();
  // Songs saved before spoken cues and click-only songs existed keep behaving as they did.
  const older = (state.lib.version || 1) < LIB_VERSION;
  state.lib.version = LIB_VERSION;
  for (const song of state.lib.songs) {
    if (!song.cues) song.cues = { enabled: false, gain: 1, start: 'two', section: 'one' };
    if (older) followAbleton(song);
    if (!song.bars) song.bars = DEFAULT_BARS;
    ensureLengths(song);
    // For one evening (2026-10-05) a click or guide stem could be made "the
    // song's own" and lose its lane; the owner had that taken out. A stem
    // marked that way is an ordinary track again, on the ears, with Selah's
    // own click or voice off so nothing is doubled.
    for (const t of song.tracks) {
      if (!t.role) continue;
      (t.role === 'click' ? song.click : song.cues).enabled = false;
      delete t.role;
      t.bus = 'cue';
    }
    delete song.click.source;
    delete song.cues.source;
  }

  timeline = new Timeline({
    getSong: () => state.song,
    getPeaks: (id) => state.peaks.get(id),
    getDuration: () => durationOf(state.song),
    isAudible,
    getPendingBar: () => (engineReady() && state.eng.pending ? state.eng.pending.bar : null),
    getCurrentSection: currentSection,
    getMaxBar: () => (hasStems(state.song) ? Math.max(0, endBarOf(state.song) - 1) : Infinity),
    getGuide: () => state.guide,
    isLocked: isLive,
    onSeek: seek,
    onEditStart: pushUndo,
    onEditMove: growToFit,
    onEditEnd: sectionsChanged,
    onEndMove: moveSongEnd,
    onEndDone: songEndMoved,
    onEndReset: resetSongEnd,
    onEndMenu: songEndMenu,
    getEndSnap: () => endSnap(state.song),
    getEndTip: () => 'The end of the song. Drag it to cut the song short or make it longer. Right-click: how finely it snaps.' + (state.song && hasStems(state.song) ? ' Double-click: back to the end of the audio.' : ''),
    onSectionMenu: sectionMenu,
    onAddSectionAt: (bar) => pickSectionName(window.innerWidth / 2 - 70, 120, (name) => addSection(bar, name)),
  });

  bindGlobal();
  renderVoice();
  bindSongBar();
  bindSidebar();
  if (state.lib.settings.locked) state.lib.settings.live = true; // the Lock button became LIVE mode
  delete state.lib.settings.locked;
  setLive(isLive());
  api.appInfo().then((info) => {
    $('#about').textContent = 'v' + info.version + (info.build ? '  ·  ' + info.build.commit + '  ·  ' + info.build.date : '  ·  from source');
  });
  pruneCache();

  state.song = state.lib.songs.find((s) => s.id === state.lib.lastSongId) || null;
  renderAll();
  renderAudioButton();
  requestAnimationFrame(tick);
  send({ cmd: 'getDevices' });
}

// Hooks for the automated self-test (npm run selftest).
window.__app = { state, importPaths, openSong, createSong, newSampleSong, detectTempo, addSection, jumpToSection, send, undo: () => stepHistory(undoStack, redoStack), redo: () => stepHistory(redoStack, undoStack), deleteSong, setLive, selectedTracks, pruneCache, cueMessage, songReadout: () => songReadout(livePos()), sendBars, previewClick, drawFrame, setVoice, voiceTarget, engineBuses, trackMessage, clickMessage, resendRouting, defaultSplit, answers: [], readout: () => nextReadout(livePos()), getTimeline: () => timeline };

start();
