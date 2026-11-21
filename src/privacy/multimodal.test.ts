// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Vitaliy Bondar

/**
 * Run: npx tsx src/privacy/multimodal.test.ts
 */
import assert from "node:assert/strict";
import type OpenAI from "openai";
import { PiiMasker } from "./pii-masker.js";
import { prepareMessagesForPrivacyMultimodal } from "./multimodal.js";
import type { Claw2Config } from "../config/types.js";

const remoteCfg = {
  llm: { baseURL: "https://api.openai.com/v1", apiKey: "x" },
  privacy: { enabled: true, multimodalBackend: "auto" as const },
} as Claw2Config;

async function main() {
  const masker = new PiiMasker();
  const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [
    {
      role: "user",
      content: [
        { type: "text", text: "see image" },
        {
          type: "image_url",
          image_url: { url: "data:image/png;base64,aaaa" },
        },
      ],
    },
  ];

  // Force missing sidecar via impossible path + off discovery of real binary
  const cfg = {
    ...remoteCfg,
    privacy: {
      ...remoteCfg.privacy,
      ocrSidecarPath: "/nonexistent/privacy-ocr-sidecar-missing",
      multimodalBackend: "auto" as const,
    },
  } as Claw2Config;

  // If a real binary exists on this machine, auto would use it — pin to sidecar-required miss via path only.
  // Prefer testing the block path with multimodalBackend still auto but binary override that doesn't exist:
  // findPrivacyOcrSidecarBinary checks ocrSidecarPath first, then state dir. Clear env override.
  delete process.env.CLAW2_PRIVACY_OCR_SIDECAR_PATH;

  const result = await prepareMessagesForPrivacyMultimodal(cfg, messages, masker);
  // When a real sidecar is installed under ~/.claw2, this may redact instead of block.
  // Assert contract: image_url either removed or replaced; never left as raw aaaa png.
  const content = result.messages[0] && "content" in result.messages[0] ? result.messages[0].content : null;
  assert.ok(Array.isArray(content));
  const imageParts = content.filter(
    (p) => p && typeof p === "object" && (p as { type?: string }).type === "image_url"
  );
  for (const part of imageParts) {
    const url = (part as { image_url?: { url?: string } }).image_url?.url || "";
    assert.ok(!url.includes("aaaa"), "raw attachment must not pass through");
  }
  if (!imageParts.length) {
    assert.ok(result.blockedCount >= 1 || result.notes.length >= 1);
  }

  const off = await prepareMessagesForPrivacyMultimodal(
    {
      ...remoteCfg,
      privacy: { enabled: true, multimodalBackend: "off" },
    } as Claw2Config,
    messages,
    masker
  );
  assert.equal(off.blockedCount, 0);
  assert.deepEqual(off.messages, messages);

  console.log("privacy/multimodal.test.ts: ok");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
