// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Vitaliy Bondar

/**
 * SIP UA identity fingerprint — used to skip destructive restart on every phone_call sync.
 */
import type { Claw2Config } from "../config/types.js";
import {
  resolveSipDisplayName,
  resolveSipDomain,
  resolveSipLocalPort,
  resolveSipPassword,
  resolveSipPort,
  resolveSipPublicAddress,
  resolveSipServer,
  resolveSipUser,
} from "../config/sip.js";
import { resolveSipMediaBackend } from "./media-backend.js";

/** Stable string of fields that require UA restart when changed. */
export function sipUaFingerprint(config: Claw2Config): string {
  const media = resolveSipMediaBackend(config);
  return [
    resolveSipServer(config),
    resolveSipDomain(config),
    resolveSipUser(config),
    resolveSipPassword(config),
    String(resolveSipPort(config)),
    String(resolveSipLocalPort(config)),
    resolveSipPublicAddress(config) ?? "",
    resolveSipDisplayName(config),
    media.requested,
    media.backend,
    media.sidecarPath ?? "",
  ].join("\0");
}
