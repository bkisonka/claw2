/**
 * WAV ↔ PCM helpers for SIP (G.711 path expects 16-bit LE mono @ 8 kHz).
 */

export const SIP_PCM_RATE = 8000;

/** Parse WAV (PCM) → { pcm, sampleRate, channels }. */
export function parseWavPcm(buf: Buffer): { pcm: Buffer; sampleRate: number; channels: number } {
  if (buf.length < 44 || buf.toString("ascii", 0, 4) !== "RIFF") {
    throw new Error("Invalid WAV: missing RIFF header");
  }
  let offset = 12;
  let sampleRate = 0;
  let channels = 0;
  let bitsPerSample = 0;
  let dataOffset = -1;
  let dataSize = 0;

  while (offset + 8 <= buf.length) {
    const id = buf.toString("ascii", offset, offset + 4);
    const size = buf.readUInt32LE(offset + 4);
    const next = offset + 8 + size;
    if (id === "fmt " && size >= 16) {
      channels = buf.readUInt16LE(offset + 10);
      sampleRate = buf.readUInt32LE(offset + 12);
      bitsPerSample = buf.readUInt16LE(offset + 22);
    } else if (id === "data") {
      dataOffset = offset + 8;
      dataSize = size;
      break;
    }
    offset = next + (size % 2); // word align
  }

  if (dataOffset < 0 || !sampleRate || !channels || bitsPerSample !== 16) {
    throw new Error(
      `Unsupported WAV (need 16-bit PCM): rate=${sampleRate} ch=${channels} bits=${bitsPerSample}`
    );
  }

  const pcm = buf.subarray(dataOffset, dataOffset + dataSize);
  return { pcm: Buffer.from(pcm), sampleRate, channels };
}

/** Build mono 16-bit LE WAV. */
export function buildWavPcm(pcm: Buffer, sampleRate: number): Buffer {
  const dataSize = pcm.length;
  const buf = Buffer.alloc(44 + dataSize);
  buf.write("RIFF", 0);
  buf.writeUInt32LE(36 + dataSize, 4);
  buf.write("WAVE", 8);
  buf.write("fmt ", 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20); // PCM
  buf.writeUInt16LE(1, 22); // mono
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * 2, 28); // byte rate
  buf.writeUInt16LE(2, 32); // block align
  buf.writeUInt16LE(16, 34);
  buf.write("data", 36);
  buf.writeUInt32LE(dataSize, 40);
  pcm.copy(buf, 44);
  return buf;
}

/** Downmix stereo → mono (average). */
export function toMonoPcm16(pcm: Buffer, channels: number): Buffer {
  if (channels <= 1) return pcm;
  const frames = Math.floor(pcm.length / (2 * channels));
  const out = Buffer.alloc(frames * 2);
  for (let i = 0; i < frames; i++) {
    let sum = 0;
    for (let c = 0; c < channels; c++) {
      sum += pcm.readInt16LE((i * channels + c) * 2);
    }
    out.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(sum / channels))), i * 2);
  }
  return out;
}

/** Linear resample PCM16 mono from→to. */
export function resamplePcm16(pcm: Buffer, fromRate: number, toRate: number): Buffer {
  if (fromRate === toRate) return pcm;
  if (fromRate <= 0 || toRate <= 0) throw new Error("Invalid sample rate");
  const inFrames = Math.floor(pcm.length / 2);
  const outFrames = Math.max(1, Math.round((inFrames * toRate) / fromRate));
  const out = Buffer.alloc(outFrames * 2);
  for (let i = 0; i < outFrames; i++) {
    const src = (i * fromRate) / toRate;
    const i0 = Math.floor(src);
    const i1 = Math.min(inFrames - 1, i0 + 1);
    const t = src - i0;
    const s0 = pcm.readInt16LE(i0 * 2);
    const s1 = pcm.readInt16LE(i1 * 2);
    out.writeInt16LE(Math.round(s0 + (s1 - s0) * t), i * 2);
  }
  return out;
}

/** WAV (any common PCM rate) → mono PCM @ 8 kHz for SIP. */
export function wavToSipPcm(wav: Buffer): Buffer {
  const { pcm, sampleRate, channels } = parseWavPcm(wav);
  const mono = toMonoPcm16(pcm, channels);
  return resamplePcm16(mono, sampleRate, SIP_PCM_RATE);
}
