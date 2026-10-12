# The listening model

What Selah's voice control listens with: a small English keyword-spotting
model from the sherpa-onnx project (Apache-2.0),
`sherpa-onnx-kws-zipformer-gigaspeech-3.3M-2024-01-01`, from
https://github.com/k2-fsa/sherpa-onnx/releases/tag/kws-models

- `encoder.onnx`, `decoder.onnx`, `joiner.onnx`: the int8 files of that
  release, renamed.
- `tokens.txt`: the 500 sound pieces the model knows, as shipped.
- `pieces.json`: the same pieces with the scores from the release's
  `bpe.model`, which `src/voice/spell.js` uses to spell a word the way the
  model was trained to hear it.

It runs on this computer; nothing is sent anywhere.
