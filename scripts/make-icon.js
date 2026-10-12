'use strict';
// Renders assets/icon.svg into assets/icon.png (512 px) and assets/icon.ico.
//   npx electron scripts/make-icon.js
// Run again whenever icon.svg changes. The Mac .icns has to be made on a Mac
// from icon.png.
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');

const assets = path.join(__dirname, '..', 'assets');
const SIZES = [256, 128, 64, 48, 32, 24, 16];

// An .ico is a small directory followed by one PNG per size.
function buildIco(images) {
  const header = Buffer.alloc(6 + images.length * 16);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(images.length, 4);
  let offset = header.length;
  images.forEach((img, i) => {
    const at = 6 + i * 16;
    header.writeUInt8(img.size === 256 ? 0 : img.size, at);
    header.writeUInt8(img.size === 256 ? 0 : img.size, at + 1);
    header.writeUInt16LE(1, at + 4);
    header.writeUInt16LE(32, at + 6);
    header.writeUInt32LE(img.png.length, at + 8);
    header.writeUInt32LE(offset, at + 12);
    offset += img.png.length;
  });
  return Buffer.concat([header, ...images.map((i) => i.png)]);
}

app.disableHardwareAcceleration();
app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 512, height: 512, show: false, frame: false, transparent: true, useContentSize: true, webPreferences: { offscreen: true } });
  const svg = fs.readFileSync(path.join(assets, 'icon.svg'), 'utf8');
  const html = `<body style="margin:0;background:transparent;overflow:hidden"><img width="512" height="512" src="data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}"></body>`;
  await win.loadURL('data:text/html;base64,' + Buffer.from(html).toString('base64'));
  await new Promise((r) => setTimeout(r, 300));
  const full = (await win.webContents.capturePage()).resize({ width: 512, height: 512, quality: 'best' });
  fs.writeFileSync(path.join(assets, 'icon.png'), full.toPNG());
  const images = SIZES.map((size) => ({ size, png: full.resize({ width: size, height: size, quality: 'best' }).toPNG() }));
  fs.writeFileSync(path.join(assets, 'icon.ico'), buildIco(images));
  console.log('Wrote icon.png and icon.ico (' + SIZES.join(', ') + ' px)');
  app.exit(0);
});
