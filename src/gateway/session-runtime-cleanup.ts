// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Vitaliy Bondar

import {
  releaseActivationVectorSeeds,
  releaseHssSession,
  releasePendingHssHints,
} from "../claw-cache/index.js";
import { releaseSidebarSession } from "../sidebar/store.js";
import { releaseGatewaySession } from "./sessions.js";

export interface SessionRuntimeCleanupResult {
  hssNodes: number;
  pendingHssHints: number;
  activationVectorSeeds: number;
  sidebarState: boolean;
}

/**
 * Clears process-local state for a deleted chat.
 * Persistent chat data and HSS chronicle storage are intentionally out of scope.
 */
export function releaseSessionRuntime(sessionId: string): SessionRuntimeCleanupResult {
  const result = {
    hssNodes: releaseHssSession(sessionId),
    pendingHssHints: releasePendingHssHints(sessionId),
    activationVectorSeeds: releaseActivationVectorSeeds(sessionId),
    sidebarState: releaseSidebarSession(sessionId),
  };
  releaseGatewaySession(sessionId);
  return result;
}
