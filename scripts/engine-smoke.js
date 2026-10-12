'use strict';
// Plays a few seconds of quiet test tones through the real default output and
// checks that the engine keeps time and does not underrun.
//   node scripts/engine-smoke.js [apiId] [deviceName]
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Engine } = require('../src/engine/engine');

const RATE = 48000;
const SECONDS = 20;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'selah-smoke-'));

function tone(file, freq, level) {
  const data = new Int16Array(RATE * SECONDS * 2);
  for (let i = 0; i < RATE * SECONDS; i++) {
    const v = Math.round(Math.sin((2 * Math.PI * freq * i) / RATE) * level * 32767);
    data[i * 2] = v;
    data[i * 2 + 1] = v;
  }
  fs.writeFileSync(file, Buffer.from(data.buffer));
}

const tracks = [220, 330, 440, 550].map((f, i) => {
  const file = path.join(dir, `t${i}.pcm`);
  tone(file, f, 0.02);
  return { id: 't' + i, path: file, channels: 2, frames: RATE * SECONDS, gain: 1, mute: false, solo: false, bus: i === 0 ? 'cue' : 'band' };
});

const seen = { states: [], events: [] };
const engine = new Engine((msg) => {
  if (msg.type === 'state') seen.states.push(msg);
  else {
    seen.events.push(msg);
    if (msg.type !== 'devices') console.log(JSON.stringify(msg));
  }
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  await engine.handle({ cmd: 'getDevices' });
  const devs = seen.events.find((e) => e.type === 'devices');
  for (const a of devs.apis) console.log(a.name + ':', a.devices.map((d) => `${d.name} (${d.channels}ch${d.isDefault ? ', default' : ''})`).join('; ') || 'no devices');

  const apiId = process.argv[2] || (process.platform === 'win32' ? 'wasapi' : process.platform === 'darwin' ? 'core' : 'pulse');
  await engine.handle({ cmd: 'openOutput', apiId, deviceName: process.argv[3], sampleRate: RATE, frameSize: 512, queueBlocks: 4 });
  await engine.handle({ cmd: 'setBuses', buses: { band: { mode: 'stereo', ch: 0, gain: 1 }, cue: { mode: 'stereo', ch: 0, gain: 1 } } });
  await engine.handle({
    cmd: 'loadSong',
    songId: 'smoke',
    key: 'k1',
    grid: { bpm: 120, num: 4, den: 4, beatUnit: 'auto', offset: 0 },
    click: { enabled: true, gain: 0.05, bus: 'cue' },
    tracks,
  });

  await engine.handle({ cmd: 'play' });
  const t0 = Date.now();
  await sleep(3000);
  const mid = seen.states[seen.states.length - 1];
  const elapsed = (Date.now() - t0) / 1000;
  console.log(`after ${elapsed.toFixed(2)}s wall clock the playhead is at ${mid.pos.toFixed(2)}s, underruns ${mid.underruns}`);

  await engine.handle({ cmd: 'jumpToBar', bar: 6 }); // bar 6 starts at 12 s
  await sleep(2500);
  const after = seen.states[seen.states.length - 1];
  console.log(`after the bar jump the playhead is at ${after.pos.toFixed(2)}s, underruns ${after.underruns}`);

  await engine.handle({ cmd: 'stop' });
  await sleep(200);
  const end = seen.states[seen.states.length - 1];
  console.log(`after stop: playing=${end.playing} pos=${end.pos.toFixed(2)}`);

  const drift = Math.abs(mid.pos - elapsed);
  const ok = drift < 0.25 && after.pos > 12 && after.pos < 15.5 && end.pos === 0 && !end.playing && after.underruns === 0;
  console.log(ok ? 'SMOKE OK' : 'SMOKE FAILED');
  engine.close();
  fs.rmSync(dir, { recursive: true, force: true });
  process.exit(ok ? 0 : 1);
})();
