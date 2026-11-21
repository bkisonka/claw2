// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Vitaliy Bondar

/**
 * Optional SIP media sidecar (SMED v1 IPC). Fallback to Node when binary/health fails.
 */
export { SmedIpcType, SMED_MAGIC, SMED_VERSION, packSmedFrame, unpackSmedHeader } from "./protocol.js";
export { SidecarIpcClient } from "./ipc-client.js";
export { SidecarMediaPort } from "./media-port.js";
export {
  SipSidecarRuntime,
  tryStartSipSidecar,
  type SidecarIncomingInfo,
  type SidecarOutgoingInfo,
  type SidecarDialResult,
  type SipSidecarStartResult,
} from "./runtime.js";
export {
  defaultSidecarIpcPath,
  spawnSipSidecar,
  stopSipSidecarProcess,
} from "./spawn.js";
export { createSidecarDialogAdapter } from "./dialog-adapter.js";
