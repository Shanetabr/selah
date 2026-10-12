'use strict';
// Seals the owner's click (main.wav and eighth.wav) into assets/clicks/ew.lock
// with the full key, so the project can hold it without anyone being able to
// take it. The two WAVs live outside the project; the key is never written
// down here: it comes in through the environment for this one run.
//
//   SELAH_FULL_KEY='…' node scripts/lock-ew.js <folder with main.wav and eighth.wav>
const fs = require('fs');
const path = require('path');
const vault = require('../src/engine/vault');

const dir = process.argv[2];
const key = process.env.SELAH_FULL_KEY;
if (!dir || !key) {
  console.error("Usage: SELAH_FULL_KEY='…' node scripts/lock-ew.js <folder with main.wav and eighth.wav>");
  process.exit(1);
}
const files = { 'main.wav': fs.readFileSync(path.join(dir, 'main.wav')), 'eighth.wav': fs.readFileSync(path.join(dir, 'eighth.wav')) };
const out = path.join(__dirname, '..', 'assets', 'clicks', 'ew.lock');
fs.writeFileSync(out, vault.seal(files, key));
console.log(`Sealed ${Object.keys(files).join(' and ')} into ${out}`);
