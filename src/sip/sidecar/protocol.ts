/**
 * SMED v1 frame protocol (sip-media-sidecar Unix IPC).
 * Ref: rag2/sip-media-sidecar/docs/IPC.md
 */
export const SMED_MAGIC = 0x44454d53; // 'SMED' LE
export const SMED_VERSION = 1;
export const SMED_HEADER_SIZE = 12;

export enum SmedIpcType {
  Hello = 1,
  Config = 2,
  Ready = 3,
  Incoming = 10,
  Answer = 11,
  Hangup = 12,
  Deny = 13,
  CallEnded = 14,
  Transfer = 15,
  Dial = 16,
  Outgoing = 17,
  DialResult = 18,
  CapturePcm = 20,
  PlayPcm = 21,
  PlayEos = 22,
  Interrupt = 23,
  ClearInterrupt = 24,
  Stats = 30,
  Error = 40,
}

export function packSmedFrame(type: SmedIpcType, payload: Buffer = Buffer.alloc(0)): Buffer {
  const hdr = Buffer.alloc(SMED_HEADER_SIZE);
  hdr.writeUInt32LE(SMED_MAGIC, 0);
  hdr.writeUInt8(SMED_VERSION, 4);
  hdr.writeUInt8(type & 0xff, 5);
  hdr.writeUInt8(0, 6); // flags
  hdr.writeUInt8(0, 7); // reserved
  hdr.writeUInt32LE(payload.length >>> 0, 8);
  return Buffer.concat([hdr, payload]);
}

export function unpackSmedHeader(data: Buffer): { type: number; length: number } {
  if (data.length < SMED_HEADER_SIZE) throw new Error("SMED header too short");
  const magic = data.readUInt32LE(0);
  const ver = data.readUInt8(4);
  const type = data.readUInt8(5);
  const length = data.readUInt32LE(8);
  if (magic !== SMED_MAGIC || ver !== SMED_VERSION) {
    throw new Error(`bad SMED header magic=${magic.toString(16)} ver=${ver}`);
  }
  return { type, length };
}
