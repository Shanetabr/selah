// The microphone for voice control: opens an input and hands its sound on as
// 16 kHz mono, a tenth of a second at a time (see mic-worklet.js). What the
// sound means is decided elsewhere (src/voice).

export const MIC_RATE = 16000;

export class Mic {
  constructor(onSound) {
    this.onSound = onSound;
    this.stream = null;
    this.ctx = null;
  }

  // The inputs there are, as [{ id, label }]. Labels are empty until the
  // owner has allowed the microphone once.
  static async inputs() {
    const all = await navigator.mediaDevices.enumerateDevices();
    return all.filter((d) => d.kind === 'audioinput' && d.deviceId !== 'default' && d.deviceId !== 'communications').map((d) => ({ id: d.deviceId, label: d.label }));
  }

  // Echo cancelling is off: it is made for calls and would eat a voice that
  // sounds like what the speakers are playing.
  async start(deviceId) {
    this.stop();
    const audio = { channelCount: 1, echoCancellation: false, noiseSuppression: true, autoGainControl: true };
    if (deviceId) audio.deviceId = { exact: deviceId };
    this.stream = await navigator.mediaDevices.getUserMedia({ audio });
    this.ctx = new AudioContext({ sampleRate: MIC_RATE });
    await this.ctx.audioWorklet.addModule('mic-worklet.js');
    const node = new AudioWorkletNode(this.ctx, 'mic', { numberOfOutputs: 0 });
    node.port.onmessage = (e) => this.onSound(e.data);
    this.ctx.createMediaStreamSource(this.stream).connect(node);
    return this.stream.getAudioTracks()[0].label;
  }

  stop() {
    if (this.stream) for (const t of this.stream.getTracks()) t.stop();
    if (this.ctx) this.ctx.close();
    this.stream = null;
    this.ctx = null;
  }
}
