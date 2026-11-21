// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Vitaliy Bondar

import { createContext, useContext } from "react";
import type { ChatPageOutletContext } from "../pages/ChatPage";

const ChatPageContext = createContext<ChatPageOutletContext | null>(null);

export function ChatPageProvider({
  value,
  children,
}: {
  value: ChatPageOutletContext;
  children: React.ReactNode;
}) {
  return (
    <ChatPageContext.Provider value={value}>
      {children}
    </ChatPageContext.Provider>
  );
}

export function useChatPageContext(): ChatPageOutletContext {
  const ctx = useContext(ChatPageContext);
  if (!ctx) throw new Error("useChatPageContext must be used within ChatPageProvider");
  return ctx;
}
