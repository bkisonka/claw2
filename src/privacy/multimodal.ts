// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Vitaliy Bondar

/**
 * Privacy multimodal orchestration (phase 2).
 * Sidecar does OCR/PDF/paint; PiiMasker decides what to redact/block.
 */
import type OpenAI from "openai";
import type { Claw2Config } from "../config/types.js";
import { auditLog } from "../audit/log.js";
import { PiiMasker } from "./pii-masker.js";
import { shouldApplyPrivacy } from "./should-apply.js";
import {
  PrivacyOcrClient,
  defaultPrivacyOcrIpcPath,
  findPrivacyOcrSidecarBinary,
  resolveMultimodalBackend,
  spawnPrivacyOcrSidecar,
  stopPrivacyOcrProcess,
  type OcrWord,
  type PaintBox,
} from "./ocr-sidecar/index.js";
import { randomUUID } from "node:crypto";

function maxBytes(config: Claw2Config): number {
  const mb = config.privacy?.multimodalMaxSizeMb ?? 10;
  return Math.max(1, mb) * 1024 * 1024;
}

function ocrTimeoutMs(config: Claw2Config): number {
  return Math.max(5, config.privacy?.ocrTimeoutSeconds ?? 30) * 1000;
}

function lowConfRatio(config: Claw2Config): number {
  const v = config.privacy?.ocrLowConfRatio;
  return typeof v === "number" && v >= 0 && v <= 1 ? v : 0.35;
}

function decodeDataUrl(url: string): { mime: string; bytes: Buffer } | null {
  if (!url?.startsWith("data:")) return null;
  const comma = url.indexOf(",");
  if (comma < 0) return null;
  const header = url.slice(5, comma);
  if (!/base64/i.test(header)) return null;
  const mime = header.split(";")[0]?.trim() || "application/octet-stream";
  try {
    return { mime, bytes: Buffer.from(url.slice(comma + 1), "base64") };
  } catch {
    return null;
  }
}

function toJpegDataUrl(buf: Buffer): string {
  return `data:image/jpeg;base64,${buf.toString("base64")}`;
}

function wordsToBoxesWithConfig(
  words: OcrWord[],
  masker: PiiMasker,
  config: Claw2Config
): { boxes: PaintBox[]; lowConfPii: boolean } {
  const boxes: PaintBox[] = [];
  let piiWords = 0;
  let lowConfPiiWords = 0;
  for (const w of words) {
    if (!w.text?.trim()) continue;
    const masked = masker.maskText(w.text);
    if (masked === w.text) continue;
    piiWords++;
    if (typeof w.conf === "number" && w.conf >= 0 && w.conf < 50) lowConfPiiWords++;
    boxes.push({
      page: w.page ?? 0,
      x: w.left,
      y: w.top,
      w: w.width,
      h: w.height,
    });
  }
  const ratio = piiWords > 0 ? lowConfPiiWords / piiWords : 0;
  return { boxes, lowConfPii: ratio >= lowConfRatio(config) };
}

export type MultimodalPrepResult = {
  messages: OpenAI.Chat.ChatCompletionMessageParam[];
  blockedCount: number;
  redactedCount: number;
  notes: string[];
};

/**
 * When privacy applies: redact/block multimodal parts before cloud LLM.
 * Without sidecar → block image/file parts (safe fallback).
 */
export async function prepareMessagesForPrivacyMultimodal(
  config: Claw2Config,
  messages: OpenAI.Chat.ChatCompletionMessageParam[],
  masker: PiiMasker
): Promise<MultimodalPrepResult> {
  const decision = shouldApplyPrivacy(config);
  if (!decision.apply) {
    return { messages, blockedCount: 0, redactedCount: 0, notes: [] };
  }

  const backend = resolveMultimodalBackend(config);
  const notes: string[] = [];
  let blockedCount = 0;
  let redactedCount = 0;

  const hasMm = messages.some((m) => {
    const c = (m as { content?: unknown }).content;
    return Array.isArray(c);
  });
  if (!hasMm) {
    return { messages, blockedCount: 0, redactedCount: 0, notes: [] };
  }

  // Explicit opt-out: text masking still applies later; leave attachments as-is.
  if (backend.requested === "off") {
    return { messages, blockedCount: 0, redactedCount: 0, notes: [] };
  }

  if (!backend.useSidecar || !findPrivacyOcrSidecarBinary(config)) {
    const cleaned = messages.map((m) =>
      scrubMultimodalParts(m, (reason) => {
        blockedCount++;
        notes.push(reason);
      })
    );
    if (blockedCount > 0) {
      auditLog(config, {
        type: "privacy_multimodal_blocked",
        details: {
          count: blockedCount,
          reason: backend.reason,
          sidecar: false,
        },
      });
      notes.unshift(
        "[claw2 privacy] Multimodal attachments were blocked: privacy-ocr-sidecar is not available. Text still masked."
      );
    }
    return { messages: cleaned, blockedCount, redactedCount, notes };
  }

  let spawned: ReturnType<typeof spawnPrivacyOcrSidecar> | null = null;
  let client: PrivacyOcrClient | null = null;
  try {
    spawned = spawnPrivacyOcrSidecar(config, { ipcPath: defaultPrivacyOcrIpcPath() });
    client = new PrivacyOcrClient(spawned.ipcPath);
    await new Promise((r) => setTimeout(r, 250));
    await client.connect(10_000);
    await client.hello({
      maxBytes: maxBytes(config),
      ocrTimeoutMs: ocrTimeoutMs(config),
    });

    const out: OpenAI.Chat.ChatCompletionMessageParam[] = [];
    for (const msg of messages) {
      const content = (msg as { content?: unknown }).content;
      if (!Array.isArray(content)) {
        out.push(msg);
        continue;
      }
      const newParts: unknown[] = [];
      for (const part of content) {
        if (!part || typeof part !== "object") {
          newParts.push(part);
          continue;
        }
        const p = part as Record<string, unknown>;
        if (p.type === "text") {
          newParts.push(part);
          continue;
        }
        if (p.type === "image_url" && p.image_url && typeof p.image_url === "object") {
          const url = (p.image_url as { url?: string }).url;
          const decoded = typeof url === "string" ? decodeDataUrl(url) : null;
          if (!decoded) {
            blockedCount++;
            notes.push("image_url blocked (not data URL)");
            continue;
          }
          if (decoded.bytes.length > maxBytes(config)) {
            blockedCount++;
            notes.push("image blocked (size_limit)");
            continue;
          }
          const jobId = randomUUID();
          const result = await client.analyze(jobId, decoded.mime, decoded.bytes);
          if (result.kind === "block") {
            blockedCount++;
            notes.push(`image blocked (${result.reason})`);
            continue;
          }
          if (result.kind === "pdf") {
            newParts.push({
              type: "text",
              text: `[claw2: attachment]\n${masker.maskText(result.text)}`,
            });
            redactedCount++;
            continue;
          }
          const { boxes, lowConfPii } = wordsToBoxesWithConfig(result.words, masker, config);
          if (lowConfPii && boxes.length > 0) {
            blockedCount++;
            notes.push("image blocked (ocr_low_conf + PII)");
            continue;
          }
          if (boxes.length === 0) {
            const sanitized = await client.sanitize(randomUUID(), decoded.mime, decoded.bytes);
            if (Buffer.isBuffer(sanitized)) {
              newParts.push({ type: "image_url", image_url: { url: toJpegDataUrl(sanitized) } });
              redactedCount++;
            } else {
              blockedCount++;
              notes.push(`image blocked (${sanitized.reason})`);
            }
            continue;
          }
          const painted = await client.paint(jobId, boxes);
          if (Buffer.isBuffer(painted)) {
            newParts.push({ type: "image_url", image_url: { url: toJpegDataUrl(painted) } });
            redactedCount++;
          } else {
            blockedCount++;
            notes.push(`image paint failed (${painted.reason})`);
          }
          continue;
        }
        if (p.type === "file" || (typeof p.file === "object" && p.file)) {
          const fileObj = (p.file || p) as Record<string, unknown>;
          const raw =
            typeof fileObj.file_data === "string"
              ? fileObj.file_data
              : typeof fileObj.data === "string"
                ? fileObj.data
                : null;
          const filename =
            typeof fileObj.filename === "string"
              ? fileObj.filename
              : typeof fileObj.name === "string"
                ? fileObj.name
                : "file.pdf";
          if (!raw) {
            blockedCount++;
            notes.push(`file blocked (${filename})`);
            continue;
          }
          let bytes: Buffer;
          try {
            const b64 = raw.includes("base64,") ? raw.split("base64,")[1]! : raw;
            bytes = Buffer.from(b64, "base64");
          } catch {
            blockedCount++;
            notes.push(`file decode failed (${filename})`);
            continue;
          }
          if (bytes.length > maxBytes(config)) {
            blockedCount++;
            notes.push(`file blocked size_limit (${filename})`);
            continue;
          }
          const jobId = randomUUID();
          const result = await client.analyze(jobId, "application/pdf", bytes);
          if (result.kind === "pdf" && result.textual) {
            newParts.push({
              type: "text",
              text: `[claw2: PDF «${filename}»]\n${masker.maskText(result.text)}`,
            });
            redactedCount++;
            continue;
          }
          if (result.kind === "ocr") {
            const { boxes, lowConfPii } = wordsToBoxesWithConfig(result.words, masker, config);
            if (lowConfPii && boxes.length) {
              blockedCount++;
              notes.push(`PDF scan blocked low_conf (${filename})`);
              continue;
            }
            if (boxes.length) {
              const painted = await client.paint(jobId, boxes);
              if (Buffer.isBuffer(painted)) {
                newParts.push({ type: "image_url", image_url: { url: toJpegDataUrl(painted) } });
                redactedCount++;
                continue;
              }
            }
          }
          blockedCount++;
          notes.push(
            `PDF blocked (${filename}: ${result.kind === "block" ? result.reason : "no_safe_path"})`
          );
          continue;
        }
        blockedCount++;
        notes.push(`part blocked (type=${String(p.type)})`);
      }
      out.push({ ...(msg as object), content: newParts } as OpenAI.Chat.ChatCompletionMessageParam);
    }

    if (blockedCount > 0 || redactedCount > 0) {
      auditLog(config, {
        type: "privacy_multimodal_blocked",
        details: {
          blockedCount,
          redactedCount,
          reason: backend.reason,
          sidecar: true,
        },
      });
    }
    if (blockedCount > 0) {
      notes.unshift(
        `[claw2 privacy] Blocked ${blockedCount} multimodal part(s); redacted ${redactedCount}.`
      );
    }
    return { messages: out, blockedCount, redactedCount, notes };
  } catch (err) {
    const cleaned = messages.map((m) =>
      scrubMultimodalParts(m, (reason) => {
        blockedCount++;
        notes.push(reason);
      })
    );
    const msg = err instanceof Error ? err.message : String(err);
    auditLog(config, {
      type: "privacy_multimodal_blocked",
      details: { count: blockedCount, reason: `sidecar_error:${msg}`, sidecar: false },
    });
    notes.unshift(
      `[claw2 privacy] Multimodal attachments blocked (sidecar error: ${msg}). Text still masked.`
    );
    return { messages: cleaned, blockedCount, redactedCount, notes };
  } finally {
    await client?.close().catch(() => undefined);
    if (spawned) await stopPrivacyOcrProcess(spawned.proc).catch(() => undefined);
  }
}

function scrubMultimodalParts(
  msg: OpenAI.Chat.ChatCompletionMessageParam,
  onBlock: (reason: string) => void
): OpenAI.Chat.ChatCompletionMessageParam {
  const content = (msg as { content?: unknown }).content;
  if (!Array.isArray(content)) return msg;
  const kept: unknown[] = [];
  for (const part of content) {
    if (!part || typeof part !== "object") {
      kept.push(part);
      continue;
    }
    const p = part as { type?: string };
    if (p.type === "text") {
      kept.push(part);
      continue;
    }
    onBlock(`blocked ${p.type || "part"} (no sidecar)`);
  }
  return { ...(msg as object), content: kept } as OpenAI.Chat.ChatCompletionMessageParam;
}
