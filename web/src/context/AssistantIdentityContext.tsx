// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Vitaliy Bondar

import { createContext, useCallback, useContext, useEffect, useState } from "react";
import {
  getAssistantIdentity,
  type AssistantIdentityPayload,
} from "../api/assistantIdentity";

/**
 * How the assistant looks: the name above its messages and its avatar
 * (preset emoji or a small uploaded image, delivered as a data URL). Fetched
 * once at mount; PersonaTab updates it in place after a save, so the chat
 * surfaces pick up the new face without a reload.
 */
interface AssistantIdentityContextValue {
  identity: AssistantIdentityPayload | null;
  setIdentity: (identity: AssistantIdentityPayload) => void;
  refreshIdentity: () => Promise<void>;
}

const AssistantIdentityContext = createContext<AssistantIdentityContextValue | null>(null);

export function AssistantIdentityProvider({ children }: { children: React.ReactNode }) {
  const [identity, setIdentity] = useState<AssistantIdentityPayload | null>(null);

  const refreshIdentity = useCallback(async () => {
    try {
      setIdentity(await getAssistantIdentity());
    } catch {
      // The face stays a default; the chat works without an identity too.
    }
  }, []);

  useEffect(() => {
    void refreshIdentity();
  }, [refreshIdentity]);

  // The avatar diameter is a CSS variable: every surface (messages, header,
  // composer, welcome) scales from it, emoji included.
  useEffect(() => {
    const size = identity?.avatarSize;
    if (size && Number.isFinite(size)) {
      document.documentElement.style.setProperty("--avatar-size", `${size}px`);
    } else {
      document.documentElement.style.removeProperty("--avatar-size");
    }
  }, [identity]);

  return (
    <AssistantIdentityContext.Provider value={{ identity, setIdentity, refreshIdentity }}>
      {children}
    </AssistantIdentityContext.Provider>
  );
}

export function useAssistantIdentity(): AssistantIdentityContextValue {
  const ctx = useContext(AssistantIdentityContext);
  if (!ctx) throw new Error("useAssistantIdentity must be used within AssistantIdentityProvider");
  return ctx;
}
