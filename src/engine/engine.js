'use strict';
const fs = require('fs');
const { Mixer } = require('./mixer');
const output = require('./output');
const samples = require('./samples');
const vault = require('./vault');

const STATE_INTERVAL_MS = 33;
const MAX_CACHED_SONGS = 3;

// Owns the output device, the mixer and the decoded songs. Driven by plain
// message objects ({ cmd, ... }) and reports back through `emit`, so it runs
// the same inside the utility process and under plain Node in tests.
class Engine {
  constructor(emit) {
    this.emit = emit;
    this.out = null;
    this.mixer = null;
    this.buses = null;
    this.loaded = new Map(); // songId -> { key, song } decoded PCM kept in RAM
    this.currentId = null;
    this.audible = { pos: 0, playing: false, at: Date.now() };
    // SELAH_SILENT=1 sends silence to the device while everything else runs
    // and is metered as usual. For testing next to a live rig.
    this.silent = process.env.SELAH_SILENT === '1';
    this.stateTimer = setInterval(() => this._sendState(), STATE_INTERVAL_MS);
  }

  async handle(msg) {
    try {
      const fn = this['cmd_' + msg.cmd];
      if (!fn) throw new Error('Unknown engine command: ' + msg.cmd);
      await fn.call(this, msg);
    } catch (err) {
      this.emit({ type: 'error', cmd: msg.cmd, message: String((err && err.message) || err) });
    }
  }

  cmd_getDevices() {
    this.emit(Object.assign({ type: 'devices' }, output.listDevices()));
  }

  // { apiId, deviceName, sampleRate, frameSize, queueBlocks }
  cmd_openOutput(msg) {
    const wasId = this.currentId;
    if (this.out) {
      this.out.close();
      this.out = null;
    }
    const opts = {
      apiId: msg.apiId,
      deviceName: msg.deviceName,
      sampleRate: msg.sampleRate || 48000,
      frameSize: msg.frameSize || 512,
      queueBlocks: msg.queueBlocks || 4,
      render: (buf, n) => this._render(buf, n),
      onBlock: (meta) => this._onBlock(meta),
      onError: (message) => this.emit({ type: 'outputError', message }),
    };
    let out;
    let error = null;
    try {
      if (!output.available() || msg.apiId === 'none') throw new Error(msg.apiId === 'none' ? 'No audio output selected' : 'Native audio module failed to load');
      out = new output.RtOutput(opts).open();
    } catch (err) {
      error = String((err && err.message) || err);
      out = new output.NullOutput(opts).open();
    }

    // A different sample rate invalidates everything decoded so far.
    if (this.mixer && this.mixer.rate !== out.sampleRate) {
      this.loaded.clear();
      this.currentId = null;
    }
    const mixer = new Mixer({ sampleRate: out.sampleRate, channels: out.channels });
    if (this.buses) mixer.setBuses(this.buses);
    let soundsError = null;
    try {
      mixer.setSounds(samples.load(out.sampleRate));
    } catch (err) {
      // The generated click still works; spoken cues do not.
      soundsError = String((err && err.message) || err);
    }
    this.mixer = mixer;
    this.out = out;
    this.preview = null;
    if (wasId && this.loaded.has(wasId)) {
      mixer.setSong(this.loaded.get(wasId).song);
      this.currentId = wasId;
    }
    this.audible = { pos: 0, playing: false, at: Date.now() };
    out.start();
    this.emit({
      type: 'output',
      ok: !error,
      error,
      fellBack: !!out.fellBack,
      apiId: out.apiId,
      apiName: out.apiName,
      deviceName: out.deviceName,
      channels: out.channels,
      sampleRate: out.sampleRate,
      frameSize: out.frameSize,
      latencyMs: Math.round((((opts.queueBlocks * out.frameSize + out.latencyFrames) / out.sampleRate) * 1000)),
    });
    if (soundsError) this.emit({ type: 'error', cmd: 'openOutput', message: 'Click and guide sounds could not be loaded: ' + soundsError });
    this._sendGuide();
  }

  // Where the guide voice speaks in the current song, for the window to draw:
  // [{ sec, bar, spoken }], `bar` being the section announced. An entry that
  // is not spoken only marks where a count-in bar of click starts.
  _sendGuide() {
    const m = this.mixer;
    if (!m || !m.song || !this.currentId) return;
    const on = !!(m.song.cues && m.song.cues.enabled && m.sounds);
    const events = on ? m._plan().map((e) => ({ sec: e.frame / m.rate, bar: e.bar, spoken: !!e.snd })) : [];
    this.emit({ type: 'guide', songId: this.currentId, events });
  }

  // { buses: { band: { mode, ch, gain }, cue: { ... } } }
  cmd_setBuses(msg) {
    this.buses = msg.buses;
    if (this.mixer) this.mixer.setBuses(msg.buses);
  }

  // { songId, key, grid, bars, click, cues, tracks: [{ id, path, channels, frames, gain, mute, solo, bus }], preload }
  // `key` changes whenever the cached audio does (stems added, removed, re-decoded).
  async cmd_loadSong(msg) {
    if (!this.mixer) throw new Error('Open an output before loading a song');
    let entry = this.loaded.get(msg.songId);
    if (!entry || entry.key !== msg.key) {
      const rate = this.mixer.rate;
      const tracks = [];
      for (const t of msg.tracks) {
        const buf = await fs.promises.readFile(t.path);
        const usable = buf.length - (buf.length % (2 * t.channels));
        // Int16Array needs an even byte offset; copy in the rare case it is not.
        const src = buf.byteOffset % 2 === 0 ? buf : Buffer.from(buf);
        const data = new Int16Array(src.buffer, src.byteOffset, usable / 2);
        tracks.push({ id: t.id, data, ch: t.channels, frames: usable / 2 / t.channels, gain: t.gain, mute: t.mute, solo: t.solo, bus: t.bus });
      }
      if (rate !== this.mixer.rate) return; // output changed while reading
      entry = { key: msg.key, song: { id: msg.songId, grid: msg.grid, bars: msg.bars, endBar: msg.endBar, click: msg.click, cues: msg.cues, tracks } };
      this.loaded.delete(msg.songId);
      this.loaded.set(msg.songId, entry);
      this._trimCache(msg.songId);
    } else {
      // Same audio; refresh everything else from the message.
      entry.song.grid = msg.grid;
      entry.song.bars = msg.bars;
      entry.song.endBar = msg.endBar;
      entry.song.click = msg.click;
      entry.song.cues = msg.cues;
      for (const t of msg.tracks) {
        const have = entry.song.tracks.find((x) => x.id === t.id);
        if (have) Object.assign(have, { gain: t.gain, mute: t.mute, solo: t.solo, bus: t.bus });
      }
      this.loaded.delete(msg.songId);
      this.loaded.set(msg.songId, entry);
    }
    if (msg.preload) {
      this.emit({ type: 'songPreloaded', songId: msg.songId });
      return;
    }
    this.mixer.setSong(entry.song);
    this.currentId = msg.songId;
    this.audible = { pos: 0, playing: false, at: Date.now() };
    this.emit({ type: 'songLoaded', songId: msg.songId, duration: entry.song.length / this.mixer.rate });
    this._sendGuide();
  }

  _trimCache(keepId) {
    for (const id of this.loaded.keys()) {
      if (this.loaded.size <= MAX_CACHED_SONGS) break;
      if (id !== keepId && id !== this.currentId) this.loaded.delete(id);
    }
  }

  cmd_unloadSong(msg) {
    if (!msg.songId || msg.songId === this.currentId) {
      if (this.mixer) this.mixer.setSong(null);
      this.currentId = null;
    }
    if (msg.songId) this.loaded.delete(msg.songId);
  }

  cmd_setTrack(msg) {
    if (this.mixer && msg.songId === this.currentId) this.mixer.setTrack(msg.id, msg.patch);
    else {
      const entry = this.loaded.get(msg.songId);
      const t = entry && entry.song.tracks.find((x) => x.id === msg.id);
      if (t) Object.assign(t, msg.patch);
    }
  }

  cmd_setGrid(msg) {
    if (this.mixer && msg.songId === this.currentId) {
      this.mixer.setGrid(msg.grid);
      this._sendGuide();
    }
  }

  cmd_setClick(msg) {
    if (this.mixer && msg.songId === this.currentId) this.mixer.setClick(msg.click);
  }

  cmd_setCues(msg) {
    if (this.mixer && msg.songId === this.currentId) {
      this.mixer.setCues(msg.cues);
      this._sendGuide();
    } else {
      const entry = this.loaded.get(msg.songId);
      if (entry) entry.song.cues = msg.cues;
    }
  }

  cmd_setBars(msg) {
    if (this.mixer && msg.songId === this.currentId) this.mixer.setBars(msg.bars, msg.endBar);
    else {
      const entry = this.loaded.get(msg.songId);
      if (entry) {
        entry.song.bars = msg.bars;
        entry.song.endBar = msg.endBar;
      }
    }
  }

  cmd_play() {
    if (this.mixer) this.mixer.play();
  }

  cmd_playFromBar(msg) {
    if (this.mixer) this.mixer.playFromBar(msg.bar);
  }

  cmd_pause() {
    if (this.mixer) this.mixer.pause();
  }

  cmd_stop() {
    if (this.mixer) this.mixer.stop();
  }

  // { grid, click, bars }: play a few bars of this click on its own, as a
  // demo of how it sounds in that meter and tempo. The song is not touched;
  // it has to be stopped, and starting it ends the demo. A second mixer does
  // the work, so the click heard is exactly the click a song would get.
  cmd_previewClick(msg) {
    const m = this.mixer;
    if (!m || !this.out || m.playing) return;
    const p = new Mixer({ sampleRate: m.rate, channels: m.channels });
    if (this.buses) p.setBuses(this.buses);
    p.setSounds(m.sounds);
    const bars = msg.bars > 0 ? msg.bars : 2;
    const click = Object.assign({ gain: 1, bus: 'cue' }, msg.click, { enabled: true });
    p.setSong({ id: 'preview', grid: msg.grid, bars, endBar: bars, click, cues: { enabled: false, sections: [] }, tracks: [] });
    p.play();
    // Straight in at full level: the first tick is the point.
    p.tGain = 1;
    p.clickCur = click.gain * (p.buses[click.bus] || p.buses.cue).gain;
    this.preview = p;
  }

  cmd_stopPreview() {
    this.preview = null;
  }

  // { key }: the key that opens the owner's click (hex, from the main
  // process once the full key has been given), or none to close it again.
  cmd_setEw(msg) {
    const lock = msg.key && fs.existsSync(samples.EW_LOCK) ? fs.readFileSync(samples.EW_LOCK) : null;
    samples.setEw(lock ? vault.open(lock, Buffer.from(msg.key, 'hex')) : null);
    if (this.mixer) this.mixer.setSounds(samples.load(this.mixer.rate));
  }

  // The output check: one output after another gets a sound of its own, the
  // voice saying its number as far as the voice can count (7) and a click
  // after that, so each one can be found at the desk. Past every bus and
  // every level, straight to the device's outputs. Only while the song is
  // stopped; { on: false } ends it. `testOutput` says which one is sounding.
  cmd_testOutputs(msg) {
    const m = this.mixer;
    if (msg.on === false || !m || !this.out || m.playing) {
      if (this.test) this.emit({ type: 'testOutput', ch: null });
      this.test = null;
      return;
    }
    this.test = { ch: -1, at: 0, len: 0, snd: null };
  }

  _renderTest(buf, n) {
    const t = this.test;
    const m = this.mixer;
    const C = m.channels;
    for (let i = 0; i < n; i++) {
      if (t.at >= t.len) {
        t.ch++;
        if (t.ch >= C) {
          this.test = null;
          this.emit({ type: 'testOutput', ch: null });
          return;
        }
        const words = m.sounds && m.sounds.words;
        t.snd = (words && words.get(String(t.ch + 1))) || (m.sounds && m.sounds.click && m.sounds.click.main) || null;
        t.at = 0;
        t.len = Math.round(m.rate * 1.2);
        this.emit({ type: 'testOutput', ch: t.ch });
      }
      if (t.snd && t.at < t.snd.length) buf[i * C + t.ch] += t.snd[t.at] * 0.5;
      t.at++;
    }
  }

  // { seconds }: fade the song out and stop.
  cmd_fadeOut(msg) {
    if (this.mixer) this.mixer.fadeOut((msg.seconds > 0 ? msg.seconds : 4) * this.mixer.rate);
  }

  // For the self-test: { on }. See RtOutput.freeze.
  cmd_freezeOutput(msg) {
    if (this.out) this.out.freeze(msg.on);
  }

  cmd_seek(msg) {
    if (this.mixer) this.mixer.seek(msg.seconds * this.mixer.rate);
  }

  cmd_jumpToBar(msg) {
    if (this.mixer) this.mixer.jumpToBar(msg.bar, msg.count);
  }

  cmd_cancelJump() {
    if (this.mixer) this.mixer.cancelJump();
  }

  _render(buf, n) {
    const m = this.mixer;
    const meta = { pos: m.pos, playing: m.playing };
    m.render(buf, n);
    // A click demo plays on top, while the song itself is stopped.
    const p = this.preview;
    if (p) {
      if (m.playing || !p.playing) this.preview = null;
      else {
        if (!this.previewBuf || this.previewBuf.length !== buf.length) this.previewBuf = new Float32Array(buf.length);
        p.render(this.previewBuf, n);
        for (let i = 0, len = n * m.channels; i < len; i++) buf[i] += this.previewBuf[i];
      }
    }
    if (this.test) {
      if (m.playing) this.cmd_testOutputs({ on: false });
      else this._renderTest(buf, n);
    }
    if (this.silent) buf.fill(0);
    return meta;
  }

  _onBlock(meta) {
    if (!meta) return;
    this.audible = { pos: meta.pos, playing: meta.playing, at: Date.now() };
  }

  _sendState() {
    const m = this.mixer;
    if (!m || !this.out) return;
    for (const e of m.takeEvents()) this.emit(Object.assign({ songId: this.currentId }, e));

    const rate = m.rate;
    // While stopped nothing is in flight, so report the mixer's own position.
    const pos = m.playing || this.audible.playing ? this.audible.pos : m.pos;
    this.emit({
      type: 'state',
      songId: this.currentId,
      playing: m.playing && m.tTarget === 1,
      fading: m.playing && m.tTarget === 0 && m.fadeLen > m.fadeFrames,
      pos: pos / rate,
      at: this.audible.at,
      pending: m.pending ? { bar: m.pending.bar, at: m.pending.at / rate, to: m.pending.to / rate } : null,
      peaks: this._peaks(m),
      tracks: m.takeTrackPeaks(),
      underruns: this.out.underruns(),
    });
  }

  // The meters show a click demo as well as the song.
  _peaks(m) {
    const peaks = m.takePeaks();
    if (this.preview) {
      const more = this.preview.takePeaks();
      for (let i = 0; i < peaks.length; i++) if (more[i] > peaks[i]) peaks[i] = more[i];
    }
    return peaks;
  }

  close() {
    clearInterval(this.stateTimer);
    if (this.out) this.out.close();
    this.out = null;
  }
}

module.exports = { Engine };
