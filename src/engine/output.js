'use strict';

// Output backends. Both pull audio by calling `render(float32, frames)` and
// report each block as it reaches the device through `onBlock(meta)`, where
// `meta` is whatever render() returned for that block.

let audify = null;
let audifyError = null;
try {
  audify = require('audify');
} catch (err) {
  audifyError = err;
}

const FLOAT32 = 0x10; // RtAudioFormat.RTAUDIO_FLOAT32
const MAX_CHANNELS = 64;

// Devices Selah must never send audio to (owner's instruction, 2026-10-04),
// matched against the device name. They are not listed, cannot be opened even
// if saved in settings, and are never used as a fallback.
const BLOCKED_DEVICES = [/volt/i, /midi/i];
const allowed = (d) => d.outputChannels > 0 && !BLOCKED_DEVICES.some((re) => re.test(d.name));

// The RtAudio backends worth offering on each platform, best first.
function platformApis() {
  if (!audify) return [];
  const A = audify.RtAudioApi;
  if (process.platform === 'win32') {
    return [
      { id: 'asio', api: A.WINDOWS_ASIO, name: 'ASIO' },
      { id: 'wasapi', api: A.WINDOWS_WASAPI, name: 'WASAPI' },
      { id: 'ds', api: A.WINDOWS_DS, name: 'DirectSound' },
    ];
  }
  if (process.platform === 'darwin') return [{ id: 'core', api: A.MACOSX_CORE, name: 'CoreAudio' }];
  return [
    { id: 'pulse', api: A.LINUX_PULSE, name: 'PulseAudio' },
    { id: 'alsa', api: A.LINUX_ALSA, name: 'ALSA' },
    { id: 'jack', api: A.UNIX_JACK, name: 'JACK' },
  ];
}

function listDevices() {
  const apis = [];
  for (const a of platformApis()) {
    let devices = [];
    try {
      const rt = new audify.RtAudio(a.api);
      devices = rt
        .getDevices()
        .filter(allowed)
        .map((d) => ({
          id: d.id,
          name: d.name,
          channels: d.outputChannels,
          isDefault: !!d.isDefaultOutput,
          preferredRate: d.preferredSampleRate,
          rates: d.sampleRates || [],
        }));
    } catch (err) {
      devices = [];
    }
    apis.push({ id: a.id, name: a.name, devices });
  }
  return { apis, error: audifyError ? String(audifyError.message || audifyError) : null };
}

class RtOutput {
  // opts: { apiId, deviceName, sampleRate, frameSize, queueBlocks, render, onBlock, onError }
  constructor(opts) {
    this.opts = opts;
    this.rt = null;
    this.queued = 0;
    this.metas = [];
    this.timer = null;
    this.closed = false;
    this.dropouts = 0;
    this.lastPump = 0;
    this.frozen = false; // self-test only, see freeze()
  }

  open() {
    const o = this.opts;
    const entry = platformApis().find((a) => a.id === o.apiId);
    if (!entry) throw new Error('Audio backend not available: ' + o.apiId);
    const rt = new audify.RtAudio(entry.api);
    const devices = rt.getDevices().filter(allowed);
    // Device ids change between runs, so devices are remembered by name.
    const dev = (o.deviceName && devices.find((d) => d.name === o.deviceName)) || devices.find((d) => d.isDefaultOutput) || devices[0];
    if (!dev) throw new Error('No output device found for ' + entry.name);
    if (o.deviceName && dev.name !== o.deviceName) this.fellBack = true;

    this.channels = Math.min(dev.outputChannels, MAX_CHANNELS);
    this.sampleRate = o.sampleRate;
    if (dev.sampleRates && dev.sampleRates.length && !dev.sampleRates.includes(o.sampleRate)) {
      throw new Error(`${dev.name} does not support ${o.sampleRate} Hz`);
    }
    this.frameSize = rt.openStream(
      { deviceId: dev.id, nChannels: this.channels, firstChannel: 0 },
      null,
      FLOAT32,
      o.sampleRate,
      o.frameSize,
      'Selah',
      null,
      () => this._played(),
      0,
      (type, msg) => {
        // Types 0 and 1 are warnings.
        if (type > 1 && !this.closed && o.onError) o.onError(msg);
      }
    );
    this.rt = rt;
    this.apiName = entry.name;
    this.apiId = entry.id;
    this.deviceName = dev.name;
    this.block = new Float32Array(this.frameSize * this.channels);
    this.bytes = Buffer.from(this.block.buffer);
    this.queueMs = ((o.queueBlocks * this.frameSize) / o.sampleRate) * 1000;
    try {
      this.latencyFrames = rt.getStreamLatency();
    } catch (err) {
      this.latencyFrames = 0;
    }
    return this;
  }

  start() {
    this._pump();
    this.rt.start();
    this.startedAt = Date.now();
    // Starting a CoreAudio device can block longer than the queue covers;
    // that is not a dropout, so the gap is measured from here.
    this.lastPump = this.startedAt;
    // Safety net in case a device callback notification is lost.
    this.timer = setInterval(() => this._pump(), 10);
  }

  _pump() {
    if (this.closed) return;
    const now = Date.now();
    if (this.lastPump && now - this.lastPump > this.queueMs) this.dropouts++;
    this.lastPump = now;
    try {
      while (this.queued < this.opts.queueBlocks) {
        const meta = this.opts.render(this.block, this.frameSize);
        this.rt.write(this.bytes); // copies, so the block is reused
        this.metas.push(meta);
        this.queued++;
      }
    } catch (err) {
      // The stream is gone (device unplugged). Stop feeding it and report once.
      this.closed = true;
      clearInterval(this.timer);
      if (this.opts.onError) this.opts.onError(String((err && err.message) || err));
    }
  }

  _played() {
    if (this.closed || this.frozen) return;
    this.queued--;
    const meta = this.metas.shift();
    this._pump();
    if (this.opts.onBlock) this.opts.onBlock(meta);
  }

  // For the self-test: behave as a device that has stopped asking for audio,
  // and come back. That is what a Mac does when its lid is shut: the stream
  // still counts as running, nothing is rendered and the song stands still.
  freeze(on) {
    this.frozen = !!on;
    if (on) return;
    this.queued = 0;
    this.metas.length = 0;
    this._pump();
  }

  // Times this process went longer between refills than the queue can cover,
  // which is when the device runs dry and the room hears a gap.
  underruns() {
    return this.dropouts;
  }

  // Seconds of audio rendered but not yet handed to the device.
  queuedSeconds() {
    return (this.queued * this.frameSize) / this.sampleRate;
  }

  close() {
    this.closed = true;
    if (this.timer) clearInterval(this.timer);
    if (!this.rt) return;
    try {
      if (this.rt.isStreamRunning()) this.rt.stop();
    } catch (err) {}
    try {
      if (this.rt.isStreamOpen()) this.rt.closeStream();
    } catch (err) {}
    this.rt = null;
  }
}

// Consumes audio in real time without a device, so the app still runs on a
// machine with no sound hardware.
class NullOutput {
  constructor(opts) {
    this.opts = opts;
    this.channels = 2;
    this.sampleRate = opts.sampleRate;
    this.frameSize = opts.frameSize;
    this.apiName = 'None';
    this.apiId = 'none';
    this.deviceName = 'No audio device';
    this.latencyFrames = 0;
    this.closed = false;
  }

  open() {
    this.block = new Float32Array(this.frameSize * this.channels);
    return this;
  }

  start() {
    const t0 = Date.now();
    let done = 0;
    this.timer = setInterval(() => {
      const due = Math.floor((((Date.now() - t0) / 1000) * this.sampleRate) / this.frameSize);
      // After a long stall, skip ahead rather than rendering a burst.
      if (due - done > 50) done = due - 1;
      while (done < due && !this.closed) {
        const meta = this.opts.render(this.block, this.frameSize);
        done++;
        if (this.opts.onBlock) this.opts.onBlock(meta);
      }
    }, 5);
  }

  freeze() {}

  underruns() {
    return 0;
  }

  queuedSeconds() {
    return 0;
  }

  close() {
    this.closed = true;
    if (this.timer) clearInterval(this.timer);
  }
}

module.exports = { listDevices, RtOutput, NullOutput, available: () => !!audify };
