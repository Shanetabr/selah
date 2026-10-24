import { el, modal, uid, fmtTime } from './ui.js';
import { sectionColor } from './timeline.js';

const Chart = window.Chart;
const NAMES = ['Intro', 'Verse 1', 'Verse 2', 'Chorus', 'Pre-Chorus', 'Bridge', 'Instrumental', 'Interlude', 'Turnaround', 'Tag', 'Vamp', 'Outro', 'Ending'];
const fmt = (n) => Number(n.toFixed(2)).toString();

// All edits stay in this window's draft. The only way out to the library is
// onApply, after validation and the explicit arrangement approval.
export function openChartReview({ draft: incoming, target, peaks, duration = 0, words = [], onApply, onClose, onOpenSource }) {
  let draft = Chart.copy(incoming), selected = draft.sections[0]?.id;
  if (!draft.warnings.length) draft.warnings.push({ id: 'approval', text: 'Confirm the proposed section order and lengths.', reviewed: false });
  let zoom = 1, dragging = null, applying = false;
  const past = [], future = [];
  const voiceWords = new Set(words);
  let choice = target ? 'current' : 'new';
  if (target) {
    draft.offset = target.tracks.length ? target.offset || 0 : 0;
    // A click stem may have supplied a more precise tempo than the chart.
    const bpm = target.bpm / (target.double ? 2 : 1);
    if (target.tracks.length && (!incoming.bpm || Math.abs(bpm - incoming.bpm) < 1)) draft.bpm = bpm;
  }
  draft.guideEnabled = target ? !!target.cues.enabled : true;
  const original = Chart.copy(draft);
  const body = el('div.chart-review');
  let observer = null;
  const m = modal('REVIEW CHART TIMELINE', body, { onClose: () => { observer?.disconnect(); onClose?.(); } });
  body.closest('.modal').classList.add('chart-modal');
  body.closest('.modal').setAttribute('role', 'dialog');
  body.closest('.modal').setAttribute('aria-label', 'Review chart timeline');

  const remember = () => {
    past.push(Chart.copy(draft));
    if (past.length > 100) past.shift();
    future.length = 0;
  };
  const unapprove = () => draft.warnings.forEach((w) => { w.reviewed = false; });
  const change = (fn) => { remember(); fn(); unapprove(); render(); };
  function history(from, to) {
    if (!from.length) return;
    to.push(Chart.copy(draft)); draft = from.pop();
    if (!draft.sections.some((s) => s.id === selected)) selected = draft.sections[0]?.id;
    render();
  }
  const seconds = (bar) => draft.offset + bar * 60 / (draft.bpm || 120) * draft.num * 4 / draft.den;
  const summary = (blocks, total) => `${blocks.length} sections · ${fmt(total)} bars · ${fmtTime(seconds(total) - draft.offset)} · ${blocks.reduce((n, s) => n + (s.callouts || []).filter((c) => c.enabled).length, 0)} directions`;
  function validationMessage(total) {
    const error = Chart.validate(draft);
    const audioBars = choice === 'current' && duration > 0 ? (duration - draft.offset) / (seconds(1) - seconds(0)) : null;
    const alignment = audioBars && total > audioBars + 1 ? `This arrangement extends ${fmt(total - audioBars)} bars past the audio. Check the lengths or repeats.` : null;
    return error || alignment || (choice === 'current' ? 'Replaces sections and directions, and sets the song end to this timeline. One Undo restores the old setup.' : 'Ready to create this song with click and guide cues.');
  }
  // Keep the input and nearby action buttons mounted while someone types, so
  // tabbing or clicking Apply never loses an edit or requires a second click.
  function refreshPreview() {
    const blocks = Chart.layout(draft), total = blocks.reduce((n, s) => n + s.len, 0);
    const old = body.querySelector('.chart-timeline-scroll'), left = old.scrollLeft;
    old.replaceWith(renderTimeline(blocks, total));
    body.querySelector('.chart-timeline-scroll').scrollLeft = left;
    body.querySelector('#chartSummary').textContent = summary(blocks, total);
    for (const row of body.querySelectorAll('.chart-section-row')) {
      const s = blocks.find((s) => s.id === row.dataset.section);
      row.children[1].textContent = s.name;
      row.children[2].textContent = `Bar ${fmt(s.bar + 1)}`;
      row.children[3].textContent = `${fmt(s.len)} bars`;
    }
    const block = blocks.find((s) => s.id === selected);
    if (block) body.querySelector('.chart-readout strong').textContent = `Bar ${fmt(block.bar + 1)} · ${fmtTime(seconds(block.bar))}`;
    body.querySelector('#chartConfirm').checked = false;
    body.querySelector('#chartApply').disabled = !!Chart.validate(draft);
    body.querySelector('.chart-validation').textContent = validationMessage(total);
    body.querySelector('#chartUndo').disabled = !past.length;
    body.querySelector('#chartRedo').disabled = !future.length;
    const merge = body.querySelector('#chartMerge');
    if (merge) merge.disabled = !Chart.canMerge(draft, selected);
    colorSections(blocks);
  }
  function colorSections(blocks) {
    for (const node of body.querySelectorAll('[data-section]')) node.style.setProperty('--section-color', sectionColor(blocks.find((s) => s.id === node.dataset.section)));
  }
  function editInput(control, fn) {
    let editing = false;
    const update = () => {
      if (!editing) { remember(); editing = true; }
      fn(control.value); unapprove(); refreshPreview();
    };
    control.addEventListener('input', update);
    control.addEventListener('change', update);
    control.addEventListener('blur', () => { editing = false; });
    return control;
  }
  function input(label, props, fn) {
    const { list, ...attributes } = props;
    const control = editInput(el('input', attributes), fn);
    if (list) control.setAttribute('list', list);
    return el('label', null, el('span', null, label), control);
  }
  function select(id) {
    selected = id; render();
    if (window.innerHeight < 720) body.querySelector('.chart-inspector')?.scrollIntoView({ block: 'nearest' });
  }
  function move(id, delta) {
    const at = draft.sections.findIndex((s) => s.id === id), to = at + delta;
    if (at < 0 || to < 0 || to >= draft.sections.length) return;
    change(() => { const [s] = draft.sections.splice(at, 1); draft.sections.splice(to, 0, s); });
  }
  function remove(id) {
    change(() => {
      const at = draft.sections.findIndex((s) => s.id === id);
      draft.sections.splice(at, 1);
      selected = draft.sections[Math.min(at, draft.sections.length - 1)]?.id;
    });
  }
  function duplicate() {
    change(() => { selected = Chart.duplicate(draft, selected, uid('chart'))?.id; });
  }
  function add() {
    change(() => {
      const block = { id: uid('chart'), name: 'New section', len: 4, callouts: [] };
      const at = draft.sections.findIndex((s) => s.id === selected);
      draft.sections.splice(at + 1, 0, block); selected = block.id;
    });
    body.querySelector('#chartSectionName')?.select();
  }
  function dragStart(e, id) {
    dragging = id;
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/x-selah-chart', id);
  }
  function drop(e, id) {
    if (!dragging || dragging === id) return;
    e.preventDefault(); e.stopPropagation();
    const from = draft.sections.findIndex((s) => s.id === dragging), to = draft.sections.findIndex((s) => s.id === id);
    if (from < 0 || to < 0) return;
    change(() => { const [s] = draft.sections.splice(from, 1); draft.sections.splice(to, 0, s); selected = s.id; });
    dragging = null;
  }

  function renderTimeline(blocks, total) {
    const available = Math.max(200, (body.querySelector('.chart-content')?.clientWidth || body.clientWidth - 36) - 4);
    const scale = Math.max(8, available / Math.max(total, 1)) * zoom;
    const width = Math.max(available, total * scale);
    const scroll = el('div.chart-timeline-scroll', { 'aria-label': 'Proposed timeline. Select a section to edit it.' });
    const track = el('div.chart-timeline-track', { style: { width: width + 'px' } });
    const ruler = el('div.chart-ruler');
    const interval = Math.max(scale >= 24 ? 2 : 8, Math.ceil(total / 120));
    for (let b = 0; b <= total; b += interval) ruler.append(el('span', { style: { left: b * scale + 'px' } }, fmt(b + 1)));
    track.append(ruler);
    const lane = el('div.chart-lane');
    for (const s of blocks) {
      const block = el('button.chart-block' + (s.id === selected ? '.selected' : ''), {
        draggable: true, 'data-section': s.id, title: `${s.name} · bar ${fmt(s.bar + 1)} · ${fmt(s.len)} bars${s.cue === 'off' ? ' · No announcement or count-in' : ''} · drag to reorder`,
        style: { left: s.bar * scale + 'px', width: s.len * scale + 'px' },
        onclick: () => select(s.id), ondragstart: (e) => dragStart(e, s.id), ondragend: () => { dragging = null; },
        ondragover: (e) => { if (dragging) e.preventDefault(); }, ondrop: (e) => drop(e, s.id),
      }, el('strong', null, s.name), el('span', null, fmt(s.len) + ' bars'));
      if (s.cue === 'off') block.append(el('small.chart-cue-off', null, 'No count-in'));
      lane.append(block);
    }
    track.append(lane);
    if (choice === 'current' && target?.tracks.length) {
      const canvas = el('canvas.chart-waveform', { height: 58, width: Math.min(16000, Math.ceil(width)), 'aria-label': 'Backing track waveform aligned to the draft grid', style: { width: width + 'px' } });
      track.append(canvas);
      const ctx = canvas.getContext('2d'), ratio = canvas.width / width;
      ctx.fillStyle = '#1b1b1b'; ctx.fillRect(0, 0, canvas.width, 58);
      ctx.strokeStyle = '#454b51'; ctx.beginPath(); ctx.moveTo(0, 29); ctx.lineTo(canvas.width, 29); ctx.stroke();
      if (peaks?.length) {
        ctx.strokeStyle = '#848e97'; ctx.beginPath();
        for (let x = 0; x < canvas.width; x++) {
          const sec = seconds(x / ratio / scale);
          const at = Math.floor(sec * 200) * 2;
          if (at < 0 || at >= peaks.length) continue;
          ctx.moveTo(x, 29 + peaks[at] / 128 * 26); ctx.lineTo(x, 29 + peaks[at + 1] / 128 * 26);
        }
        ctx.stroke();
      } else { ctx.fillStyle = '#9da4ac'; ctx.fillText('No waveform available. Check the tempo and bar 1 offset.', 10, 33); }
      if (duration > 0) {
        const end = (duration - draft.offset) / (seconds(1) - seconds(0)) * scale;
        const edge = el('span.chart-audio-end', { style: { left: Math.max(0, Math.min(width - 2, end)) + 'px' } }, 'Audio ends');
        track.append(edge);
      }
    }
    const calls = el('div.chart-direction-lane');
    for (const s of blocks) for (const c of s.callouts || []) {
      calls.append(el('button.chart-direction' + (c.enabled ? '.included' : ''), { style: { left: (s.bar + c.at) * scale + 'px' }, title: `${c.word}${c.enabled ? '' : ' (not included yet)'}`, onclick: () => select(s.id) }, c.word));
    }
    track.append(calls); scroll.append(track);
    return scroll;
  }

  function inspector(blocks) {
    const s = draft.sections.find((s) => s.id === selected);
    if (!s) return el('div.chart-inspector', null, el('p', null, 'Add a section to start your arrangement.'));
    const at = draft.sections.indexOf(s), block = blocks[at];
    const panel = el('div.chart-inspector', null,
      el('div.chart-panel-title', null, 'EDIT SECTION'),
      input('Section name', { id: 'chartSectionName', type: 'text', value: s.name, list: 'chartNames', maxlength: 80 }, (v) => { s.name = v; }),
      el('datalist#chartNames', null, NAMES.map((n) => el('option', { value: n }))),
      el('div.chart-field-pair', null,
        input('Length in bars', { id: 'chartSectionLength', type: 'number', min: 0.25, max: 4000, step: 0.25, value: s.len }, (v) => { s.len = Number(v); }),
        el('div.chart-readout', null, el('span', null, 'Starts at'), el('strong', null, `Bar ${fmt(block.bar + 1)} · ${fmtTime(seconds(block.bar))}`))),
      el('div.chart-actions', null,
        el('button', { disabled: at === 0, title: 'Move section earlier', onclick: () => move(s.id, -1) }, '← Earlier'),
        el('button', { disabled: at === draft.sections.length - 1, title: 'Move section later', onclick: () => move(s.id, 1) }, 'Later →'),
        el('button#chartDuplicate', { onclick: duplicate }, 'Duplicate'),
        el('button#chartMerge', { disabled: !Chart.canMerge(draft, s.id), title: 'Join matching adjacent sections into one longer block, keeping the first section’s guide setting and all directions.', onclick: () => {
          if (Chart.canMerge(draft, s.id)) change(() => { selected = Chart.mergePrevious(draft, s.id).id; });
        } }, 'Merge with previous'),
        el('button#chartRemove.danger', { onclick: () => remove(s.id) }, 'Remove')),
      el('p.chart-help', null, s.page ? `From page ${s.page}, printed measure ${s.sourceMeasure}.` : 'Added by you.'),
      el('p.chart-help', null, 'Duplicates keep a separate block with no extra count-in. Merge matching neighbours to make one longer section.'));
    const countIn = el('input#chartSectionCountIn', { type: 'checkbox', checked: s.cue !== 'off', onchange: () => change(() => {
      if (countIn.checked) delete s.cue;
      else s.cue = 'off';
    }) });
    panel.insertBefore(el('label.chart-section-guide', { title: 'Off skips the section name and spoken count. The click and band directions continue. On uses the song’s guide settings.' }, countIn, 'Announce / count into this section'), panel.querySelector('.chart-actions'));
    const normal = s.name.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
    if (s.cue !== 'off' && !voiceWords.has(normal) && !voiceWords.has(normal.replace(/ \d+$/, ''))) panel.append(el('p.chart-help', null, 'The guide has no recording of this name; it will count into this section.'));
    panel.append(el('div.chart-panel-title', null, 'BAND DIRECTIONS'));
    const directions = ['all in', 'build', 'slowly build', 'last time', 'hits', 'break', 'breakdown', 'drums in', 'swell', 'softly', 'hold', 'big ending', 'key change up', 'key change down', 'worship freely'];
    const options = directions.filter((w) => voiceWords.has(w));
    for (const c of s.callouts || []) {
      const include = el('input', { type: 'checkbox', checked: c.enabled, 'aria-label': 'Include ' + c.word, onchange: () => change(() => { c.enabled = include.checked; }) });
      const word = el('select', { 'aria-label': 'Direction word' }, options.map((w) => el('option', { value: w, selected: w.toLowerCase() === c.word.toLowerCase() }, w)));
      if (!options.some((w) => w.toLowerCase() === c.word.toLowerCase())) word.prepend(el('option', { value: c.word, selected: true }, c.word));
      word.onchange = () => change(() => { c.word = word.value; });
      const where = editInput(el('input', { type: 'number', min: 1, max: s.len + 0.75, step: 0.25, value: c.at + 1, 'aria-label': 'Bar within this section' }), (v) => { c.at = Number(v) - 1; });
      panel.append(el('div.chart-callout', null, include, word, el('span', null, 'bar'), where, el('button', { title: 'Remove direction', 'aria-label': 'Remove direction', onclick: () => change(() => { s.callouts.splice(s.callouts.indexOf(c), 1); }) }, '×')));
    }
    if (!s.callouts?.length) panel.append(el('p.chart-help', null, 'No directions in this section. Add one if the band needs it.'));
    panel.append(el('button#chartAddDirection', { disabled: !options.length, onclick: () => change(() => { (s.callouts ||= []).push({ id: uid('call'), word: options.includes('build') ? 'build' : options[0], at: 0, enabled: true }); }) }, '+ Direction'));
    return panel;
  }

  function render() {
    const oldScroll = body.querySelector('.chart-timeline-scroll')?.scrollLeft || 0;
    const listScroll = body.querySelector('.chart-section-list')?.scrollTop || 0;
    const contentScroll = body.querySelector('.chart-content')?.scrollTop || 0;
    const notesOpen = body.querySelector('.chart-notes')?.open || false;
    const blocks = Chart.layout(draft), total = blocks.reduce((n, s) => n + Number(s.len || 0), 0);
    const head = el('div.chart-intro', null,
      el('div', null, el('h2', null, 'Make this arrangement yours'), el('p', null, `${draft.source} · ${draft.pages} pages · Nothing is applied until you approve.`)),
      el('button', { onclick: onOpenSource }, 'Open original PDF ↗'));
    const settings = el('div.chart-settings', null);
    if (target) {
      const selectTarget = el('select#chartTarget', { 'aria-label': 'Apply chart to' },
        el('option', { value: 'current', selected: choice === 'current' }, 'Update ' + target.name),
        el('option', { value: 'new', selected: choice === 'new' }, 'Create a new song'));
      selectTarget.onchange = () => {
        choice = selectTarget.value;
        change(() => {
          draft.offset = choice === 'current' && target.tracks.length ? target.offset || 0 : 0;
          draft.guideEnabled = choice === 'current' ? !!target.cues.enabled : true;
          if (choice === 'new') draft.bpm = incoming.bpm;
        });
      };
      settings.append(el('label', null, el('span', null, 'Apply to'), selectTarget));
    }
    settings.append(input('Song name', { id: 'chartSongName', type: 'text', value: draft.name, maxlength: 160 }, (v) => { draft.name = v; }),
      input('BPM', { id: 'chartBpm', type: 'number', min: 20, max: 400, step: 0.01, value: draft.bpm ?? '', placeholder: 'Set tempo' }, (v) => { draft.bpm = Number(v); }),
      input('Beats / bar', { type: 'number', min: 1, max: 24, step: 1, value: draft.num }, (v) => { draft.num = Number(v); }));
    const den = el('select', { 'aria-label': 'Beat unit' }, [2, 4, 8, 16].map((n) => el('option', { value: n, selected: n === draft.den }, n)));
    den.onchange = () => change(() => { draft.den = Number(den.value); });
    settings.append(el('label', null, el('span', null, 'Beat unit'), den), input('Key', { type: 'text', value: draft.key, maxlength: 6 }, (v) => { draft.key = v; }));
    if (choice === 'current' && target?.tracks.length) settings.append(input('Bar 1 at (seconds)', { id: 'chartOffset', type: 'number', min: 0, step: 0.001, value: Math.round(draft.offset * 1000) / 1000 }, (v) => { draft.offset = Number(v); }));
    const guide = el('input', { type: 'checkbox', checked: draft.guideEnabled, onchange: () => change(() => { draft.guideEnabled = guide.checked; }) });
    settings.append(el('label.chart-guide', null, guide, 'Guide cues'));
    const toolbar = el('div.chart-toolbar', null,
      el('strong#chartSummary', null, summary(blocks, total)),
      el('span.spacer'),
      el('button#chartUndo', { disabled: !past.length, onclick: () => history(past, future) }, 'Undo'),
      el('button#chartRedo', { disabled: !future.length, onclick: () => history(future, past) }, 'Redo'),
      el('button', { title: 'Zoom out', onclick: () => { zoom = Math.max(0.5, zoom / 1.5); render(); } }, '−'),
      el('button', { onclick: () => { zoom = 1; render(); } }, 'Fit'),
      el('button', { title: 'Zoom in', onclick: () => { zoom = Math.min(4, zoom * 1.5); render(); } }, '+'));
    const list = el('div.chart-section-list', { role: 'list', 'aria-label': 'Arrangement sections' });
    for (const [i, s] of blocks.entries()) {
      list.append(el('button.chart-section-row' + (s.id === selected ? '.selected' : ''), {
        role: 'listitem', draggable: true, 'data-section': s.id,
        onclick: () => select(s.id), ondragstart: (e) => dragStart(e, s.id), ondragend: () => { dragging = null; },
        ondragover: (e) => { if (dragging) e.preventDefault(); }, ondrop: (e) => drop(e, s.id),
      }, el('span.chart-row-index', null, i + 1), el('strong', null, s.name), el('span', null, `Bar ${fmt(s.bar + 1)}`), el('span', null, `${fmt(s.len)} bars`)));
    }
    const arrangement = el('div.chart-arrangement', null, el('div.chart-panel-title', null, 'SECTION ORDER', el('span', null, 'Drag to reorder · select to edit')), list,
      el('div.chart-actions', null, el('button#chartAddSection', { onclick: add }, '+ Section'), el('button', { disabled: !blocks.length, onclick: duplicate }, 'Repeat selected section')));
    const notes = el('details.chart-notes', null, el('summary', null, `Check the chart notes (${draft.warnings.length})`),
      el('ul', null, draft.warnings.map((w) => el('li', null, w.text))));
    notes.open = notesOpen;
    const approved = draft.warnings.every((w) => w.reviewed);
    const approveCheck = el('input#chartConfirm', { type: 'checkbox', checked: approved, onchange: () => { draft.warnings.forEach((w) => { w.reviewed = approveCheck.checked; }); render(); } });
    const error = Chart.validate(draft);
    const apply = el('button#chartApply.primary', { disabled: !!error || applying, onclick: async () => {
      if (Chart.validate(draft) || applying) return;
      applying = true; apply.disabled = true;
      try { await onApply(Chart.copy(draft), choice); m.close(); }
      catch (error) { applying = false; errorText.textContent = error.message; apply.disabled = false; }
    } }, choice === 'current' ? 'Approve & apply' : 'Approve & create song');
    const errorText = el('div.chart-validation', { role: 'status', 'aria-live': 'polite' }, validationMessage(total));
    body.replaceChildren(el('div.chart-content', null, head, settings, toolbar, renderTimeline(blocks, total), el('p.chart-help', null,
      choice === 'current' && target?.tracks.length ? 'This edits section markers and guide cues. Duplicating or moving sections does not repeat or rearrange the recorded stems. Check the boundaries against the waveform.' : 'This is the section order for your click and guide. Select any block to edit it. Recorded stems, if added later, keep their original audio order.'),
      el('div.chart-workspace', null, arrangement, inspector(blocks)), notes),
      el('div.chart-footer', null, el('div', null, el('label.chart-approval', null, approveCheck, 'I’ve checked the chart notes and this timeline looks right'), errorText),
        el('button', { onclick: () => m.close() }, 'Cancel'), apply));
    colorSections(blocks);
    body.querySelector('.chart-timeline-scroll').scrollLeft = oldScroll;
    body.querySelector('.chart-content').scrollTop = contentScroll;
    list.scrollTop = listScroll;
    // If length/name changes were blank or invalid, their validation remains
    // visible, but the draft can still be repaired or undone.
  }
  render();
  // Once mounted, use the available width for the fit view.
  requestAnimationFrame(render);
  let lastWidth = body.clientWidth;
  observer = new ResizeObserver(() => {
    if (Math.abs(lastWidth - body.clientWidth) < 1) return;
    lastWidth = body.clientWidth;
    render();
  });
  observer.observe(body);
  body.addEventListener('keydown', (e) => {
    if (!(e.metaKey || e.ctrlKey) || e.key.toLowerCase() !== 'z' || /INPUT|TEXTAREA|SELECT/.test(e.target.tagName)) return;
    e.preventDefault(); e.stopPropagation(); history(e.shiftKey ? future : past, e.shiftKey ? past : future);
  });
  return { close: m.close, getDraft: () => Chart.copy(draft), undo: () => history(past, future), redo: () => history(future, past), reset: () => { change(() => { draft = Chart.copy(original); selected = draft.sections[0]?.id; }); } };
}
