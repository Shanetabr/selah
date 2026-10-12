'use strict';
const { app, BrowserWindow, ipcMain, dialog, Menu, protocol, net, utilityProcess, powerSaveBlocker, shell, systemPreferences } = require('electron');
const path = require('path');
const fs = require('fs');
const { pathToFileURL } = require('url');
const { Library, isAudioFile, AUDIO_EXT } = require('./library');
const cuefile = require('./cuefile');
const samples = require('../engine/samples');
const vault = require('../engine/vault');

const isDev = process.argv.includes('--dev');
const selfTest = process.argv.includes('--selftest');

// Keep our data out of the default "Electron" folder that every unpackaged
// Electron app shares, and off any synced Documents/Desktop folder.
// SELAH_DATA puts it somewhere else altogether, which is how a second
// self-test can run beside one that is already running: the data folder is
// also what stops two copies of the app from opening at once.
app.setPath('userData', process.env.SELAH_DATA || path.join(app.getPath('appData'), selfTest ? 'selah-selftest' : 'selah'));
// Avoids "Access denied" GPU cache errors on Windows.
app.commandLine.appendSwitch('disable-gpu-shader-disk-cache');
// A self-test must not come to the front of whatever the owner is doing.
if (selfTest && process.platform === 'darwin') app.setActivationPolicy('accessory');

const SRC = path.join(__dirname, '..');
const ORIGIN = 'app://selah';

protocol.registerSchemesAsPrivileged([{ scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } }]);

let win = null;
let engine = null;
let voice = null; // voice control's listener, once it has been asked for
let ewKey = null; // opens the owner's click, once the full key has been given (see key:try)
let library = null;
let quitting = false;
let sleepBlock = null;
let voiceWords = null; // what the guide's voice can say, listed on first use
const engineTaps = []; // extra listeners for engine messages (used by the self-test)

// The UI, the decoded-audio cache and the user's stem files are all served
// from one origin so the window can fetch large files as streams instead of
// receiving them over IPC.
function serve(request) {
  const url = new URL(request.url);
  const parts = decodeURIComponent(url.pathname).split('/').filter(Boolean);
  const area = parts.shift();
  let file = null;
  if (area === 'ui') file = path.join(SRC, 'renderer', ...parts);
  else if (area === 'shared') file = path.join(SRC, 'shared', ...parts);
  else if (area === 'cache') file = path.join(library.cacheDir, ...parts);
  else if (area === 'file') {
    const p = url.searchParams.get('p');
    if (p && path.isAbsolute(p) && isAudioFile(p)) return net.fetch(pathToFileURL(p).toString());
  }
  const roots = { ui: path.join(SRC, 'renderer'), shared: path.join(SRC, 'shared'), cache: library.cacheDir };
  if (!file || !path.resolve(file).startsWith(roots[area] + path.sep)) return new Response('Not found', { status: 404 });
  return net.fetch(pathToFileURL(file).toString());
}

function sendToWindow(channel, msg) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, msg);
}

function startEngine() {
  engine = utilityProcess.fork(path.join(SRC, 'engine', 'engine-process.js'), [], { serviceName: 'Selah audio engine' });
  engine.on('message', (msg) => {
    if (msg.type === 'state') setSleepBlock(msg.playing);
    sendToWindow('engine:event', msg);
    for (const fn of engineTaps) fn(msg);
  });
  engine.on('exit', () => {
    engine = null;
    if (quitting) return;
    // The engine should never die, but if it does, bring it back and let the
    // window reopen the output and reload the song.
    startEngine();
    if (ewKey) engine.postMessage({ cmd: 'setEw', key: ewKey });
    sendToWindow('engine:event', { type: 'engineRestarted' });
  });
}

// Voice control's listener (src/voice), started the first time the window
// has something for it. If it dies the window is told, and the next message
// starts it again.
function sendToVoice(msg) {
  if (!voice) {
    voice = utilityProcess.fork(path.join(SRC, 'voice', 'voice-process.js'), [], { serviceName: 'Selah voice control' });
    voice.on('message', (m) => sendToWindow('voice:event', m));
    voice.on('exit', () => {
      voice = null;
      if (!quitting) sendToWindow('voice:event', { type: 'stopped' });
    });
  }
  voice.postMessage(msg);
}

// Keep the machine awake while audio is running.
function setSleepBlock(on) {
  if (on && sleepBlock === null) sleepBlock = powerSaveBlocker.start('prevent-display-sleep');
  else if (!on && sleepBlock !== null) {
    powerSaveBlocker.stop(sleepBlock);
    sleepBlock = null;
  }
}

function createWindow() {
  win = new BrowserWindow({
    width: 1400,
    height: 860,
    minWidth: 980,
    minHeight: 560,
    backgroundColor: '#1f1f1f',
    show: false,
    // The self-test drives its window itself, and the owner goes on using the
    // Mac while it runs. When this window took the keyboard, a Space or an
    // Enter meant for another app started, paused or stopped playback in the
    // middle of a test. So in the self-test it cannot be focused, is shown
    // without being activated, and lets real clicks fall through.
    focusable: !selfTest,
    title: 'Selah BETA',
    icon: path.join(SRC, '..', 'assets', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      // Timers must keep running for the playhead when the window is behind others.
      backgroundThrottling: false,
    },
  });
  win.once('ready-to-show', () => {
    if (!selfTest) return win.show();
    win.showInactive();
    win.setIgnoreMouseEvents(true);
  });
  win.loadURL(ORIGIN + '/ui/index.html');
  if (isDev) win.webContents.openDevTools({ mode: 'detach' });
  win.on('closed', () => {
    win = null;
  });
}

function buildMenu() {
  const send = (action) => () => sendToWindow('menu', action);
  const template = [
    ...(process.platform === 'darwin' ? [{ role: 'appMenu' }] : []),
    {
      label: 'File',
      submenu: [
        { label: 'Open…', accelerator: 'CmdOrCtrl+O', click: send('open') },
        // Only macOS can offer files and folders in one dialog.
        ...(process.platform === 'darwin' ? [] : [{ label: 'Open Folder of Stems…', accelerator: 'CmdOrCtrl+Shift+O', click: send('newFromFolder') }]),
        { label: 'New Empty Song…', accelerator: 'CmdOrCtrl+N', click: send('newSong') },
        { label: 'New Sample Song', click: send('sampleSong') },
        { type: 'separator' },
        { label: 'Audio Settings…', accelerator: 'CmdOrCtrl+,', click: send('audioSettings') },
        { type: 'separator' },
        process.platform === 'darwin' ? { role: 'close' } : { role: 'quit' },
      ],
    },
    {
      label: 'Edit',
      submenu: [
        // The window decides: text being typed, or the last change to the song's sections.
        { label: 'Undo', accelerator: 'CmdOrCtrl+Z', click: send('undo') },
        { label: 'Redo', accelerator: 'Shift+CmdOrCtrl+Z', click: send('redo') },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' },
      ],
    },
    {
      label: 'View',
      submenu: [
        { label: 'Zoom In', accelerator: 'CmdOrCtrl+=', click: send('zoomIn') },
        { label: 'Zoom Out', accelerator: 'CmdOrCtrl+-', click: send('zoomOut') },
        { type: 'separator' },
        { role: 'togglefullscreen' },
        ...(isDev ? [{ type: 'separator' }, { role: 'reload' }, { role: 'toggleDevTools' }] : []),
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function registerIpc() {
  ipcMain.handle('lib:load', () => library.load());
  ipcMain.handle('lib:save', (e, data) => library.save(data));

  ipcMain.handle('dialog:stems', async () => {
    const res = await dialog.showOpenDialog(win, {
      title: 'Import stems',
      properties: ['openFile', 'multiSelections'],
      filters: [{ name: 'Audio', extensions: Array.from(AUDIO_EXT, (x) => x.slice(1)) }],
    });
    return res.canceled ? [] : res.filePaths;
  });

  // Everything Selah opens: stems, a folder of stems (a new song), cue clips.
  ipcMain.handle('dialog:open', async () => {
    const res = await dialog.showOpenDialog(win, {
      title: 'Open stems, a folder of stems, or a cue clip',
      properties: process.platform === 'darwin' ? ['openFile', 'openDirectory', 'multiSelections'] : ['openFile', 'multiSelections'],
      filters: [{ name: 'Stems and cue clips', extensions: [...Array.from(AUDIO_EXT, (x) => x.slice(1)), 'mid', 'midi'] }],
    });
    return res.canceled ? [] : res.filePaths;
  });

  // A question with more than one answer. Returns the button's index, or -1
  // for Cancel. The self-test takes the first answer.
  ipcMain.handle('dialog:choose', async (e, { message, detail, buttons }) => {
    if (selfTest) return 0;
    const res = await dialog.showMessageBox(win, { type: 'question', message, detail, buttons: [...buttons, 'Cancel'], defaultId: 0, cancelId: buttons.length });
    return res.response < buttons.length ? res.response : -1;
  });

  // The words the guide's voice has, for the window to offer as callouts.
  ipcMain.handle('voice:words', () => {
    voiceWords = voiceWords || samples.names();
    return Array.from(voiceWords);
  });

  // The click sounds there are to choose from: [{ id, name }].
  ipcMain.handle('click:sounds', () => samples.clickSets().map((s) => ({ id: s.id, name: s.name })));

  // A cue clip (MIDI) as a song draft; see cuefile.js.
  ipcMain.handle('cue:read', (e, file) => {
    voiceWords = voiceWords || samples.names();
    return cuefile.read(file, (w) => voiceWords.has(w));
  });

  ipcMain.handle('dialog:confirm', async (e, { message, detail, button }) => {
    if (selfTest) return true; // nobody is there to press the button
    const res = await dialog.showMessageBox(win, { type: 'warning', message, detail, buttons: [button || 'OK', 'Cancel'], defaultId: 1, cancelId: 1 });
    return res.response === 0;
  });

  // The version shown in the corner of the window. `build.json` is written by
  // scripts/build.js; running from source there is none.
  // Two keys (owner, 2026-10-12). Selah asks once on each computer and
  // remembers the answer in a file beside the library.
  //   the basic key   Selah without the owner's own click
  //   the full key    Selah with it: the click is sealed in
  //                   assets/clicks/ew.lock and only this key opens it
  // Neither key is written here. The basic one is known by its SHA-256. The
  // full one is known by nothing at all: it is the right key when it opens
  // the lock (vault.js), so reading this code, or the app, gives nobody the
  // click. The self-test is not asked and runs as with the basic key, unless
  // SELAH_KEY hands it one.
  const BASIC_HASH = '5aebbba217c97edc23929c6c3f81b203592a1928367dc189095006fd594ccd60';
  const sha = (text) => require('crypto').createHash('sha256').update(text).digest('hex');
  const unlockedFile = () => path.join(app.getPath('userData'), 'unlocked');
  const readLock = () => (fs.existsSync(samples.EW_LOCK) ? fs.readFileSync(samples.EW_LOCK) : null);
  // 'full', 'basic' or null for what was typed; `key` is the click's key in hex.
  const judge = (typed) => {
    const text = String(typed || '').trim();
    const lock = readLock();
    if (text && lock) {
      const key = vault.keyFrom(text, vault.saltOf(lock));
      if (vault.open(lock, key)) return { level: 'full', key: key.toString('hex') };
    }
    return sha(text) === BASIC_HASH ? { level: 'basic', proof: BASIC_HASH } : null;
  };
  // What this computer was unlocked with, checked again every time: a file
  // that only says so does not count.
  const remembered = () => {
    try {
      const saved = JSON.parse(fs.readFileSync(unlockedFile(), 'utf8'));
      const lock = readLock();
      if (saved.level === 'full' && lock && vault.open(lock, Buffer.from(saved.key, 'hex'))) return saved;
      if (saved.level === 'basic' && saved.proof === BASIC_HASH) return saved;
    } catch (err) {
      // No file, or not one of ours.
    }
    return null;
  };
  // Only when it changes: the engine loads every sound again for it, which
  // must not happen while a song plays.
  const apply = (got) => {
    const next = got && got.level === 'full' ? got.key : null;
    if (next !== ewKey) {
      ewKey = next;
      const lock = ewKey && readLock();
      samples.setEw(lock ? vault.open(lock, Buffer.from(ewKey, 'hex')) : null);
      if (engine) engine.postMessage({ cmd: 'setEw', key: ewKey });
    }
    return got ? got.level : null;
  };
  ipcMain.handle('key:state', () => apply(selfTest ? judge(process.env.SELAH_KEY) || { level: 'basic' } : remembered()));
  ipcMain.handle('key:try', (e, typed) => {
    const got = judge(typed);
    if (!got) return null;
    fs.writeFileSync(unlockedFile(), JSON.stringify(got) + '\n');
    return apply(got);
  });

  ipcMain.handle('app:info', () => {
    let build = null;
    try {
      build = JSON.parse(fs.readFileSync(path.join(SRC, '..', 'build.json'), 'utf8'));
    } catch (err) {
      // Not a packaged build.
    }
    return { version: app.getVersion(), build };
  });

  // The folder song stems are kept in, opened in Finder or Explorer so a song
  // can be dragged onto the window. Made on first use.
  ipcMain.handle('shell:stems', async () => {
    const dir = path.join(app.getPath('music'), 'Selah Stems');
    await fs.promises.mkdir(dir, { recursive: true });
    await shell.openPath(dir);
    return dir;
  });

  ipcMain.handle('dialog:folders', async () => {
    const res = await dialog.showOpenDialog(win, { title: 'Choose a folder of stems', properties: ['openDirectory', 'multiSelections'] });
    return res.canceled ? [] : res.filePaths;
  });

  // Sorts dropped or picked paths into folders of stems (each becomes a song,
  // with the cue clips found beside the stems), loose audio files and loose
  // cue clips. A folder of nothing but cue clips counts as loose clips.
  // Folders are read one level deep.
  ipcMain.handle('fs:expand', async (e, paths) => {
    const out = { folders: [], files: [], cues: [] };
    for (const p of paths) {
      try {
        const st = await fs.promises.stat(p);
        if (st.isDirectory()) {
          const names = (await fs.promises.readdir(p)).sort();
          const files = names.filter(isAudioFile).map((n) => path.join(p, n));
          const cues = names.filter(cuefile.isCueFile).map((n) => path.join(p, n));
          if (files.length) out.folders.push({ name: path.basename(p), files, cues });
          else out.cues.push(...cues);
        } else if (isAudioFile(p)) out.files.push(p);
        else if (cuefile.isCueFile(p)) out.cues.push(p);
      } catch (err) {
        // Unreadable entries are skipped.
      }
    }
    return out;
  });

  ipcMain.handle('fs:exists', async (e, paths) => paths.map((p) => fs.existsSync(p)));

  ipcMain.handle('cache:check', (e, { songId, tracks, rate }) => library.check(songId, tracks, rate));
  ipcMain.handle('cache:begin', (e, { songId, trackId, rate }) => library.begin(rate ? library.pcmPath(songId, trackId, rate) : library.peaksPath(songId, trackId)));
  ipcMain.handle('cache:append', (e, { songId, trackId, rate, chunk }) => library.append(rate ? library.pcmPath(songId, trackId, rate) : library.peaksPath(songId, trackId), chunk));
  ipcMain.handle('cache:commit', (e, { songId, trackId, rate }) => library.commit(rate ? library.pcmPath(songId, trackId, rate) : library.peaksPath(songId, trackId)));
  ipcMain.handle('cache:removeSong', (e, songId) => library.removeSong(songId));
  ipcMain.handle('cache:keepOnly', (e, ids, trackIds) => library.keepOnly(ids, trackIds));
  ipcMain.handle('cache:removeTrack', (e, { songId, trackId }) => library.removeTrack(songId, trackId));

  ipcMain.on('voice:send', (e, msg) => sendToVoice(msg));
  // macOS asks the owner once whether Selah may use the microphone.
  ipcMain.handle('voice:mic', async () => (process.platform === 'darwin' ? systemPreferences.askForMediaAccess('microphone') : true));

  ipcMain.on('engine:send', (e, msg) => {
    if (!engine) return;
    if (msg.cmd === 'loadSong') {
      // The window knows tracks by id; only this process knows where the cache is.
      for (const t of msg.tracks) t.path = library.pcmPath(msg.songId, t.id, msg.rate);
    }
    engine.postMessage(msg);
  });
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });

  app.whenReady().then(() => {
    library = new Library(app.getPath('userData'));
    if (selfTest) require('./selftest').clean(library);
    protocol.handle('app', serve);
    registerIpc();
    buildMenu();
    startEngine();
    createWindow();
    if (selfTest) require('./selftest').run({ app, getWindow: () => win, library, onEngine: (fn) => engineTaps.push(fn) });
  });

  app.on('window-all-closed', () => app.quit());
  app.on('before-quit', () => {
    quitting = true;
    if (engine) engine.kill();
    if (voice) voice.kill();
  });
}
