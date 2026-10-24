'use strict';
const fs = require('fs');
const path = require('path');

// SongSelect splits a long section into parts: "VERSE 1a", "CHORUS 2b".
const SECTION = /^(intro|verse|pre[ -]?chorus|chorus|bridge|refrain|interlude|instrumental|turnaround|tag|vamp|solo|outro|ending)(?:\s+(\d+)([a-z])?)?$/i;
const DIRECTIONS = /^(all in|build|slowly build|last time|hits|break|breakdown|drums in|swell|softly|hold|big ending|key change up|key change down|worship freely)$/i;
const titleCase = (s) => s.toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());
const near = (a, b, n = 1) => Math.abs(a - b) < n;
const unique = (ns, tolerance = 1) => ns.sort((a, b) => a - b).filter((n, i, a) => !i || n - a[i - 1] > tolerance);

// PDF.js 6 emits compact drawing paths. Keep only straight segments, in page
// coordinates. Full-height vertical strokes distinguish bar lines from stems.
function linesFromOperators(list, OPS, Util, viewport) {
  let matrix = viewport.transform;
  const stack = [];
  const lines = [];
  const point = (x, y) => { const p = [x, y]; Util.applyTransform(p, matrix); return p; };
  const add = (a, b) => { if (a && b) lines.push({ x0: a[0], y0: a[1], x1: b[0], y1: b[1] }); };
  for (let i = 0; i < list.fnArray.length; i++) {
    const op = list.fnArray[i], args = list.argsArray[i];
    if (op === OPS.save) stack.push(matrix.slice());
    else if (op === OPS.restore) matrix = stack.pop() || viewport.transform;
    else if (op === OPS.transform) matrix = Util.transform(matrix, args);
    else if (op === OPS.constructPath) {
      const data = args[1]?.[0];
      if (!data || typeof data.length !== 'number') continue;
      let last = null, first = null;
      for (let j = 0; j < data.length;) {
        const type = data[j++];
        if (type === 0) first = last = point(data[j++], data[j++]);
        else if (type === 1) { const next = point(data[j++], data[j++]); add(last, next); last = next; }
        else if (type === 2) { j += 4; last = point(data[j++], data[j++]); }
        else if (type === 3) { j += 2; last = point(data[j++], data[j++]); }
        else if (type === 4) { add(last, first); last = first; }
        else break;
      }
    }
  }
  return lines;
}

function staves(lines) {
  const horizontal = lines.filter((l) => near(l.y0, l.y1, 0.3) && Math.abs(l.x1 - l.x0) > 30);
  // Beams can lie between staff lines. Require a substantial total span so
  // those short strokes cannot interrupt a five-line staff.
  const ys = unique(horizontal.map((l) => l.y0), 0.6).filter((y) => horizontal.filter((l) => near(l.y0, y, 0.6)).reduce((sum, l) => sum + Math.abs(l.x1 - l.x0), 0) > 180);
  const rows = [];
  for (let i = 0; i + 4 < ys.length; i++) {
    const five = ys.slice(i, i + 5), step = (five[4] - five[0]) / 4;
    if (step < 2 || step > 10 || five.some((y, k) => !near(y, five[0] + k * step, 0.5))) continue;
    const strokes = horizontal.filter((l) => five.some((y) => near(l.y0, y, 0.6)));
    const left = Math.min(...strokes.map((l) => Math.min(l.x0, l.x1)));
    const right = Math.max(...strokes.map((l) => Math.max(l.x0, l.x1)));
    const bars = lines.filter((l) => near(l.x0, l.x1, 0.5) && near(Math.min(l.y0, l.y1), five[0], 0.8) && near(Math.max(l.y0, l.y1), five[4], 0.8));
    const boundaries = unique([left, ...bars.map((l) => l.x0), right], 5);
    rows.push({ top: five[0], bottom: five[4], left, right, boundaries, count: boundaries.length - 1 });
    i += 4;
  }
  return rows;
}

function textLines(items) {
  const sorted = items.filter((t) => t.text.trim()).sort((a, b) => a.y - b.y || a.x - b.x);
  const groups = [];
  for (const item of sorted) {
    let group = groups.findLast((g) => near(g.y, item.y, 2));
    if (!group) { group = { y: item.y, items: [] }; groups.push(group); }
    group.items.push(item);
  }
  return groups.flatMap((g) => {
    const spans = [];
    for (const t of g.items.sort((a, b) => a.x - b.x)) {
      const prev = spans[spans.length - 1];
      if (prev && t.x - prev.right < Math.max(t.h, prev.h) * 1.3) {
        prev.text += ' ' + t.text; prev.right = t.x + t.w;
      } else spans.push({ ...t, right: t.x + t.w });
    }
    return spans;
  });
}

function convert(pages, filename) {
  const warnings = [];
  const warn = (text, page) => warnings.push({ id: 'note_' + warnings.length, text, page, reviewed: false });
  let rowIndex = 0;
  const rows = pages.flatMap((p) => {
    p.rows = staves(p.lines).map((r) => ({ ...r, page: p.number, index: rowIndex++ }));
    return p.rows;
  });
  if (!rows.length) throw new Error('No readable music staves found. Use a lead sheet with selectable text and printed notation. Scans and chord-only sheets are not supported yet.');
  for (const p of pages) {
    if (!p.items.some((t) => /[a-z]{3}/i.test(t.text))) throw new Error(`Page ${p.number} has no readable text. Use the original downloaded PDF rather than a scan.`);
    if (!p.rows.length) warn(`Page ${p.number}: no music staves found. Check that no music was missed.`, p.number);
    for (const r of p.rows) {
      const numbers = p.items.filter((t) => /^\d+$/.test(t.text) && t.x <= r.left + 8 && t.y >= r.top - 22 && t.y <= r.top + 2 && Number(t.text) > 1);
      r.printed = numbers.length === 1 ? Number(numbers[0].text) : null;
    }
  }
  let cursor = 1;
  const anchor = rows.findIndex((r) => r.printed !== null);
  if (anchor >= 0) cursor = rows[anchor].printed - rows.slice(0, anchor).reduce((n, r) => n + r.count, 0);
  for (const r of rows) {
    if (r.printed !== null && r.printed !== cursor) warn(`Page ${r.page}: measure numbering changes near measure ${r.printed}. Check section lengths.`, r.page);
    r.start = r.printed ?? cursor;
    cursor = r.start + r.count;
  }
  const position = (p, t) => {
    const r = p.rows.find((r) => t.y <= r.top + 2 && r.top - t.y < 65);
    if (!r) return null;
    let measure = 0;
    for (let i = 1; i < r.boundaries.length - 1; i++) if (t.x >= r.boundaries[i] - 9) measure = i;
    return { measure: r.start + measure, row: r };
  };
  const markers = [], directions = [];
  for (const p of pages) {
    const spans = textLines(p.items);
    // Keep individual text items too: an ending number close to a label must
    // not turn "INTRO" into "INTRO 1 2" and hide a section.
    const candidates = [...p.items, ...spans];
    for (const t of candidates) {
      const text = t.text.trim().replace(/\s+/g, ' ');
      const section = SECTION.exec(text), direction = DIRECTIONS.exec(text);
      if (!section && !direction) continue;
      const at = position(p, t);
      if (!at) continue;
      const list = section ? markers : directions;
      // A part letter is dropped from the name ("Verse 1a" is Verse 1), and kept
      // to join a later part to the section it continues.
      const name = section ? titleCase(section[1] + (section[2] ? ' ' + section[2] : '')) : titleCase(text);
      if (list.some((s) => s.measure === at.measure && s.name === name)) continue;
      list.push({ name: name.replace(/^Pre[ -]?Chorus/, 'Pre-Chorus'), part: section && section[3] ? section[3].toLowerCase() : '', measure: at.measure, page: p.number });
    }
    for (const t of spans) {
      if (/\bD\s*\.\s*[SC]\b|\bcoda\b|repeat as desired|\b[1-9](?:st|nd|rd|th) time\b/i.test(t.text)) warn(`Page ${p.number}: “${t.text}”. Adjust the section order or repeat count below.`, p.number);
    }
    const endings = spans.filter((t) => /^\d+(?:\s*[,–-]\s*\d+)*$/.test(t.text.trim()) && t.x > 100 && p.rows.some((r) => r.top - t.y > 20 && r.top - t.y < 60));
    if (endings.length) warn(`Page ${p.number}: alternate endings (${Array.from(new Set(endings.map((t) => t.text))).join(' / ')}). Check repeats and section lengths.`, p.number);
  }
  markers.sort((a, b) => a.measure - b.measure);
  // A longer matching label supersedes a split word at the same position.
  const distinct = markers
    .filter((s) => !markers.some((m) => m !== s && m.measure === s.measure && m.name.startsWith(s.name + ' ')))
    // "Chorus 2b" right after "Chorus 2a" is the same chorus going on, not a new one.
    .filter((s, i, a) => !(s.part && s.part !== 'a' && i && a[i - 1].name === s.name));
  if (!distinct.length) throw new Error('No section labels found. This importer needs a lead sheet with labels such as Intro, Verse, and Chorus.');
  const sections = distinct.map((s, i) => ({
    id: 'chart_' + i, name: s.name, len: Math.max(1, (distinct[i + 1]?.measure ?? cursor) - s.measure),
    sourceMeasure: s.measure, page: s.page, callouts: [],
  }));
  for (const d of directions) {
    const i = distinct.findLastIndex((s) => s.measure <= d.measure);
    if (i >= 0) sections[i].callouts.push({ id: 'direction_' + i + '_' + sections[i].callouts.length, word: d.name, at: d.measure - distinct[i].measure, enabled: false });
  }
  if (rows[0].start < distinct[0].measure) warn('Music before the first section may be a pickup. The timeline starts at the first labeled section; check bar 1.', 1);
  warn('Repeat bar lines are not unfolded automatically. Duplicate sections to match the arrangement you will play.', null);
  const text = pages.flatMap((p) => p.items.map((t) => t.text)).join(' ');
  const tempo = /(?:=\s*|\bBPM\s*[:=]?\s*)(\d+(?:\.\d+)?)/i.exec(text);
  const sig = /\b(\d{1,2})\s*\/\s*(2|4|8|16)\b/.exec(text);
  const title = pages[0].items.filter((t) => t.y < rows[0].top - 40 && /[a-z]{3}/i.test(t.text)).sort((a, b) => b.h - a.h)[0]?.text;
  const key = /(?:lead|chord)[-_ ]([A-G](?:b|#)?)(?:\.pdf)$/i.exec(filename)?.[1] || '';
  warn(sig ? 'Confirm the extracted time signature.' : 'Confirm the time signature; 4/4 is selected because the printed signature could not be read as text.', 1);
  if (!tempo) warn('No tempo found. Enter the BPM before applying.', 1);
  return { name: title || path.basename(filename, '.pdf'), bpm: tempo ? Number(tempo[1]) : null, key,
    num: sig ? Number(sig[1]) : 4, den: sig ? Number(sig[2]) : 4, offset: 0,
    sections, warnings, source: path.basename(filename), pages: pages.length };
}

async function read(file) {
  if (typeof file !== 'string' || !path.isAbsolute(file) || !/\.pdf$/i.test(file)) throw new Error('Choose a PDF lead sheet.');
  const stat = await fs.promises.stat(file);
  if (stat.size > 25 * 1024 * 1024) throw new Error('Choose a chart smaller than 25 MB.');
  const { getDocument, OPS, Util } = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const task = getDocument({ data: new Uint8Array(await fs.promises.readFile(file)), isEvalSupported: false, useSystemFonts: true });
  // Password-protected charts should fail promptly instead of waiting for a UI
  // password callback in the background process.
  task.onPassword = () => task.destroy();
  try {
    const doc = await task.promise;
    if (doc.numPages > 30) throw new Error('Choose a chart with 30 pages or fewer.');
    const pages = [];
    for (let n = 1; n <= doc.numPages; n++) {
      const page = await doc.getPage(n), viewport = page.getViewport({ scale: 1 });
      const content = await page.getTextContent();
      const items = content.items.filter((t) => t.str?.trim()).map((t) => {
        const transform = Util.transform(viewport.transform, t.transform);
        return { text: t.str, x: transform[4], y: transform[5], w: t.width, h: t.height };
      });
      const lines = linesFromOperators(await page.getOperatorList(), OPS, Util, viewport);
      pages.push({ number: n, items, lines });
      page.cleanup();
    }
    return convert(pages, file);
  } finally { await task.destroy(); }
}

module.exports = { read, convert, staves, linesFromOperators };
