// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Vitaliy Bondar

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Claw2Config } from "../config/types.js";
import { resolveAgentsUploadsDir } from "../agents/paths.js";

const MAX_FILE_SIZE = 15 * 1024 * 1024; // 15 MB
const MAX_DOCUMENTS = 20;

export interface IncomingDocument {
  name?: string;
  contentBase64?: string;
  mimeType?: string;
}

/**
 * Saves uploaded documents (base64) to the uploads directory from the config
 * (uploads.hostPath or agentsDir/uploads) and returns absolute paths for the orchestrator.
 */
export function saveUploadedDocuments(
  documents: IncomingDocument[],
  sessionId: string,
  config: Claw2Config
): { path: string; name: string; mimeType?: string }[] {
  if (!documents.length) return [];
  const uploadsDir = resolveAgentsUploadsDir(config);
  const list = documents.slice(0, MAX_DOCUMENTS);
  const saved: { path: string; name: string; mimeType?: string }[] = [];
  mkdirSync(uploadsDir, { recursive: true });
  const safeName = (s: string) => s.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 200) || "file";
  for (let i = 0; i < list.length; i++) {
    const doc = list[i];
    const name = typeof doc.name === "string" && doc.name.trim() ? doc.name.trim() : `file-${i}`;
    const b64 = typeof doc.contentBase64 === "string" ? doc.contentBase64 : "";
    if (!b64) continue;
    const buf = Buffer.from(b64, "base64");
    if (buf.length > MAX_FILE_SIZE) continue;
    const base = safeName(name);
    const filename = `${sessionId}-${i}-${Date.now()}-${base}`.replace(/[^a-zA-Z0-9._-]/g, "_");
    const filePath = join(uploadsDir, filename);
    writeFileSync(filePath, buf, { flag: "w" });
    const mimeType =
      typeof doc.mimeType === "string" && doc.mimeType.trim() ? doc.mimeType.trim() : undefined;
    saved.push({ path: filePath, name, mimeType });
  }
  return saved;
}
