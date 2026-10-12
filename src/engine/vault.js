'use strict';
// Files locked with a key: sealed with AES-256-GCM under a key made from a
// passphrase with scrypt. What is on disk is noise without the passphrase;
// nothing here or anywhere else in the project holds it. Used for the owner's
// own click sound, which only people he gives the full key to may have.
//
//   "SELAHV1" | salt (16) | iv (12) | tag (16) | sealed bytes
//   opened:   for each file: name length (2), name, data length (4), data

const crypto = require('crypto');

const MAGIC = Buffer.from('SELAHV1');
// Slow on purpose: each guess at the passphrase costs this much work.
const SCRYPT = { N: 1 << 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

function keyFrom(passphrase, salt) {
  return crypto.scryptSync(String(passphrase), salt, 32, SCRYPT);
}

function saltOf(vault) {
  return vault.subarray(MAGIC.length, MAGIC.length + 16);
}

// files: { name: Buffer }
function seal(files, passphrase) {
  const parts = [];
  for (const [name, data] of Object.entries(files)) {
    const n = Buffer.from(name, 'utf8');
    const head = Buffer.alloc(6 + n.length);
    head.writeUInt16LE(n.length, 0);
    n.copy(head, 2);
    head.writeUInt32LE(data.length, 2 + n.length);
    parts.push(head, data);
  }
  const salt = crypto.randomBytes(16);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', keyFrom(passphrase, salt), iv);
  const sealed = Buffer.concat([cipher.update(Buffer.concat(parts)), cipher.final()]);
  return Buffer.concat([MAGIC, salt, iv, cipher.getAuthTag(), sealed]);
}

// The files, or null when `key` (from keyFrom) is not the right one.
function open(vault, key) {
  try {
    if (!vault.subarray(0, MAGIC.length).equals(MAGIC)) return null;
    let p = MAGIC.length + 16;
    const iv = vault.subarray(p, (p += 12));
    const tag = vault.subarray(p, (p += 16));
    const d = crypto.createDecipheriv('aes-256-gcm', key, iv);
    d.setAuthTag(tag);
    const plain = Buffer.concat([d.update(vault.subarray(p)), d.final()]);
    const files = {};
    for (let q = 0; q < plain.length; ) {
      const n = plain.readUInt16LE(q);
      const name = plain.toString('utf8', q + 2, q + 2 + n);
      const len = plain.readUInt32LE(q + 2 + n);
      q += 6 + n;
      files[name] = plain.subarray(q, q + len);
      q += len;
    }
    return files;
  } catch (err) {
    return null;
  }
}

module.exports = { keyFrom, saltOf, seal, open };
