'use strict';
// End-to-end check of the real app: `npm run selftest`.
// Generates stems, imports them through the UI code path, plays them on the
// real output at low volume, and checks sync, tempo detection, routing,
// bar-line jumps and saving. Uses its own data folder, never the real library.
const fs = require('fs');
const os = require('os');
const path = require('path');

//
// Optional environment variables:
//   SELFTEST_SECONDS=300 SELFTEST_PADS=9   a realistic 14-stem, 5-minute song
//   SELFTEST_EXTRA=<audio file>            also import this file (e.g. an MP3)
//   SELAH_SILENT=1                         run everything but send silence to the device

const SRC_RATE = 44100; // differs from the 48 kHz engine rate on purpose
const BPM = 100;
const FIRST_BEAT = 0.5;
const SECONDS = parseInt(process.env.SELFTEST_SECONDS, 10) || 40;
const PADS = parseInt(process.env.SELFTEST_PADS, 10) || 0;
const BEAT = 60 / BPM;

function writeWav(file, channels, render) {
  const frames = SRC_RATE * SECONDS;
  const data = Buffer.alloc(44 + frames * channels * 2);
  data.write('RIFF', 0);
  data.writeUInt32LE(36 + frames * channels * 2, 4);
  data.write('WAVEfmt ', 8);
  data.writeUInt32LE(16, 16);
  data.writeUInt16LE(1, 20);
  data.writeUInt16LE(channels, 22);
  data.writeUInt32LE(SRC_RATE, 24);
  data.writeUInt32LE(SRC_RATE * channels * 2, 28);
  data.writeUInt16LE(channels * 2, 32);
  data.writeUInt16LE(16, 34);
  data.write('data', 36);
  data.writeUInt32LE(frames * channels * 2, 40);
  for (let i = 0; i < frames; i++) {
    for (let c = 0; c < channels; c++) {
      const v = Math.max(-1, Math.min(1, render(i / SRC_RATE, c, i)));
      data.writeInt16LE(Math.round(v * 32767), 44 + (i * channels + c) * 2);
    }
  }
  fs.writeFileSync(file, data);
}

// Time since the most recent beat, and that beat's index (-1 before the first).
function beatAt(t) {
  const k = Math.floor((t - FIRST_BEAT) / BEAT + 1e-9);
  return k < 0 ? { k: -1, dt: 0 } : { k, dt: t - FIRST_BEAT - k * BEAT };
}

// Yields between files so the main process is never blocked for long.
async function makeStems(dir) {
  const breathe = () => new Promise((r) => setTimeout(r, 20));
  writeWav(path.join(dir, '01 Click.wav'), 1, (t) => {
    const { k, dt } = beatAt(t);
    if (k < 0 || dt > 0.02) return 0;
    return Math.sin(2 * Math.PI * (k % 4 === 0 ? 2000 : 1000) * dt) * Math.exp(-dt / 0.004) * 0.8;
  });
  writeWav(path.join(dir, '02 Guide.wav'), 1, (t) => {
    const { k, dt } = beatAt(t);
    if (k < 0 || k % 16 !== 0 || dt > 0.3) return 0;
    return Math.sin(2 * Math.PI * 660 * dt) * 0.4 * (1 - dt / 0.3);
  });
  let seed = 1;
  const noise = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x3fffffff - 1;
  };
  writeWav(path.join(dir, '03 Drums.wav'), 2, (t, c) => {
    const { k, dt } = beatAt(t);
    if (k < 0 || dt > 0.12) return 0;
    return noise() * Math.exp(-dt / 0.03) * (c === 0 ? 0.7 : 0.5);
  });
  // Identical left and right: should be stored as mono.
  writeWav(path.join(dir, '04 Bass.wav'), 2, (t) => (t < FIRST_BEAT ? 0 : Math.sin(2 * Math.PI * 55 * t) * 0.5));
  writeWav(path.join(dir, '05 Keys.wav'), 2, (t, c) => (t < FIRST_BEAT ? 0 : (Math.sin(2 * Math.PI * 220 * t) + Math.sin(2 * Math.PI * (c ? 277 : 330) * t)) * 0.2));
  for (let n = 0; n < PADS; n++) {
    await breathe();
    const f = 110 * Math.pow(2, n / 12);
    writeWav(path.join(dir, `${String(6 + n).padStart(2, '0')} Pad ${n + 1}.wav`), 2, (t, c) => (t < FIRST_BEAT ? 0 : Math.sin(2 * Math.PI * (c ? f * 1.01 : f) * t) * 0.05));
  }
}

function clean(library) {
  for (const f of [library.file, library.file + '.bak', library.file + '.tmp']) fs.rmSync(f, { force: true });
  fs.rmSync(library.cacheDir, { recursive: true, force: true });
  fs.mkdirSync(library.cacheDir, { recursive: true });
}

function firstOnset(file, channels) {
  const buf = fs.readFileSync(file);
  const pcm = new Int16Array(buf.buffer, buf.byteOffset, buf.length / 2);
  for (let i = 0; i < pcm.length; i += channels) if (Math.abs(pcm[i]) > 1500) return i / channels;
  return -1;
}

async function run({ app, getWindow, library, onEngine }) {
  const results = [];
  const check = (name, ok, detail) => {
    results.push({ name, ok: !!ok, detail });
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail !== undefined ? '  [' + detail + ']' : ''}`);
  };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const win = getWindow();
  const js = (code) => win.webContents.executeJavaScript(code, true);
  const until = async (code, ms, label) => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      if (await js(code)) return true;
      await sleep(50);
    }
    throw new Error('Timed out waiting for: ' + (label || code));
  };

  // Screenshots are for looking at afterwards, not checks. Capturing fails
  // when the window is hidden or covered, and that must not stop the test.
  const shot = async (name) => {
    try {
      fs.writeFileSync(path.join(process.env.SELFTEST_SHOTS || os.tmpdir(), name), (await win.webContents.capturePage()).toPNG());
    } catch (err) {
      console.log(`INFO  screenshot ${name} skipped (${(err && err.message) || err})`);
    }
  };

  // The window cannot take the keyboard during a self-test (see createWindow
  // in main.js): keys the owner pressed for another app used to land here and
  // start, pause or stop playback mid-test, which is what the "playback did
  // not start" failures of 2026-10-04 were. As a second line of defence, a
  // key this test did not send itself is dropped here and counted.
  //   SELFTEST_STRAY=1          presses Space and Enter at the window all through
  //                             the run, as stray typing would; it has to pass
  //   SELFTEST_STRAY=unguarded  lets those through, to see what such a run looks like
  const ownKeys = [];
  const strayKeys = [];
  win.webContents.on('before-input-event', (e, input) => {
    const i = ownKeys.indexOf(input.type + ':' + input.code);
    if (i >= 0) return ownKeys.splice(i, 1);
    strayKeys.push(input.code);
    if (process.env.SELFTEST_STRAY !== 'unguarded') e.preventDefault();
  });
  const press = (keyCode) => {
    for (const type of ['keyDown', 'keyUp']) {
      ownKeys.push(type + ':' + keyCode);
      win.webContents.sendInputEvent({ type, keyCode });
    }
  };
  if (process.env.SELFTEST_STRAY) {
    let n = 0;
    const timer = setInterval(() => {
      if (win.isDestroyed()) return clearInterval(timer);
      const keyCode = n++ % 2 ? 'Enter' : 'Space';
      win.webContents.sendInputEvent({ type: 'keyDown', keyCode });
      win.webContents.sendInputEvent({ type: 'keyUp', keyCode });
    }, 700);
  }

  const events = [];
  const peaks = [];
  let last = null;
  // `at` is when the device last took a block. A Mac that sleeps or has its
  // lid shut stops taking them: nothing errors and playback just stands
  // still, which once looked like an engine fault. Say so when it happens.
  let asleep = false;
  let sleptDuringRun = false;
  let freezing = false; // the test itself is doing it, at the end
  onEngine((m) => {
    if (m.type === 'state') {
      const stopped = Date.now() - m.at > 2000;
      if (stopped !== asleep && !freezing) {
        asleep = stopped;
        if (stopped) sleptDuringRun = true;
        console.log(`INFO  the audio device ${stopped ? 'has stopped taking audio (is the lid closed, or the Mac asleep?)' : 'is taking audio again'}`);
      }
      last = m;
      for (let i = 0; i < m.peaks.length; i++) peaks[i] = Math.max(peaks[i] || 0, m.peaks[i]);
    } else events.push(m);
  });

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'selah-selftest-'));
  const stemDir = path.join(dir, 'Test Song');
  fs.mkdirSync(stemDir);
  let failed = false;
  try {
    await makeStems(stemDir);
    if (win.webContents.isLoading()) await new Promise((r) => win.webContents.once('did-finish-load', r));
    await until('!!(window.__app && window.__app.state.out)', 15000, 'audio output');
    const out = await js('window.__app.state.out');
    check('audio output opened', out.ok, `${out.apiName} / ${out.deviceName} / ${out.channels} ch / ${out.sampleRate} Hz`);
    await shot('selah-selftest-empty.png');

    // Keep the test quiet on whatever is plugged in.
    await js(`(() => { const b = window.__app.state.lib.settings.buses; b.band.gain = 0.05; b.cue.gain = 0.05; window.__app.send({ cmd: 'setBuses', buses: b }); })()`);

    // The self-test is not asked for a key and runs as with the basic one: no EW click among the sounds.
    const keyed = await js(`(async () => ({ wrong: await window.api.key.try('not a key'), level: await window.api.key.state(), sounds: (await window.api.clickSounds()).map((x) => x.id) }))()`);
    const fullKey = keyed.level === 'full';
    check('a wrong key is turned away, and without the full key the owner\'s click is not there', keyed.wrong === null && (fullKey ? keyed.sounds[0] === 'ew' : keyed.level === 'basic' && !keyed.sounds.includes('ew') && keyed.sounds.includes('classic')), JSON.stringify(keyed));

    // --- 1. import and sync ---
    const importStart = Date.now();
    await js(`window.__app.importPaths([${JSON.stringify(stemDir)}])`);
    await until('window.__app.state.song && window.__app.state.eng.songId === window.__app.state.song.id', 600000, 'song loaded in engine');

    // The song came with a click stem, so its tempo and bar 1 are read from it without being asked.
    await until(`window.__app.state.song.bpm === ${BPM}`, 15000, 'tempo read from the click stem on import');
    const fromClick = await js('({ bpm: window.__app.state.song.bpm, offset: window.__app.state.song.offset, rows: document.querySelectorAll("#rows .row").length })');
    check('stems that include a click set the song\'s tempo and bar 1 from it, and the click stays an ordinary track', fromClick.bpm === BPM && Math.abs(fromClick.offset - FIRST_BEAT) < 0.004 && fromClick.rows === 5 + PADS, JSON.stringify(fromClick));
    const song = await js('JSON.parse(JSON.stringify(window.__app.state.song))');
    const engineProc = app.getAppMetrics().find((p) => p.serviceName === 'Selah audio engine' || p.name === 'Selah audio engine');
    console.log(`INFO  imported ${song.tracks.length} stems of ${SECONDS}s in ${((Date.now() - importStart) / 1000).toFixed(1)}s; engine process RAM ${engineProc ? Math.round(engineProc.memory.workingSetSize / 1024) + ' MB' : 'unknown'}`);
    check('folder imported as a song, stems named from the files', song.tracks.length === 5 + PADS && song.name === 'Test Song', song.tracks.map((t) => t.name).join(', '));
    check('click and guide default to the ears', song.tracks.filter((t) => t.bus === 'cue').map((t) => t.name).sort().join() === 'Click,Guide' && (await js('Array.from(document.querySelectorAll(".thead .bus"), (b) => b.textContent).join()')) === 'EARS,EARS,MAINS,MAINS,MAINS' + ',MAINS'.repeat(PADS));
    check('dual-mono stem stored as one channel', song.tracks.find((t) => t.name === 'Bass').channels === 1 && song.tracks.find((t) => t.name === 'Drums').channels === 2);
    check('generated click is off because a click stem exists', song.click.enabled === false);
    const rate = out.sampleRate;
    const lengths = song.tracks.map((t) => fs.statSync(library.pcmPath(song.id, t.id, rate)).size / 2 / t.channels);
    check('all stems decode to the same length', lengths.every((n) => Math.abs(n - SECONDS * rate) <= 2), lengths.join(', '));
    const click = song.tracks.find((t) => t.name === 'Click');
    const drums = song.tracks.find((t) => t.name === 'Drums');
    const onClick = firstOnset(library.pcmPath(song.id, click.id, rate), click.channels);
    const onDrums = firstOnset(library.pcmPath(song.id, drums.id, rate), drums.channels);
    check('first beat lines up across stems after resampling', Math.abs(onClick - FIRST_BEAT * rate) <= 24 && Math.abs(onClick - onDrums) <= 24, `click ${onClick}, drums ${onDrums}, expected ${FIRST_BEAT * rate}`);
    check('waveform peaks loaded for every track', await js('window.__app.state.song.tracks.every((t) => window.__app.state.peaks.get(t.id) && window.__app.state.peaks.get(t.id).length > 1000)'));

    // --- 2. tempo, click, sections ---
    await js('window.__app.detectTempo()');
    const tempo = await js('({ bpm: window.__app.state.song.bpm, offset: window.__app.state.song.offset })');
    check('tempo detected from the click stem', tempo.bpm === BPM && Math.abs(tempo.offset - FIRST_BEAT) < 0.004, `${tempo.bpm} BPM, bar 1 at ${tempo.offset}s`);
    await js(`(() => { const a = window.__app; a.addSection(0, 'Intro'); a.addSection(2, 'Verse 1'); a.addSection(6, 'Chorus'); a.addSection(10, 'Bridge'); })()`);
    check('section pads created', (await js('document.querySelectorAll("#pads .pad").length')) === 4);

    // Real mouse input on the timeline: move a section, resize one, undo, click the ruler.
    await sleep(200);
    const geo = (barIndex) => js(`(() => { const a = window.__app; const r = document.querySelector('#ruler').getBoundingClientRect(); return { x: Math.round(r.left + a.getTimeline().xOf(window.Grid.barToSeconds(a.state.song, ${barIndex}))), y: Math.round(r.top) }; })()`);
    const mouse = (type, x, y) => win.webContents.sendInputEvent({ type, x, y, button: 'left', clickCount: 1 });
    const from = await geo(6);
    const to = await geo(8);
    mouse('mouseDown', from.x + 12, from.y + 10);
    for (let i = 1; i <= 8; i++) {
      mouse('mouseMove', Math.round(from.x + 12 + ((to.x - from.x) * i) / 8), from.y + 10);
      await sleep(15);
    }
    mouse('mouseUp', to.x + 12, to.y + 10);
    await sleep(150);
    // Sections as { name: [first bar, length] }. Before: Intro 0-2, Verse 1 2-6, Chorus 6-10, Bridge 10 to the end.
    const blocks = () => js(`Object.fromEntries(window.__app.state.song.sections.map((s) => [s.name, [s.bar, s.len]]))`);
    let st = await blocks();
    check('dragging a section moves it by whole bars and pushes the next one along', st.Chorus[0] === 8 && st.Chorus[1] === 4 && st.Bridge[0] === 12 && st['Verse 1'][0] === 2 && st['Verse 1'][1] === 4, JSON.stringify(st));
    const edge = await geo(6);
    const edgeTo = await geo(7);
    mouse('mouseDown', edge.x - 2, edge.y + 10);
    for (let i = 1; i <= 8; i++) {
      mouse('mouseMove', Math.round(edge.x - 2 + ((edgeTo.x - edge.x) * i) / 8), edge.y + 10);
      await sleep(15);
    }
    mouse('mouseUp', edgeTo.x - 2, edgeTo.y + 10);
    await sleep(150);
    st = await blocks();
    check('dragging a right edge makes the section longer and the rest follow', st['Verse 1'][0] === 2 && st['Verse 1'][1] === 5 && st.Chorus[0] === 9 && st.Bridge[0] === 13, JSON.stringify(st));
    await js('window.__app.undo()');
    await sleep(150);
    st = await blocks();
    check('undo puts the sections back', st['Verse 1'][1] === 4 && st.Chorus[0] === 8 && st.Bridge[0] === 12, JSON.stringify(st));
    const verse = await geo(2);
    mouse('mouseDown', verse.x + 30, verse.y + 10);
    mouse('mouseUp', verse.x + 30, verse.y + 10);
    await sleep(250);
    check('clicking a section block does not move the playhead', last.pos === 0 && !last.pending, `${last.pos.toFixed(3)}s`);
    await js(`document.querySelectorAll('#pads .pad')[1].click()`);
    await sleep(250);
    check('tapping a section pad while stopped moves the playhead to it', Math.abs(last.pos - (tempo.offset + 2 * 4 * BEAT)) < 0.001, `${last.pos.toFixed(3)}s`);
    const spot = await geo(4);
    mouse('mouseDown', spot.x, spot.y + 32);
    mouse('mouseUp', spot.x, spot.y + 32);
    await sleep(250);
    check('clicking the bar ruler seeks there', Math.abs(last.pos - (tempo.offset + 4 * 4 * BEAT)) < 0.08, `${last.pos.toFixed(3)}s`);
    await js(`window.__app.send({ cmd: 'stop' })`);
    await sleep(100);

    // The end of the song is dragged like the edge of a clip. Cut short, the
    // engine stops the song there; undo gives the audio's own end back.
    const endAt = () => js(`(() => { const a = window.__app; a.drawFrame(); const t = a.getTimeline(); const r = document.querySelector('#ruler').getBoundingClientRect(); return { x: Math.round(r.left + t.endX), y: Math.round(r.top + t.laneH + 10), end: a.state.song.end || null, total: document.querySelector('#clockTotal').textContent }; })()`);
    const end0 = await endAt();
    const cutTo = await geo(8);
    mouse('mouseDown', end0.x, end0.y);
    for (let i = 1; i <= 8; i++) {
      mouse('mouseMove', Math.round(end0.x + ((cutTo.x - end0.x) * i) / 8), end0.y);
      await sleep(15);
    }
    mouse('mouseUp', cutTo.x, end0.y);
    await sleep(200);
    const end1 = await endAt();
    check('dragging the end of the timeline cuts the song short, on a bar line', end0.end === null && end1.end === 8 && end1.total !== end0.total && Math.abs(end1.x - cutTo.x) <= 1, JSON.stringify({ end0, end1, cutTo }));
    await js(`(() => { const a = window.__app; a.send({ cmd: 'seek', seconds: ${tempo.offset + 8 * 4 * BEAT - 0.6} }); a.send({ cmd: 'play' }); })()`);
    await sleep(1600);
    check('the engine ends the song at the new end', last.playing === false, `playing ${last.playing} at ${last.pos.toFixed(2)}s`);
    await js(`window.__app.send({ cmd: 'stop' })`);
    await sleep(150);
    await js('window.__app.undo()');
    await sleep(150);
    const end2 = await endAt();
    check('undo puts the end of the song back', end2.end === null && end2.total === end0.total && Math.abs(end2.x - end0.x) <= 1, JSON.stringify(end2));
    await js('window.__app.redo()');
    await sleep(150);
    const end3 = await endAt();
    for (const n of [1, 2]) {
      win.webContents.sendInputEvent({ type: 'mouseDown', x: end3.x, y: end3.y, button: 'left', clickCount: n });
      win.webContents.sendInputEvent({ type: 'mouseUp', x: end3.x, y: end3.y, button: 'left', clickCount: n });
    }
    await sleep(200);
    const end4 = await endAt();
    check('double-clicking the end gives the song the end of its audio again', end3.end === 8 && end4.end === null && end4.total === end0.total, JSON.stringify({ end3, end4 }));
    await js(`window.__app.send({ cmd: 'stop' })`);
    await sleep(100);

    // A right-click on the end's line chooses how finely it snaps: coarser
    // (4 bars) or not at all. The line runs through the tracks as well.
    const dragEnd = async (toX) => {
      const at = await endAt();
      mouse('mouseDown', at.x, at.y);
      for (let i = 1; i <= 8; i++) {
        mouse('mouseMove', Math.round(at.x + ((toX - at.x) * i) / 8), at.y);
        await sleep(15);
      }
      mouse('mouseUp', toX, at.y);
      await sleep(200);
      return (await endAt()).end;
    };
    const pickSnap = (label, on) => js(`(() => {
      const node = document.querySelector('${on}');
      const r = document.querySelector('#ruler').getBoundingClientRect();
      const box = node.getBoundingClientRect();
      node.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: r.left + window.__app.getTimeline().endX, clientY: box.top + box.height - 6 }));
      const items = Array.from(document.querySelectorAll('.menu button'), (b) => b.textContent);
      Array.from(document.querySelectorAll('.menu button')).find((b) => b.textContent.replace('✓ ', '') === '${label}').click();
      return { items, snap: window.__app.state.lib.settings.endSnap };
    })()`);
    const coarse = await pickSnap('Snap to: 4 bars', '#ruler');
    const at7 = await geo(7);
    const snapped = await dragEnd(at7.x);
    const fine = await pickSnap('Snap to: Nothing (free)', '#rows canvas');
    const at5 = await geo(5);
    const at6 = await geo(6);
    const loose = await dragEnd(Math.round((at5.x + at6.x) / 2));
    check(
      'a right-click on the end chooses how finely it snaps: to 4 bars, or not at all',
      coarse.items.length === 5 && coarse.items[2] === '✓ Snap to: 1 bar' && coarse.snap === 4 && snapped === 8 && fine.snap === 'free' && fine.items.includes('Back to the end of the audio') && loose > 5.3 && loose < 5.7,
      JSON.stringify({ coarse, snapped, fine, loose })
    );
    await js(`(() => { const a = window.__app; delete a.state.lib.settings.endSnap; a.undo(); a.undo(); })()`);
    await sleep(150);
    check('and undo takes the song back to the end of its audio', (await endAt()).end === null);

    // Voice control, without a microphone: the listener is sent the guide's
    // own recording of "Chorus" and the window does what a tap on that pad
    // does. Sections here: Intro, Verse 1, Chorus, Bridge.
    const chorusWav = path.join(__dirname, '..', '..', 'assets', 'cues', 'english-female', 'Song Sections', 'English Female - Chorus.wav');
    const voice = await js(`(async () => {
      const a = window.__app;
      const wait = (ms) => new Promise((r) => setTimeout(r, ms));
      a.send({ cmd: 'seek', seconds: 0 });
      await a.setVoice(true, false);
      const wav = await (await fetch('app://selah/file?p=' + encodeURIComponent(${JSON.stringify(chorusWav)}))).arrayBuffer();
      const data = (await new OfflineAudioContext(1, 1, 16000).decodeAudioData(wav)).getChannelData(0);
      for (let i = 0; i < 40 && !a.state.voice.names.length; i++) await wait(100);
      const say = (sound) => window.api.voice.send({ cmd: 'audio', samples: sound });
      say(new Float32Array(4800));
      for (let i = 0; i < data.length; i += 1600) say(data.slice(i, i + 1600));
      say(new Float32Array(16000));
      for (let i = 0; i < 30 && !a.state.voice.heard; i++) await wait(100);
      await wait(250);
      const chorus = a.state.song.sections.find((x) => x.name === 'Chorus');
      const out = { names: a.state.voice.names, heard: a.state.voice.heard, lit: document.querySelector('#btnVoice').classList.contains('on'), want: window.Grid.barToSeconds(a.state.song, chorus.bar), next: a.voiceTarget('Verse').name };
      await a.setVoice(false);
      out.off = !document.querySelector('#btnVoice').classList.contains('on');
      return out;
    })()`);
    check(
      'voice control: hearing "Chorus" moves to the chorus, as a tap on its pad would',
      voice.names.join() === 'Intro,Verse,Chorus,Bridge' && voice.heard === 'Chorus' && voice.lit && voice.off && voice.next === 'Verse 1' && Math.abs(last.pos - voice.want) < 0.05,
      JSON.stringify(voice) + ` at ${last.pos.toFixed(2)}s`
    );
    await js(`window.__app.send({ cmd: 'stop' })`);
    await sleep(100);

    // Double-clicking a level slider sets it to unity: a track's, and the click's.
    const unity = await js(`(() => {
      const a = window.__app;
      const dbl = (node) => node.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
      const fader = document.querySelector('.thead input[type=range]');
      fader.value = -12;
      fader.dispatchEvent(new Event('input', { bubbles: true }));
      const lowered = a.state.song.tracks[0].gain;
      dbl(fader);
      const click = document.querySelector('#clickGain');
      const clickStart = a.state.song.click.gain;
      click.value = -12;
      click.dispatchEvent(new Event('input', { bubbles: true }));
      const clickLowered = a.state.song.click.gain;
      dbl(click);
      return { lowered, track: a.state.song.tracks[0].gain, fader: fader.value, clickStart, clickLowered, click: a.state.song.click.gain, clickSlider: click.value };
    })()`);
    check('levels start at 0 dB, and double-clicking a slider brings it back there', unity.lowered < 0.3 && unity.track === 1 && unity.fader === '0' && unity.clickStart === 1 && unity.clickLowered < 0.3 && unity.click === 1 && unity.clickSlider === '0', JSON.stringify(unity));

    // --- 3. routing ---
    if (out.channels >= 4) {
      await js(`(() => { const b = window.__app.state.lib.settings.buses; Object.assign(b.band, { mode: 'stereo', ch: 0 }); Object.assign(b.cue, { mode: 'stereo', ch: 2 }); window.__app.send({ cmd: 'setBuses', buses: b }); })()`);
    } else {
      await js(`(() => { const b = window.__app.state.lib.settings.buses; Object.assign(b.band, { mode: 'mono', ch: 1 }); Object.assign(b.cue, { mode: 'mono', ch: 0 }); window.__app.send({ cmd: 'setBuses', buses: b }); })()`);
    }

    // --- playback ---
    await js(`window.__app.send({ cmd: 'play' })`);
    const t0 = Date.now();
    await sleep(1500);
    const elapsed = (Date.now() - t0) / 1000;
    check('playback advances in real time', last.playing && Math.abs(last.pos - elapsed) < 0.3, `${last.pos.toFixed(2)}s after ${elapsed.toFixed(2)}s`);

    // Band tracks only: nothing may reach the cue outputs, and the reverse.
    const bandCh = out.channels >= 4 ? [0, 1] : [1];
    const cueCh = out.channels >= 4 ? [2, 3] : [0];
    const soloOnly = async (names) => {
      await js(`(() => { const a = window.__app; for (const t of a.state.song.tracks) { const solo = ${JSON.stringify(names)}.includes(t.name); t.solo = solo; a.send({ cmd: 'setTrack', songId: a.state.song.id, id: t.id, patch: { solo } }); } })()`);
      await sleep(250);
      peaks.length = 0;
      await sleep(900);
      return peaks.slice();
    };
    let p = await soloOnly(['Drums', 'Bass', 'Keys']);
    check('band tracks reach only the band outputs', bandCh.every((c) => p[c] > 0.001) && cueCh.every((c) => !(p[c] > 0)), p.map((v) => (v || 0).toFixed(4)).join(' '));
    p = await soloOnly(['Click', 'Guide']);
    check('click and guide reach only the cue outputs', cueCh.every((c) => p[c] > 0.001) && bandCh.every((c) => !(p[c] > 0)), p.map((v) => (v || 0).toFixed(4)).join(' '));
    await soloOnly([]);

    // Separate channels, for a desk that takes click, guide and groups of
    // tracks apart: the layout switch in the audio settings, what the engine
    // is then told, a track moved to another group, and back to two feeds.
    const split = await js(`(() => {
      const a = window.__app;
      const s = a.state.song;
      const pick = (id, i) => { const sel = document.querySelector(id); sel.selectedIndex = i; sel.dispatchEvent(new Event('change', { bubbles: true })); };
      const where = () => Object.fromEntries(s.tracks.map((t) => [t.name, a.trackMessage(s, t).bus]));
      const labels = () => Array.from(document.querySelectorAll('.thead .bus'), (b) => b.textContent).join();
      const out = { before: { buses: Object.keys(a.engineBuses()).sort().join(), where: where(), labels: labels(), click: a.clickMessage(s).bus } };
      document.querySelector('#btnAudio').click();
      pick('#setLayout', 1);
      const eb = a.engineBuses();
      out.on = { ids: Object.keys(eb).sort().join(), click: eb.click.mode + eb.click.ch, guide: eb.guide.mode + eb.guide.ch, g1: eb.g1.mode + eb.g1.ch, g6: eb.g6.mode + eb.g6.ch, where: where(), labels: labels(), rows: document.querySelectorAll('.groupRow').length };
      const drums = Array.from(document.querySelectorAll('#rows .row')).find((r) => r.querySelector('.tname').textContent === 'Drums');
      drums.querySelector('.bus').click();
      out.menu = Array.from(document.querySelectorAll('.menu button'), (b) => b.textContent);
      Array.from(document.querySelectorAll('.menu button')).find((b) => b.textContent.startsWith('Other')).click();
      out.moved = { bus: where().Drums, label: drums.querySelector('.bus').textContent };
      pick('#setLayout', 0);
      out.off = { buses: Object.keys(a.engineBuses()).sort().join(), where: where(), labels: labels() };
      Array.from(document.querySelectorAll('.modal button')).find((b) => b.textContent === 'Done').click();
      return out;
    })()`);
    check(
      'separate channels: click on output 1, guide on 2, tracks in groups by their names; a track can change group; two feeds comes back as it was',
      split.before.buses === 'band,click,cue,guide' && split.before.where.Drums === 'band' && split.before.click === 'click' &&
        split.on.ids === 'click,g1,g2,g3,g4,g5,g6,guide' && split.on.click === 'mono0' && split.on.guide === 'mono1' && split.on.g1 === 'mono2' && split.on.g6 === 'mono7' &&
        split.on.where.Drums === 'g1' && split.on.where.Bass === 'g2' && split.on.where.Keys === 'g3' && split.on.where.Click === 'click' && split.on.where.Guide === 'guide' && split.on.labels === 'CLICK,GUIDE,Drums,Bass,Keys' + ',Other'.repeat(PADS) && split.on.rows === 6 &&
        split.menu.length === 8 && split.menu[0].startsWith('✓ Drums') && split.moved.bus === 'g6' && split.moved.label === 'Other' &&
        split.off.buses === 'band,click,cue,guide' && split.off.where.Drums === 'band' && split.off.labels === split.before.labels,
      JSON.stringify(split)
    );

    // Generated click on its own: mute every stem, switch the click on.
    const setAll = (mute, clickOn) =>
      js(`(() => { const a = window.__app; for (const t of a.state.song.tracks) { t.mute = ${mute}; a.send({ cmd: 'setTrack', songId: a.state.song.id, id: t.id, patch: { mute: ${mute} } }); } const c = document.querySelector('#clickOn'); c.checked = ${clickOn}; c.dispatchEvent(new Event('change')); })()`);
    await setAll(true, true);
    await sleep(250);
    peaks.length = 0;
    await sleep(1400);
    p = peaks.slice();
    check('generated click plays on the cue outputs only', cueCh.every((c) => p[c] > 0.001) && bandCh.every((c) => !(p[c] > 0)), p.map((v) => (v || 0).toFixed(4)).join(' '));
    await setAll(false, false);
    await sleep(200);

    // --- 4. jump on the next bar line ---
    const bar = 4 * BEAT;
    const bridgeBar = st.Bridge[0];
    const bridgeStart = tempo.offset + bridgeBar * bar;
    const before = last.pos;
    await js(`window.__app.jumpToSection(window.__app.state.song.sections.find((s) => s.name === 'Bridge'))`);
    await sleep(120);
    const pending = last.pending;
    // The engine renders slightly ahead of what is audible, so a tap just
    // before a bar line may be taken at the following one.
    const nextLine = tempo.offset + Math.ceil((before - tempo.offset) / bar) * bar;
    const onLine = pending && (Math.abs(pending.at - nextLine) < 0.01 || Math.abs(pending.at - nextLine - bar) < 0.01);
    check('jump is queued for the next bar line', pending && pending.bar === bridgeBar && Math.abs(pending.to - bridgeStart) < 0.01 && onLine, pending ? `at ${pending.at.toFixed(3)}s -> ${pending.to.toFixed(3)}s (playhead was ${before.toFixed(2)}s)` : 'no pending jump');
    await until('!window.__app.state.eng.pending', 4000, 'jump to happen');
    const jumpedAt = Date.now();
    await sleep(400);
    const lag = (Date.now() - jumpedAt) / 1000;
    check('playback continues from the section start', events.some((e) => e.type === 'jumped' && e.bar === bridgeBar) && last.pos >= bridgeStart && last.pos < bridgeStart + lag + 0.4, `${last.pos.toFixed(2)}s, section starts ${bridgeStart.toFixed(2)}s`);

    await shot('selah-selftest.png');
    await js(`document.querySelector('#btnAudio').click()`);
    await sleep(300);
    await shot('selah-selftest-audio.png');
    await js(`document.querySelector('#overlay .modal-head .x').click()`);

    await js(`window.__app.send({ cmd: 'stop' })`);
    await sleep(300);
    check('stop rewinds to the start', !last.playing && last.pos === 0);
    check('no audio dropouts during the test', last.underruns === 0, `${last.underruns} dropouts`);

    // --- 5. setlist and saving ---
    await js(`document.querySelector('#songKey').value = 'C'; document.querySelector('#songKey').dispatchEvent(new Event('change'))`);
    await sleep(700);
    const saved = JSON.parse(fs.readFileSync(library.file, 'utf8'));
    const s = saved.songs[0];
    check(
      'song setup is saved to disk',
      saved.songs.length === 1 && s.bpm === BPM && s.key === 'C' && s.sections.length === 4 && s.tracks.length === 5 + PADS && saved.setlists[0].songIds[0] === s.id && saved.lastSongId === s.id
    );
    check('routing is saved to disk', saved.settings.buses.cue.ch !== saved.settings.buses.band.ch);

    // Reload the window: everything should come back without re-importing.
    win.webContents.reload();
    await sleep(500);
    await until('!!(window.__app && window.__app.state.song && window.__app.state.eng.songId === window.__app.state.song.id)', 20000, 'song restored after reload');
    const restored = await js('({ name: window.__app.state.song.name, pads: document.querySelectorAll("#pads .pad").length, rows: document.querySelectorAll("#rows .row").length, setlist: document.querySelectorAll("#setlist li").length })');
    check('song, sections and setlist restored on restart', restored.name === 'Test Song' && restored.pads === 4 && restored.rows === 5 + PADS && restored.setlist === 1, JSON.stringify(restored));

    // A second song in the setlist: switching, and background preload of the next song.
    const dir2 = path.join(dir, 'Second Song');
    fs.mkdirSync(dir2);
    for (const n of ['03 Drums.wav', '04 Bass.wav']) fs.copyFileSync(path.join(stemDir, n), path.join(dir2, n));
    await js(`window.__app.importPaths([${JSON.stringify(dir2)}])`);
    await until(`window.__app.state.song.name === 'Second Song' && window.__app.state.eng.songId === window.__app.state.song.id`, 120000, 'second song loaded');
    const second = await js('({ click: window.__app.state.song.click.enabled, setlist: document.querySelectorAll("#setlist li").length, library: document.querySelectorAll("#library li").length })');
    check('second song added to setlist and library, generated click on', second.click === true && second.setlist === 2 && second.library === 2, JSON.stringify(second));
    events.length = 0;
    await js(`window.__app.openSong(window.__app.state.lib.setlists[0].songIds[0])`);
    await until(`window.__app.state.song.name === 'Test Song' && window.__app.state.eng.songId === window.__app.state.song.id`, 60000, 'first song reopened');
    await sleep(1500);
    check('next song in the setlist is preloaded', events.some((e) => e.type === 'songPreloaded'));
    const switchStart = Date.now();
    await js(`window.__app.openSong(window.__app.state.lib.setlists[0].songIds[1])`);
    await until(`window.__app.state.song.name === 'Second Song' && window.__app.state.eng.songId === window.__app.state.song.id`, 60000, 'switch to second song');
    console.log(`INFO  switched to the preloaded song in ${Date.now() - switchStart} ms`);
    await js(`window.__app.send({ cmd: 'play' })`);
    await sleep(700);
    check('second song plays', last.playing && last.pos > 0.3, `${last.pos.toFixed(2)}s`);
    // Every track has its own level meter, which follows what is heard: muted, it shows nothing.
    // The levels are read here as the engine reports them (the test window may be covered and not
    // drawing), each reading the highest of a stretch, since drums are short hits with silence between.
    const trackNames = await js('Object.fromEntries(window.__app.state.song.tracks.map((t) => [t.id, t.name]))');
    const heardFor = async (ms) => {
      const top = {};
      for (const end = Date.now() + ms; Date.now() < end; ) {
        for (const [id, v] of Object.entries((last && last.tracks) || {})) top[trackNames[id]] = Math.max(top[trackNames[id]] || 0, v);
        await sleep(25);
      }
      return top;
    };
    const muteBass = () => js(`Array.from(document.querySelectorAll('#rows .row')).find((r) => r.querySelector('.tname').textContent === 'Bass').querySelector('.m').click()`);
    const open = await heardFor(600);
    const bars = await js(`(() => { window.__app.drawFrame(); return Array.from(document.querySelectorAll('#rows .row'), (r) => parseFloat(r.querySelector('.tmeter i').style.width) || 0); })()`);
    await muteBass();
    await sleep(300);
    const muted = await heardFor(600);
    await muteBass();
    await sleep(300);
    const reopened = await heardFor(400);
    check('each track has a level meter that follows what is heard', open.Drums > 0.01 && open.Bass > 0.01 && bars.length === 2 && bars.some((w) => w > 5) && muted.Drums > 0.01 && !(muted.Bass > 0) && reopened.Bass > 0.01, JSON.stringify({ open, bars, muted, reopened }));
    await js(`window.__app.openSong(window.__app.state.lib.setlists[0].songIds[0])`);
    await sleep(300);
    const linedUp = await js('(() => { const a = window.__app; return { song: a.state.song.name, queued: a.state.queued === a.state.lib.setlists[0].songIds[0], readout: a.songReadout().text, mark: document.querySelectorAll("#setlist li.coming.byhand").length }; })()');
    check('opening another song while one plays lines it up instead of interrupting', linedUp.song === 'Second Song' && last.playing && linedUp.queued && /^Lined up: Test Song/.test(linedUp.readout) && linedUp.mark === 1, JSON.stringify(linedUp));
    // Stopped, the lined-up song opens by itself.
    await js(`window.__app.send({ cmd: 'stop' })`);
    await sleep(300);
    await js(`window.__app.openSong(window.__app.state.lib.setlists[0].songIds[0])`);
    await until(`window.__app.state.song.name === 'Test Song' && window.__app.state.eng.songId === window.__app.state.song.id`, 60000, 'back to first song');

    // Move to a stereo-only device while the cue bus still points at 3-4:
    // the click must go silent, not fall back to the main outputs.
    const devs = await js('window.__app.state.devices');
    const sameApi = devs.apis.find((a) => a.id === out.apiId);
    const stereo = sameApi && sameApi.devices.find((d) => d.name !== out.deviceName && d.channels === 2);
    if (stereo && out.channels >= 4) {
      events.length = 0;
      await js(`(() => { const a = window.__app; Object.assign(a.state.lib.settings.audio, { apiId: ${JSON.stringify(out.apiId)}, deviceName: ${JSON.stringify(stereo.name)} }); a.send({ cmd: 'getDevices' }); })()`);
      await until(`window.__app.state.out && window.__app.state.out.deviceName !== ${JSON.stringify(out.deviceName)}`, 20000, 'device switch');
      const now = await js('window.__app.state.out');
      if (now.ok) {
        await until(`window.__app.state.eng.songId === window.__app.state.song.id`, 20000, 'song reloaded on new device');
        await sleep(300);
        await js(`window.__app.send({ cmd: 'play' })`);
        p = await soloOnly(['Click', 'Guide']);
        const warned = await js(`document.querySelector('#btnAudio').classList.contains('warn')`);
        check('cue bus with no matching outputs is silent and flagged', now.channels === 2 && !(p[0] > 0) && !(p[1] > 0) && warned, `${now.deviceName}: ${p.map((v) => (v || 0).toFixed(4)).join(' ')}`);
        p = await soloOnly(['Drums']);
        check('band still plays on the stereo device', p[0] > 0.001 && p[1] > 0.001, p.map((v) => (v || 0).toFixed(4)).join(' '));
        await soloOnly([]);
        await js(`window.__app.send({ cmd: 'stop' })`);
        await sleep(300);
      } else console.log(`INFO  could not open ${stereo.name} (${now.error}); stereo-device check skipped`);
    } else console.log('INFO  no second stereo device; stereo-device check skipped');

    // The built-in sample song: laid out end to end, cues on, nothing to import.
    await js(`window.__app.newSampleSong()`);
    await until(`window.__app.state.song.name === 'Sample Song' && window.__app.state.eng.songId === window.__app.state.song.id`, 20000, 'sample song loaded');
    const demo = await js('(() => { const s = window.__app.state.song; return { bpm: s.bpm, bars: s.bars, sections: s.sections.length, pads: document.querySelectorAll("#pads .pad").length, gapless: s.sections.every((x, i, a) => i === 0 || a[i - 1].bar + a[i - 1].len === x.bar), cues: s.cues.enabled }; })()');
    check('the sample song opens ready to play', demo.bpm === 72 && demo.bars === 68 && demo.sections === 11 && demo.pads === 11 && demo.gapless && demo.cues, JSON.stringify(demo));

    // --- 6. a song with no stems: sampled click, guide voice, count-in ---
    // Opens a settings window with its button, picks options by the start of
    // their label, and closes it again.
    const inDialog = async (button, picks) => {
      await js(`document.querySelector(${JSON.stringify(button)}).click()`);
      await sleep(200);
      for (const [id, label] of Object.entries(picks)) {
        const ok = await js(`(() => { const c = document.querySelector('#${id}'); if (!c) return false; const i = Array.from(c.options).findIndex((o) => o.textContent.startsWith(${JSON.stringify(label)})); if (i < 0) return false; c.selectedIndex = i; c.dispatchEvent(new Event('change')); return true; })()`);
        if (!ok) throw new Error(`No option "${label}" in #${id}`);
        await sleep(150);
      }
      await js(`document.querySelector('#overlay .modal-head .x').click()`);
      await sleep(100);
    };
    // 4/4 at 240 BPM, so a bar is one second.
    await js(`(() => { const a = window.__app; const s = a.createSong('Click Only'); s.bpm = 240; a.openSong(s.id); })()`);
    await until(`window.__app.state.song.name === 'Click Only' && window.__app.state.eng.songId === window.__app.state.song.id`, 20000, 'click-only song loaded');
    await js(`(() => { const a = window.__app; a.addSection(0, 'Intro'); a.addSection(4, 'Verse 1'); const c = document.querySelector('#clickOn'); c.checked = false; c.dispatchEvent(new Event('change')); })()`);
    await sleep(300);
    const only = await js('({ bars: window.__app.state.song.bars, total: document.querySelector("#clockTotal").textContent, bigPads: document.querySelector("#main").classList.contains("nostems"), guide: window.__app.state.song.cues.enabled, marks: window.__app.state.guide.length, startsWith: window.__app.readout().text })');
    check('a song with no stems has a length in bars, the guide on and big pads', only.bars === 96 && only.total === '/ 1:36' && only.bigPads && only.guide, JSON.stringify(only));
    // Intro: name, "2", then "1 2 3 4" before the song. Verse 1: name and "2 3 4".
    check('the window knows where the guide speaks and announces the count-in', only.marks === 10 && /2-bar count-in/.test(only.startsWith), JSON.stringify(only));
    peaks.length = 0;
    await js(`window.__app.send({ cmd: 'play' })`);
    await sleep(600);
    check('the first section is counted in before the song starts', last.playing && last.pos < -0.8 && last.pos > -1.9, `${last.pos.toFixed(2)}s`);
    await sleep(1900);
    p = peaks.slice();
    check('the guide voice plays on the ears outputs only', cueCh.every((c) => p[c] > 0.001) && bandCh.every((c) => !(p[c] > 0)), p.map((v) => (v || 0).toFixed(4)).join(' '));
    check('the song starts after the count-in', last.playing && last.pos > 0.1 && last.pos < 1.2, `${last.pos.toFixed(2)}s`);
    await js(`(() => { const c = document.querySelector('#clickOn'); c.checked = true; c.dispatchEvent(new Event('change')); })()`);
    await sleep(300);
    peaks.length = 0;
    await sleep(700);
    p = peaks.slice();
    check('sampled click plays on the ears outputs only', cueCh.every((c) => p[c] > 0.001) && bandCh.every((c) => !(p[c] > 0)), p.map((v) => (v || 0).toFixed(4)).join(' '));

    // Song settings: half-time click and guide change neither tempo nor length.
    const hint = await js('document.querySelector("#btnSongSettings").classList.contains("suggest")');
    await inDialog('#btnSongSettings', { setClickFeel: 'Half-time', setGuideSpeed: 'Half-time' });
    await sleep(600);
    const sp = await js('(() => { const s = window.__app.state.song; return { feel: s.click.feel, speed: s.cues.speed, hint: document.querySelector("#btnSongSettings").classList.contains("suggest"), bpm: s.bpm, bars: s.bars, total: document.querySelector("#clockTotal").textContent }; })()');
    check('half-time click and half-time guide leave the tempo and length alone', sp.feel === 'half' && sp.speed === 'half' && sp.bpm === 240 && sp.bars === 96 && sp.total === '/ 1:36' && last.playing, JSON.stringify(sp));
    check('a fast song suggests a half-time guide until it is on', hint === true && sp.hint === false);
    await js(`document.querySelector('#btnSongSettings').click()`);
    await sleep(300);
    await shot('selah-selftest-cues.png');
    await js(`document.querySelector('#overlay .modal-head .x').click()`);
    await js(`window.__app.send({ cmd: 'stop' })`);
    await sleep(300);
    await inDialog('#btnSongSettings', { setClickFeel: 'Normal', setGuideSpeed: 'Normal' });

    // Settings: a tap while stopped starts playback from that section's count-in.
    // Verse 1 is at bar 5 (4 s) and its guide is the bar before it.
    await inDialog('#btnSettings', { setLaunch: 'Starts playing' });
    await js(`document.querySelectorAll('#pads .pad')[1].click()`);
    await sleep(600);
    check('a section pad can start playback from its count-in', last.playing && last.pos > 3.0 && last.pos < 3.9, `${last.pos.toFixed(2)}s`);
    // A tap while playing is counted in: it waits for a bar line a full count
    // away. A second tap on the same pad leaves it queued.
    const tapAt = last.pos;
    await js(`document.querySelectorAll('#pads .pad')[0].click()`);
    await sleep(150);
    await js(`document.querySelectorAll('#pads .pad')[0].click()`);
    await sleep(120);
    const queued = last.pending;
    check('a tap while playing leaves a full bar for its count, and a second tap does not cancel it', queued && queued.to === 0 && queued.at - tapAt >= 0.9 && queued.at - tapAt < 2.2 && Math.abs(queued.at - Math.round(queued.at)) < 0.001, queued ? `tapped at ${tapAt.toFixed(2)}s, lands at ${queued.at.toFixed(2)}s` : 'no pending jump');
    // Asked directly rather than read off the screen, which is not redrawn while the window is hidden.
    const readout = await js('window.__app.readout()');
    check('the top bar says what is queued and when', readout.queued && /^→ Intro in \d+ (bar|beat)s?$/.test(readout.text), JSON.stringify(readout));
    await until('!window.__app.state.eng.pending', 5000, 'jump to the intro');
    await sleep(300);
    check('and lands on the section', last.playing && last.pos >= 0 && last.pos < 1, `${last.pos.toFixed(2)}s`);
    await js(`window.__app.send({ cmd: 'stop' })`);
    await sleep(300);
    await inDialog('#btnSettings', { setLaunch: 'Moves the playhead' });

    // Settings: pausing can go back to the start of the song instead of holding its place.
    const space = async () => {
      press('Space');
      await sleep(500);
    };
    await js(`window.__app.send({ cmd: 'seek', seconds: 10 })`);
    await sleep(150);
    await space();
    const playingAt = last.pos;
    await space();
    const held = { playing: last.playing, pos: last.pos };
    await inDialog('#btnSettings', { setPause: 'Goes back' });
    await space();
    await space();
    const rewound = { playing: last.playing, pos: last.pos };
    check('pausing holds its place, or goes back to the start when Settings says so', playingAt > 10 && !held.playing && held.pos > 10 && !rewound.playing && rewound.pos === 0, JSON.stringify({ playingAt, held, rewound }));
    await inDialog('#btnSettings', { setPause: 'Holds its place' });

    // 6/8 the Ableton way: the tempo box still counts quarter notes, so at 240
    // a 6/8 bar is three quarters (0.75 s), and the count-in is a bar of click
    // and then a one-bar cue.
    const setSig = (num, den) => js(`(() => { const n = document.querySelector('#songNum'); n.value = ${num}; n.dispatchEvent(new Event('change')); const d = document.querySelector('#songDen'); d.value = ${den}; d.dispatchEvent(new Event('change')); })()`);
    await setSig(6, 8);
    await sleep(200);
    const six = await js('(() => { const s = window.__app.state.song; return { unit: s.beatUnit, bar: window.Grid.barSeconds(s), beats: window.Grid.beatsPerBar(s), start: s.cues.start }; })()');
    check('6/8 keeps the tempo in quarter notes, as Ableton does', six.unit === 'quarter' && Math.abs(six.bar - 0.75) < 1e-9 && six.beats === 6 && six.start === 'auto', JSON.stringify(six));
    await js(`window.__app.send({ cmd: 'play' })`);
    await sleep(500);
    check('and its count-in is two bars long', last.playing && last.pos < -0.7 && last.pos > -1.3, `${last.pos.toFixed(2)}s`);
    await js(`window.__app.send({ cmd: 'stop' })`);
    await sleep(300);
    await setSig(4, 4);
    await sleep(200);

    // "Fast song": type 120 and switch it on. The bars run at 240, every bar
    // number doubles, and the click and guide stay at the typed 120.
    await js(`(() => { const b = document.querySelector('#songBpm'); b.value = 120; b.dispatchEvent(new Event('change')); })()`);
    await sleep(200);
    const shape = () => js('(() => { const s = window.__app.state.song; return { bpm: s.bpm, shown: document.querySelector("#songBpm").value, bars: s.bars, total: document.querySelector("#clockTotal").textContent, verse: s.sections.find((x) => x.name === "Verse 1").bar, fast: !!s.double }; })()');
    const one = await shape();
    await inDialog('#btnSongSettings', { setDouble: 'Yes' });
    await sleep(200);
    const two = await shape();
    check('a fast song doubles the bar numbers and keeps the typed tempo and the length', one.bpm === 120 && two.bpm === 240 && two.shown === '120' && two.bars === one.bars * 2 && two.total === one.total && two.verse === one.verse * 2 && two.fast && !one.fast, JSON.stringify([one, two]));
    await js(`window.__app.send({ cmd: 'play' })`);
    await sleep(600);
    check('and the count-in is still counted at the typed tempo', last.playing && last.pos < -2.8 && last.pos > -3.9, `${last.pos.toFixed(2)}s`);
    await js(`window.__app.send({ cmd: 'stop' })`);
    await sleep(300);
    await js('window.__app.undo()');
    await sleep(200);
    const back = await shape();
    check('undo covers the song setup, not only its sections', back.bpm === one.bpm && back.bars === one.bars && back.verse === one.verse && !back.fast, JSON.stringify(back));

    // LIVE: nothing can be edited, and the keyboard still runs playback.
    await js('window.__app.setLive(true)');
    await sleep(100);
    await shot('selah-selftest-live.png');
    const lockFrom = await geo(4);
    const lockTo = await geo(6);
    mouse('mouseDown', lockFrom.x + 12, lockFrom.y + 10);
    for (let i = 1; i <= 6; i++) {
      mouse('mouseMove', Math.round(lockFrom.x + 12 + ((lockTo.x - lockFrom.x) * i) / 6), lockFrom.y + 10);
      await sleep(15);
    }
    mouse('mouseUp', lockTo.x + 12, lockTo.y + 10);
    await sleep(150);
    const lockedState = await js('({ verse: window.__app.state.song.sections.find((x) => x.name === "Verse 1").bar, bar: getComputedStyle(document.querySelector("#songBpm").parentElement).display, lit: document.querySelector("#modeLive").classList.contains("on") && !document.querySelector("#modeEdit").classList.contains("on"), info: document.querySelector("#liveInfo").textContent, addSong: getComputedStyle(document.querySelector("#btnNewSong")).display })');
    press('Space');
    await sleep(500);
    check('LIVE: sections cannot be dragged, the setup controls are gone, and Space still plays', lockedState.verse === one.verse && lockedState.bar === 'none' && lockedState.addSong === 'none' && lockedState.lit && /^Click Only  ·  120 BPM  ·  4\/4$/.test(lockedState.info) && last.playing, JSON.stringify(lockedState));
    await js(`window.__app.send({ cmd: 'stop' })`);
    await sleep(300);
    // An unplanned song: a click on it in the library adds it to the end of the setlist, without opening it.
    const inSet = await js('window.__app.state.lib.setlists[0].songIds.length');
    await js(`(() => { const set = window.__app.state.lib.setlists[0]; set.songIds.pop(); })()`);
    await js(`Array.from(document.querySelectorAll('#library li')).find((li) => li.textContent.includes('Click Only')).click()`);
    await sleep(150);
    const added = await js('({ n: window.__app.state.lib.setlists[0].songIds.length, open: window.__app.state.song.name })');
    check('LIVE: a song from the library can be added to the end of the setlist', added.n === inSet && added.open === 'Click Only', JSON.stringify(added));
    await js('window.__app.setLive(false)');
    const about = await js('document.querySelector("#about").textContent');
    check('the window says which build it is', /^v\d+\.\d+\.\d+/.test(about), about);

    await js(`window.__app.openSong(window.__app.state.lib.setlists[0].songIds[0])`);
    await until(`window.__app.state.song.name === 'Test Song' && window.__app.state.eng.songId === window.__app.state.song.id`, 60000, 'back to first song');

    // --- selecting several tracks: click, Shift-click, Cmd-click, drag, remove ---
    const picks = await js(`(async () => {
      const a = window.__app;
      const names = () => a.state.song.tracks.map((t) => t.name).join();
      const heads = () => Array.from(document.querySelectorAll('#rows .thead'));
      const click = (i, mods) => heads()[i].querySelector('.tname').dispatchEvent(new MouseEvent('click', Object.assign({ bubbles: true }, mods)));
      const picked = () => heads().map((h, i) => (h.classList.contains('sel') ? i : '')).join('');
      const rows = document.querySelector('#rows');
      const drop = (y) => {
        const dt = new DataTransfer();
        dt.setData('text/x-track', 'x');
        rows.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt, clientY: y }));
        const marked = document.querySelectorAll('#rows .row.dropabove, #rows .row.dropbelow').length;
        rows.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt, clientY: y }));
        return marked;
      };
      const out = { start: names(), n: heads().length };
      click(1);
      click(3, { shiftKey: true });
      out.run = picked();
      out.corner = document.querySelector('#corner').textContent;
      click(2, { metaKey: true });
      out.pair = picked();
      out.marked = drop(rows.getBoundingClientRect().top + 2);
      out.top = names();
      out.kept = picked();
      a.undo();
      out.undone = names();
      a.redo();
      out.redone = names();
      a.undo();
      // A drag that starts on a track outside the selection moves that track alone.
      heads()[0].dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: new DataTransfer() }));
      out.alone = picked();
      drop(heads()[out.n - 1].getBoundingClientRect().bottom - 2);
      out.bottom = names();
      a.undo();
      out.back = names();
      a.setLive(true);
      click(2);
      out.live = picked();
      a.setLive(false);
      // The × on one of two selected tracks removes both.
      click(1);
      click(3, { metaKey: true });
      out.gone = a.selectedTracks().map((t) => t.id);
      heads()[3].querySelector('.rm').click();
      await new Promise((r) => setTimeout(r, 600));
      out.left = names();
      out.rows = heads().length;
      out.after = picked();
      return out;
    })()`);
    {
      const t = picks.start.split(',');
      const order = (...i) => i.map((k) => t[k]).join();
      const others = t.slice(4).map((x, k) => k + 4);
      check('tracks select like files: click, Shift-click a run, Cmd-click one', picks.run === '123' && picks.corner === `3 of ${t.length} selected` && picks.pair === '13' && picks.live === '', JSON.stringify(picks));
      check('dragging the selected tracks reorders them, and undo puts them back', picks.marked === 1 && picks.top === order(1, 3, 0, 2, ...others) && picks.kept === '01' && picks.undone === picks.start && picks.redone === picks.top && picks.alone === '0' && picks.bottom === order(1, 2, 3, ...others, 0) && picks.back === picks.start, JSON.stringify(picks));
      const cacheDir = path.dirname(library.pcmPath(song.id, song.tracks[0].id, rate));
      const cachedFor = (ids) => fs.readdirSync(cacheDir).filter((f) => ids.some((id) => f.startsWith(id + '.'))).length;
      check('removing one of several selected tracks removes them all', picks.left === order(0, 2, ...others) && picks.rows === t.length - 2 && picks.after === '' && picks.gone.length === 2 && cachedFor(picks.gone) === 4, JSON.stringify({ left: picks.left, gone: picks.gone, kept: cachedFor(picks.gone) }));
      // Undo brings them back with their audio; removed again, the clean-up at the next start clears it.
      await js('window.__app.undo()');
      await until(`document.querySelectorAll('#rows .row').length === ${t.length} && window.__app.state.song.tracks.every((x) => (window.__app.state.peaks.get(x.id) || []).length > 1000)`, 20000, 'removed tracks back');
      await sleep(500);
      const back = await js('window.__app.state.song.tracks.map((x) => x.name).join()');
      const again = await js(`(async () => {
        const a = window.__app;
        const heads = () => Array.from(document.querySelectorAll('#rows .thead'));
        heads()[1].querySelector('.tname').dispatchEvent(new MouseEvent('click', { bubbles: true }));
        heads()[3].querySelector('.tname').dispatchEvent(new MouseEvent('click', { bubbles: true, metaKey: true }));
        heads()[3].querySelector('.rm').click();
        await new Promise((r) => setTimeout(r, 600));
        await a.pruneCache();
        return a.state.song.tracks.map((x) => x.id);
      })()`);
      check('undo brings removed tracks back, and their audio is only cleared at the next start', back === picks.start && again.length === t.length - 2 && cachedFor(picks.gone) === 0 && cachedFor(again) === again.length * 2, JSON.stringify({ back, gone: cachedFor(picks.gone), kept: cachedFor(again) }));
      await sleep(300);
    }

    const extra = process.env.SELFTEST_EXTRA;
    if (extra) {
      await js(`window.__app.importPaths([${JSON.stringify(extra)}])`);
      await sleep(300);
      await until(`!document.querySelector('#overlay .progress')`, 120000, 'extra file decoded');
      await sleep(500);
      const t = await js(`(() => { const a = window.__app; const t = a.state.song.tracks[a.state.song.tracks.length - 1]; return { name: t.name, channels: t.channels, duration: t.duration, missing: !!t.missing, peaks: (a.state.peaks.get(t.id) || []).length }; })()`);
      check('extra file ' + path.extname(extra) + ' decoded', !t.missing && t.duration > 1 && t.peaks > 100, JSON.stringify(t));
    }
    // --- right-click on a pad: turn that section into another one ---
    const padSwap = await js(`(() => {
      const a = window.__app;
      const names = () => a.state.song.sections.slice().sort((x, y) => x.bar - y.bar).map((x) => x.name).join();
      const pad = () => document.querySelectorAll('#pads .pad')[1];
      const item = (label) => Array.from(document.querySelectorAll('.menu button')).find((b) => b.textContent.replace('✓ ', '') === label);
      const out = { was: names(), pad: pad().querySelector('.n').textContent };
      pad().dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 300, clientY: 300 }));
      out.items = document.querySelectorAll('.menu button').length;
      out.ticked = (Array.from(document.querySelectorAll('.menu button')).find((b) => b.textContent.startsWith('✓ ')) || {}).textContent;
      item('Tag').click();
      out.now = names();
      out.shown = pad().querySelector('.n').textContent;
      a.undo();
      out.undone = names();
      pad().dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 300, clientY: 300 }));
      item('Delete section').click();
      out.fewer = names();
      a.undo();
      // The guide and the colour are one step further in the same menu.
      pad().dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 300, clientY: 300 }));
      item('Guide and colour…').click();
      item('No guide here').click();
      out.cue = a.state.song.sections.slice().sort((x, y) => x.bar - y.bar)[1].cue;
      a.undo();
      a.setLive(true);
      pad().dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 300, clientY: 300 }));
      out.live = document.querySelectorAll('.menu button').length;
      a.setLive(false);
      // The strip above the bar numbers has no menu any more.
      const ruler = document.querySelector('#ruler').getBoundingClientRect();
      document.querySelector('#ruler').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: ruler.left + 20, clientY: ruler.top + 5 }));
      out.strip = document.querySelectorAll('.menu button').length;
      out.back = names();
      return out;
    })()`);
    {
      const was = padSwap.was.split(',');
      const swapped = was.slice();
      swapped[1] = 'Tag';
      check('right-clicking a pad changes, silences or deletes that section; the timeline strip has no menu', padSwap.items >= 15 && padSwap.ticked === '✓ ' + was[1] && padSwap.now === swapped.join() && padSwap.shown === 'Tag' && padSwap.undone === padSwap.was && padSwap.fewer === was.filter((x, i) => i !== 1).join() && padSwap.cue === 'off' && padSwap.live === 0 && padSwap.strip === 0 && padSwap.back === padSwap.was, JSON.stringify(padSwap));
    }

    // --- cue clips: a MIDI file from the Count In track gives a song its tempo and sections ---
    {
      const cuefile = require('./cuefile');
      const cueDir = path.join(dir, 'cue clips');
      fs.mkdirSync(cueDir);
      const two = (q, pitch) => [{ q, pitch }, { q: q + 2, pitch: 45 }, { q: q + 4, pitch: 44 }, { q: q + 5, pitch: 45 }, { q: q + 6, pitch: 46 }, { q: q + 7, pitch: 47 }];
      const one = (q, pitch) => [{ q, pitch }, { q: q + 1, pitch: 45 }, { q: q + 2, pitch: 46 }, { q: q + 3, pitch: 47 }];
      // "Intro . 2 . 1 2 3 4", "Verse 2 3 4", "Chorus . 2 . 1 2 3 4", "All In" on its own, "Bridge" on a downbeat.
      const cueFile = path.join(cueDir, 'SELFTEST SONG - CUE 90.mid');
      fs.writeFileSync(cueFile, cuefile.encode([...two(0, 48), ...one(20, 49), ...two(40, 50), { q: 60, pitch: 39 }, { q: 64, pitch: 36 }], 96));
      const setup = () => js('(() => { const s = window.__app.state.song; return { name: s.name, bpm: s.bpm, sig: s.num + "/" + s.den, tracks: s.tracks.length, sections: s.sections.map((x) => x.name + "@" + x.bar + (x.cue ? ":" + (x.cue.n ? x.cue.n + x.cue.unit : x.cue) : "")).join(" ") }; })()');
      const structure = 'Intro@0 Verse@4 Chorus@10:two Bridge@14:1beats';

      // Dropped alone on a song with stems: it becomes that song's structure (the self-test answers yes), and undo puts the old one back.
      const was = await setup();
      await js(`window.__app.importPaths([${JSON.stringify(cueFile)}])`);
      const onto = await setup();
      const note = await js('document.querySelector("#toast").textContent');
      await js('window.__app.undo()');
      const undone = await setup();
      check('a cue clip dropped on a song with stems gives it its structure, and undo takes it back', onto.name === was.name && onto.tracks === was.tracks && onto.sections === structure && onto.bpm === 90 && /4 sections and 1 callout at 90 BPM in 4\/4/.test(note) && JSON.stringify(undone) === JSON.stringify(was), JSON.stringify({ was, onto, note, undone }));

      // With no stems in the open song it is a new song, in the setlist like any other.
      await js(`window.__app.openSong(window.__app.state.lib.songs.find((x) => x.name === 'Click Only').id)`);
      await until(`window.__app.state.song.name === 'Click Only'`, 20000, 'click-only song open');
      const before = await js('({ songs: window.__app.state.lib.songs.length, set: window.__app.state.lib.setlists[0].songIds.length })');
      await js(`window.__app.importPaths([${JSON.stringify(cueFile)}])`);
      await until(`window.__app.state.song.name === 'Selftest Song' && window.__app.state.eng.songId === window.__app.state.song.id`, 20000, 'song made from a cue clip');
      await sleep(300);
      const made = await setup();
      const after = await js('({ songs: window.__app.state.lib.songs.length, set: window.__app.state.lib.setlists[0].songIds.length, guide: window.__app.state.guide.filter((g) => g.spoken).length, bars: window.__app.state.song.bars })');
      check('a cue clip on its own becomes a new song with tempo, sections and a guide', made.sections === structure && made.bpm === 90 && made.sig === '4/4' && made.tracks === 0 && after.songs === before.songs + 1 && after.set === before.set + 1 && after.bars === 22 && after.guide >= 14, JSON.stringify({ made, before, after }));

      // Callouts: the clip's "All In" came across as one; they are added, changed and deleted by hand, with undo.
      const callouts = await js(`(() => {
        const a = window.__app;
        const list = () => (a.state.song.callouts || []).slice().sort((x, y) => x.bar - y.bar).map((c) => c.word + '@' + c.bar).join(' ');
        const chips = () => Array.from(document.querySelectorAll('#pads .callout'));
        const item = (label) => Array.from(document.querySelectorAll('.menu button')).find((b) => b.textContent.replace('✓ ', '') === label);
        const out = { clip: list(), chip: chips().map((c) => c.textContent).join('|'), sent: JSON.stringify(a.cueMessage(a.state.song).callouts) };
        document.querySelector('#btnAddCallout').click();
        item('Last Time').click();
        out.added = list();
        chips()[0].dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 300, clientY: 300 }));
        out.ticked = (Array.from(document.querySelectorAll('.menu button')).find((b) => b.textContent.startsWith('✓ ')) || {}).textContent;
        item('Count in (1 2 3 4)').click();
        out.changed = list();
        chips()[1].dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 300, clientY: 300 }));
        item('Delete callout').click();
        out.fewer = list();
        a.undo(); a.undo(); a.undo();
        out.back = list();
        a.setLive(true);
        chips()[0].dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 300, clientY: 300 }));
        out.live = document.querySelectorAll('.menu button').length;
        a.setLive(false);
        return out;
      })()`);
      await shot('selah-selftest-callouts.png');
      check('callouts: a clip\'s lone words come across, and they can be added, changed and deleted', callouts.clip === 'All In@13' && callouts.chip === 'bar 14All In' && callouts.sent === '[{"bar":13,"word":"All In"}]' && callouts.added === 'Last Time@0 All In@13' && callouts.ticked === '✓ Last Time' && callouts.changed === 'count@0 All In@13' && callouts.fewer === 'count@0' && callouts.back === callouts.clip && callouts.live === 0, JSON.stringify(callouts));

      // A folder of clips: one song each, in the library only. One of them is
      // already there; told to skip, Selah leaves that song alone.
      fs.writeFileSync(path.join(cueDir, 'OTHER ONE 70.mid'), cuefile.encode([...two(4, 48), ...one(28, 50)], 60));
      fs.writeFileSync(path.join(cueDir, 'THIRD ONE 80.mid'), cuefile.encode([...two(0, 48), ...one(20, 49)], 60));
      await js(`(() => { const a = window.__app; a.state.song.bpm = 50; a.answers.push(1); return a.importPaths([${JSON.stringify(cueDir)}]); })()`);
      await sleep(500);
      const many = await js('({ songs: window.__app.state.lib.songs.length, set: window.__app.state.lib.setlists[0].songIds.length, open: window.__app.state.song.name, other: (window.__app.state.lib.songs.find((x) => x.name === "Other One") || {}).bpm, kept: window.__app.state.lib.songs.find((x) => x.name === "Selftest Song").bpm, note: document.querySelector("#toast").textContent })');
      check('a folder of cue clips becomes one song each, in the library only; one already there is skipped', many.songs === after.songs + 2 && many.set === after.set && many.other === 70 && many.kept === 50 && /^2 songs added to the Library, 1 already there and left as it is\./.test(many.note), JSON.stringify(many));

      // The same clip again, told to replace: the song it has takes the clip's setup, and undo puts its own back.
      await js(`(() => { const a = window.__app; a.answers.push(0); return a.importPaths([${JSON.stringify(cueFile)}]); })()`);
      await until(`window.__app.state.song.name === 'Selftest Song'`, 20000, 'replaced song open');
      const again = await js('({ songs: window.__app.state.lib.songs.length, same: window.__app.state.lib.songs.filter((x) => x.name === "Selftest Song").length, bpm: window.__app.state.song.bpm, note: document.querySelector("#toast").textContent })');
      await js('window.__app.undo()');
      const undoneBpm = await js('window.__app.state.song.bpm');
      await js('window.__app.redo()');
      check('a clip for a song that is already there replaces it instead of making a second one', again.songs === many.songs && again.same === 1 && again.bpm === 90 && /^"Selftest Song" replaced: 4 sections/.test(again.note) && undoneBpm === 50, JSON.stringify({ again, undoneBpm }));

      // Stems and a cue clip in one folder: one song with both.
      const both = path.join(dir, 'Both Song');
      fs.mkdirSync(both);
      for (const n of ['03 Drums.wav', '04 Bass.wav']) fs.copyFileSync(path.join(stemDir, n), path.join(both, n));
      fs.copyFileSync(cueFile, path.join(both, 'cue 90.mid'));
      await js(`window.__app.importPaths([${JSON.stringify(both)}])`);
      await until(`window.__app.state.song.name === 'Both Song' && window.__app.state.eng.songId === window.__app.state.song.id`, 120000, 'song with stems and a cue clip loaded');
      const bothSong = await setup();
      check('a folder with stems and a cue clip becomes one song with both', bothSong.tracks === 2 && bothSong.sections === structure && bothSong.bpm === 90, JSON.stringify(bothSong));

      // The same folder again, skipped: still one song. Then stems with names it already has:
      // replaced, the track keeps its volume and takes the new file; skipped, nothing changes.
      const tracksNow = () => js('window.__app.state.song.tracks.map((t) => t.name + ":" + t.gain + ":" + t.file.split("/").slice(-2, -1)[0]).join()');
      await js(`(() => { const a = window.__app; a.answers.push(1); return a.importPaths([${JSON.stringify(both)}]); })()`);
      const sameSong = await js('({ n: window.__app.state.lib.songs.filter((x) => x.name === "Both Song").length, note: document.querySelector("#toast").textContent })');
      const takes = path.join(dir, 'New Takes');
      fs.mkdirSync(takes);
      fs.copyFileSync(path.join(stemDir, '04 Bass.wav'), path.join(takes, '03 Drums.wav'));
      fs.copyFileSync(path.join(stemDir, '03 Drums.wav'), path.join(takes, '09 Shaker.wav'));
      fs.copyFileSync(path.join(stemDir, '03 Drums.wav'), path.join(takes, '04 Bass.wav'));
      await js(`(() => { const a = window.__app; a.state.song.tracks.find((t) => t.name === 'Drums').gain = 0.5; a.answers.push(0); return a.importPaths([${JSON.stringify(path.join(takes, '03 Drums.wav'))}, ${JSON.stringify(path.join(takes, '09 Shaker.wav'))}]); })()`);
      await until(`window.__app.state.song.tracks.length === 3 && window.__app.state.song.tracks.every((t) => (window.__app.state.peaks.get(t.id) || []).length > 1000) && window.__app.state.eng.songId === window.__app.state.song.id`, 120000, 'replaced stem decoded');
      const swapped = await tracksNow();
      await js(`(() => { const a = window.__app; a.answers.push(1); return a.importPaths([${JSON.stringify(path.join(takes, '04 Bass.wav'))}]); })()`);
      await sleep(400);
      const skippedStem = await tracksNow();
      check('a folder or a stem that is already there is replaced or skipped, never doubled', sameSong.n === 1 && /^Already in your library, left as it is: Both Song\./.test(sameSong.note) && swapped === 'Drums:0.5:New Takes,Bass:1:Both Song,Shaker:1:New Takes' && skippedStem === swapped, JSON.stringify({ sameSong, swapped, skippedStem }));
      const refused = await js(`window.__app.importPaths([${JSON.stringify(path.join(dir, 'missing.txt'))}]).then(() => document.querySelector('#toast').textContent)`);
      check('something Selah cannot open is refused with a reason', /Nothing Selah can open/.test(refused), refused);
    }

    // --- while playing, the timeline can be scrolled away; it comes back to the playhead after a moment ---
    {
      await js(`(() => { const a = window.__app; const t = a.getTimeline(); t.freeMs = 500; t.setZoom(200); a.send({ cmd: 'stop' }); })()`);
      await sleep(200);
      // From two seconds in, so the playhead is in the song and not in the count-in before it.
      await js(`(() => { const a = window.__app; a.send({ cmd: 'seek', seconds: 2 }); a.send({ cmd: 'play' }); })()`);
      await until('window.__app.state.eng.playing && window.__app.state.eng.pos > 2', 5000, 'playing for the scroll check');
      await sleep(300);
      // The frame is run by hand as well, in case the hidden test window is not drawing.
      const view = () => js(`(() => { const a = window.__app; const t = a.getTimeline(); t.frame(a.state.eng.pos, true); return { left: document.querySelector('#hscroll').scrollLeft, x: Math.round(t.xOf(a.state.eng.pos)), w: t.viewW }; })()`);
      const following = await view();
      await js(`document.querySelector('#hscroll').scrollLeft = 2400`);
      await sleep(200);
      const away = await view();
      await sleep(700);
      const back = await view();
      await js(`(() => { const a = window.__app; a.send({ cmd: 'stop' }); const t = a.getTimeline(); t.freeMs = 4000; t.fit(); })()`);
      await sleep(300);
      check('while playing, the timeline scrolls freely and then returns to the playhead', following.x >= 0 && following.x <= following.w && away.left > 2000 && away.x < 0 && back.x >= 0 && back.x <= back.w, JSON.stringify({ following, away, back }));
    }

    // --- a device that stops taking audio (a sleeping Mac, a closed lid) is noticed and said, and the song carries on when it comes back ---
    {
      const look = () => js(`(() => { const a = window.__app; const b = document.querySelector('#btnAudio'); return { stalled: !!a.state.stalled, bad: b.classList.contains('bad'), text: b.textContent, toast: document.querySelector('#toast').textContent, pos: a.state.eng.pos, playing: a.state.eng.playing }; })()`);
      await js(`(() => { const a = window.__app; a.send({ cmd: 'seek', seconds: 2 }); a.send({ cmd: 'play' }); })()`);
      await until('window.__app.state.eng.playing && window.__app.state.eng.pos > 2.2', 5000, 'playing before the device stops');
      const before = await look();
      freezing = true;
      await js(`window.__app.send({ cmd: 'freezeOutput', on: true })`);
      await sleep(3200);
      const stuck = await look();
      await sleep(400);
      const still = await look();
      await js(`window.__app.send({ cmd: 'freezeOutput', on: false })`);
      await sleep(900);
      const back = await look();
      freezing = false;
      await js(`window.__app.send({ cmd: 'stop' })`);
      await sleep(300);
      check('a device that stops taking audio is noticed and said, and the song carries on when it is back', !before.stalled && stuck.stalled && stuck.bad && /^Audio stopped/.test(stuck.text) && /^Audio has stopped/.test(stuck.toast) && stuck.playing && still.pos === stuck.pos && !back.stalled && !back.bad && !/^Audio stopped/.test(back.text) && back.pos > stuck.pos + 0.3, JSON.stringify({ before, stuck, still, back }));
    }

    // --- from one song to the next: what a song does at its end, the heads-up before it, lining up by hand, fading out ---
    {
      // Three two-bar songs (two seconds each at 240) at the end of the setlist, with no count-in.
      const ids = await js(`(() => {
        const a = window.__app;
        a.state.lib.settings.atEnd = 'next';
        return ['Flow A', 'Flow B', 'Flow C'].map((name) => {
          const s = a.createSong(name);
          s.bpm = 240;
          s.cues.enabled = false;
          s.sections = [{ id: 'm_' + name.replace(' ', ''), name: 'Intro', bar: 0, len: 2 }];
          return s.id;
        });
      })()`);
      const open = async (i, name) => {
        await js(`window.__app.openSong(${JSON.stringify(ids[i])})`);
        await until(`window.__app.state.song.name === '${name}' && window.__app.state.eng.songId === window.__app.state.song.id`, 20000, name + ' open');
      };
      const now = () => js('(() => { const a = window.__app; a.drawFrame(); const r = a.songReadout(); return { song: a.state.song.name, playing: a.state.eng.playing, pos: a.state.eng.pos, text: r.text, soon: r.soon, shown: document.querySelector("#nextSong .nm").textContent, detail: document.querySelector("#nextSong .lbl").textContent, cls: document.querySelector("#nextSong").className, queued: a.state.queued, fading: !!a.state.eng.fading, fadeLit: document.querySelector("#btnFade").classList.contains("on") }; })()');

      // "Lines up the next song": the top bar names it, says the change is coming, and at the end it is open and waiting.
      await open(0, 'Flow A');
      const waiting = await now();
      await js(`window.__app.send({ cmd: 'play' })`);
      await sleep(600);
      const soon = await now();
      await until(`window.__app.state.song.name === 'Flow B' && window.__app.state.eng.songId === window.__app.state.song.id`, 8000, 'the next song lined up at the end');
      await sleep(400);
      const lined = await now();
      check('a song set to hand over lines up the next one at its end, and says so beforehand', waiting.text === 'Next song: Flow B · 240' && soon.soon && /^Song change in \d+ (bars?|beats?) → Flow B · 240$/.test(soon.text) && waiting.shown === 'Flow B' && waiting.detail === 'Next song · 240' && soon.shown === 'Flow B' && /^Song change in \d+ (bars?|beats?)$/.test(soon.detail) && /soon/.test(soon.cls) && lined.song === 'Flow B' && !lined.playing && lined.pos === 0, JSON.stringify({ waiting, soon, lined }));

      // "Rolls straight in", chosen for this one song: the next starts by itself.
      await js(`(() => { const a = window.__app; a.state.song.atEnd = 'roll'; a.sendBars(a.state.song); a.send({ cmd: 'play' }); })()`);
      await until(`window.__app.state.song.name === 'Flow C' && window.__app.state.eng.songId === window.__app.state.song.id && window.__app.state.eng.playing && window.__app.state.eng.pos > 0.2`, 8000, 'the next song rolling');
      const rolled = await now();
      // It is the last in the setlist: at its own end it just stops.
      await until(`!window.__app.state.eng.playing`, 8000, 'the last song ending');
      await sleep(300);
      const lastOne = await now();
      check('a song set to roll starts the next one by itself; the last song just ends', rolled.song === 'Flow C' && rolled.playing && lastOne.song === 'Flow C' && !lastOne.playing && lastOne.text === '', JSON.stringify({ rolled, lastOne }));

      // By hand: with songs set to stop, one is lined up while another plays; a fade-out ends the song and the lined-up one opens.
      await js(`window.__app.state.lib.settings.atEnd = 'stop'`);
      await open(0, 'Flow A');
      await js(`window.__app.send({ cmd: 'play' })`);
      await sleep(400);
      await js(`window.__app.openSong(${JSON.stringify(ids[2])})`);
      await sleep(200);
      const queued = await now();
      await js(`window.__app.send({ cmd: 'fadeOut', seconds: 0.6 })`);
      await sleep(250);
      const fading = await now();
      await until(`window.__app.state.song.name === 'Flow C' && window.__app.state.eng.songId === window.__app.state.song.id`, 8000, 'the lined-up song after the fade');
      await sleep(300);
      const after = await now();
      check('a song lined up by hand opens when the playing one is faded out', queued.song === 'Flow A' && queued.playing && queued.queued === ids[2] && queued.text === 'Lined up: Flow C · 240' && fading.fading && fading.fadeLit && fading.song === 'Flow A' && after.song === 'Flow C' && !after.playing && after.queued === null && !after.fadeLit, JSON.stringify({ queued, fading, after }));

      // Confirm delete, in Settings: switched off, a song goes at once with a word about undo, and undo brings it back.
      await inDialog('#btnSettings', { setConfirm: 'Off' });
      const del = await js(`(async () => {
        const a = window.__app;
        const s = a.state.lib.songs.find((x) => x.name === 'Flow B');
        const n = a.state.lib.songs.length;
        await a.deleteSong(s);
        const out = { off: a.state.lib.settings.confirmDelete === false, gone: a.state.lib.songs.length === n - 1, toast: document.querySelector('#toast').textContent };
        a.undo();
        out.back = a.state.lib.songs.length === n;
        return out;
      })()`);
      await inDialog('#btnSettings', { setConfirm: 'On' });
      const asking = await js('window.__app.state.lib.settings.confirmDelete');
      check('Confirm delete can be switched off in Settings; the song goes at once and undo brings it back', del.off && del.gone && /^Deleted "Flow B"\. Cmd\+Z brings it back\.$/.test(del.toast) && del.back && asking === true, JSON.stringify({ del, asking }));

      // The setlist: Cmd-click and Shift-click select several rows, a drag moves them together, the × takes them off, undo puts each back.
      const rows = await js(`(() => {
        const a = window.__app;
        const set = a.state.lib.setlists.find((x) => x.id === a.state.lib.currentSetlistId);
        const names = () => set.songIds.map((id) => a.state.lib.songs.find((x) => x.id === id).name).join();
        const li = () => Array.from(document.querySelectorAll('#setlist li'));
        const picked = () => li().map((r, i) => (r.classList.contains('sel') ? i : -1)).filter((i) => i >= 0).join();
        const click = (i, mods) => li()[i].dispatchEvent(new MouseEvent('click', Object.assign({ bubbles: true }, mods)));
        const n = set.songIds.length;
        const out = { n, start: names(), open: a.state.song.name };
        click(n - 3, { metaKey: true });
        click(n - 1, { shiftKey: true });
        out.run = picked();
        out.stillOpen = a.state.song.name;
        const dt = new DataTransfer();
        dt.setData('text/x-setlist-index', String(n - 2));
        li()[0].dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }));
        out.moved = names();
        out.kept = picked();
        a.undo();
        out.undone = names();
        click(n - 3, { metaKey: true });
        click(n - 1, { metaKey: true });
        out.pair = picked();
        li()[n - 1].querySelector('button').click();
        out.fewer = names();
        a.undo();
        out.back = names();
        a.setLive(true);
        click(n - 1, { shiftKey: true });
        out.live = picked();
        a.setLive(false);
        return out;
      })()`);
      {
        const t = rows.start.split(',');
        const n = t.length;
        check('setlist rows select like files; a drag moves them together, the × takes them off, undo puts them back', rows.run === `${n - 3},${n - 2},${n - 1}` && rows.stillOpen === rows.open && rows.moved === [...t.slice(n - 3), ...t.slice(0, n - 3)].join() && rows.kept === '0,1,2' && rows.undone === rows.start && rows.pair === `${n - 3},${n - 1}` && rows.fewer === t.filter((x, i) => i !== n - 3 && i !== n - 1).join() && rows.back === rows.start && rows.live === '', JSON.stringify(rows));
      }
    }

    // --- click sounds: the list, choosing one, and the demo that plays it in the song's own meter ---
    {
      await js(`(() => { const a = window.__app; a.send({ cmd: 'stop' }); const b = a.state.lib.settings.buses; ${out.channels >= 4 ? "Object.assign(b.band, { mode: 'stereo', ch: 0 }); Object.assign(b.cue, { mode: 'stereo', ch: 2 });" : "Object.assign(b.band, { mode: 'mono', ch: 1 }); Object.assign(b.cue, { mode: 'mono', ch: 0 });"} a.send({ cmd: 'setBuses', buses: b }); })()`);
      await sleep(400);
      const wasAt = last.pos;
      const soundBefore = await js('window.__app.state.song.click.sound');
      peaks.length = 0;
      // Choosing a sound in Song settings plays its demo by itself.
      await js(`document.querySelector('#btnSongSettings').click()`);
      await sleep(200);
      const listed = await js(`Array.from(document.querySelector('#setClickSound').options, (o) => o.textContent).join()`);
      await js(`(() => { const c = document.querySelector('#setClickSound'); c.selectedIndex = Array.from(c.options).findIndex((o) => o.textContent === 'Cowbell'); c.dispatchEvent(new Event('change')); })()`);
      await sleep(900);
      p = peaks.slice();
      const picked = await js(`({ sound: window.__app.state.song.click.sound, shown: document.querySelector('#setClickSound').value, button: !!document.querySelector('#btnClickListen') })`);
      const during = { playing: last.playing, pos: last.pos };
      const choose = (name) => js(`(() => { const c = document.querySelector('#setClickSound'); c.selectedIndex = Array.from(c.options).findIndex((o) => o.textContent === '${name}'); c.dispatchEvent(new Event('change')); })()`);
      // Choosing another plays that one, taking over from the first.
      peaks.length = 0;
      await choose('Classic');
      await sleep(900);
      const again = peaks.slice();
      // Closing the window cuts a demo short (two bars of this song take over five seconds).
      await choose('Gentle');
      await sleep(300);
      await js(`document.querySelector('#overlay .modal-head .x').click()`);
      await sleep(400);
      peaks.length = 0;
      await sleep(700);
      const closed = peaks.slice();
      await js('(() => { const a = window.__app; a.undo(); a.undo(); a.undo(); })()');
      const restored = await js('window.__app.state.song.click.sound');
      check('there are more click sounds; choosing one plays a demo on the ears only, without touching the song, and closing the window cuts it', /^(EW click,)?Blip,Classic,Cowbell,Digital,Gentle,Percussive,Saw,Woodblock,Beep$/.test(listed) && picked.sound === 'cowbell' && !picked.button && cueCh.every((c) => p[c] > 0.001) && bandCh.every((c) => !(p[c] > 0)) && !during.playing && during.pos === wasAt && cueCh.every((c) => again[c] > 0.001) && cueCh.every((c) => !(closed[c] > 0)) && restored === soundBefore, JSON.stringify({ listed, picked, during, restored, p: p.map((v) => (v || 0).toFixed(4)), again: again.map((v) => (v || 0).toFixed(4)), closed: closed.map((v) => (v || 0).toFixed(4)) }));
      // The output check walks the device's outputs one at a time, and starting the song ends it.
      const seen = [];
      await js(`window.__app.send({ cmd: 'testOutputs', on: true })`);
      for (let i = 0; i < 80; i++) {
        const ch = await js('window.__app.state.testCh');
        if (ch !== seen[seen.length - 1]) seen.push(ch);
        if (seen.length > 1 && ch == null) break;
        await sleep(100);
      }
      const outs = await js('window.__app.state.out.channels');
      await js(`window.__app.send({ cmd: 'testOutputs', on: true })`);
      await sleep(300);
      const mid = await js('window.__app.state.testCh');
      await js(`window.__app.send({ cmd: 'play' })`);
      await sleep(400);
      const cut = await js('window.__app.state.testCh');
      await js(`window.__app.send({ cmd: 'stop' })`);
      await sleep(150);
      check('the output check sounds each output in turn, and playing the song ends it', seen.join() === Array.from({ length: outs }, (_, i) => i).join() + ',' && mid === 0 && cut == null, JSON.stringify({ seen, outs, mid, cut }));
    }

    // --- the top bar at the smallest window: nothing sits on top of anything else (the transport once covered LIVE) ---
    {
      const size = win.getSize();
      win.setSize(980, 600);
      await sleep(400);
      const bar = await js(`(() => {
        const kids = Array.from(document.querySelector('#topbar').children).filter((k) => k.getBoundingClientRect().width > 0 && !k.classList.contains('spacer'));
        const boxes = kids.map((k) => { const r = k.getBoundingClientRect(); return { id: k.id || k.className, l: Math.round(r.left), r: Math.round(r.right) }; });
        const overlaps = boxes.filter((b, i) => i && b.l < boxes[i - 1].r).map((b) => b.id);
        const live = document.querySelector('#modeLive').getBoundingClientRect();
        const hit = document.elementFromPoint(live.left + live.width / 2, live.top + live.height / 2);
        return { width: window.innerWidth, overlaps, live: hit && hit.id, lastRight: boxes[boxes.length - 1].r, boxes };
      })()`);
      win.setSize(size[0], size[1]);
      await sleep(300);
      const meters = await js(`(() => { const m = document.querySelector('.meters').getBoundingClientRect(); const c = document.querySelector('.corner').getBoundingClientRect(); const z = document.querySelector('#btnZoomFit').getBoundingClientRect(); return { inCorner: !!document.querySelector('.corner .meters') && m.left >= c.left && m.right <= c.right && m.top >= c.top && m.bottom <= z.top, wide: Math.round(m.width) }; })()`);
      check('at the smallest window size nothing in the top bar covers anything else, and the meters sit above the track names', bar.overlaps.length === 0 && bar.live === 'modeLive' && bar.lastRight <= bar.width && meters.inCorner && meters.wide > 150, JSON.stringify({ bar, meters }));
    }

    check('no engine errors reported', !events.some((e) => e.type === 'error' || e.type === 'outputError'), events.filter((e) => e.type === 'error' || e.type === 'outputError').map((e) => e.message).join('; '));
  } catch (err) {
    failed = true;
    console.log('FAIL  self-test aborted: ' + (err && err.stack ? err.stack : err));
  }
  fs.rmSync(dir, { recursive: true, force: true });
  try {
    clean(library);
  } catch (err) {
    // Cache files can still be open in the engine; the next run clears them.
  }
  if (strayKeys.length) console.log(`INFO  ${strayKeys.length} key presses that did not come from the test reached its window${process.env.SELFTEST_STRAY === 'unguarded' ? ' and were let through' : ' and were ignored'} (${Array.from(new Set(strayKeys)).join(', ')})`);
  if (sleptDuringRun) console.log('INFO  the audio device stopped taking audio during this run, so failures above that involve playback are the Mac sleeping, not Selah. Run it again with the lid open.');
  const bad = results.filter((r) => !r.ok).length + (failed ? 1 : 0);
  console.log(bad ? `SELFTEST FAILED (${bad})` : `SELFTEST OK (${results.length} checks)`);
  fs.writeFileSync(path.join(os.tmpdir(), 'selah-selftest.json'), JSON.stringify({ ok: !bad, results }, null, 1));
  app.exit(bad ? 1 : 0);
}

module.exports = { run, clean };
