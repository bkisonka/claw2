// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Vitaliy Bondar

/**
 * Assistant display identity: the name above its messages and the avatar
 * (a preset emoji or a small uploaded image). The text persona lives in
 * assistant-persona.ts; this file is how the assistant looks, not who it is.
 * Single-user mode stores <stateDir>/assistant-identity.json; registration
 * (multi-user) mode stores the same object in the user's config jsonb as
 * assistant.identity. Images travel to clients as data URLs — <img> tags
 * cannot send auth headers.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { Claw2Config } from "../config/types.js";

export const ASSISTANT_AVATAR_PRESETS = [
  "🐱", "🤖", "🦉", "🦊", "🐼", "🐰", "🐲", "👽", "🎩", "🧠", "⭐", "🚀", "🌸", "☕", "🎧", "📚",
] as const;

export type AssistantAvatarPreset = { kind: "preset"; value: string };
export type AssistantAvatarImage = { kind: "image"; mimeType: string; dataBase64: string };
export type AssistantAvatar = AssistantAvatarPreset | AssistantAvatarImage;
export type AssistantIdentity = { name?: string; avatar?: AssistantAvatar };

export const DEFAULT_ASSISTANT_AVATAR: AssistantAvatarPreset = { kind: "preset", value: "🤖" };
export const ASSISTANT_NAME_MAX = 64;
/** Avatar images are downscaled client-side; 1 MB of raw bytes is a generous ceiling. */
export const ASSISTANT_AVATAR_IMAGE_MAX_BYTES = 1 * 1024 * 1024;

const ALLOWED_IMAGE_MIME = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);

function isPresetValue(value: unknown): value is string {
  return typeof value === "string" && (ASSISTANT_AVATAR_PRESETS as readonly string[]).includes(value);
}

/** Drops invalid parts instead of throwing: a bad field must not blind the whole identity. */
export function sanitizeAssistantIdentity(raw: unknown): AssistantIdentity {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const source = raw as { name?: unknown; avatar?: unknown };
  const identity: AssistantIdentity = {};
  if (typeof source.name === "string") {
    const name = source.name.trim().slice(0, ASSISTANT_NAME_MAX);
    if (name) identity.name = name;
  }
  const avatar = source.avatar;
  if (avatar && typeof avatar === "object" && !Array.isArray(avatar)) {
    const kind = (avatar as { kind?: unknown }).kind;
    if (kind === "preset") {
      const value = (avatar as { value?: unknown }).value;
      if (isPresetValue(value)) identity.avatar = { kind: "preset", value };
    } else if (kind === "image") {
      const mimeType = (avatar as { mimeType?: unknown }).mimeType;
      const dataBase64 = (avatar as { dataBase64?: unknown }).dataBase64;
      if (
        typeof mimeType === "string" &&
        ALLOWED_IMAGE_MIME.has(mimeType) &&
        typeof dataBase64 === "string" &&
        dataBase64.length > 0 &&
        Buffer.byteLength(dataBase64, "base64") <= ASSISTANT_AVATAR_IMAGE_MAX_BYTES
      ) {
        identity.avatar = { kind: "image", mimeType, dataBase64 };
      }
    }
  }
  return identity;
}

function identityFilePath(config?: Claw2Config): string {
  const stateDir = process.env.CLAW2_STATE_DIR?.trim();
  if (stateDir) return join(resolve(stateDir), "assistant-identity.json");
  const home = process.env.HOME || process.env.USERPROFILE;
  if (home) return join(home, ".claw2", "assistant-identity.json");
  return resolve(process.cwd(), ".claw2", "assistant-identity.json");
}

/** Read the identity (inline config override first, then the state-dir file). */
export function readAssistantIdentity(config?: Claw2Config): AssistantIdentity {
  const inline = config?.assistant?.identity;
  if (inline && typeof inline === "object") return sanitizeAssistantIdentity(inline);
  const path = identityFilePath(config);
  try {
    if (!existsSync(path)) return {};
    return sanitizeAssistantIdentity(JSON.parse(readFileSync(path, "utf-8")));
  } catch {
    return {};
  }
}

export function writeAssistantIdentity(
  identity: AssistantIdentity,
  config?: Claw2Config
): { path: string } {
  const path = identityFilePath(config);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(sanitizeAssistantIdentity(identity), null, 2), "utf-8");
  return { path };
}

export type AssistantIdentityPayload = {
  name?: string;
  avatar: { kind: "preset"; value: string } | { kind: "image"; mimeType: string; dataUrl: string };
  isDefault: boolean;
};

/** What the client gets: an invalid/absent avatar folds to the default preset. */
export function toAssistantIdentityPayload(identity: AssistantIdentity): AssistantIdentityPayload {
  const name = identity.name?.trim() || undefined;
  const avatar = identity.avatar;
  if (!avatar || avatar.kind === "preset") {
    const value = avatar && isPresetValue(avatar.value) ? avatar.value : DEFAULT_ASSISTANT_AVATAR.value;
    return { name, avatar: { kind: "preset", value }, isDefault: !name && value === DEFAULT_ASSISTANT_AVATAR.value };
  }
  return {
    name,
    avatar: {
      kind: "image",
      mimeType: avatar.mimeType,
      dataUrl: `data:${avatar.mimeType};base64,${avatar.dataBase64}`,
    },
    isDefault: false,
  };
}
