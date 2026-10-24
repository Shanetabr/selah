'use strict';
// Keep PDF parsing off the UI and main processes, and reclaim all parser
// memory when a chart has been read.
process.once('message', async (file) => {
  try { process.send({ draft: await require('./chartfile').read(file) }); }
  catch (error) { process.send({ error: error.message || 'Could not read this chart.' }); }
});
