// The bar-based timeline: section lane, bar ruler, one waveform canvas per
// track, and the playhead. Only the visible time window is drawn, so canvases
// stay viewport-sized at any zoom.
import { $ } from './ui.js';
import { PEAKS_PER_SEC } from './importer.js';

const G = window.Grid;
const Structure = window.Structure;
const LANE_H = 24; // the section lane; taller (BIG_LANE_H) when the ruler row is, on a song with no stems
const BIG_LANE_H = 52;
const EDGE = 6; // pixels at each end of a section block that resize it
const RULER_H = 20;
const MIN_PPS = 1.5;
const MAX_PPS = 600;

const COLORS = [
  [/intro|outro|end|count/i, '#8a8f98'],
  [/pre/i, '#3fb5a3'],
  [/verse|\bv\d/i, '#4f8fd6'],
  [/chorus|refrain/i, '#e8963a'],
  [/bridge/i, '#c85fb0'],
  [/tag|vamp/i, '#9a7be0'],
  [/inst|inter|solo|turn/i, '#6fb35a'],
];

export function sectionColor(section) {
  if (section.color) return section.color;
  for (const [re, c] of COLORS) if (re.test(section.name)) return c;
  return '#7c8794';
}

export function sortedSections(song) {
  return song.sections.slice().sort((a, b) => a.bar - b.bar);
}

export class Timeline {
  // opts: { getSong, getPeaks, getDuration, isAudible, getPendingBar, getCurrentSection,
  //         getMaxBar, getGuide, isLocked, onSeek, onEditStart, onEditMove, onEditEnd,
  //         onSectionMenu, onAddSectionAt, onEndMove, onEndDone, onEndReset, onEndMenu,
  //         getEndSnap, getEndTip }
  // The section lane edits the structure and never moves playback: drag a
  // block to move it, drag an edge to resize it. It has no right-click: a
  // section's menu is on its pad (the owner asked for the two to be swapped).
  constructor(opts) {
    this.o = opts;
    this.root = $('#timeline');
    this.ruler = $('#ruler');
    this.rows = $('#rows');
    this.hscroll = $('#hscroll');
    this.spacer = $('#hspacer');
    this.playhead = $('#playhead');
    this.pps = 12;
    this.scrollT = 0;
    this.canvases = new Map();
    this.hits = [];
    this.dirty = true;
    this.drag = null;
    this.laneH = LANE_H;
    this.endX = -100; // where the end of the song was last drawn
    // While playing, the view follows the playhead. Scrolling by hand lets go
    // of it for a few seconds (the owner asked for 3 to 5), then it comes back.
    this.freeMs = 4000;
    this.freeUntil = 0;
    this.autoLeft = 0; // where the view was last put by the code, not by hand
    this.isPlaying = false;

    this.hscroll.addEventListener('scroll', () => {
      this.scrollT = this.hscroll.scrollLeft / this.pps;
      this.dirty = true;
    });
    this.root.addEventListener('wheel', (e) => this._onWheel(e), { passive: false });
    new ResizeObserver(() => {
      this._syncSpacer();
      this.dirty = true;
    }).observe(this.ruler);
    this.ruler.addEventListener('mousedown', (e) => this._onRulerDown(e));
    this.ruler.addEventListener('mousemove', (e) => this._onRulerHover(e));
    this.ruler.addEventListener('dblclick', (e) => this._onRulerDbl(e));
    this.rows.addEventListener('mousedown', (e) => {
      if (e.button !== 0 || e.target.tagName !== 'CANVAS') return;
      this.o.onSeek(this.timeAt(e.clientX - e.target.getBoundingClientRect().left));
    });
    // A right-click anywhere on the line at the end of the song: how finely
    // it snaps when dragged. Nothing else on the timeline has a right-click.
    const endMenu = (e) => {
      if (e.target.tagName !== 'CANVAS' || this.o.isLocked() || !this.o.getSong()) return;
      if (Math.abs(e.clientX - e.target.getBoundingClientRect().left - this.endX) > EDGE) return;
      e.preventDefault();
      this.o.onEndMenu(e.clientX, e.clientY);
    };
    this.ruler.addEventListener('contextmenu', endMenu);
    this.rows.addEventListener('contextmenu', endMenu);
  }

  get viewW() {
    return this.ruler.clientWidth;
  }

  timeAt(x) {
    return Math.max(0, this.scrollT + x / this.pps);
  }

  xOf(sec) {
    return (sec - this.scrollT) * this.pps;
  }

  // Tell the timeline which canvases belong to which tracks after rows are rebuilt.
  setCanvases(map) {
    this.canvases = map;
    this._syncSpacer();
    this.dirty = true;
  }

  requestDraw() {
    this.dirty = true;
  }

  // The song got longer or shorter without its rows being rebuilt.
  durationChanged() {
    this._syncSpacer();
    this.dirty = true;
  }

  _syncSpacer() {
    const w = Math.max(this.viewW, this.o.getDuration() * this.pps + this.viewW * 0.5);
    this.spacer.style.width = Math.round(w) + 'px';
  }

  setZoom(pps, anchorX) {
    const ax = anchorX === undefined ? this.viewW / 2 : anchorX;
    const t = this.scrollT + ax / this.pps;
    this.pps = Math.max(MIN_PPS, Math.min(MAX_PPS, pps));
    this._syncSpacer();
    this.scrollTo(t - ax / this.pps);
  }

  // The whole song in view. With `minBarPx`, zoomed in at least far enough
  // for a bar to be that wide, so section names stay readable on a long song.
  fit(minBarPx) {
    const d = this.o.getDuration();
    if (d > 0 && this.viewW > 0) {
      const song = this.o.getSong();
      const floor = minBarPx && song ? minBarPx / G.barSeconds(song) : 0;
      this.pps = Math.max(MIN_PPS, floor, Math.min(MAX_PPS, (this.viewW - 24) / d));
      this._syncSpacer();
      this.scrollTo(0);
    }
  }

  scrollTo(sec) {
    this.scrollT = Math.max(0, sec);
    this.hscroll.scrollLeft = Math.round(this.scrollT * this.pps);
    this.autoLeft = this.hscroll.scrollLeft;
    this.scrollT = this.autoLeft / this.pps;
    this.dirty = true;
  }

  _onWheel(e) {
    if (e.ctrlKey || e.metaKey) {
      e.preventDefault();
      const x = e.clientX - this.ruler.getBoundingClientRect().left;
      this.setZoom(this.pps * (e.deltaY < 0 ? 1.25 : 0.8), Math.max(0, x));
      if (this.isPlaying) this.freeUntil = performance.now() + this.freeMs;
    } else if (e.shiftKey || Math.abs(e.deltaX) > Math.abs(e.deltaY)) {
      e.preventDefault();
      this.hscroll.scrollLeft += e.shiftKey ? e.deltaY || e.deltaX : e.deltaX;
    }
  }

  // The section block under x and which part of it: its body moves it, the
  // few pixels at either end resize it.
  _hitAt(x) {
    for (const h of this.hits) {
      if (x < h.x0 || x >= h.x1) continue;
      const wide = h.x1 - h.x0 >= 3 * EDGE;
      const zone = wide && x >= h.x1 - EDGE ? 'end' : wide && x < h.x0 + EDGE ? 'start' : 'move';
      return { section: h.section, zone };
    }
    return null;
  }

  // The end of the song is taken hold of in the bar numbers, under the lane.
  _onEnd(x, y) {
    return y >= this.laneH && Math.abs(x - this.endX) <= EDGE && !this.o.isLocked() && !!this.o.getSong();
  }

  _onRulerHover(e) {
    if (this.drag) return;
    const rect = this.ruler.getBoundingClientRect();
    const onEnd = this._onEnd(e.clientX - rect.left, e.clientY - rect.top);
    const hit = e.clientY - rect.top < this.laneH && !this.o.isLocked() ? this._hitAt(e.clientX - rect.left) : null;
    this.ruler.style.cursor = onEnd ? 'ew-resize' : !hit ? '' : hit.zone === 'move' ? 'grab' : 'ew-resize';
    this.ruler.title = onEnd ? this.o.getEndTip() : '';
  }

  _onRulerDown(e) {
    const song = this.o.getSong();
    if (e.button !== 0 || !song) return;
    const rect = this.ruler.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    if (y < this.laneH) {
      const hit = this.o.isLocked() ? null : this._hitAt(x);
      if (!hit) return;
      const s = hit.section;
      this.drag = { section: s, zone: hit.zone, startX: x, bar: s.bar, end: s.bar + s.len, before: song.sections.map((q) => ({ id: q.id, bar: q.bar, len: q.len })), moved: false };
    } else if (this._onEnd(x, y)) {
      this.drag = { songEnd: true, startX: x, moved: false };
    } else {
      this.drag = { scrub: true };
      this.o.onSeek(this.timeAt(x));
    }
    const move = (ev) => this._onDragMove(ev.clientX - rect.left, ev.altKey);
    const up = () => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
      const d = this.drag;
      this.drag = null;
      this.ruler.style.cursor = '';
      if (d && d.songEnd && d.moved) this.o.onEndDone();
      else if (d && !d.scrub && d.moved) this.o.onEditEnd();
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  }

  // `free` (Option held) snaps to beats instead of whole bars.
  _onDragMove(x, free) {
    const d = this.drag;
    const song = this.o.getSong();
    if (!d || !song) return;
    if (d.scrub) {
      this.o.onSeek(this.timeAt(x));
      return;
    }
    if (!d.moved && Math.abs(x - d.startX) < 4) return;
    if (!d.moved) {
      d.moved = true;
      this.o.onEditStart();
      this.ruler.style.cursor = d.zone === 'move' ? 'grabbing' : 'ew-resize';
    }
    const step = free ? 1 / Math.max(1, Math.round(G.beatsPerBar(song))) : 1;
    if (d.songEnd) {
      // The end snaps as chosen from its right-click menu (in bars; 0: not
      // at all). Option still means beats when it would snap to bars.
      const snap = this.o.getEndSnap();
      const to = free && snap >= 1 ? step : snap;
      const bar = G.secondsToBar(song, this.timeAt(x));
      this.o.onEndMove(to > 0 ? Math.round(bar / to) * to : Math.round(bar * 1000) / 1000);
      return;
    }
    const delta = (x - d.startX) / this.pps / G.barSeconds(song);
    const snap = (bar) => Math.round((bar + delta) / step) * step;
    const opts = { min: Math.floor(G.secondsToBar(song, 0)), limit: this.o.getMaxBar(), step };
    let res;
    if (d.zone === 'move') res = Structure.move(d.before, d.section.id, snap(d.bar), opts);
    else if (d.zone === 'end') res = Structure.resizeEnd(d.before, d.section.id, snap(d.end), opts);
    else res = Structure.resizeStart(d.before, d.section.id, snap(d.bar), opts);
    if (!res) return; // not possible: stay where the last allowed position left it
    for (const r of res) {
      const sec = song.sections.find((q) => q.id === r.id);
      sec.bar = r.bar;
      sec.len = r.len;
    }
    this.o.onEditMove();
    this.dirty = true;
  }

  _onRulerDbl(e) {
    const song = this.o.getSong();
    if (!song || this.o.isLocked()) return;
    const rect = this.ruler.getBoundingClientRect();
    if (this._onEnd(e.clientX - rect.left, e.clientY - rect.top)) this.o.onEndReset();
    if (e.clientY - rect.top >= this.laneH) return;
    const x = e.clientX - rect.left;
    const hit = this._hitAt(x);
    if (hit) this.o.onSectionMenu(hit.section, e.clientX, e.clientY, 'rename');
    else this.o.onAddSectionAt(Math.floor(G.secondsToBar(song, this.timeAt(x)) + 1e-6));
  }

  _prep(canvas) {
    const dpr = window.devicePixelRatio || 1;
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
    }
    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    return { ctx, w, h };
  }

  // Called every animation frame with the current playback position.
  frame(pos, playing) {
    const pendingBar = this.o.getPendingBar();
    if (pendingBar !== null) this.dirty = true; // the pending section blinks
    // The view is somewhere the code did not put it: it was scrolled by hand.
    const left = this.hscroll.scrollLeft;
    if (left !== this.autoLeft) {
      this.autoLeft = left;
      this.scrollT = left / this.pps;
      this.dirty = true;
      if (playing) this.freeUntil = performance.now() + this.freeMs;
    }
    this.isPlaying = playing;
    if (playing && !this.drag && performance.now() >= this.freeUntil) {
      const x = this.xOf(pos);
      if (x > this.viewW * 0.92 || x < 0) this.scrollTo(pos - (this.viewW * 0.08) / this.pps);
    }
    if (this.dirty) {
      this.dirty = false;
      this._draw(pendingBar);
    }
    const x = this.xOf(pos);
    const visible = x >= 0 && x <= this.viewW && this.o.getSong();
    this.playhead.style.display = visible ? 'block' : 'none';
    if (visible) this.playhead.style.transform = `translateX(${this.ruler.offsetLeft + x}px)`;
  }

  _barStep(barPx) {
    let step = 1;
    while (step * barPx < 46) step *= 2;
    return step;
  }

  _draw(pendingBar) {
    const song = this.o.getSong();
    const { ctx, w, h } = this._prep(this.ruler);
    // The ruler row is taller on a song with no stems (see #rulerRow in
    // styles.css), and the section lane grows with it.
    const big = h >= 80;
    this.laneH = big ? BIG_LANE_H : LANE_H;
    ctx.fillStyle = '#232323';
    ctx.fillRect(0, 0, w, h);
    ctx.fillStyle = '#1b1b1b';
    ctx.fillRect(0, 0, w, this.laneH);
    this.hits = [];
    if (!song) {
      for (const c of this.canvases.values()) {
        const p = this._prep(c);
        p.ctx.clearRect(0, 0, p.w, p.h);
      }
      return;
    }

    const barSec = G.barSeconds(song);
    const barPx = barSec * this.pps;
    const step = this._barStep(barPx);
    const firstBar = Math.floor(G.secondsToBar(song, this.scrollT));
    const lastBar = Math.ceil(G.secondsToBar(song, this.scrollT + w / this.pps));
    const mod = (a, b) => ((a % b) + b) % b;

    // Section lane
    const sections = sortedSections(song);
    const current = this.o.getCurrentSection();
    const nameFont = big ? '600 14px "Segoe UI", system-ui, sans-serif' : '11px "Segoe UI", system-ui, sans-serif';
    const smallFont = '11px "Segoe UI", system-ui, sans-serif';
    ctx.textBaseline = 'middle';
    for (let i = 0; i < sections.length; i++) {
      const s = sections[i];
      const t0 = Math.max(0, G.barToSeconds(song, s.bar));
      const t1 = Math.max(t0, G.barToSeconds(song, s.bar + s.len));
      const x0 = this.xOf(t0);
      const x1 = this.xOf(t1);
      this.hits.push({ section: s, x0, x1: Math.max(x1, x0 + 8) });
      if (x1 < 0 || x0 > w) continue;
      const color = sectionColor(s);
      let alpha = s === current ? 0.6 : 0.3;
      if (pendingBar === s.bar) alpha = 0.45 + 0.4 * Math.abs(Math.sin(Date.now() / 140));
      ctx.globalAlpha = alpha;
      ctx.fillStyle = color;
      ctx.fillRect(x0, 1, x1 - x0 - 1, this.laneH - 2);
      ctx.globalAlpha = 1;
      ctx.fillRect(x0, 1, 3, this.laneH - 2);
      ctx.save();
      ctx.beginPath();
      ctx.rect(Math.max(0, x0), 0, x1 - Math.max(0, x0) - 4, this.laneH);
      ctx.clip();
      ctx.fillStyle = '#f2f2f2';
      ctx.font = nameFont;
      const bars = String(Math.round(s.len * 100) / 100);
      if (big) {
        // Room for two lines: the name, and its length under it.
        ctx.fillText(s.name, Math.max(2, x0) + 8, this.laneH * 0.36);
        ctx.font = smallFont;
        ctx.globalAlpha = 0.6;
        ctx.fillText(bars + (s.len === 1 ? ' bar' : ' bars'), Math.max(2, x0) + 8, this.laneH * 0.72);
        ctx.globalAlpha = 1;
      } else {
        ctx.fillText(s.name, Math.max(2, x0) + 7, this.laneH / 2 + 0.5);
        // The length in bars, at the right end, when there is room beside the name.
        const nameW = ctx.measureText(s.name).width;
        const barsW = ctx.measureText(bars).width;
        if (x1 - Math.max(0, x0) > nameW + barsW + 26) {
          ctx.globalAlpha = 0.55;
          ctx.fillText(bars, x1 - barsW - 8, this.laneH / 2 + 0.5);
          ctx.globalAlpha = 1;
        }
      }
      ctx.restore();
    }

    // Where the guide voice speaks: a strip under the lane from its first
    // word to the section it announces, in that section's colour, with a
    // tick for each word. A count-in before the song is off the left edge;
    // the top bar says so instead.
    const byBar = new Map();
    for (const e of this.o.getGuide()) {
      if (!byBar.has(e.bar)) byBar.set(e.bar, []);
      byBar.get(e.bar).push(e);
    }
    for (const [bar, words] of byBar) {
      const sec = sections.find((x) => x.bar === bar);
      if (!sec) continue;
      const x0 = this.xOf(Math.max(0, words[0].sec));
      const x1 = this.xOf(G.barToSeconds(song, bar));
      if (x1 <= x0 || x1 < 0 || x0 > w) continue;
      ctx.fillStyle = sectionColor(sec);
      ctx.globalAlpha = 0.5;
      ctx.fillRect(x0, this.laneH, x1 - x0, 4);
      ctx.globalAlpha = 1;
      for (const e of words) if (e.spoken && e.sec >= 0) ctx.fillRect(Math.round(this.xOf(e.sec)), this.laneH, 2, 8);
    }

    // Bar ruler
    ctx.fillStyle = '#9a9a9a';
    ctx.font = big ? '11px "Segoe UI", system-ui, sans-serif' : '10px "Segoe UI", system-ui, sans-serif';
    const beats = Math.max(1, Math.round(G.beatsPerBar(song)));
    const beatPx = barPx / beats;
    for (let bar = firstBar; bar <= lastBar; bar++) {
      const x = Math.round(this.xOf(G.barToSeconds(song, bar))) + 0.5;
      const major = mod(bar, step) === 0;
      if (major || barPx >= 5) {
        ctx.strokeStyle = major ? '#777' : '#4a4a4a';
        ctx.beginPath();
        ctx.moveTo(x, major ? this.laneH + 3 : this.laneH + 12);
        ctx.lineTo(x, h);
        ctx.stroke();
      }
      if (major && bar >= 0) ctx.fillText(String(bar + 1), x + 4, this.laneH + 9);
      if (beatPx >= 14) {
        ctx.strokeStyle = '#3d3d3d';
        for (let b = 1; b < beats; b++) {
          const bx = Math.round(x + b * beatPx) + 0.5;
          ctx.beginPath();
          ctx.moveTo(bx, h - 4);
          ctx.lineTo(bx, h);
          ctx.stroke();
        }
      }
    }

    // Callouts: where the guide says a word that is not a section. A white
    // line through the whole strip with the word on a flag at its foot (the
    // owner's pick); with no room for the word before the next one, a triangle
    // on the top edge instead. White is --callout in styles.css.
    const calls = (song.callouts || [])
      .map((c) => ({ x: Math.round(this.xOf(G.barToSeconds(song, c.bar))), word: c.word === 'count' ? 'Count in' : c.word }))
      .sort((a, b) => a.x - b.x);
    const flagH = big ? 17 : 14;
    ctx.font = big ? '12px "Segoe UI", system-ui, sans-serif' : '10px "Segoe UI", system-ui, sans-serif';
    calls.forEach((c, i) => {
      const flagW = Math.ceil(ctx.measureText(c.word).width) + 10;
      if (c.x + flagW < 0 || c.x > w) return;
      const room = i + 1 < calls.length ? calls[i + 1].x - c.x - 3 : Infinity;
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(c.x, 0, 2, h);
      if (flagW <= room) {
        ctx.fillRect(c.x, h - flagH - 1, flagW, flagH);
        ctx.fillStyle = '#161616';
        ctx.fillText(c.word, c.x + 5, h - 1 - flagH / 2 + 0.5);
      } else {
        const r = big ? 7 : 5;
        ctx.beginPath();
        ctx.moveTo(c.x + 1 - r, 0);
        ctx.lineTo(c.x + 1 + r, 0);
        ctx.lineTo(c.x + 1, r * 1.6);
        ctx.fill();
      }
    });

    // The end of the song: what lies after it is dimmed, and the line has a
    // grip in the bar numbers to drag it by (see moveSongEnd in app.js).
    const endX = Math.round(this.xOf(this.o.getDuration()));
    this.endX = endX;
    const after = (c, cw, ch) => {
      if (endX >= cw) return;
      c.fillStyle = 'rgba(0, 0, 0, 0.45)';
      c.fillRect(Math.max(0, endX), 0, cw - Math.max(0, endX), ch);
      c.fillStyle = '#d6d6d6';
      c.fillRect(endX - 1, 0, 2, ch);
    };
    after(ctx, w, h);
    if (endX > -EDGE && endX < w + EDGE && !this.o.isLocked()) {
      ctx.fillStyle = '#d6d6d6';
      ctx.fillRect(endX - 5, this.laneH + 4, 10, 15);
      ctx.fillStyle = '#232323';
      ctx.fillRect(endX - 2, this.laneH + 8, 1, 7);
      ctx.fillRect(endX + 1, this.laneH + 8, 1, 7);
    }

    // Tracks
    for (const t of song.tracks) {
      const canvas = this.canvases.get(t.id);
      if (!canvas) continue;
      const p = this._prep(canvas);
      this._drawTrack(p.ctx, p.w, p.h, song, t, firstBar, lastBar, step, barPx);
      after(p.ctx, p.w, p.h);
    }
  }

  _drawTrack(ctx, w, h, song, t, firstBar, lastBar, step, barPx) {
    ctx.fillStyle = '#262626';
    ctx.fillRect(0, 0, w, h);
    const mod = (a, b) => ((a % b) + b) % b;
    for (let bar = firstBar; bar <= lastBar; bar++) {
      const major = mod(bar, step) === 0;
      if (!major && barPx < 8) continue;
      ctx.fillStyle = major ? '#3a3a3a' : '#2f2f2f';
      ctx.fillRect(Math.round(this.xOf(G.barToSeconds(song, bar))), 0, 1, h);
    }
    const peaks = this.o.getPeaks(t.id);
    if (!peaks) {
      ctx.fillStyle = t.missing ? '#c66' : '#777';
      ctx.font = '11px "Segoe UI", system-ui, sans-serif';
      ctx.textBaseline = 'middle';
      ctx.fillText(t.missing ? 'File not found: ' + t.file : 'Preparing…', 8, h / 2);
      return;
    }
    const audible = this.o.isAudible(t);
    ctx.fillStyle = !audible ? '#4d4d4d' : t.bus === 'cue' ? '#d6a243' : '#a9b4bf';
    const mid = h / 2;
    const scale = (h / 2 - 2) / 127;
    const nb = peaks.length / 2;
    const perPx = PEAKS_PER_SEC / this.pps;
    const base = this.scrollT * PEAKS_PER_SEC;
    for (let x = 0; x < w; x++) {
      const b0 = Math.floor(base + x * perPx);
      if (b0 >= nb) break;
      const b1 = Math.min(nb, Math.max(b0 + 1, Math.floor(base + (x + 1) * perPx)));
      let lo = 127;
      let hi = -127;
      for (let b = b0; b < b1; b++) {
        const a = peaks[b * 2];
        const z = peaks[b * 2 + 1];
        if (a < lo) lo = a;
        if (z > hi) hi = z;
      }
      const y0 = mid - hi * scale;
      const y1 = mid - lo * scale;
      ctx.fillRect(x, y0, 1, Math.max(1, y1 - y0));
    }
  }
}

export { LANE_H, RULER_H };
