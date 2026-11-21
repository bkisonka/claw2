// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Vitaliy Bondar

/**
 * MIME helpers for attachments. Android file pickers (gallery, Documents UI)
 * frequently hand us a File with an empty `type`, so the mime must be
 * recovered from the extension — otherwise images fall into the opaque
 * "[приложен файл]" branch and the model never sees them, and previews
 * render as broken data:application/octet-stream URLs.
 */

const MIME_BY_EXT: Record<string, string> = {
  // images
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  gif: "image/gif",
  bmp: "image/bmp",
  heic: "image/heic",
  heif: "image/heif",
  avif: "image/avif",
  svg: "image/svg+xml",
  // documents
  pdf: "application/pdf",
  doc: "application/msword",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xls: "application/vnd.ms-excel",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ods: "application/vnd.oasis.opendocument.spreadsheet",
  // text
  txt: "text/plain",
  md: "text/markdown",
  csv: "text/csv",
  tsv: "text/tab-separated-values",
  json: "application/json",
  yaml: "text/yaml",
  yml: "text/yaml",
  xml: "application/xml",
  log: "text/plain",
  html: "text/html",
  // audio
  mp3: "audio/mpeg",
  wav: "audio/wav",
  m4a: "audio/mp4",
  ogg: "audio/ogg",
  opus: "audio/ogg",
  flac: "audio/flac",
  aac: "audio/aac",
  // video
  mp4: "video/mp4",
  mov: "video/quicktime",
  webm: "video/webm",
};

/** Mime by extension, or undefined for unknown ones. */
export function inferMimeFromName(name: string): string | undefined {
  const ext = (name.split(".").pop() ?? "").toLowerCase();
  return MIME_BY_EXT[ext];
}

/**
 * The mime to trust for an attachment: what the platform reported, when it
 * looks like a real type (not empty / octet-stream), else the extension.
 */
export function effectiveMime(att: { name: string; mimeType?: string }): string {
  const declared = (att.mimeType ?? "").toLowerCase().trim();
  if (declared && declared !== "application/octet-stream") return declared;
  return inferMimeFromName(att.name) ?? "application/octet-stream";
}

/** Anything image-ish by mime or extension (includes formats vision APIs reject). */
export function isImageAttachment(att: { name: string; mimeType?: string }): boolean {
  return effectiveMime(att).startsWith("image/");
}

/**
 * Formats multimodal APIs actually accept as image_url parts (OpenAI-compatible
 * vision input). Everything else image-ish (heic from iPhone galleries, bmp,
 * svg…) is shown honestly as "can't be read" instead of failing the request.
 */
const VISION_IMAGE_MIMES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);

export function isVisionImage(att: { name: string; mimeType?: string }): boolean {
  return VISION_IMAGE_MIMES.has(effectiveMime(att));
}
