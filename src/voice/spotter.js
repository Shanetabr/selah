'use strict';
// Listens for a list of phrases in a stream of sound, with the sherpa-onnx
// keyword spotter and the model in assets/voice. No microphone here: whoever
// owns one feeds it 16 kHz mono samples. Runs in the voice process, and in
// the unit tests on the guide's own recordings.

const fs = require('fs');
const os = require('os');
const path = require('path');
const sherpa = require('sherpa-onnx-node');
const Spell = require('./spell');

const RATE = 16000;
const MODEL = path.join(__dirname, '..', '..', 'assets', 'voice');

class Spotter {
  constructor() {
    this.scores = JSON.parse(fs.readFileSync(path.join(MODEL, 'pieces.json'), 'utf8'));
    this.kws = null;
    this.stream = null;
    this.names = [];
    // How sure the model has to be (0 to 1) and how much a listed phrase is
    // favoured. The model's own defaults; to be tuned in the room.
    this.threshold = 0.25;
    this.boost = 1;
  }

  // What to listen for: section names. Returns the ones it cannot listen for.
  setNames(names) {
    const { list, skipped } = Spell.phrases(this.scores, names);
    this.names = list.map((p) => p.name);
    this.kws = null;
    this.stream = null;
    if (!list.length) return skipped;
    // The spotter reads its phrases from a file: one per line, in pieces,
    // with "@n" naming what to report when it is heard.
    const file = path.join(os.tmpdir(), `selah-voice-${process.pid}.txt`);
    fs.writeFileSync(file, list.map((p, i) => `${p.pieces} @${i}`).join('\n') + '\n');
    this.kws = new sherpa.KeywordSpotter({
      featConfig: { sampleRate: RATE, featureDim: 80 },
      modelConfig: {
        transducer: { encoder: path.join(MODEL, 'encoder.onnx'), decoder: path.join(MODEL, 'decoder.onnx'), joiner: path.join(MODEL, 'joiner.onnx') },
        tokens: path.join(MODEL, 'tokens.txt'),
        numThreads: 1,
        provider: 'cpu',
        debug: 0,
      },
      keywordsFile: file,
      keywordsThreshold: this.threshold,
      keywordsScore: this.boost,
    });
    this.stream = this.kws.createStream();
    fs.rmSync(file, { force: true });
    return skipped;
  }

  // Takes the next stretch of sound (Float32Array, 16 kHz mono) and returns
  // the names heard in it, usually none.
  feed(samples) {
    const heard = [];
    if (!this.kws) return heard;
    this.stream.acceptWaveform({ sampleRate: RATE, samples });
    while (this.kws.isReady(this.stream)) {
      this.kws.decode(this.stream);
      const word = this.kws.getResult(this.stream).keyword;
      if (!word) continue;
      // A new stream after each word: one that was only reset missed the
      // next word about every other time.
      this.stream = this.kws.createStream();
      const name = this.names[Number(word)];
      if (name !== undefined) heard.push(name);
    }
    return heard;
  }
}

module.exports = { Spotter, RATE };
