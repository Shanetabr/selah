'use strict';
// Packages a ready-to-run app into dist/.
//   node scripts/build.js win32    (run on Windows)
//   node scripts/build.js darwin   (run on a Mac)
// The native audio module is prebuilt per platform, so build each platform on
// that platform; cross-building would bundle the wrong binary.
const path = require('path');
const { packager } = require('@electron/packager');

const platform = process.argv[2] || process.platform;
const arch = process.argv[3] || process.arch;
const root = path.join(__dirname, '..');
// Windows uses assets/icon.ico, Mac assets/icon.icns. Without the file for
// this platform the app keeps the framework's default icon.
const iconFile = path.join(root, 'assets', platform === 'darwin' ? 'icon.icns' : 'icon.ico');

if (platform !== process.platform) {
  console.error(`This machine is ${process.platform}; build the ${platform} app on a ${platform} machine.`);
  process.exit(1);
}

// Stamp the build so the window can say exactly which one it is.
let commit = 'unknown';
try {
  commit = require('child_process').execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: root }).toString().trim();
} catch (err) {
  // Not a git checkout.
}
require('fs').writeFileSync(path.join(root, 'build.json'), JSON.stringify({ commit, date: new Date().toISOString().slice(0, 10) }));

packager({
  dir: root,
  out: path.join(root, 'dist'),
  name: 'Selah BETA',
  appBundleId: 'com.selah.app',
  icon: require('fs').existsSync(iconFile) ? iconFile : undefined,
  platform,
  arch,
  overwrite: true,
  prune: true,
  // Left unpacked so the native audio module and the engine script load
  // straight from disk.
  asar: false,
  // macOS shows this when voice control first asks for the microphone.
  extendInfo: { NSMicrophoneUsageDescription: 'Selah listens for section names when voice control is switched on. Nothing is recorded or sent anywhere.' },
  // .claude holds other working copies of the project (with their own
  // node_modules); none of it belongs in the app.
  ignore: [/^\/dist($|\/)/, /^\/test($|\/)/, /^\/docs($|\/)/, /^\/scripts($|\/)/, /^\/\.git($|\/)/, /^\/\.claude($|\/)/, /^\/[^/]+\.md$/, /^\/\.gitignore$/],
}).then(
  (paths) => {
    // An Apple Silicon Mac refuses an app whose bundle no longer matches its
    // signature, and packaging changes the bundle. Sign it again, ad hoc.
    if (platform === 'darwin') {
      for (const dir of paths) require('child_process').execFileSync('codesign', ['--force', '--deep', '--sign', '-', path.join(dir, 'Selah BETA.app')], { stdio: 'inherit' });
    }
    // The stamp belongs to the packaged copy; from source the window says so instead.
    require('fs').rmSync(path.join(root, 'build.json'), { force: true });
    console.log('Built: ' + paths.join(', '));
  },
  (err) => {
    console.error(err);
    process.exit(1);
  }
);
