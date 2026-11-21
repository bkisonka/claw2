// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Vitaliy Bondar

/** Custom PII masking rule (XZDR-compatible semantics). */
export interface PrivacyCustomRule {
  id: string;
  name: string;
  ruleType: "keyword" | "regex";
  pattern: string;
  caseSensitive?: boolean;
  wholeWord?: boolean;
  enabled?: boolean;
  sortOrder?: number;
}

export interface PrivacyConfig {
  /** Mask PII before sending to remote LLM. Default false. */
  enabled?: boolean;
  /** Also mask when llm.baseURL is local. Default false. */
  applyToLocal?: boolean;
  customRules?: PrivacyCustomRule[];
  /**
   * Multimodal (image/PDF) path via privacy-ocr-sidecar.
   * auto: use sidecar if present, else block attachments when privacy on.
   */
  multimodalBackend?: "auto" | "off" | "sidecar";
  multimodalMaxSizeMb?: number;
  ocrTimeoutSeconds?: number;
  ocrLowConfRatio?: number;
  ocrSidecarPath?: string | null;
}

export type ReplaceFn = (kind: string, value: string) => string;
