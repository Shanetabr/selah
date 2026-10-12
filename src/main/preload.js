'use strict';
const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('api', {
  platform: process.platform,
  loadLibrary: () => ipcRenderer.invoke('lib:load'),
  saveLibrary: (data) => ipcRenderer.invoke('lib:save', data),
  appInfo: () => ipcRenderer.invoke('app:info'),
  key: { state: () => ipcRenderer.invoke('key:state'), try: (key) => ipcRenderer.invoke('key:try', key) },
  openStemsFolder: () => ipcRenderer.invoke('shell:stems'),
  pickOpen: () => ipcRenderer.invoke('dialog:open'),
  pickStems: () => ipcRenderer.invoke('dialog:stems'),
  pickFolders: () => ipcRenderer.invoke('dialog:folders'),
  confirm: (opts) => ipcRenderer.invoke('dialog:confirm', opts),
  choose: (opts) => ipcRenderer.invoke('dialog:choose', opts),
  readCue: (file) => ipcRenderer.invoke('cue:read', file),
  voiceWords: () => ipcRenderer.invoke('voice:words'),
  clickSounds: () => ipcRenderer.invoke('click:sounds'),
  expandPaths: (paths) => ipcRenderer.invoke('fs:expand', paths),
  filesExist: (paths) => ipcRenderer.invoke('fs:exists', paths),
  pathForFile: (file) => webUtils.getPathForFile(file),
  cache: {
    check: (args) => ipcRenderer.invoke('cache:check', args),
    begin: (args) => ipcRenderer.invoke('cache:begin', args),
    append: (args) => ipcRenderer.invoke('cache:append', args),
    commit: (args) => ipcRenderer.invoke('cache:commit', args),
    removeSong: (songId) => ipcRenderer.invoke('cache:removeSong', songId),
    keepOnly: (ids, trackIds) => ipcRenderer.invoke('cache:keepOnly', ids, trackIds),
    removeTrack: (args) => ipcRenderer.invoke('cache:removeTrack', args),
  },
  engine: {
    send: (msg) => ipcRenderer.send('engine:send', msg),
    onEvent: (fn) => ipcRenderer.on('engine:event', (e, msg) => fn(msg)),
  },
  voice: {
    send: (msg) => ipcRenderer.send('voice:send', msg),
    onEvent: (fn) => ipcRenderer.on('voice:event', (e, msg) => fn(msg)),
    askMic: () => ipcRenderer.invoke('voice:mic'),
  },
  onMenu: (fn) => ipcRenderer.on('menu', (e, action) => fn(action)),
});
