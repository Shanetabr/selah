'use strict';
// What voice control listens for, and how each phrase is written for the
// listening model. Pure functions; unit-tested.
//
// The model hears "sound pieces" (assets/voice/tokens.txt), and a phrase has
// to be spelled in them the way the model was trained: of all the ways to cut
// a word into pieces, the one whose scores add up highest (`pieces.json`).

const NUMBERS = ['ZERO', 'ONE', 'TWO', 'THREE', 'FOUR', 'FIVE', 'SIX', 'SEVEN', 'EIGHT', 'NINE'];

// A section's name as it is said: "Pre-Chorus 2" is "PRE CHORUS TWO". Empty
// when there is nothing in it to say.
function spoken(name) {
  return String(name || '')
    .toUpperCase()
    .replace(/[0-9]/g, (d) => ' ' + NUMBERS[d] + ' ')
    .replace(/[^A-Z']+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

// One word in sound pieces, or null when the pieces cannot spell it.
function spellWord(scores, word) {
  const s = '▁' + word;
  const best = new Array(s.length + 1).fill(-Infinity);
  const cut = new Array(s.length + 1).fill(-1);
  best[0] = 0;
  for (let end = 1; end <= s.length; end++) {
    for (let start = Math.max(0, end - 12); start < end; start++) {
      const score = scores[s.slice(start, end)];
      if (score === undefined || best[start] === -Infinity) continue;
      if (best[start] + score > best[end]) {
        best[end] = best[start] + score;
        cut[end] = start;
      }
    }
  }
  if (best[s.length] === -Infinity) return null;
  const out = [];
  for (let end = s.length; end > 0; end = cut[end]) out.unshift(s.slice(cut[end], end));
  return out;
}

// A spoken phrase in sound pieces, separated by spaces, or null.
function spell(scores, phrase) {
  const out = [];
  for (const word of phrase.split(' ')) {
    const pieces = spellWord(scores, word);
    if (!pieces) return null;
    out.push(...pieces);
  }
  return out.length ? out.join(' ') : null;
}

// The phrases to listen for, from the names of a song's sections: one per
// different name, in the order given. A name that cannot be said or spelled
// is left out and listed in `skipped`.
function phrases(scores, names) {
  const list = [];
  const skipped = [];
  const seen = new Set();
  for (const name of names) {
    const phrase = spoken(name);
    if (seen.has(phrase)) continue;
    seen.add(phrase);
    const pieces = phrase ? spell(scores, phrase) : null;
    if (pieces) list.push({ name, phrase, pieces });
    else skipped.push(name);
  }
  return { list, skipped };
}

module.exports = { spoken, spell, phrases };
