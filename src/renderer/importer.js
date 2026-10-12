// Turns a stem file into what the engine and the timeline need:
//   - raw int16 PCM at the output sample rate (played by the engine)
//   - min/max peaks for drawing the waveform
// Decoding uses Chromium's built-in decoder, which also resamples.

export const PEAKS_PER_SEC = 200;
const CHUNK = 8 * 1024 * 1024;

async function writeChunks(key, buffer) {
  await window.api.cache.begin(key);
  for (let off = 0; off < buffer.byteLength; off += CHUNK) {
    await window.api.cache.append(Object.assign({ chunk: buffer.slice(off, Math.min(buffer.byteLength, off + CHUNK)) }, key));
  }
  await window.api.cache.commit(key);
}

// Returns { channels, frames, peaks }.
export async function decodeToCache({ songId, trackId, file, rate }) {
  const res = await fetch('/file?p=' + encodeURIComponent(file));
  if (!res.ok) throw new Error('Cannot read file');
  const bytes = await res.arrayBuffer();
  const ctx = new OfflineAudioContext(2, 1, rate);
  let audio;
  try {
    audio = await ctx.decodeAudioData(bytes);
  } catch (err) {
    throw new Error('Not a supported audio file');
  }
  const frames = audio.length;
  const L = audio.getChannelData(0);
  const R = audio.numberOfChannels > 1 ? audio.getChannelData(1) : null;

  // Stems are often dual-mono; storing those as one channel halves the RAM.
  let mono = !R;
  if (R) {
    mono = true;
    for (let i = 0; i < frames; i++) {
      if (Math.abs(L[i] - R[i]) > 1e-4) {
        mono = false;
        break;
      }
    }
  }
  const channels = mono ? 1 : 2;

  const pcm = new Int16Array(frames * channels);
  const to16 = (v) => (v >= 1 ? 32767 : v <= -1 ? -32768 : Math.round(v * 32767));
  if (mono) for (let i = 0; i < frames; i++) pcm[i] = to16(L[i]);
  else {
    for (let i = 0; i < frames; i++) {
      pcm[i * 2] = to16(L[i]);
      pcm[i * 2 + 1] = to16(R[i]);
    }
  }

  const bucket = Math.round(rate / PEAKS_PER_SEC);
  const nb = Math.ceil(frames / bucket);
  const peaks = new Int8Array(nb * 2);
  for (let b = 0; b < nb; b++) {
    let lo = 0;
    let hi = 0;
    const end = Math.min(frames, (b + 1) * bucket);
    for (let i = b * bucket; i < end; i++) {
      const v = L[i];
      if (v < lo) lo = v;
      else if (v > hi) hi = v;
      if (!mono) {
        const w = R[i];
        if (w < lo) lo = w;
        else if (w > hi) hi = w;
      }
    }
    peaks[b * 2] = Math.max(-127, Math.round(lo * 127));
    peaks[b * 2 + 1] = Math.min(127, Math.round(hi * 127));
  }

  await writeChunks({ songId, trackId, rate }, pcm.buffer);
  await writeChunks({ songId, trackId, rate: 0 }, peaks.buffer);
  return { channels, frames, peaks };
}

export async function loadPeaks(songId, trackId) {
  try {
    const res = await fetch(`/cache/${songId}/${trackId}.peaks`);
    if (!res.ok) return null;
    return new Int8Array(await res.arrayBuffer());
  } catch (err) {
    return null;
  }
}

export async function loadPcm(songId, trackId, rate) {
  const res = await fetch(`/cache/${songId}/${trackId}.r${rate}.pcm`);
  if (!res.ok) throw new Error('Audio is not cached yet');
  return new Int16Array(await res.arrayBuffer());
}

// "01 - Click Track.wav" -> "Click Track"
export function trackNameFromFile(file) {
  const base = file.split(/[\\/]/).pop().replace(/\.[^.]+$/, '');
  return base.replace(/^\d+[\s._-]+/, '').trim() || base;
}

export function folderNameOf(file) {
  const parts = file.split(/[\\/]/);
  return parts.length > 1 ? parts[parts.length - 2] : '';
}

// Click and guide stems default to the in-ear bus.
export function guessBus(name) {
  return /\b(click|clk|metronome|guide|guia|cues?|count)\b/i.test(name.replace(/[_-]/g, ' ')) ? 'cue' : 'band';
}
