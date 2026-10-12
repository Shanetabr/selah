// Song structure edits. A section is a block on the bar grid: it starts at
// `bar` and is `len` bars long. Blocks never overlap; gaps are allowed.
//
// Pure functions over [{ id, bar, len }]. Each returns a new list sorted by
// bar, or null when the edit is not possible, and never changes its input.
//
// The rules, as the owner asked for them:
//   - moving a block right pushes the blocks it runs into, and they keep
//     their lengths; moving left stops at the block before
//   - dragging a block's right edge makes it longer or shorter and everything
//     after it follows by the same amount
//   - dragging a block's left edge stops at the block before
//
// opts: { min, limit, step }: the lowest bar a block may start at, the highest
// (the end of a song with stems; Infinity otherwise), and the shortest length.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Structure = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const EPS = 1e-9;

  function copy(list) {
    return list.map((s) => ({ id: s.id, bar: s.bar, len: s.len })).sort((a, b) => a.bar - b.bar);
  }

  // An edit may not carry a block past either end of the song. A block that
  // was already outside (the song got shorter since) may stay where it was.
  function fits(out, list, opts) {
    return out.every((s) => {
      const was = list.find((x) => x.id === s.id);
      const lo = was ? Math.min(opts.min, was.bar) : opts.min;
      const hi = was ? Math.max(opts.limit, was.bar) : opts.limit;
      return s.bar >= lo - EPS && s.bar <= hi + EPS;
    });
  }

  // Gives every block a length. Sections saved as plain markers run to the
  // next marker, the last one to `endBar`. Overlaps are trimmed.
  function normalize(list, endBar) {
    const out = copy(list);
    out.forEach((s, i) => {
      const next = out[i + 1];
      if (!(s.len > 0)) s.len = next ? next.bar - s.bar : Math.max(1, endBar - s.bar);
      if (next && s.bar + s.len > next.bar) s.len = next.bar - s.bar;
    });
    return out;
  }

  // Shifts the blocks from index i on to the right until nothing starts before `from`.
  function pushRight(out, i, from) {
    for (let k = i; k < out.length; k++) {
      if (out[k].bar >= from - EPS) break;
      out[k].bar = from;
      from = out[k].bar + out[k].len;
    }
  }

  function move(list, id, bar, opts) {
    const out = copy(list);
    const i = out.findIndex((s) => s.id === id);
    if (i < 0) return null;
    const s = out[i];
    const floor = i > 0 ? out[i - 1].bar + out[i - 1].len : opts.min;
    s.bar = Math.max(bar, floor, opts.min);
    pushRight(out, i + 1, s.bar + s.len);
    return fits(out, list, opts) ? out : null;
  }

  function resizeEnd(list, id, end, opts) {
    const out = copy(list);
    const i = out.findIndex((s) => s.id === id);
    if (i < 0) return null;
    const s = out[i];
    const len = Math.max(opts.step, end - s.bar);
    const delta = len - s.len;
    s.len = len;
    for (let k = i + 1; k < out.length; k++) out[k].bar += delta;
    return fits(out, list, opts) ? out : null;
  }

  function resizeStart(list, id, bar, opts) {
    const out = copy(list);
    const i = out.findIndex((s) => s.id === id);
    if (i < 0) return null;
    const s = out[i];
    const end = s.bar + s.len;
    const floor = i > 0 ? out[i - 1].bar + out[i - 1].len : opts.min;
    s.bar = Math.min(Math.max(bar, floor, opts.min), end - opts.step);
    s.len = end - s.bar;
    return out;
  }

  // A new block at `bar`. Inside an existing block it takes that block's
  // remainder; in a gap it runs to the next block, `len` bars at most.
  function insert(list, id, bar, len) {
    const out = copy(list);
    if (out.some((s) => Math.abs(s.bar - bar) < EPS)) return null;
    const inside = out.find((s) => s.bar < bar && bar < s.bar + s.len - EPS);
    const next = out.find((s) => s.bar > bar);
    let n = len;
    if (inside) {
      n = inside.bar + inside.len - bar;
      inside.len = bar - inside.bar;
    } else if (next) n = Math.min(len, next.bar - bar);
    out.push({ id, bar, len: n });
    return out.sort((a, b) => a.bar - b.bar);
  }

  // The bar where the last block ends.
  function end(list) {
    let e = 0;
    for (const s of list) if (s.bar + s.len > e) e = s.bar + s.len;
    return e;
  }

  // The block that contains `bar`, or null in a gap.
  function at(list, bar) {
    for (const s of list) if (bar >= s.bar - EPS && bar < s.bar + s.len - EPS) return s;
    return null;
  }

  return { normalize, move, resizeEnd, resizeStart, insert, end, at };
});
