// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Vitaliy Bondar

/**
 * PDOC v1 frame protocol (privacy-ocr-sidecar Unix IPC).
 * Ref: privacy-ocr-sidecar/docs/IPC.md
 */
export const PDOC_MAGIC = 0x434f4450; // 'PDOC' LE
export const PDOC_VERSION = 1;
export const PDOC_HEADER_SIZE = 12;

export enum PdocIpcType {
  Ready = 1,
  Hello = 2,
  JobSubmit = 10,
  Blob = 11,
  JobProgress = 12,
  JobOcrResult = 20,
  JobPdfText = 21,
  JobPaint = 30,
  JobDone = 40,
  JobBlock = 41,
  JobCancel = 50,
  Error = 90,
}

export function packPdocFrame(type: PdocIpcType, payload: Buffer = Buffer.alloc(0)): Buffer {
  const hdr = Buffer.alloc(PDOC_HEADER_SIZE);
  hdr.writeUInt32LE(PDOC_MAGIC, 0);
  hdr.writeUInt8(PDOC_VERSION, 4);
  hdr.writeUInt8(type & 0xff, 5);
  hdr.writeUInt8(0, 6);
  hdr.writeUInt8(0, 7);
  hdr.writeUInt32LE(payload.length >>> 0, 8);
  return Buffer.concat([hdr, payload]);
}

export function unpackPdocHeader(data: Buffer): { type: number; length: number } {
  if (data.length < PDOC_HEADER_SIZE) throw new Error("PDOC header too short");
  const magic = data.readUInt32LE(0);
  const ver = data.readUInt8(4);
  const type = data.readUInt8(5);
  const length = data.readUInt32LE(8);
  if (magic !== PDOC_MAGIC || ver !== PDOC_VERSION) {
    throw new Error(`bad PDOC header magic=${magic.toString(16)} ver=${ver}`);
  }
  return { type, length };
}
