'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vault = require('../src/engine/vault');
const samples = require('../src/engine/samples');

test('sealed files open with their passphrase and with nothing else', () => {
  const files = { 'a.wav': Buffer.from('first sound'), 'b.wav': Buffer.alloc(5000, 7) };
  const sealed = vault.seal(files, 'a test passphrase');
  const opened = vault.open(sealed, vault.keyFrom('a test passphrase', vault.saltOf(sealed)));
  assert.deepStrictEqual(Object.keys(opened), ['a.wav', 'b.wav']);
  assert.ok(opened['a.wav'].equals(files['a.wav']) && opened['b.wav'].equals(files['b.wav']));
  for (const wrong of ['A test passphrase', 'a test passphrase ', '']) assert.strictEqual(vault.open(sealed, vault.keyFrom(wrong, vault.saltOf(sealed))), null, JSON.stringify(wrong));
  // Nothing of the contents is readable in what is stored, and a changed byte is refused.
  assert.ok(!sealed.includes(Buffer.from('first sound')));
  const bent = Buffer.from(sealed);
  bent[bent.length - 1] ^= 1;
  assert.strictEqual(vault.open(bent, vault.keyFrom('a test passphrase', vault.saltOf(bent))), null);
  assert.strictEqual(vault.open(Buffer.from('not a vault at all, just some bytes'), Buffer.alloc(32)), null);
});

test('the owner\'s click is in the project only sealed, and Selah has its sounds without it', () => {
  const clicks = path.join(__dirname, '..', 'assets', 'clicks');
  assert.ok(fs.existsSync(samples.EW_LOCK), 'the sealed click is there');
  for (const plain of ['main.wav', 'eighth.wav']) assert.ok(!fs.existsSync(path.join(clicks, plain)), plain + ' must not be in the project');
  // A guessable key does not open it.
  const lock = fs.readFileSync(samples.EW_LOCK);
  for (const guess of ['', 'selah', 'SELAH', 'password']) assert.strictEqual(vault.open(lock, vault.keyFrom(guess, vault.saltOf(lock))), null);
  // Without it there is no "ew" to choose, and the stand-in plays where it was asked for.
  samples.setEw(null);
  assert.ok(!samples.clickSets().some((s) => s.id === 'ew'));
  const set = samples.load(8000);
  assert.strictEqual(set.clicks.ew, undefined);
  assert.strictEqual(set.click, set.clicks[samples.STAND_IN]);
  // With it (any two WAVs will do here) it is the first sound in the list.
  const wav = fs.readFileSync(path.join(clicks, samples.STAND_IN, 'quarter.wav'));
  samples.setEw({ 'main.wav': wav, 'eighth.wav': wav });
  assert.strictEqual(samples.clickSets()[0].id, 'ew');
  assert.strictEqual(samples.load(8000).click, samples.load(8000).clicks.ew);
  samples.setEw(null);
});
