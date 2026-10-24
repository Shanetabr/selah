// Chart review uses a separate draft. Nothing here changes the song being played.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Chart = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  const copy = (v) => JSON.parse(JSON.stringify(v));
  const validLength = (v) => Number.isFinite(Number(v)) && Number(v) >= 0.25 && Number(v) <= 4000;

  function layout(draft) {
    let bar = 0;
    return draft.sections.map((s) => {
      const len = validLength(s.len) ? Number(s.len) : 1;
      const block = { ...s, bar, len };
      bar += len;
      return block;
    });
  }

  function validate(draft) {
    if (!draft.sections.length) return 'Add at least one section.';
    if (!draft.name.trim()) return 'Give the song a name.';
    if (!(Number.isFinite(draft.bpm) && draft.bpm >= 20 && draft.bpm <= 400)) return 'Set a tempo between 20 and 400 BPM.';
    if (!(Number.isInteger(draft.num) && draft.num >= 1 && draft.num <= 24 && [2, 4, 8, 16].includes(draft.den))) return 'Choose a valid time signature.';
    if (!(Number.isFinite(draft.offset) && draft.offset >= 0)) return 'Bar 1 must be at zero seconds or later.';
    if (draft.sections.some((s) => !s.name.trim() || !validLength(s.len))) return 'Each section needs a name and a length of ¼ to 4000 bars.';
    for (const s of draft.sections) {
      if ((s.callouts || []).some((c) => c.enabled && (!Number.isFinite(c.at) || c.at < 0 || c.at >= s.len))) return 'Place each enabled direction inside its section.';
    }
    if ((draft.warnings || []).some((w) => !w.reviewed)) return 'Check the chart notes before approving.';
    return null;
  }

  function setup(draft) {
    const error = validate(draft);
    if (error) throw new Error(error);
    const blocks = layout(draft);
    return {
      name: draft.name.trim(), key: draft.key.trim(), bpm: draft.bpm,
      num: draft.num, den: draft.den, offset: draft.offset, beatUnit: 'quarter',
      bars: blocks.reduce((sum, s) => sum + Number(s.len), 0),
      sections: blocks.map((s) => ({ id: s.id, name: s.name.trim(), bar: s.bar, len: Number(s.len), ...(s.cue ? { cue: copy(s.cue) } : {}) })),
      callouts: blocks.flatMap((s) => (s.callouts || []).filter((c) => c.enabled).map((c) => ({ id: c.id, word: c.word, bar: s.bar + c.at }))),
    };
  }

  // Callouts belong to a section instance, so a repeat moves/copies them too.
  function duplicate(draft, id, newId) {
    const at = draft.sections.findIndex((s) => s.id === id);
    if (at < 0) return null;
    const block = copy(draft.sections[at]);
    block.id = newId;
    // A repeat continues the music without announcing the same section again.
    block.cue = 'off';
    block.callouts = (block.callouts || []).map((c, i) => ({ ...c, id: newId + '_call_' + i }));
    draft.sections.splice(at + 1, 0, block);
    return block;
  }

  function canMerge(draft, id) {
    const at = draft.sections.findIndex((s) => s.id === id);
    const current = draft.sections[at], previous = draft.sections[at - 1];
    return !!previous && !!current.name.trim() && current.name.trim().toLowerCase() === previous.name.trim().toLowerCase()
      && validLength(current.len) && validLength(previous.len) && validLength(Number(current.len) + Number(previous.len));
  }

  function mergePrevious(draft, id) {
    if (!canMerge(draft, id)) return null;
    const at = draft.sections.findIndex((s) => s.id === id);
    const current = draft.sections[at], previous = draft.sections[at - 1];
    const offset = Number(previous.len);
    previous.callouts = [...(previous.callouts || []), ...(current.callouts || []).map((c) => ({ ...c, at: c.at + offset }))];
    previous.len = offset + Number(current.len);
    draft.sections.splice(at, 1);
    return previous;
  }

  return { copy, layout, validate, setup, duplicate, canMerge, mergePrevious, validLength };
});
