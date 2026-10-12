'use strict';
const Grid = require('../shared/grid');
const Cues = require('./cues');
const { makeClickSounds } = require('./click');

const INT16 = 1 / 32768;
const EXTEND_BARS = 16;

// The sampled click follows the meter, not what the BPM happens to count:
// 6/8 has two dotted-quarter beats of three eighths each however its tempo is
// written. These are the click's beats in a bar, and the eighth-note pulses
// each is split into (none when the beat is already an eighth; four to a
// half-note beat when the tempo is in quarter notes).
function clickBeats(g) {
  return Grid.isCompound(g) ? g.num / 3 : g.num;
}

function subdivision(g) {
  if (Grid.isCompound(g)) return 3;
  if (g.beatUnit === 'quarter') return Math.max(1, Math.round(8 / g.den));
  return g.den >= 8 ? 1 : 2;
}

// How many pulses apart the main click sound falls when it is set to twice a
// bar, given `pulses` to the bar. This is where the owner's Ableton sets put
// it: every half bar in 4/4, 3/4 and 2/4 (in 3/4 that is three eighths), and
// once a bar in 6/8. A bar that cannot be halved evenly gets it once.
function twiceABar(g, pulses) {
  if (Grid.isCompound(g)) {
    const dotted = g.num / 3;
    return dotted % 2 === 0 ? (2 * pulses) / dotted : pulses;
  }
  return pulses % 2 === 0 ? pulses / 2 : pulses;
}

// Sums every track of the loaded song from one shared frame position, so stems
// cannot drift apart. No I/O in here: render() only reads PCM already in RAM,
// which is what makes it safe to call from the output pump and easy to test.
//
// Output is interleaved Float32 across all device channels. Each track goes to
// a bus and each bus to a stereo pair or one mono channel. "band" and "cue"
// are always there; the window may add more (setBuses): one for the click,
// one for the guide, one for each group of tracks.
class Mixer {
  constructor({ sampleRate, channels }) {
    this.rate = sampleRate;
    this.channels = channels;
    this.buses = {
      band: { mode: 'stereo', ch: 0, gain: 1 },
      cue: { mode: 'stereo', ch: 0, gain: 1 },
    };
    this.song = null;
    this.pos = 0;
    this.playing = false;
    this.tGain = 0; // transport fade, 0..1
    this.tTarget = 0;
    this.afterFade = null; // 'stop' rewinds once the fade-out finishes
    this.pending = null; // { at, to, bar } jump waiting for its bar line
    this.xf = null; // { oldPos, len, done } crossfade from the old position
    this.fadeFrames = Math.max(16, Math.round(0.006 * sampleRate));
    this.fadeLen = this.fadeFrames; // the transport fade in use: much longer while a song is faded out
    this.xfFrames = Math.max(8, Math.round(0.01 * sampleRate));
    this.rampFrames = Math.max(16, Math.round(0.012 * sampleRate));
    this.peaks = new Float32Array(channels);
    this.clicks = makeClickSounds(sampleRate);
    this.beep = { main: this.clicks.accent, sub: this.clicks.beat }; // the generated beep as a click sound like the others
    this.clickCur = 0;
    this.sounds = null; // { click: { main, sub }, words: Map } sampled click and cue voice
    this.cuePlan = null; // [{ frame, snd }] spoken cues of the song, built on demand
    this.calloutPlan = null; // [{ frame, snd }] the song's callouts, likewise
    this.jcue = null; // the cue for a pending jump; replaces the plan until it lands
    this.lead = null; // { events, until }: the count for a tap that started playback
    this.voices = []; // cue samples sounding now: { snd, at }
    this.clickGrid = null; // the click's own grid when the song is written at double tempo
    this.cueCur = 0;
    this.events = [];
  }

  // Samples loaded by the engine for this sample rate. Without them the click
  // is the generated one and there are no spoken cues.
  setSounds(sounds) {
    this.sounds = sounds;
    this.cuePlan = null;
    this.calloutPlan = null;
  }

  // { id: { mode, ch, gain } }. A bus that is no longer named goes, except
  // the two that are always there; a track on a bus that does not exist is
  // silent.
  setBuses(buses) {
    for (const id of Object.keys(this.buses)) if (!buses[id] && id !== 'band' && id !== 'cue') delete this.buses[id];
    for (const id of Object.keys(buses)) this.buses[id] = Object.assign(this.buses[id] || { mode: 'stereo', ch: 0, gain: 1 }, buses[id]);
  }

  // The click and the guide have buses of their own when the window gave
  // them one; until then they are on the ears.
  _bus(id) {
    return !this.buses[id] && (id === 'click' || id === 'guide') ? 'cue' : id;
  }

  get voiceBus() {
    return this._bus('guide');
  }

  // song: { id, grid, bars, endBar, click: { enabled, gain, bus, sound, sub, main, feel },
  //         cues: { enabled, gain, speed, start, section, sections: [{ bar, name, cue }] },
  //         tracks: [{ id, data, ch, frames, gain, mute, solo, bus }] }
  setSong(song) {
    this.song = song;
    this.pos = 0;
    this.playing = false;
    this.tGain = 0;
    this.tTarget = 0;
    this.afterFade = null;
    this.fadeLen = this.fadeFrames;
    this.pending = null;
    this.xf = null;
    this.clickCur = 0;
    this.cuePlan = null;
    this.calloutPlan = null;
    this.lead = null;
    this.voices.length = 0;
    this.cueCur = 0;
    if (song) {
      for (const t of song.tracks) t.cur = this._trackTarget(t, song.tracks.some((x) => x.solo));
      this._updateLength();
    }
  }

  _updateLength() {
    const song = this.song;
    let len = 0;
    for (const t of song.tracks) if (t.frames > len) len = t.frames;
    // `endBar` is where the song is to end, whatever its audio does: a song
    // with no stems that hands over to the next one, or a song with stems
    // whose end was dragged (shorter cuts it; longer, click and guide go on
    // after the audio). With no stems and no `endBar`: `bars` bars.
    if (song.endBar > 0) len = Math.max(0, Grid.barToFrame(song.grid, song.endBar, this.rate));
    else if (len === 0 && song.bars > 0) len = Math.max(0, Grid.barToFrame(song.grid, song.bars, this.rate));
    song.length = len;
  }

  setTrack(id, patch) {
    if (!this.song) return;
    const t = this.song.tracks.find((x) => x.id === id);
    if (t) Object.assign(t, patch);
  }

  setGrid(grid) {
    if (!this.song) return;
    this.song.grid = grid;
    this.pending = null;
    this.cuePlan = null;
    this.calloutPlan = null;
    this._updateLength();
  }

  setClick(click) {
    if (this.song) this.song.click = click;
  }

  setCues(cues) {
    if (!this.song) return;
    this.song.cues = cues;
    this.cuePlan = null;
    this.calloutPlan = null;
  }

  // `endBar`: where the song ends (see _updateLength); a song with no stems
  // and no `endBar` has no end and grows when played past its last bar.
  setBars(bars, endBar) {
    if (!this.song) return;
    this.song.bars = bars;
    this.song.endBar = endBar;
    this._updateLength();
  }

  _plan() {
    if (this.cuePlan) return this.cuePlan;
    const song = this.song;
    const words = this.sounds && this.sounds.words;
    let plan = [];
    if (song && song.cues && words) {
      const rate = this.rate;
      plan = Cues.plan(song.grid, song.cues.sections || [], song.cues, (w) => words.has(w)).map((e) => ({ frame: Math.round(e.sec * rate), snd: e.word ? words.get(e.word) : null, bar: e.bar }));
    }
    this.cuePlan = plan;
    return plan;
  }

  // The song's callouts (cues.callouts: [{ bar, word }]) as [{ frame, snd }].
  // Kept apart from the plan, which the count-in and "play from this section"
  // read: a callout is only ever said, where it stands.
  _callouts() {
    if (this.calloutPlan) return this.calloutPlan;
    const song = this.song;
    const words = this.sounds && this.sounds.words;
    let list = [];
    if (song && song.cues && words) {
      const rate = this.rate;
      list = Cues.callouts(song.grid, song.cues.callouts, song.cues, (w) => words.has(w)).map((e) => ({ frame: Math.round(e.sec * rate), snd: words.get(e.word) }));
    }
    this.calloutPlan = list;
    return list;
  }

  // The section marker at `bar` when the song's own guide announces it: null
  // when the guide is off, there is no marker there, or it says nothing.
  _cueSection(bar) {
    const cues = this.song.cues;
    if (!cues || !cues.enabled || !this.sounds) return null;
    const sorted = (cues.sections || []).slice().sort((a, b) => a.bar - b.bar);
    const s = sorted.find((x) => x.bar === bar);
    if (!s || Cues.silent(s)) return null;
    return Cues.isOff(Cues.styleFor(cues, s, s === sorted[0])) ? null : s;
  }

  // The section marker at `bar` for a pad tap: { s, first }. A tap is always
  // announced, even on a song whose own guide is off (one with a recorded
  // guide stem, which cannot follow a jump). Null when there is no marker
  // there or the section is one that says nothing, such as a tag.
  _tapSection(bar) {
    const cues = this.song.cues;
    if (!cues || !this.sounds) return null;
    const sorted = (cues.sections || []).slice().sort((a, b) => a.bar - b.bar);
    const s = sorted.find((x) => x.bar === bar);
    return s && !Cues.silent(s) ? { s, first: s === sorted[0] } : null;
  }

  // What is said before a jump lands. An empty list still silences the cues
  // of the section that playback is leaving.
  _jumpCue(at, bar) {
    const t = this._tapSection(bar);
    if (!t) return [];
    const words = this.sounds.words;
    const rate = this.rate;
    const pos = this.pos;
    const cues = this.song.cues;
    return Cues.jumpPlan(this.song.grid, pos / rate, at / rate, t.s.name, (w) => words.has(w), cues.speed, cues.scale).map((e) => ({ frame: Math.max(pos, Math.round(e.sec * rate)), snd: words.get(e.word) }));
  }

  // A counted tap on the section at `bar`: { lead, events(at, from) } in
  // frames, or null when there is nothing to count. `from` is where playback
  // is, so that no word is placed behind it.
  _countedJump(bar) {
    const t = this._tapSection(bar);
    if (!t) return null;
    const words = this.sounds.words;
    const rate = this.rate;
    const cues = this.song.cues;
    const c = Cues.countedJump(this.song.grid, t.s.name, (w) => words.has(w), cues.speed, cues.scale);
    return { first: t.first, lead: Math.round(c.lead * rate), events: (at, from) => c.events(at / rate).map((e) => ({ frame: Math.max(from, Math.round(e.sec * rate)), snd: words.get(e.word) })) };
  }

  play() {
    if (!this.song || this.song.length === 0) return;
    if (this.pos >= this.song.length) this.pos = 0;
    this.lead = null;
    // From the top, a first-section cue that has no room in the song plays
    // as a count-in before it.
    if (this.pos === 0 && this.song.cues && this.song.cues.enabled) {
      const plan = this._plan();
      if (plan.length && plan[0].frame < 0) this.pos = plan[0].frame;
    }
    this.playing = true;
    this.tTarget = 1;
    this.afterFade = null;
    this.fadeLen = this.fadeFrames;
  }

  pause() {
    this.pending = null;
    if (this.playing) {
      this.tTarget = 0;
      this.afterFade = 'pause';
      this.fadeLen = this.fadeFrames;
    }
  }

  stop() {
    this.pending = null;
    if (this.playing) {
      this.tTarget = 0;
      this.afterFade = 'stop';
      this.fadeLen = this.fadeFrames;
    } else {
      this.pos = 0;
    }
  }

  // Fades the whole song out over `frames` and stops, rewound: a way to end a
  // song early without a hard cut. Play, pause or stop meanwhile takes over.
  fadeOut(frames) {
    this.pending = null;
    if (!this.playing || this.tTarget === 0) return;
    this.tTarget = 0;
    this.afterFade = 'stop';
    this.fadeLen = Math.max(this.fadeFrames, Math.round(frames));
  }

  seek(frame) {
    if (!this.song) return;
    frame = Math.max(0, Math.min(this.song.length, Math.round(frame)));
    this.pending = null;
    this.lead = null;
    if (this.playing) this.xf = { oldPos: this.pos, len: this.xfFrames, done: 0 };
    this.pos = frame;
  }

  // Start playing at the section marked at `bar`, counted in: "Verse 2 3 4",
  // then the verse. When the song's own guide announces that section,
  // playback starts where that announcement does (for the first section that
  // can be before time 0). When it does not, the tap brings its own one-bar
  // count, except into the first section, where a recorded guide usually has
  // its count-in already. A section that says nothing starts on its bar line.
  playFromBar(bar) {
    if (!this.song || this.song.length === 0) return;
    const to = Math.max(0, Math.min(this.song.length, Grid.barToFrame(this.song.grid, bar, this.rate)));
    let start = to;
    this.lead = null;
    if (this._cueSection(bar)) {
      for (const e of this._plan()) if (e.bar === bar && e.frame < start) start = e.frame;
    } else {
      const count = this._countedJump(bar);
      if (count && !count.first) {
        start = Math.max(0, to - count.lead);
        this.lead = { events: count.events(to, start), until: to };
      }
    }
    this.pending = null;
    this.pos = start;
    this.playing = true;
    this.tTarget = 1;
    this.afterFade = null;
    this.fadeLen = this.fadeFrames;
  }

  // Jump to bar `bar` when playback reaches the next bar line. Stopped: move now.
  // `counted`: wait for the first bar line that leaves room for a full
  // one-bar count, and say "Chorus 2 3 4" in the bar before it. Either way,
  // from the tap until the jump lands only the jump's cue is heard.
  jumpToBar(bar, counted) {
    if (!this.song) return;
    const g = this.song.grid;
    const to = Math.max(0, Math.min(this.song.length, Grid.barToFrame(g, bar, this.rate)));
    if (!this.playing || this.tTarget === 0) {
      this.pending = null;
      this.pos = to;
      return;
    }
    let count = counted ? this._countedJump(bar) : null;
    // Playback is about to reach that section anyway, on the next bar line and
    // with its own cue: there is nothing to wait for or to say again.
    const next = Math.min(this.song.length, Grid.barToFrame(g, Grid.nextBar(g, this.pos, this.rate, this.xfFrames), this.rate));
    if (next === to) count = null;
    // Leave room for the crossfade (and the count); closer than that, take a later bar.
    const k = Grid.nextBar(g, this.pos, this.rate, Math.max(this.xfFrames, count ? count.lead : 0));
    const at = Math.min(this.song.length, Grid.barToFrame(g, k, this.rate));
    this.pending = { at, to, bar };
    this.jcue = at === to ? null : count ? count.events(at, this.pos) : this._jumpCue(at, bar);
  }

  cancelJump() {
    this.pending = null;
  }

  _trackTarget(t, anySolo) {
    if (t.mute || (anySolo && !t.solo)) return 0;
    const bus = this.buses[this._bus(t.bus)];
    return t.gain * (bus ? bus.gain : 0);
  }

  // Where a bus lands in the interleaved output, or null when its channels do
  // not exist on this device. Out-of-range is silence on purpose: falling back
  // to outputs 1-2 would put the click in the house mix.
  _busMap(busId) {
    const b = this.buses[busId];
    if (!b) return null;
    if (b.mode === 'mono') {
      if (b.ch >= this.channels) return null;
      return { mono: true, l: b.ch, r: b.ch };
    }
    if (b.ch + 1 >= this.channels) return null;
    return { mono: false, l: b.ch, r: b.ch + 1 };
  }

  // Fills `out` with n frames and advances the transport.
  render(out, n) {
    const C = this.channels;
    out.fill(0, 0, n * C);
    const song = this.song;
    let done = 0;
    while (song && this.playing && done < n) {
      let seg = n - done;

      if (this.tGain !== this.tTarget) {
        const left = Math.ceil(Math.abs(this.tTarget - this.tGain) * this.fadeLen);
        seg = Math.min(seg, Math.max(1, left));
      }

      if (this.pending && !this.xf) {
        // The crossfade runs just before the bar line and reads the same
        // distance before the destination, so the new downbeat lands on the
        // bar line at full level.
        const pre = Math.min(this.xfFrames, this.pending.to);
        const startAt = this.pending.at - pre;
        if (this.pos >= startAt) {
          const lead = this.pending.at - this.pos;
          if (lead > 0) {
            this.xf = { oldPos: this.pos, len: lead, done: 0 };
            this.pos = this.pending.to - lead;
          } else {
            this.xf = { oldPos: this.pos, len: this.xfFrames, done: 0 };
            this.pos = this.pending.to;
          }
          this.events.push({ type: 'jumped', bar: this.pending.bar });
          this.pending = null;
        } else {
          seg = Math.min(seg, startAt - this.pos);
        }
      }

      if (this.xf) seg = Math.min(seg, this.xf.len - this.xf.done);

      const remain = song.length - this.pos;
      if (remain <= 0) {
        if (song.tracks.length === 0 && song.bars > 0 && !(song.endBar > 0)) {
          // A click-only song has no end to reach: it grows instead of stopping.
          song.bars += EXTEND_BARS;
          this._updateLength();
          this.events.push({ type: 'extended', bars: song.bars });
          continue;
        }
        this.playing = false;
        this.tGain = 0;
        this.tTarget = 0;
        this.xf = null;
        this.pending = null;
        this.voices.length = 0;
        this.events.push({ type: 'ended' });
        break;
      }
      seg = Math.min(seg, remain);

      const tg0 = this.tGain;
      let tg1 = tg0;
      if (tg0 !== this.tTarget) {
        const step = seg / this.fadeLen;
        tg1 = this.tTarget > tg0 ? Math.min(this.tTarget, tg0 + step) : Math.max(this.tTarget, tg0 - step);
      }
      let a0 = tg0;
      let a1 = tg1;
      let b0 = 0;
      let b1 = 0;
      let oldPos = 0;
      if (this.xf) {
        const x0 = this.xf.done / this.xf.len;
        const x1 = (this.xf.done + seg) / this.xf.len;
        a0 = tg0 * x0;
        a1 = tg1 * x1;
        b0 = tg0 * (1 - x0);
        b1 = tg1 * (1 - x1);
        oldPos = this.xf.oldPos;
      }

      this._mixTracks(out, done, seg, this.pos, a0, a1, this.xf !== null, oldPos, b0, b1);
      this._mixClick(out, done, seg, this.pos, a0, a1);
      this._mixCues(out, done, seg, this.pos, tg0, tg1);

      this.pos += seg;
      done += seg;
      this.tGain = tg1;
      if (this.xf) {
        this.xf.oldPos += seg;
        this.xf.done += seg;
        if (this.xf.done >= this.xf.len) this.xf = null;
      }
      if (this.tGain === 0 && this.tTarget === 0) {
        this.playing = false;
        this.xf = null;
        this.voices.length = 0;
        // 'stopped' tells the window a stop or a fade-out has finished, which
        // is when a song lined up behind this one can take over.
        if (this.afterFade === 'stop') {
          this.pos = 0;
          this.events.push({ type: 'stopped' });
        }
        this.afterFade = null;
        this.fadeLen = this.fadeFrames;
      }
    }

    // Clamp, and track per-channel peaks for the meters.
    const peaks = this.peaks;
    for (let i = 0, len = n * C; i < len; i++) {
      let v = out[i];
      if (v > 1) v = out[i] = 1;
      else if (v < -1) v = out[i] = -1;
      if (v < 0) v = -v;
      const c = i % C;
      if (v > peaks[c]) peaks[c] = v;
    }
  }

  _mixTracks(out, off, seg, pos, a0, a1, hasOld, oldPos, b0, b1) {
    const tracks = this.song.tracks;
    let anySolo = false;
    for (let i = 0; i < tracks.length; i++) if (tracks[i].solo) anySolo = true;
    const maxStep = seg / this.rampFrames;
    for (let i = 0; i < tracks.length; i++) {
      const t = tracks[i];
      const target = this._trackTarget(t, anySolo);
      const g0 = t.cur;
      let g1 = target;
      if (g1 > g0 + maxStep) g1 = g0 + maxStep;
      else if (g1 < g0 - maxStep) g1 = g0 - maxStep;
      t.cur = g1;
      if (g0 === 0 && g1 === 0) continue;
      const map = this._busMap(this._bus(t.bus));
      if (!map) continue;
      this._addTrack(out, off, seg, t, pos, g0 * a0, g1 * a1, map);
      if (hasOld) this._addTrack(out, off, seg, t, oldPos, g0 * b0, g1 * b1, map);
      this._meterTrack(t, seg, pos, Math.max(g0 * a0, g1 * a1));
    }
  }

  // The level a track is being heard at, for its meter in the window: the
  // highest sample of this stretch after its fader, mute and solo. It looks at
  // every fourth frame, which is plenty for a meter and leaves the mixing
  // loops alone.
  _meterTrack(t, seg, pos, gain) {
    const start = pos < 0 ? -pos : 0;
    const end = Math.min(seg, t.frames - pos);
    const d = t.data;
    let peak = 0;
    if (t.ch === 2) {
      for (let i = start, p = (pos + start) * 2; i < end; i += 4, p += 8) {
        const a = d[p] < 0 ? -d[p] : d[p];
        const b = d[p + 1] < 0 ? -d[p + 1] : d[p + 1];
        if (a > peak) peak = a;
        if (b > peak) peak = b;
      }
    } else {
      for (let i = start, p = pos + start; i < end; i += 4, p += 4) {
        const a = d[p] < 0 ? -d[p] : d[p];
        if (a > peak) peak = a;
      }
    }
    peak *= gain * INT16;
    if (peak > (t.peak || 0)) t.peak = peak;
  }

  _addTrack(out, off, seg, t, pos, g0, g1, map) {
    const start = pos < 0 ? -pos : 0;
    const end = Math.min(seg, t.frames - pos);
    if (end <= start) return;
    const C = this.channels;
    const d = t.data;
    const dg = (g1 - g0) / seg;
    const l = map.l;
    const r = map.r;
    let o = (off + start) * C;
    if (t.ch === 2) {
      let p = (pos + start) * 2;
      if (map.mono) {
        for (let i = start; i < end; i++) {
          out[o + l] += (d[p] + d[p + 1]) * (g0 + dg * i) * INT16 * 0.5;
          p += 2;
          o += C;
        }
      } else {
        for (let i = start; i < end; i++) {
          const g = (g0 + dg * i) * INT16;
          out[o + l] += d[p] * g;
          out[o + r] += d[p + 1] * g;
          p += 2;
          o += C;
        }
      }
    } else {
      let p = pos + start;
      if (map.mono) {
        for (let i = start; i < end; i++) {
          out[o + l] += d[p] * (g0 + dg * i) * INT16;
          p++;
          o += C;
        }
      } else {
        for (let i = start; i < end; i++) {
          const v = d[p] * (g0 + dg * i) * INT16;
          out[o + l] += v;
          out[o + r] += v;
          p++;
          o += C;
        }
      }
    }
  }

  // The click is a pure function of song position, so it needs no state to
  // stay on the grid through seeks and jumps.
  _mixClick(out, off, seg, pos, a0, a1) {
    const click = this.song.click;
    // The click's own bus when the window has set one up, else the ears.
    const busId = click && (this.buses[click.bus] ? click.bus : 'cue');
    const bus = click && this.buses[busId];
    const target = click && click.enabled && bus ? click.gain * bus.gain : 0;
    const maxStep = seg / this.rampFrames;
    const c0 = this.clickCur;
    let c1 = target;
    if (c1 > c0 + maxStep) c1 = c0 + maxStep;
    else if (c1 < c0 - maxStep) c1 = c0 - maxStep;
    this.clickCur = c1;
    if (c0 === 0 && c1 === 0) return;
    const map = this._busMap(busId);
    if (!map) return;

    // `scale` 2 is a song whose bars are written at double tempo: its click
    // is the click of the tempo that was typed, half the grid's.
    const scale = click.scale > 0 ? click.scale : 1;
    let g = this.song.grid;
    if (scale !== 1) {
      const c = this.clickGrid;
      if (!c || c.from !== g || c.scale !== scale) this.clickGrid = { from: g, scale, grid: Object.assign({}, g, { bpm: g.bpm / scale }) };
      g = this.clickGrid.grid;
    }
    const rate = this.rate;
    const C = this.channels;
    // A click sound, sampled or the beep: eighth-note pulses, the main sound
    // every beat, twice a bar or once a bar (`main`: 1, 2 or 'bar') and the
    // second sound on the rest. The beep used to tick once a beat whatever
    // was set, half as often as every other sound, which the owner heard as
    // half time. Only a song with no `sound` at all, from before there was a
    // choice, keeps that old click: one pulse per beat, accented on the downbeat.
    // `feel` plays that same pattern at half or double speed against the
    // song, which itself does not change: pulses stay on the bar lines.
    // Any sampled sound by its name; one that is not there (the owner's own
    // click on a copy without it, say) plays the stand-in, never silence.
    const sets = this.sounds ? this.sounds.clicks || { ew: this.sounds.click } : null;
    const smp = click.sound === 'beep' ? this.beep : sets && click.sound ? sets[click.sound] || this.sounds.click || null : null;
    const div = smp && click.sub !== false ? subdivision(g) : 1;
    const feel = click.feel === 'half' ? 2 : click.feel === 'double' ? 0.5 : 1;
    const beats = smp ? clickBeats(g) : Math.max(1, Math.round(Grid.beatsPerBar(g)));
    // Pulses are spread evenly over the bar, so they restart on every bar line
    // even when the feel does not divide the bar exactly.
    const perBar = Math.max(1, Math.round((beats * div) / feel));
    const stepSec = Grid.barSeconds(g) / perBar;
    const every = !smp || click.main === 'bar' ? perBar : click.main === 1 ? div : twiceABar(g, beats * div);
    const longest = smp ? Math.max(smp.main.length, smp.sub.length) : this.clicks.accent.length;
    const kMin = Math.ceil(((pos - longest) / rate - g.offset) / stepSec);
    const kMax = Math.floor(((pos + seg) / rate - g.offset) / stepSec);
    const dg = (c1 * a1 - c0 * a0) / seg;
    const g0 = c0 * a0;
    for (let k = kMin; k <= kMax; k++) {
      const main = (((k % perBar) + perBar) % perBar) % every === 0;
      const snd = smp ? (main ? smp.main : smp.sub) : main ? this.clicks.accent : this.clicks.beat;
      const bf = Math.round((g.offset + k * stepSec) * rate);
      let i = bf - pos; // segment frame where this click starts
      let s = 0;
      if (i < 0) {
        s = -i;
        i = 0;
      }
      let o = (off + i) * C;
      for (; i < seg && s < snd.length; i++, s++) {
        const v = snd[s] * (g0 + dg * i);
        out[o + map.l] += v;
        if (!map.mono) out[o + map.r] += v;
        o += C;
      }
    }
  }

  // Spoken cues are one-shot voices, started as playback passes their frame
  // and left to finish, so a jump never cuts a word that has begun.
  //
  // Two kinds. The song's own guide (the plan) plays when the guide is on. A
  // pad tap's announcement (a pending jump's cue, or the count for a tap that
  // started playback) always plays, at the guide's level, whether the song's
  // guide is on or not.
  _mixCues(out, off, seg, pos, t0, t1) {
    const cues = this.song.cues;
    const ready = !!(cues && this.sounds);
    const on = ready && !!cues.enabled;
    const start = (list, tap) => {
      for (let i = 0; i < list.length; i++) {
        const e = list[i];
        // An event with no sound only marks where a cue's lead starts.
        if (e.snd && e.frame >= pos && e.frame < pos + seg) this.voices.push({ snd: e.snd, at: pos - e.frame, tap });
      }
    };
    // One list at a time, so a section is never announced twice: the jump's
    // cue while a jump is pending, otherwise the song's own, with its callouts.
    const jump = ready && this.pending && this.jcue ? this.jcue : null;
    if (jump) start(jump, true);
    else if (on) {
      start(this._plan(), false);
      start(this._callouts(), false);
    }
    if (ready && this.lead) {
      start(this.lead.events, true);
      if (pos + seg >= this.lead.until) this.lead = null;
    }

    const level = ready ? cues.gain * this.buses[this.voiceBus].gain : 0;
    const maxStep = seg / this.rampFrames;
    const c0 = this.cueCur;
    let c1 = on ? level : 0;
    if (c1 > c0 + maxStep) c1 = c0 + maxStep;
    else if (c1 < c0 - maxStep) c1 = c0 - maxStep;
    this.cueCur = c1;
    if (this.voices.length === 0) return;

    const map = this._busMap(this.voiceBus);
    const C = this.channels;
    let keep = 0;
    for (let n = 0; n < this.voices.length; n++) {
      const v = this.voices[n];
      const snd = v.snd;
      const g0 = (v.tap ? level : c0) * t0;
      const g1 = (v.tap ? level : c1) * t1;
      if (map && (g0 !== 0 || g1 !== 0)) {
        const dg = (g1 - g0) / seg;
        let i = v.at < 0 ? -v.at : 0; // segment frame where this voice starts
        let s = v.at + i;
        let o = (off + i) * C;
        for (; i < seg && s < snd.length; i++, s++) {
          const x = snd[s] * (g0 + dg * i);
          out[o + map.l] += x;
          if (!map.mono) out[o + map.r] += x;
          o += C;
        }
      }
      v.at += seg;
      if (v.at < snd.length) this.voices[keep++] = v;
    }
    this.voices.length = keep;
  }

  takePeaks() {
    const p = Array.from(this.peaks);
    this.peaks.fill(0);
    return p;
  }

  // { trackId: peak } since the last call, for the tracks that made a sound.
  takeTrackPeaks() {
    const out = {};
    if (!this.song) return out;
    for (const t of this.song.tracks) {
      if (t.peak > 0) {
        out[t.id] = t.peak;
        t.peak = 0;
      }
    }
    return out;
  }

  takeEvents() {
    if (this.events.length === 0) return this.events;
    const e = this.events;
    this.events = [];
    return e;
  }
}

module.exports = { Mixer };
