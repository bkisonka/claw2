// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Vitaliy Bondar

/**
 * Checking URLs for sensitive data and filtering external content before Content Boundary.
 * Used for web_fetch (URL + response body) and run_agent output.
 */

/**
 * Checks that the URL (and its decoded version) does not contain any fragments from uploads/output or memory.
 * Call before executing web_fetch.
 */
export function urlContainsSensitive(
  url: string,
  sensitiveFragments: string[],
  memoryFragments: string[]
): boolean {
  if (!url || typeof url !== "string") return false;
  const decoded = safeDecodeUriComponent(url);
  const combined = `${url}\n${decoded}`;
  const check = (chunk: string) => chunk.length > 0 && combined.includes(chunk);
  return sensitiveFragments.some(check) || memoryFragments.some(check);
}

function safeDecodeUriComponent(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

const CODE_BLOCK_RE = /```[\s\S]*?```/g;
const SCRIPT_RE = /<script\b[\s\S]*?<\/script>/gi;
const CURL_LIKE_RE = /\b(curl|wget)\s+[^\n]+/gi;
const SUSPICIOUS_TOKENS = [
  /\[SYSTEM\]/gi,
  /\[INST\]/gi,
  /\[\/INST\]/gi,
  /<<SYS>>/gi,
  /<<\/SYS>>/gi,
  /<\|im_start\|>/g,
  /<\|im_end\|>/g,
  /<\|endoftext\|>/g,
];
const PATH_LEAK_RE = /(\/home\/[^\s<>"\']+|C:\\Users\\[^\s<>"\']+)/g;
const API_KEY_LIKE_RE = /\b(sk-[a-zA-Z0-9]{20,}|ghp_[a-zA-Z0-9]{36,}|xox[baprs]-[a-zA-Z0-9-]{10,})/g;

/**
 * Filters a response from an external source before substitution into the context (and before Content Boundary).
 * Removes/masks: executable code blocks, suspicious instruction tokens, path and key leaks.
 */
export function filterExternalResponse(text: string): string {
  if (!text || typeof text !== "string") return text;
  let out = text;

  // Executable code: ```...``` blocks, <script>, curl/wget one-liners
  out = out.replace(CODE_BLOCK_RE, "[code block removed]");
  out = out.replace(SCRIPT_RE, "[script removed]");
  out = out.replace(CURL_LIKE_RE, "[command removed]");

  // Tokens that can be interpreted as system instructions
  for (const re of SUSPICIOUS_TOKENS) {
    out = out.replace(re, "[removed]");
  }

  // Heuristics for leaking paths and keys (we mask, do not delete the context)
  out = out.replace(PATH_LEAK_RE, "[path redacted]");
  out = out.replace(API_KEY_LIKE_RE, "[key redacted]");

  return out;
}
