// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Vitaliy Bondar

/**
 * Channel ingress trust (security/origin.ts integration).
 *
 * Messages arriving through Telegram/VK are untrusted-origin content by
 * default: a channel message is text the operator did not type on the
 * keyboard, and in a community anyone in it can write. The in-band boundary
 * already wrapped channel text in <<<EXT>>> markers (channels/*) — this
 * module adds the out-of-band counterpart so the session ledger agrees.
 *
 * Softening: `channels.<name>.trustedUserIds` lists channel user IDs whose
 * messages are trusted operator speech (not wrapped, not tainting). Hard by
 * default: an empty/missing list trusts nobody.
 */

import type { Claw2Config } from "../config/types.js";

export interface ChannelIngressTrust {
  /** Trusted message: operator speech — no wrap, no taint. */
  trusted: boolean;
}

export function resolveChannelIngressTrust(
  channelCfg: { trustedUserIds?: number[] } | undefined,
  channelUserId: number | undefined
): ChannelIngressTrust {
  const list = channelCfg?.trustedUserIds;
  if (
    channelUserId != null &&
    Array.isArray(list) &&
    list.length > 0 &&
    list.includes(channelUserId)
  ) {
    return { trusted: true };
  }
  return { trusted: false };
}

/** Config lookup for a channel block by name. */
export function channelIngressConfig(
  config: Claw2Config,
  channel: "telegram" | "vk"
): { trustedUserIds?: number[] } | undefined {
  return config.channels?.[channel];
}
