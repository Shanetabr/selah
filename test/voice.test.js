'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const Spell = require('../src/voice/spell');
const Samples = require('../src/engine/samples');
const { Spotter, RATE } = require('../src/voice/spotter');

const scores = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'assets', 'voice', 'pieces.json'), 'utf8'));
const VOICE = path.join(__dirname, '..', 'assets', 'cues', 'english-female', 'Song Sections');
const said = (word) => Float32Array.from(Samples.loadSample(path.join(VOICE, `English Female - ${word}.wav`), RATE));
const quiet = (sec) => new Float32Array(Math.round(RATE * sec));

test('a section name is turned into what is said', () => {
  assert.strictEqual(Spell.spoken('Pre-Chorus 2'), 'PRE CHORUS TWO');
  assert.strictEqual(Spell.spoken('  verse  '), 'VERSE');
  assert.strictEqual(Spell.spoken("Don't Stop"), "DON'T STOP");
  assert.strictEqual(Spell.spoken('···'), '');
});

test('a phrase is spelled in sound pieces the way the model was trained', () => {
  // Checked against the model's own tokenizer when the model was added.
  const want = {
    INTRO: '▁IN T RO',
    VERSE: '▁ VER SE',
    'VERSE TWO': '▁ VER SE ▁TWO',
    CHORUS: '▁C HO RU S',
    'PRE CHORUS': '▁PRE ▁C HO RU S',
    BRIDGE: '▁B RI D GE',
    INTERLUDE: '▁IN TER LU DE',
    INSTRUMENTAL: '▁IN S T RU MENT AL',
    TAG: '▁TA G',
    OUTRO: '▁OUT RO',
    BREAKDOWN: '▁B RE A K D OW N',
    'HELLO WORLD': '▁HE LL O ▁WORLD',
  };
  for (const [phrase, pieces] of Object.entries(want)) assert.strictEqual(Spell.spell(scores, phrase), pieces, phrase);
});

test('the phrases for a song: one per name, and what cannot be said is left out', () => {
  const { list, skipped } = Spell.phrases(scores, ['Verse', 'Chorus', 'verse', '???', 'Bridge']);
  assert.deepStrictEqual(list.map((p) => p.name), ['Verse', 'Chorus', 'Bridge']);
  assert.deepStrictEqual(skipped, ['???']);
});

test('the listener hears section names in the guide\'s own recordings, and nothing in silence', () => {
  const sp = new Spotter();
  assert.deepStrictEqual(sp.feed(said('Chorus')), [], 'with nothing to listen for it hears nothing');
  assert.deepStrictEqual(sp.setNames(['Intro', 'Verse', 'Chorus', 'Bridge', 'Tag', '???']), ['???']);
  assert.deepStrictEqual(sp.feed(quiet(2)), []);
  // One after another on the same stream, as in a service.
  for (const word of ['Chorus', 'Verse', 'Bridge', 'Intro', 'Tag', 'Chorus', 'Chorus']) {
    const heard = [...sp.feed(quiet(0.3)), ...sp.feed(said(word)), ...sp.feed(quiet(0.8))];
    assert.deepStrictEqual(heard, [word], word);
  }
  // A word it was not asked for is not mistaken for one it was.
  assert.deepStrictEqual([...sp.feed(said('Instrumental')), ...sp.feed(quiet(0.8))], []);
});
