'use strict';
// Entry point of the audio engine, run as an Electron utility process so UI
// work in the window can never stall audio.
const os = require('os');
const { Engine } = require('./engine');

try {
  os.setPriority(os.constants.priority.PRIORITY_HIGH);
} catch (err) {
  // Not allowed on every system; audio still works at normal priority.
}

const port = process.parentPort;
const engine = new Engine((msg) => port.postMessage(msg));

port.on('message', (e) => engine.handle(e.data));

process.on('uncaughtException', (err) => {
  port.postMessage({ type: 'error', cmd: 'engine', message: String((err && err.stack) || err) });
});
