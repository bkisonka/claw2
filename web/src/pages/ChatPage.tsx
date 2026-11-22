// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Vitaliy Bondar

import { Chat } from "../components/Chat";
import { SearchResults } from "../components/SearchResults";
import { useChatPageContext } from "../context/ChatPageContext";
import type { Message } from "../components/Chat";
import type { ProjectListItemApi } from "../api/project";
import type { ChatItem } from "../store/chatList";
import { fetchSearchResults } from "../api/chat";

export type ChatPageOutletContext = {
  chats: ChatItem[];
  projects: ProjectListItemApi[];
  currentChatId: string | null;
  setCurrentChatId: (id: string | null) => void;
  searchQuery: string;
  setSearchQuery: (q: string) => void;
  listLoading: boolean;
  listError: string | null;
  searchResults: Awaited<ReturnType<typeof fetchSearchResults>>;
  searchResultsLoading: boolean;
  searchResultsError: string | null;
  pendingProjectId: string | null;
  currentChat: ChatItem | undefined;
  /** Increments on every New task so Chat remounts even when sessionId stays empty. */
  chatEpoch: number;
  onOpenChatFromSearch: (chatId: string) => void;
  onSessionUpdate: (sessionId: string, title: string, messages: Message[]) => void;
  onDeleteChat: (chatId: string) => void;
  onChatProjectChange: (chatId: string, projectId: string | null) => void;
  onExportChat: (chatId: string) => void;
  /** Fork the chat: full duplicate, or a branch cut at the first upToCount messages. */
  onDuplicateChat: (chatId: string, opts?: { upToCount?: number; title?: string }) => Promise<string | null>;
  onNewChat: (projectId?: string | null) => void;
  onProjectCreated: (project: ProjectListItemApi) => void;
  onProjectUpdated: (project: ProjectListItemApi) => void;
  onDeleteProject: (projectId: string) => void;
  seedPrompt?: string | null;
  onSeedPromptConsumed?: () => void;
  seedPageContext?: { text: string; url?: string; title?: string } | null;
  onSeedPrompt?: (text: string) => void;
  onSidebarUpdated?: () => void;
  removedImageUrls?: string[];
  onImageRemoved?: (url: string) => void;
  surfaceMode?: "chat" | "web";
  onWebAnswerOverlay?: (
    payload: {
      messages: {
        role: "user" | "assistant" | "visit_marker";
        content: string;
        at?: string;
        cells?: { type: string; content: string }[];
      }[];
      streaming: boolean;
    } | null
  ) => void;
  onOpenBrowserUrl?: (url: string) => void;
  pendingVisitMarker?: boolean;
  onVisitMarkerConsumed?: () => void;
  onStreamingChange?: (sessionId: string, streaming: boolean) => void;
  onStreamProgress?: (sessionId: string, title: string, messages: Message[]) => void;
  onStreamComplete?: (sessionId: string, info?: { aborted?: boolean }) => void;
  onRegisterStreamAbort?: (sessionId: string, controller: AbortController | null) => void;
  onAbortSession?: (sessionId: string) => void;
  streamingChatIds?: string[];
  historyLoadingChatIds?: string[];
  /** Browse mode: page &lt;title&gt; for sidebar/DB chat title. */
  browserChatTitle?: string | null;
  /** Normalized page URL for browser-bound chats. */
  browserPageKey?: string | null;
  onOpenPastChat?: (chatId: string) => void;
  onChatModelChange?: (sessionId: string, model: string | null) => void;
};

function ChatPageContent() {
  const ctx = useChatPageContext();
  const {
    searchQuery,
    searchResults,
    searchResultsLoading,
    searchResultsError,
    currentChatId,
    currentChat,
    pendingProjectId,
    projects,
    chatEpoch,
    onOpenChatFromSearch,
    onSessionUpdate,
    seedPrompt,
    onSeedPromptConsumed,
    seedPageContext,
    onSidebarUpdated,
  } = ctx;
  const initialMessages = currentChat?.messages ?? [];
  const projectName =
    (currentChat?.projectId
      ? projects.find((p) => p.id === currentChat.projectId)?.name
      : pendingProjectId
        ? projects.find((p) => p.id === pendingProjectId)?.name
        : undefined) ?? null;

  return (
    <div className={`page-wrap page-chat${ctx.surfaceMode === "web" ? " page-chat--web" : ""}`}>
      {searchQuery.trim() ? (
        <SearchResults
          query={searchQuery}
          results={searchResults}
          loading={searchResultsLoading}
          error={searchResultsError}
          onOpenChat={onOpenChatFromSearch}
        />
      ) : (
        <Chat
          key={currentChatId ?? `new-${chatEpoch}`}
          sessionId={currentChatId ?? ""}
          initialMessages={initialMessages}
          onSessionUpdate={onSessionUpdate}
          projectId={currentChat?.projectId ?? pendingProjectId ?? undefined}
          projectName={projectName}
          forkedFrom={currentChat?.forkedFrom ?? null}
          forkedFromTitle={
            currentChat?.forkedFrom
              ? ctx.chats.find((c) => c.id === currentChat.forkedFrom)?.title ?? null
              : null
          }
          seedPrompt={seedPrompt}
          onSeedPromptConsumed={onSeedPromptConsumed}
          seedPageContext={seedPageContext}
          onSidebarUpdated={onSidebarUpdated}
          removedImageUrls={ctx.removedImageUrls}
          onImageRemoved={ctx.onImageRemoved}
          onSeedPrompt={ctx.onSeedPrompt}
          surfaceMode={ctx.surfaceMode}
          onWebAnswerOverlay={ctx.onWebAnswerOverlay}
          onOpenBrowserUrl={ctx.onOpenBrowserUrl}
          pendingVisitMarker={ctx.pendingVisitMarker}
          onVisitMarkerConsumed={ctx.onVisitMarkerConsumed}
          onStreamingChange={ctx.onStreamingChange}
          onStreamProgress={ctx.onStreamProgress}
          onStreamComplete={ctx.onStreamComplete}
          onRegisterStreamAbort={ctx.onRegisterStreamAbort}
          onAbortSession={ctx.onAbortSession}
          isSessionStreaming={
            !!currentChatId && (ctx.streamingChatIds ?? []).includes(currentChatId)
          }
          historyLoading={
            !!currentChatId && (ctx.historyLoadingChatIds ?? []).includes(currentChatId)
          }
          browserChatTitle={ctx.browserChatTitle}
          browserPageKey={ctx.browserPageKey}
          onOpenPastChat={ctx.onOpenPastChat}
          onForkFrom={(upToCount) => {
            const sid = currentChatId ?? "";
            if (!sid) return;
            void ctx.onDuplicateChat(sid, { upToCount });
          }}
          chatModel={currentChat?.model ?? null}
          onChatModelChange={(model) => {
            const sid = currentChatId ?? "";
            if (!sid) return;
            ctx.onChatModelChange?.(sid, model);
          }}
        />
      )}
    </div>
  );
}

export function ChatPage() {
  return <ChatPageContent />;
}
