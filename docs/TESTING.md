# Testing and status

## Running the tests

```bash
npm test
```

```bash
npm run selftest
```

`npm test` runs the unit tests. With Ableton or another live rig running,
use `npm run selftest:no-audio`: it simulates four-channel and stereo outputs
without loading the audio driver or opening hardware.

`npm run selftest` drives the real app end to
end and plays quietly for about a minute; put `SELAH_SILENT=1` in front of it
to make no sound.

The code is under the MIT licence. The sounds in `assets/` are not: the guide
voice and the click sounds are there for Selah to play, not to be reused.

## What is done

Build-order steps 1 to 5:

1. **Audio engine.** Imports WAV, MP3, M4A, FLAC and OGG. All tracks play from
   one shared sample position, so they cannot drift. Volume, mute and solo per
   track.
2. **Song setup.** BPM and time signature per song, tempo detection, a
   generated click, real waveforms on a bar timeline, draggable section
   markers.
   Click-only songs with no stems. The click is either a generated beep or
   the sampled EW click on eighth notes. Spoken cues and count-ins are placed
   automatically from the section markers and follow live jumps.
3. **Output routing.** Two outputs, MAINS and EARS, each sent to any stereo pair or
   single output of the device. ASIO, WASAPI and DirectSound on Windows;
   CoreAudio on Mac.
4. **Section jumping.** Jumps land exactly on the next bar line with a short
   crossfade so the new downbeat is intact.
5. **Setlist.** A song library, multiple named setlists, reorder by dragging,
   all saved automatically. The next song in the setlist is preloaded so
   switching is immediate.

Around those: one **Open…** (and drop) for stems, folders of stems and the
Ableton cue clips, which become songs with their tempo and sections; EDIT and
LIVE modes; undo for a song's setup, removed tracks and deleted songs;
selecting several tracks to reorder, re-route or remove them; a right-click on
a section's pad to change, silence or delete it.

## How it was tested

- `npm test`: 123 unit tests (2026-11) on the mixer, cue placement, section editing,
  sample loading, tempo detection and the reading of cue clips, including a sweep of the click and the
  cues through every time signature from 1/4 to 12/8, and a comparison of
  4/4, 3/4 and 6/8 against the note times in the Ableton set (sample alignment across block sizes, mute/solo, bus routing,
  click placement, bar-line jumps, cue timing, count-in, cues across a jump).
- `npm run selftest`: starts the real app, generates stems, imports them, plays
  them quietly on the real output and checks up to 89 things end to end,
  including mouse input on the timeline, a click-only song with its count-in,
  opening cue clips, replacing and skipping duplicates, callouts, the hand-over
  from song to song, selecting and removing tracks, the pad menu, and
  switching to a stereo-only device. `SELAH_SILENT=1 npm run selftest`
  runs the same checks while sending silence to the device. On Windows it was
  also run against the packaged build, and with a 14-stem, 5-minute song plus
  an MP3. The test window cannot take the keyboard or the mouse, so the
  computer can be used while it runs. Before 2026-10-05 it could, and a key
  pressed for another app now and then started or stopped playback mid-test
  and failed the run. Keep the lid open, though: a Mac with its lid shut
  stops taking audio, the test's playback stands still, and the test says so.

Not tested, so check these yourself:

- **By ear.** The tests measure signal levels and positions. The owner has
  listened to the click and the guide voice and steered them; the automated
  runs themselves are done with the output silenced.
- **Mac.** Runs from source on an Apple Silicon Mac: the unit tests and the
  self-test pass through CoreAudio on the built-in speakers, and the packaged
  `Selah BETA.app` passes the same self-test. No interface with more than two
  outputs has been tried, and the packaged app has not been opened on a second
  Mac.
- **ASIO and a real multi-output interface.** This PC has no ASIO driver.
  Routing was verified on a headset that reports 8 channels over WASAPI.
- **A full-length service** on the machine and interface you will use.
- **A few gestures by hand.** Dragging files onto the window, the Open
  dialog, dragging tracks to reorder them and right-clicking a pad are checked
  by the self-test through the same code, with made-up mouse events. The 11
  cue clips on the owner's Desktop were read with the app's own reader and
  compared word by word (847 of 876 identical with callouts); the owner
  dropped them in himself.
