// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Vitaliy Bondar

import { useCallback, useEffect, useRef, useState } from "react";
import { Chat } from "./components/Chat";
import { ChatList } from "./components/ChatList";
import { Layout, isStackView } from "./components/Layout";
import { SessionMedia } from "./components/SessionMedia";
import { Settings } from "./components/Settings";
import { LlmSetupScreen } from "./components/LlmSetupScreen";
import type { PwaView } from "./components/TabBar";
import {
  deleteChat,
  exportChatToMarkdown,
  fetchChatHistory,
  fetchChatList,
  type ChatListItemApi,
  type HistoryMessageApi,
} from "./api/chat";
import { useWide } from "./useWide";
import { isNative } from "./native";
import { getSettings, llmReady, onSettingsChange, saveSettings } from "./engine/settings";

function titleFor(view: PwaView, chats: ChatListItemApi[], sessionId: string): string {
  if (view === "chats") return "Чаты";
  if (view === "settings") return "Настройки";
  if (view === "images") return "Картинки";
  if (view === "documents") return "Документы";
  const chat = sessionId ? chats.find((c) => c.id === sessionId) : null;
  return chat?.title?.trim() || (sessionId ? "Чат" : "Новый чат");
}

export default function App() {
  const wide = useWide();
  const [view, setView] = useState<PwaView>("chats");
  const [sessionId, setSessionId] = useState("");
  const [history, setHistory] = useState<HistoryMessageApi[]>([]);
  const [historyKey, setHistoryKey] = useState("new");
  const [refreshTrigger, setRefreshTrigger] = useState(0);
  const [chats, setChats] = useState<ChatListItemApi[]>([]);
  const [chatsLoading, setChatsLoading] = useState(false);
  const [chatsError, setChatsError] = useState<string | null>(null);
  // The onboarding wizard is a one-time gate: a later broken API config must
  // never eject into it (that read as "the app broke"). It shows a warning
  // banner and points to Настройки instead.
  const [llmSetup, setLlmSetup] = useState(() => !getSettings().onboarded);
  const [llmConfigured, setLlmConfigured] = useState(() => llmReady());

  useEffect(
    () =>
      onSettingsChange((s) => {
        setLlmConfigured(llmReady(s));
      }),
    []
  );

  const finishOnboarding = useCallback(() => {
    saveSettings({ onboarded: true });
    setLlmSetup(false);
  }, []);

  const refreshChats = useCallback(async () => {
    setChatsLoading(true);
    setChatsError(null);
    try {
      setChats(await fetchChatList());
    } catch (e) {
      setChatsError(e instanceof Error ? e.message : String(e));
    } finally {
      setChatsLoading(false);
    }
  }, []);

  useEffect(() => {
    if (llmSetup) return;
    void refreshChats();
  }, [llmSetup, refreshChats]);

  const refreshHistory = useCallback(async (id: string) => {
    if (!id.trim()) return;
    try {
      setHistory(await fetchChatHistory(id));
      setHistoryKey(`${id}-${Date.now()}`);
    } catch {
      // keep current history
    }
  }, []);

  const openChat = useCallback(
    async (id: string) => {
      setSessionId(id);
      setView("chat");
      await refreshHistory(id);
      setRefreshTrigger((n) => n + 1);
    },
    [refreshHistory]
  );

  const newChat = useCallback(() => {
    setSessionId("");
    setHistory([]);
    setHistoryKey(`new-${Date.now()}`);
    setView("chat");
  }, []);

  const handleDelete = useCallback(
    async (id: string) => {
      try {
        await deleteChat(id);
        if (sessionId === id) {
          setSessionId("");
          setHistory([]);
          setHistoryKey(`new-${Date.now()}`);
          setView("chats");
        }
        await refreshChats();
      } catch (e) {
        setChatsError(e instanceof Error ? e.message : String(e));
      }
    },
    [sessionId, refreshChats]
  );

  const navigate = useCallback(
    (next: PwaView) => {
      if ((next === "images" || next === "documents") && !sessionId) {
        setView("chats");
        return;
      }
      if (next === "chat" && !sessionId) {
        newChat();
        return;
      }
      if (next === "chats") {
        void refreshChats();
      }
      setView(next);
    },
    [sessionId, newChat, refreshChats]
  );

  // Stack-style back: images/documents → chat, chat/settings → chats list.
  const handleBack = useCallback(() => {
    if (view === "images" || view === "documents") {
      setView("chat");
      return;
    }
    if (view === "chat" || view === "settings") {
      void refreshChats();
      setView("chats");
      return;
    }
    setView("chats");
  }, [view, refreshChats]);

  // Android hardware/gesture back: navigate the stack, minimize at the root.
  const backRef = useRef<() => void>(() => {});
  backRef.current = () => {
    const stacked = isStackView(view, wide);
    if (stacked || view === "settings") {
      handleBack();
      return;
    }
    if (view === "chat" && wide) {
      void refreshChats();
      setView("chats");
      return;
    }
    void (async () => {
      try {
        const { App: CapApp } = await import("@capacitor/app");
        await (CapApp as typeof CapApp & { minimize(): Promise<void> }).minimize();
      } catch {
        /* ignore */
      }
    })();
  };
  useEffect(() => {
    if (!isNative()) return;
    let sub: { remove: () => void } | null = null;
    let disposed = false;
    import("@capacitor/app")
      .then(({ App }) => App.addListener("backButton", () => backRef.current()))
      .then((s) => {
        if (disposed) {
          s.remove();
          return;
        }
        sub = s;
      })
      .catch(() => {});
    return () => {
      disposed = true;
      sub?.remove();
    };
  }, []);

  if (llmSetup) {
    return <LlmSetupScreen onReady={finishOnboarding} />;
  }

  const inStack = isStackView(view, wide);

  return (
    <Layout
      view={view}
      title={titleFor(view, chats, sessionId)}
      wide={wide}
      onNavigate={navigate}
      onBack={inStack ? handleBack : undefined}
      onNewChat={newChat}
      onOpenImages={sessionId ? () => setView("images") : undefined}
      onOpenDocuments={sessionId ? () => setView("documents") : undefined}
      showLogout={false}
      listPane={
        <ChatList
          chats={chats}
          currentId={sessionId}
          loading={chatsLoading}
          error={chatsError}
          onSelect={(id) => void openChat(id)}
          onDelete={(id) => void handleDelete(id)}
          onExport={(id, title) => {
            void exportChatToMarkdown(id, title).catch((e) =>
              window.alert(`Не удалось экспортировать чат: ${e instanceof Error ? e.message : String(e)}`)
            );
          }}
        />
      }
    >
      {/* Shown in the detail pane when nothing is open (visible only in wide mode —
          narrow mode hides the whole detail pane via CSS). */}
      {view === "chats" && (
        <div className="pane-empty" style={{ display: "flex" }}>
          <p className="pane-empty-text">Выберите чат слева или создайте новый.</p>
        </div>
      )}
      <div className="page-wrap page-chat" style={{ display: view === "chat" ? "flex" : "none" }}>
        {!llmConfigured && (
          <div className="llm-warning" role="status">
            Модель не настроена — ответы работать не будут.
            <button type="button" onClick={() => setView("settings")}>
              Открыть Настройки
            </button>
          </div>
        )}
        <Chat
          sessionId={sessionId}
          onSessionIdChange={(id) => {
            setSessionId(id);
            void refreshChats();
          }}
          onSessionFilesRefresh={() => setRefreshTrigger((n) => n + 1)}
          onChatListRefresh={() => void refreshChats()}
          initialMessages={history}
          historyKey={historyKey}
        />
      </div>
      <div className="page-wrap" style={{ display: view === "images" ? "block" : "none" }}>
        <SessionMedia sessionId={sessionId} kind="images" refreshTrigger={refreshTrigger} />
      </div>
      <div className="page-wrap" style={{ display: view === "documents" ? "block" : "none" }}>
        <SessionMedia sessionId={sessionId} kind="documents" refreshTrigger={refreshTrigger} />
      </div>
      <div className="page-wrap page-settings" style={{ display: view === "settings" ? "block" : "none" }}>
        {view === "settings" ? <Settings /> : null}
      </div>
    </Layout>
  );
}
