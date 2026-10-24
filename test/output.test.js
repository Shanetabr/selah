'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

// Exercise discovery and stream selection without opening hardware in unit tests.
function backend(devices, noAudio = false) {
  const opened = [];
  class RtAudio {
    getDevices() { return devices; }
    openStream(output, input, format, rate, frames) {
      opened.push(output);
      return frames;
    }
    getStreamLatency() { return 0; }
  }
  const context = {
    module: { exports: {} },
    require: (name) => {
      assert.ok(!noAudio, 'hardware-free tests must not load the native audio module');
      assert.strictEqual(name, 'audify');
      return { RtAudio, RtAudioApi: { MACOSX_CORE: 5 } };
    },
    process: { platform: 'darwin', env: noAudio ? { SELAH_TEST_OUTPUT: '1' } : {} },
    Buffer,
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../src/engine/output.js'), 'utf8'), context);
  return { ...context.module.exports, opened };
}

const volt = { id: 129, name: 'Universal Audio: Volt 4', outputChannels: 4, sampleRates: [44100, 48000], preferredSampleRate: 48000 };
const speakers = { id: 132, name: 'MacBook Pro Speakers', outputChannels: 2, isDefaultOutput: true };
const opts = { apiId: 'core', sampleRate: 48000, frameSize: 512, queueBlocks: 4 };

test('discovery includes Volt audio outputs and excludes MIDI-only and input-only devices', () => {
  const output = backend([speakers, volt,
    { id: 133, name: 'USB MIDI Audio', outputChannels: 2 },
    { id: 134, name: 'Volt 4 MIDI', outputChannels: 0 },
    { id: 135, name: 'Microphone', inputChannels: 1, outputChannels: 0 },
  ]);
  const devices = output.listDevices().apis[0].devices;
  assert.strictEqual(devices.map((d) => d.name).join('|'), 'MacBook Pro Speakers|Universal Audio: Volt 4|USB MIDI Audio');
  assert.strictEqual(devices[1].channels, 4);
});

test('a saved Volt selection opens all four outputs instead of falling back to speakers', () => {
  const output = backend([speakers, volt]);
  const stream = new output.RtOutput({ ...opts, deviceName: volt.name }).open();
  assert.strictEqual(stream.deviceName, volt.name);
  assert.strictEqual(stream.channels, 4);
  assert.ok(!stream.fellBack);
  assert.strictEqual(output.opened[0].deviceId, volt.id);
  assert.strictEqual(output.opened[0].nChannels, 4);
});

test('the Volt can be used as the default audio output', () => {
  const output = backend([{ ...speakers, isDefaultOutput: false }, { ...volt, isDefaultOutput: true }]);
  const stream = new output.RtOutput(opts).open();
  assert.strictEqual(stream.deviceName, volt.name);
});

test('an unavailable saved device still falls back and reports the change', () => {
  const output = backend([speakers]);
  const stream = new output.RtOutput({ ...opts, deviceName: volt.name }).open();
  assert.strictEqual(stream.deviceName, speakers.name);
  assert.strictEqual(stream.fellBack, true);
});

test('hardware-free app tests use simulated four-channel and stereo outputs without loading audify', () => {
  const output = backend([], true);
  assert.strictEqual(output.listDevices().apis[0].id, 'test');
  for (const [deviceName, channels] of [['Test four outputs', 4], ['Test stereo', 2]]) {
    const stream = new output.RtOutput({ ...opts, apiId: 'test', deviceName, render: () => null }).open();
    assert.strictEqual(stream.channels, channels);
    assert.strictEqual(stream.block.length, channels * opts.frameSize);
    assert.ok(stream instanceof output.NullOutput);
  }
  assert.strictEqual(output.opened.length, 0);
});
