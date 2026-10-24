'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Library } = require('../src/main/library');

const fresh = () => new Library(fs.mkdtempSync(path.join(os.tmpdir(), 'selah-lib-test-')));

test('the library is saved and read back, with the version before kept as a backup', () => {
  const lib = fresh();
  assert.equal(lib.load(), null, 'nothing yet on a new computer');
  lib.save({ songs: [{ id: 'a' }] });
  lib.save({ songs: [{ id: 'a' }, { id: 'b' }] });
  assert.deepEqual(lib.load(), { songs: [{ id: 'a' }, { id: 'b' }] });
  assert.deepEqual(JSON.parse(fs.readFileSync(lib.file + '.bak', 'utf8')), { songs: [{ id: 'a' }] });
});

test('an unreadable library falls back to the backup, is kept aside, and says it was damaged', () => {
  const lib = fresh();
  lib.save({ songs: [{ id: 'a' }] });
  lib.save({ songs: [{ id: 'a' }, { id: 'b' }] });
  fs.writeFileSync(lib.file, '{ half a fil');
  const got = lib.load();
  assert.deepEqual(got.songs, [{ id: 'a' }]);
  assert.equal(got.damaged, true);
  assert.ok(fs.readdirSync(lib.root).some((f) => f.startsWith('library.json.damaged-')), 'the unreadable file is kept');
  // Both unreadable: no songs, but still marked, so nothing is cleaned up.
  fs.writeFileSync(lib.file + '.bak', 'also broken');
  assert.deepEqual(lib.load(), { damaged: true });
});

test('cleaning the decoded audio keeps what is still used', () => {
  const lib = fresh();
  for (const [song, track] of [['s1', 't1'], ['s1', 't2'], ['s2', 't3']]) {
    fs.mkdirSync(path.join(lib.cacheDir, song), { recursive: true });
    fs.writeFileSync(path.join(lib.cacheDir, song, `${track}.r48000.pcm`), 'x');
  }
  lib.keepOnly(['s1'], ['t1']);
  assert.deepEqual(fs.readdirSync(lib.cacheDir), ['s1']);
  assert.deepEqual(fs.readdirSync(path.join(lib.cacheDir, 's1')), ['t1.r48000.pcm']);
});
