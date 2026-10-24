'use strict';
const fs = require('fs');
const path = require('path');

// Everything the user sets up lives in one small JSON file; decoded audio
// lives beside it in cache/ and can always be rebuilt from the original stems.
//
//   <userData>/library.json
//   <userData>/cache/<songId>/<trackId>.r<rate>.pcm   raw int16 LE, interleaved
//   <userData>/cache/<songId>/<trackId>.peaks         int8 min/max pairs for drawing

// Formats Chromium's decoder reads. AIFF is not one of them.
const AUDIO_EXT = new Set(['.wav', '.wave', '.mp3', '.m4a', '.aac', '.flac', '.ogg', '.oga']);
const ID = /^[A-Za-z0-9_-]+$/;

class Library {
  constructor(root) {
    this.root = root;
    this.file = path.join(root, 'library.json');
    this.cacheDir = path.join(root, 'cache');
    fs.mkdirSync(this.cacheDir, { recursive: true });
    this.writing = new Map(); // temp path -> file handle of a cache file being written
  }

  // The library, or null when there is none yet. A file that is there but
  // cannot be read is copied aside first, so the next save cannot bury it,
  // and `damaged` tells the window not to clean up any decoded audio.
  load() {
    let damaged = false;
    for (const f of [this.file, this.file + '.bak']) {
      if (!fs.existsSync(f)) continue;
      try {
        const lib = JSON.parse(fs.readFileSync(f, 'utf8'));
        if (damaged) lib.damaged = true;
        return lib;
      } catch (err) {
        damaged = true;
        try {
          fs.copyFileSync(f, `${f}.damaged-${Date.now()}`);
        } catch (e) {
          // Keep going: the backup may still be readable.
        }
      }
    }
    return damaged ? { damaged: true } : null;
  }

  // Write to a temp file and rename, so a crash mid-save cannot leave a
  // half-written library. The previous version is kept as .bak.
  save(data) {
    const tmp = this.file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(data, null, 1));
    try {
      fs.copyFileSync(this.file, this.file + '.bak');
    } catch (err) {
      // First save: nothing to back up.
    }
    fs.renameSync(tmp, this.file);
  }

  // Removes the decoded audio of every song not in `ids` and, in the songs
  // that stay, of every track not in `trackIds`. Run at startup: a deleted
  // song or a removed track keeps its cache until then, so both can be undone.
  keepOnly(ids, trackIds) {
    const keep = new Set(ids);
    const tracks = new Set(trackIds);
    for (const name of fs.readdirSync(this.cacheDir)) {
      if (!ID.test(name)) continue;
      const dir = path.join(this.cacheDir, name);
      if (!keep.has(name)) fs.rmSync(dir, { recursive: true, force: true });
      else if (trackIds && fs.statSync(dir).isDirectory()) {
        // Cache files are named <trackId>.<something>.
        for (const f of fs.readdirSync(dir)) if (!tracks.has(f.split('.')[0])) fs.rmSync(path.join(dir, f), { force: true });
      }
    }
  }

  pcmPath(songId, trackId, rate) {
    if (!ID.test(songId) || !ID.test(trackId) || !Number.isInteger(rate)) throw new Error('Bad cache id');
    return path.join(this.cacheDir, songId, `${trackId}.r${rate}.pcm`);
  }

  peaksPath(songId, trackId) {
    if (!ID.test(songId) || !ID.test(trackId)) throw new Error('Bad cache id');
    return path.join(this.cacheDir, songId, `${trackId}.peaks`);
  }

  // Which tracks have decoded audio at this rate: { trackId: frames | 0 }
  check(songId, tracks, rate) {
    const out = {};
    for (const t of tracks) {
      try {
        out[t.id] = fs.statSync(this.pcmPath(songId, t.id, rate)).size / 2 / t.channels;
      } catch (err) {
        out[t.id] = 0;
      }
    }
    return out;
  }

  // Cache files arrive in chunks: begin, append..., commit.
  async begin(file) {
    await fs.promises.mkdir(path.dirname(file), { recursive: true });
    const tmp = file + '.part';
    this.writing.set(file, await fs.promises.open(tmp, 'w'));
  }

  async append(file, chunk) {
    const fh = this.writing.get(file);
    if (!fh) throw new Error('Cache write was not started');
    await fh.write(Buffer.from(chunk));
  }

  async commit(file) {
    const fh = this.writing.get(file);
    if (!fh) throw new Error('Cache write was not started');
    this.writing.delete(file);
    await fh.close();
    await fs.promises.rename(file + '.part', file);
  }

  async removeSong(songId) {
    if (!ID.test(songId)) throw new Error('Bad cache id');
    await fs.promises.rm(path.join(this.cacheDir, songId), { recursive: true, force: true });
  }

  async removeTrack(songId, trackId) {
    if (!ID.test(songId) || !ID.test(trackId)) throw new Error('Bad cache id');
    const dir = path.join(this.cacheDir, songId);
    let names = [];
    try {
      names = await fs.promises.readdir(dir);
    } catch (err) {
      return;
    }
    for (const n of names) if (n.startsWith(trackId + '.')) await fs.promises.rm(path.join(dir, n), { force: true });
  }
}

function isAudioFile(file) {
  return AUDIO_EXT.has(path.extname(file).toLowerCase());
}

module.exports = { Library, isAudioFile, AUDIO_EXT };
