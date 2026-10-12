'use strict';
// Entry point of voice control's listener, run as an Electron utility process
// so that recognising speech can never hold up the window or the audio. The
// window owns the microphone and sends the sound here; this sends back the
// section names it hears.
const { Spotter } = require('./spotter');

const port = process.parentPort;
let spotter = null;

port.on('message', (e) => {
  const msg = e.data;
  try {
    if (msg.cmd === 'names') {
      if (!spotter) spotter = new Spotter();
      const skipped = spotter.setNames(msg.names);
      port.postMessage({ type: 'listening', names: spotter.names, skipped });
    } else if (msg.cmd === 'audio' && spotter) {
      for (const name of spotter.feed(msg.samples)) port.postMessage({ type: 'heard', name });
    }
  } catch (err) {
    port.postMessage({ type: 'error', message: String((err && err.message) || err) });
  }
});

process.on('uncaughtException', (err) => {
  port.postMessage({ type: 'error', message: String((err && err.stack) || err) });
});
