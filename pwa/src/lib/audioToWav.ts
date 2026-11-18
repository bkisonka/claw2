/**
 * Decode browser MediaRecorder blob (webm/opus, mp4, …) to PCM WAV for STT APIs.
 */

function writeString(view: DataView, offset: number, str: string): void {
  for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i));
}

function encodeWav(buffer: AudioBuffer): ArrayBuffer {
  const numChannels = 1;
  const sampleRate = buffer.sampleRate;
  const numFrames = buffer.length;
  const bytesPerSample = 2;
  const blockAlign = numChannels * bytesPerSample;
  const dataSize = numFrames * blockAlign;
  const out = new ArrayBuffer(44 + dataSize);
  const view = new DataView(out);

  writeString(view, 0, "RIFF");
  view.setUint32(4, 36 + dataSize, true);
  writeString(view, 8, "WAVE");
  writeString(view, 12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, numChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * blockAlign, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, 16, true);
  writeString(view, 36, "data");
  view.setUint32(40, dataSize, true);

  const left = buffer.getChannelData(0);
  const right = buffer.numberOfChannels > 1 ? buffer.getChannelData(1) : null;
  let offset = 44;
  for (let i = 0; i < numFrames; i++) {
    const sample = right ? (left[i]! + right[i]!) * 0.5 : left[i]!;
    const s = Math.max(-1, Math.min(1, sample));
    view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7fff, true);
    offset += 2;
  }
  return out;
}

/** If already WAV, return as-is; otherwise decode and re-encode as mono PCM WAV. */
export async function toWavBlob(blob: Blob): Promise<Blob> {
  const type = (blob.type || "").toLowerCase();
  if (type.includes("wav") || type.includes("wave")) {
    return blob.type ? blob : new Blob([blob], { type: "audio/wav" });
  }
  const AudioCtx =
    window.AudioContext ||
    (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
  const ctx = new AudioCtx();
  try {
    const raw = await blob.arrayBuffer();
    const audioBuffer = await ctx.decodeAudioData(raw.slice(0));
    const wav = encodeWav(audioBuffer);
    return new Blob([wav], { type: "audio/wav" });
  } finally {
    void ctx.close();
  }
}
