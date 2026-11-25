// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Vitaliy Bondar

import { memo, useState, useRef, useEffect, useCallback, useMemo, type PointerEvent as ReactPointerEvent } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeSanitize, { defaultSchema } from "rehype-sanitize";
import { sendMessageStream, readFileAsBase64, deleteChatImage, downloadChatFile, acceptInsightOffer, dismissInsightOffer, fetchIdleInsightOffer, answerReadBrowserPage, answerHeadlessPageText, type DocumentToSend, type ChatCell, type ChatPageContextPayload, type InsightOfferApi, type ClientInsightContextPayload, type ToolStep } from "../api/chat";
import { InsightCard, InsightOfferCard } from "./InsightCards";
import { getConfig } from "../api/config";
import { makeChatTitle } from "../store/chatList";
import { voiceStt, voiceTts, getVoiceCapabilities } from "../api/voice";
import { toWavBlob } from "../lib/audioToWav";
import { rateRun } from "../api/agentSelection";
import { FileIcon, getFileTypeLabel, isImageFile } from "./FileIcon";
import { ChartCell } from "./ChartCell";
import { ModelPicker } from "./ModelPicker";
import {
  IconArrowUp,
  IconClose,
  IconPlus,
  IconProject,
  IconStop,
  IconThumbDown,
  IconThumbUp,
} from "./icons";
import { markdownToPlainText } from "../utils/markdown-to-plain";
import { normalizeAssistantMarkdown } from "../utils/normalize-assistant-markdown";
import { resolveAssistantDisplay } from "../lib/messageCells";
import { resolveAssistantPhase } from "../lib/assistantPhase";
import { AssistantAvatar, useAssistantDisplayName } from "./AssistantAvatar";
import { renderCellSegments, resolveMediaSrc, useMediaSrc } from "../lib/cellRender";
import { sanitizeCellHtml } from "../lib/cellSanitize";
import {
  buildImageEditPrompt,
  imageFilenameFromUrl,
  IMAGE_DELETED_CELL_TYPE,
  markImageDeletedInMessages,
} from "../lib/galleryActions";
import { apiBase } from "../config";
import { useT } from "../i18n";
import { pageKeyLabel } from "../browser/pageKey";
import { formatVisitMarkerLabel } from "../browser/visitMarkers";
import { markdownComponents, createMarkdownComponents } from "./markdownComponents";
import { ChatComposerInput, type ChatComposerInputHandle } from "./ChatComposerInput";
import { ChatQueuePanel } from "./ChatQueuePanel";
import {
  enqueueMessage,
  moveQueued,
  removeQueued,
  takeNextQueued,
  type QueuedMessage,
} from "../store/composerQueue";
import {
  ContextMenu,
  selectionTextIn,
  writeClipboard,
  type ContextMenuItem,
  type ContextMenuState,
} from "./ContextMenu";
import { ChatWorkingIndicator } from "./ChatWorkingIndicator";
import { ChatToolSteps } from "./ChatToolSteps";
import { upsertToolStep } from "../lib/toolSteps";
import { CodeBlock, guessCodeLanguage, looksLikeCode } from "./CodeBlock";
import { IconDownload, IconSpark, IconTrash, IconExpand } from "./icons";
import { ImageLightbox } from "./ImageLightbox";
import { ImageEditDialog } from "./ImageEditDialog";
import { restoreShellFocus } from "../desktop/shellFocus";
import {
  releaseTranscriptBlobPreviewUrls,
  trackTranscriptBlobPreviewUrl,
} from "../lib/transcriptBlobUrls";
import { cleanupVoiceSessionResources } from "../lib/voiceSessionCleanup";

const VISION_RECOGNIZE_TIMEOUT_MS = 12000;

const markdownSanitizeSchema = {
  ...defaultSchema,
  attributes: {
    ...defaultSchema.attributes,
    code: [...(defaultSchema.attributes?.code ?? []), ["className"], ["class"]],
    span: [...(defaultSchema.attributes?.span ?? []), ["className"], ["style"], ["class"]],
    pre: [...(defaultSchema.attributes?.pre ?? []), ["className"], ["class"]],
  },
};

/** Render Markdown in assistant messages (GFM + sanitization). */
const MarkdownContent = memo(function MarkdownContent({
  content,
  onOpenLink,
}: {
  content: string;
  onOpenLink?: (url: string) => void;
}) {
  const normalized = normalizeAssistantMarkdown(content);
  const components = useMemo(
    () => (onOpenLink ? createMarkdownComponents(onOpenLink) : markdownComponents),
    [onOpenLink]
  );
  if (!normalized.trim()) return null;
  return (
    <div className="chat-msg-markdown-wrapper">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[[rehypeSanitize, markdownSanitizeSchema]]}
        className="chat-msg-markdown"
        components={components}
      >
        {normalized}
      </ReactMarkdown>
    </div>
  );
});

/** User text: raw code → CodeBlock; fence/markdown → Markdown; otherwise plain. */
function UserMessageContent({
  content,
  onOpenLink,
}: {
  content: string;
  onOpenLink?: (url: string) => void;
}) {
  const text = content ?? "";
  if (!text.trim()) return null;
  // Same as composer: without ``` markdown won't highlight — render CodeBlock directly.
  if (looksLikeCode(text) && !/```/.test(text)) {
    return <CodeBlock code={text} language={guessCodeLanguage(text)} />;
  }
  if (/```/.test(text) || /^#{1,6}\s|^\*\s|^\d+\.\s/m.test(text)) {
    return <MarkdownContent content={text} onOpenLink={onOpenLink} />;
  }
  return <span className="chat-msg-content">{text}</span>;
}

/** Render an audio/video/image cell with fallback on load error or empty URL. */
function MediaCell({
  cell,
  sessionId,
  onImageRemoved,
  onSeedPrompt,
}: {
  cell: ChatCell;
  sessionId?: string;
  onImageRemoved?: (url: string) => void;
  onSeedPrompt?: (text: string) => void;
}) {
  const t = useT();
  const [loadError, setLoadError] = useState(false);
  const [loadNonce, setLoadNonce] = useState(0);
  const [busy, setBusy] = useState(false);
  const [lightboxOpen, setLightboxOpen] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  const retryUsedRef = useRef(false);
  const rawUrl = (cell.content ?? "").trim();
  const url = useMediaSrc(rawUrl, apiBase);
  const filename = imageFilenameFromUrl(rawUrl);
  const isLocalFile = /^\/files\/(output|uploads)\//i.test(rawUrl);
  const isDeleted = cell.type === IMAGE_DELETED_CELL_TYPE;

  // During stream the URL is truncated at first (404), then complete — clear error and retry.
  useEffect(() => {
    setLoadError(false);
    retryUsedRef.current = false;
    setLoadNonce(0);
  }, [url]);

  const onMediaError = () => {
    // One delayed retry: the file may appear on disk slightly after the URL in the stream.
    if (!retryUsedRef.current) {
      retryUsedRef.current = true;
      window.setTimeout(() => setLoadNonce((n) => n + 1), 350);
      return;
    }
    setLoadError(true);
  };

  const handleSave = async () => {
    if (!rawUrl) return;
    setBusy(true);
    try {
      await downloadChatFile(rawUrl, filename);
    } catch {
      // fallback: open in new tab
      window.open(url, "_blank", "noopener,noreferrer");
    } finally {
      setBusy(false);
    }
  };

  const handleEdit = () => {
    setLightboxOpen(false);
    setEditOpen(true);
  };

  const submitEdit = (edits: string) => {
    setEditOpen(false);
    onSeedPrompt?.(buildImageEditPrompt(rawUrl, edits));
  };

  const handleDelete = async () => {
    if (!isLocalFile) return;
    if (!window.confirm(t("gallery.deleteConfirm", { name: filename }))) return;
    setBusy(true);
    try {
      await deleteChatImage(rawUrl, sessionId || undefined);
      onImageRemoved?.(rawUrl);
    } catch (e) {
      window.alert(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  if (isDeleted) {
    return <div className="chat-cell-media-fallback">{t("chat.imageDeletedByUser")}</div>;
  }

  if (!url) {
    return <div className="chat-cell-media-fallback">{t("chat.mediaLinkInvalid")}</div>;
  }
  if (loadError) {
    return (
      <div className="chat-cell-media-fallback">
        {isLocalFile ? t("chat.imageDeletedByUser") : (
          <>
            {t("chat.mediaLoadFailed")}{" "}
            <a href={url} target="_blank" rel="noopener noreferrer">
              {t("chat.openInNewTab")}
            </a>
            {" · "}
            <button type="button" className="chat-cell-media-retry" onClick={() => {
              retryUsedRef.current = false;
              setLoadError(false);
              setLoadNonce((n) => n + 1);
            }}>
              {t("chat.retryLoad")}
            </button>
            {cell.type === "image" && (
              <>
                {" · "}
                <button type="button" className="chat-cell-media-retry" disabled={busy} onClick={() => void handleSave()}>
                  {t("gallery.save")}
                </button>
              </>
            )}
          </>
        )}
      </div>
    );
  }
  const mediaKey = `${url}#${loadNonce}`;
  if (cell.type === "audio") {
    return (
      <audio
        key={mediaKey}
        className="chat-cell-audio"
        controls
        src={url}
        preload="metadata"
        onError={onMediaError}
      />
    );
  }
  if (cell.type === "video") {
    return (
      <video
        key={mediaKey}
        className="chat-cell-video"
        controls
        src={url}
        preload="metadata"
        onError={onMediaError}
      />
    );
  }
  if (cell.type === "image") {
    return (
      <div className="chat-cell-image-wrap">
        <img
          key={mediaKey}
          className="chat-cell-image"
          src={url}
          alt=""
          onError={onMediaError}
          onClick={() => setLightboxOpen(true)}
        />
        <div className="chat-cell-image-actions">
          <button
            type="button"
            className="chat-cell-image-btn"
            disabled={busy}
            onClick={(e) => {
              e.stopPropagation();
              setLightboxOpen(true);
            }}
            title={t("gallery.fullscreen")}
            aria-label={t("gallery.fullscreen")}
          >
            <IconExpand size={14} />
          </button>
          <button
            type="button"
            className="chat-cell-image-btn"
            disabled={busy}
            onClick={(e) => {
              e.stopPropagation();
              void handleSave();
            }}
            title={t("gallery.save")}
            aria-label={t("gallery.save")}
          >
            <IconDownload size={14} />
          </button>
          {onSeedPrompt && (
            <button
              type="button"
              className="chat-cell-image-btn"
              disabled={busy}
              onClick={(e) => {
                e.stopPropagation();
                handleEdit();
              }}
              title={t("gallery.edit")}
              aria-label={t("gallery.edit")}
            >
              <IconSpark size={14} />
            </button>
          )}
          {isLocalFile && (
            <button
              type="button"
              className="chat-cell-image-btn chat-cell-image-btn-danger"
              disabled={busy}
              onClick={(e) => {
                e.stopPropagation();
                void handleDelete();
              }}
              title={t("gallery.delete")}
              aria-label={t("gallery.delete")}
            >
              <IconTrash size={14} />
            </button>
          )}
        </div>
        {lightboxOpen && (
          <ImageLightbox src={url} alt={filename} onClose={() => setLightboxOpen(false)} />
        )}
        {editOpen && (
          <ImageEditDialog
            imageName={filename}
            previewSrc={url}
            onCancel={() => setEditOpen(false)}
            onSubmit={submitEdit}
          />
        )}
      </div>
    );
  }
  return <pre className="chat-cell-raw">{cell.content}</pre>;
}

function AssistantCell({
  cell,
  sessionId,
  onImageRemoved,
  onSeedPrompt,
}: {
  cell: ChatCell;
  sessionId?: string;
  onImageRemoved?: (url: string) => void;
  onSeedPrompt?: (text: string) => void;
}) {
  const isMedia =
    cell.type === "audio" ||
    cell.type === "video" ||
    cell.type === "image" ||
    cell.type === IMAGE_DELETED_CELL_TYPE;
  // Stored content may predate a sanitizer fix — re-sanitize HTML cells at render (idempotent).
  return (
    <div className="chat-cell">
      {cell.type === "chart" ? (
        <ChartCell content={cell.content} />
      ) : cell.type === "html" ? (
        <div className="chat-cell-html" dangerouslySetInnerHTML={{ __html: sanitizeCellHtml(cell.content ?? "") }} />
      ) : isMedia ? (
        <MediaCell
          cell={cell}
          sessionId={sessionId}
          onImageRemoved={onImageRemoved}
          onSeedPrompt={onSeedPrompt}
        />
      ) : (
        <pre className="chat-cell-raw">{cell.content}</pre>
      )}
    </div>
  );
}

const MAX_FILE_SIZE = 15 * 1024 * 1024; // 15 MB — retina screenshots often exceed 5 MB
// 10 x 15 MB ≈ 150 MB raw (~200 MB base64) — sized to the gateway's chat body limit.
const MAX_FILES = 10;

// PNG is better for the detector on a small face: fewer artifacts than JPEG compression.
function captureVideoFrameAsBlob(video: HTMLVideoElement, mime = "image/png", quality = 1): Promise<Blob | null> {
  if (video.readyState < 2 || video.videoWidth === 0) return Promise.resolve(null);
  const canvas = document.createElement("canvas");
  canvas.width = video.videoWidth;
  canvas.height = video.videoHeight;
  const ctx = canvas.getContext("2d");
  if (!ctx) return Promise.resolve(null);
  ctx.drawImage(video, 0, 0);
  return new Promise((resolve) => canvas.toBlob(resolve, mime, quality));
}

export interface Message {
  role: "user" | "assistant" | "visit_marker";
  content: string;
  /** ISO timestamp for visit_marker (display). */
  at?: string;
  attachedFiles?: { name: string; previewUrl?: string; deleted?: boolean }[];
  cells?: ChatCell[];
  /** Tool steps of an assistant turn (live while it streams, from the history afterwards). */
  tools?: ToolStep[];
  /** The tool step limit was spent before this answer. */
  toolLimitReached?: boolean;
  /** The gateway was restarting while the answer was written: the answer is cut short. */
  interruptedBy?: "gateway_restart";
  /** The model's <comment> line that has not grown into a step yet. */
  comment?: string;
  /** The model's mood tag (<emotion>) shown as a badge on the avatar. */
  emotion?: string;
}

export interface ChatProps {
  /** Current session: empty string = new chat (backend returns id after the first message). */
  sessionId: string;
  /** History when opening an existing chat. */
  initialMessages?: Message[];
  /** Called after the backend reply: save/update the chat with a title (2–3 words). */
  onSessionUpdate?: (sessionId: string, title: string, messages: Message[]) => void;
  /** When creating a new chat — bind to a project (sent in POST /chat). For an existing chat — LLM context. */
  projectId?: string | null;
  /** Project name for display and context (if the chat is in a project). */
  projectName?: string | null;
  /** Fork lineage: id of the chat this one was branched from (banner above the log). */
  forkedFrom?: string | null;
  /** Resolved parent chat title for the fork banner; banner renders only when resolved. */
  forkedFromTitle?: string | null;
  /** External prompt (dynamic sidebar click) — send once. */
  seedPrompt?: string | null;
  onSeedPromptConsumed?: () => void;
  /** Browser selection attached to the next seedPrompt / submit. */
  seedPageContext?: ChatPageContextPayload | null;
  onSidebarUpdated?: () => void;
  removedImageUrls?: string[];
  onImageRemoved?: (url: string) => void;
  onSeedPrompt?: (text: string) => void;
  /** Browse mode: no thread; answers go to page overlay. */
  surfaceMode?: "chat" | "web";
  onWebAnswerOverlay?: (
    payload: {
      messages: {
        role: "user" | "assistant" | "visit_marker";
        content: string;
        at?: string;
        cells?: ChatCell[];
        emotion?: string;
      }[];
      streaming: boolean;
    } | null
  ) => void;
  onOpenBrowserUrl?: (url: string) => void;
  /** Browser tab chat: prepend a visit datetime marker before the next user message. */
  pendingVisitMarker?: boolean;
  onVisitMarkerConsumed?: () => void;
  /** Notify parent that this session is mid-stream (freeze tab↔chat rebinds). */
  onStreamingChange?: (sessionId: string, streaming: boolean) => void;
  /** Push live transcript to parent so switching chats does not lose progress. */
  onStreamProgress?: (sessionId: string, title: string, messages: Message[]) => void;
  onStreamComplete?: (sessionId: string, info?: { aborted?: boolean }) => void;
  onRegisterStreamAbort?: (sessionId: string, controller: AbortController | null) => void;
  onAbortSession?: (sessionId: string) => void;
  /** Parent knows a background stream is still running for this session. */
  isSessionStreaming?: boolean;
  /** Existing history is being restored after its in-memory transcript was evicted. */
  historyLoading?: boolean;
  /** Preferred sidebar/DB title in browse mode (page &lt;title&gt;). */
  browserChatTitle?: string | null;
  /** Normalized page URL persisted with the chat. */
  browserPageKey?: string | null;
  /** Open a past chat from an Insight card. */
  onOpenPastChat?: (chatId: string) => void;
  /** Fork the chat: create a new chat carrying the first upToCount messages of the history. */
  onForkFrom?: (upToCount: number) => void;
  /** Per-chat model override (null = settings default). */
  chatModel?: string | null;
  onChatModelChange?: (model: string | null) => void;
}


export function Chat({
  sessionId: sessionIdProp,
  initialMessages,
  onSessionUpdate,
  projectId,
  projectName,
  forkedFrom,
  forkedFromTitle,
  seedPrompt,
  onSeedPromptConsumed,
  seedPageContext,
  onSidebarUpdated,
  removedImageUrls,
  onImageRemoved,
  onSeedPrompt,
  surfaceMode = "chat",
  onWebAnswerOverlay,
  onOpenBrowserUrl,
  pendingVisitMarker = false,
  onVisitMarkerConsumed,
  onStreamingChange,
  onStreamProgress,
  onStreamComplete,
  onRegisterStreamAbort,
  onAbortSession,
  isSessionStreaming = false,
  historyLoading = false,
  browserChatTitle = null,
  browserPageKey = null,
  onOpenPastChat,
  onForkFrom,
  chatModel = null,
  onChatModelChange,
}: ChatProps) {
  const isWebSurface = surfaceMode === "web";
  const t = useT();
  const assistantName = useAssistantDisplayName(t("common.agent"));
  const [messages, setMessages] = useState<Message[]>(initialMessages ?? []);
  const [loading, setLoading] = useState(false);
  const busy = loading || isSessionStreaming;
  /** What the assistant is doing right now — the avatar animation reads it. */
  const lastMessage = messages[messages.length - 1];
  const livePhase = useMemo(
    () =>
      resolveAssistantPhase({
        busy,
        streamingContent: lastMessage?.role === "assistant" ? lastMessage.content : undefined,
        tools: lastMessage?.role === "assistant" ? lastMessage.tools : undefined,
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [busy, lastMessage?.role, lastMessage?.content, lastMessage?.tools]
  );
  const chatModelRef = useRef(chatModel);
  chatModelRef.current = chatModel;
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);
  /** Input text lives in ChatComposerInput — otherwise every keystroke re-renders Prism across the whole history. */
  const composerRef = useRef<ChatComposerInputHandle>(null);
  const prevSurfaceModeRef = useRef(surfaceMode);

  // After leaving BrowserView, reclaim keyboard focus (Windows often keeps keys on a detached view).
  useEffect(() => {
    const leftWeb = prevSurfaceModeRef.current === "web" && surfaceMode !== "web";
    prevSurfaceModeRef.current = surfaceMode;
    if (!leftWeb) return;
    let cancelled = false;
    void (async () => {
      await restoreShellFocus();
      if (cancelled) return;
      requestAnimationFrame(() => {
        if (!cancelled) composerRef.current?.focus();
      });
    })();
    return () => {
      cancelled = true;
    };
  }, [surfaceMode]);

  // Quote from W answer overlay context menu → composer.
  useEffect(() => {
    const onQuote = (ev: Event) => {
      const text = String((ev as CustomEvent<{ text?: string }>).detail?.text || "").trim();
      if (!text) return;
      const cur = composerRef.current?.getValue() ?? "";
      const next = cur.trim() ? `${cur.replace(/\s+$/, "")}\n\n${text}\n\n` : `${text}\n\n`;
      composerRef.current?.setValue(next);
      composerRef.current?.focus();
    };
    window.addEventListener("claw2:quote-composer", onQuote);
    return () => window.removeEventListener("claw2:quote-composer", onQuote);
  }, []);

  // When a turn ends, put the caret back if focus was lost while it streamed.
  useEffect(() => {
    if (busy) return;
    const ae = document.activeElement;
    if (ae && ae !== document.body && ae !== document.documentElement) return;
    requestAnimationFrame(() => composerRef.current?.focus());
  }, [busy]);

  // After chat switch / remount (esp. post window.confirm delete on Windows), reclaim caret.
  useEffect(() => {
    let cancelled = false;
    const timers = [0, 50, 200].map((ms) =>
      window.setTimeout(() => {
        if (cancelled || busy) return;
        const ae = document.activeElement as HTMLElement | null;
        if (
          ae &&
          ae !== document.body &&
          ae !== document.documentElement &&
          !(ae instanceof HTMLTextAreaElement && ae.classList.contains("chat-input")) &&
          (ae.tagName === "INPUT" ||
            ae.tagName === "TEXTAREA" ||
            ae.tagName === "SELECT" ||
            ae.isContentEditable)
        ) {
          return;
        }
        void restoreShellFocus().then(() => {
          if (!cancelled) composerRef.current?.focus();
        });
      }, ms)
    );
    return () => {
      cancelled = true;
      for (const id of timers) window.clearTimeout(id);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only on chat identity change
  }, [sessionIdProp]);

  const [sessionId, setSessionId] = useState<string>(sessionIdProp);
  const sessionIdRef = useRef(sessionIdProp);
  sessionIdRef.current = sessionIdProp;
  /**
   * Messages submitted while a reply is streaming: queued per chat, drained
   * FIFO when the turn ends. Ephemeral client state — a reload clears it.
   * forcedQueuedRef marks the row whose "send now" (⚡) interrupted the run.
   */
  const [queues, setQueues] = useState<Record<string, QueuedMessage[]>>({});
  const forcedQueuedRef = useRef<string | null>(null);
  const [queueHint, setQueueHint] = useState(false);
  const queueHintTimerRef = useRef<number | null>(null);
  const queueSid = sessionIdRef.current || sessionId;
  const currentQueue = queues[queueSid] ?? [];
  const prevSessionIdRef = useRef(sessionIdProp);
  useEffect(() => {
    const next = initialMessages ?? [];
    if (sessionIdProp !== prevSessionIdRef.current) {
      prevSessionIdRef.current = sessionIdProp;
      setSessionId(sessionIdProp);
      setMessages(next);
      streamRawRef.current = "";
      composerRef.current?.clear();
      setInsightOffer(null);
      setInsightText(null);
      insightInjectRef.current = null;
      return;
    }
    // Background stream progress (parent) — always accept newer transcript for this session.
    if (isSessionStreaming && next.length > 0) {
      setMessages(next);
      return;
    }
    // Live sync from server / other clients — skip while this client is streaming
    if (loading) return;
    if (next.length === 0) return;
    setMessages((prev) => {
      if (next.length > prev.length) return next;
      if (next.length < prev.length) return prev;
      const a = prev[prev.length - 1];
      const b = next[next.length - 1];
      if (!a || !b) return next;
      if (a.role !== b.role || a.content !== b.content) return next;
      return prev;
    });
  }, [sessionIdProp, initialMessages, loading, isSessionStreaming]);

  useEffect(() => {
    const sid = sessionIdProp?.trim();
    if (!sid) return;
    if (idleScannedRef.current === sid) return;
    idleScannedRef.current = sid;
    let cancelled = false;
    void fetchIdleInsightOffer({
      sessionId: sid,
      pageTitle: browserChatTitle || undefined,
      pageKey: browserPageKey || undefined,
    })
      .then((offer) => {
        if (cancelled || !offer) return;
        setInsightOffer(offer);
        if (offer.text) setInsightText(offer.text);
      })
      .catch(() => {
        /* idle optional */
      });
    return () => {
      cancelled = true;
    };
  }, [sessionIdProp, browserChatTitle, browserPageKey, surfaceMode]);

  const removedUrlsKey = (removedImageUrls ?? []).join("\0");
  useEffect(() => {
    if (!removedImageUrls?.length) return;
    setMessages((prev) => {
      let next = prev;
      for (const url of removedImageUrls) {
        next = markImageDeletedInMessages(next, url);
      }
      return next;
    });
  }, [removedUrlsKey]);

  const handleImageRemoved = useCallback(
    (url: string) => {
      setMessages((prev) => markImageDeletedInMessages(prev, url));
      onImageRemoved?.(url);
    },
    [onImageRemoved]
  );

  const [files, setFiles] = useState<File[]>([]);
  const [filePreviewUrls, setFilePreviewUrls] = useState<(string | null)[]>([]);
  const [attachmentLightbox, setAttachmentLightbox] = useState<{ src: string; alt: string } | null>(
    null
  );
  const [error, setError] = useState<string | null>(null);
  const [lastRunId, setLastRunId] = useState<number | null>(null);
  const [ratingSent, setRatingSent] = useState(false);
  const [insightOffer, setInsightOffer] = useState<InsightOfferApi | null>(null);
  const [insightText, setInsightText] = useState<string | null>(null);
  const [insightBusy, setInsightBusy] = useState(false);
  const insightInjectRef = useRef<ClientInsightContextPayload | null>(null);
  const idleScannedRef = useRef<string | null>(null);
  const lastUserBriefRef = useRef("");
  const [replyWithVoice, setReplyWithVoice] = useState(() => {
    try {
      return localStorage.getItem("claw2.replyWithVoice") === "1";
    } catch {
      return false;
    }
  });
  const [pttActive, setPttActive] = useState(false);
  const [pttRecognizing, setPttRecognizing] = useState(false);
  const [visionEnabled, setVisionEnabled] = useState(false);
  const [visionRecognizeUrl, setVisionRecognizeUrl] = useState<string | null>(null);
  const [visionError, setVisionError] = useState<string | null>(null);
  const [copiedMessageIndex, setCopiedMessageIndex] = useState<number | null>(null);
  const [chatCtxMenu, setChatCtxMenu] = useState<ContextMenuState | null>(null);
  /** Fork from a message: count DB-aligned messages up to and including index (visit markers are client-only, not stored). */
  const handleForkFromMessage = (index: number) => {
    if (!onForkFrom) return;
    const upToCount = messages
      .slice(0, index + 1)
      .filter((m) => m.role === "user" || m.role === "assistant").length;
    if (upToCount <= 0) return;
    if (!window.confirm(t("chat.forkConfirm"))) {
      // Native confirm steals keyboard focus on Windows Electron even on Cancel.
      void restoreShellFocus();
      return;
    }
    onForkFrom(upToCount);
  };
  const fileInputRef = useRef<HTMLInputElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const visionStreamRef = useRef<MediaStream | null>(null);
  const logRef = useRef<HTMLDivElement>(null);
  const formRef = useRef<HTMLFormElement>(null);
  const abortControllerRef = useRef<AbortController | null>(null);
  // Do not abort on unmount — switching chats must keep the request running in the background.
  const pttChunksRef = useRef<Blob[]>([]);
  const pttRecorderRef = useRef<MediaRecorder | null>(null);
  const pttStreamRef = useRef<MediaStream | null>(null);
  const pttBusyRef = useRef(false);
  const ttsBufferRef = useRef("");
  const ttsMossBatchRef = useRef("");
  const ttsQueueRef = useRef<Promise<void>>(Promise.resolve());
  const ttsAbortedRef = useRef(false);
  const ttsAbortControllerRef = useRef<AbortController | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  /** Raw stream reply (before CELL placeholders) — so cell indices stay stable while chunks append. */
  const streamRawRef = useRef("");
  const ttsNextStartRef = useRef(0);
  const TTS_MAX_CHARS = 1000;
  /** MOSS on CPU is slow: batch phrases to call inference less often. */
  const MOSS_TTS_BATCH_MIN = 72;
  const MOSS_TTS_FIRST_MIN = 24;
  const ttsEngineRef = useRef<string | undefined>(undefined);
  /** Gender from voice on the last PTT; sent with the message after push-to-talk. */
  const pttVoiceGenderRef = useRef<"male" | "female" | undefined>(undefined);
  /** Emotion from voice on the last PTT. */
  const pttVoiceEmotionRef = useRef<"angry" | "happy" | "neutral" | "sad" | undefined>(undefined);

  useEffect(() => {
    return () => {
      ttsAbortedRef.current = true;
      cleanupVoiceSessionResources({
        ttsRequest: ttsAbortControllerRef.current,
        audioContext: audioContextRef.current,
        recorder: pttRecorderRef.current,
        stream: pttStreamRef.current,
      });
      ttsAbortControllerRef.current = null;
      ttsBufferRef.current = "";
      ttsMossBatchRef.current = "";
      ttsQueueRef.current = Promise.resolve();
      ttsNextStartRef.current = 0;
      audioContextRef.current = null;
      pttRecorderRef.current = null;
      pttStreamRef.current = null;
      pttChunksRef.current = [];
    };
  }, []);

  useEffect(() => {
    const urls = files.map((f) => (isImageFile(f) ? URL.createObjectURL(f) : null));
    setFilePreviewUrls(urls);
    return () => {
      for (const u of urls) {
        if (u) URL.revokeObjectURL(u);
      }
    };
  }, [files]);

  useEffect(() => {
    if (logRef.current) {
      logRef.current.scrollTop = logRef.current.scrollHeight;
    }
  }, [messages]);

  useEffect(() => {
    Promise.all([getConfig(), getVoiceCapabilities()])
      .then(([c, caps]) => {
        const cfg = c as {
          vision?: { enabled?: boolean; recognizeUrl?: string };
          voice?: { ttsEngine?: string };
        };
        const v = cfg.vision;
        setVisionEnabled(v?.enabled === true);
        setVisionRecognizeUrl(typeof v?.recognizeUrl === "string" && v.recognizeUrl.trim() ? v.recognizeUrl.trim() : null);
        ttsEngineRef.current = caps.effectiveEngine;
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    if (!visionEnabled) return;
    setVisionError(null);
    navigator.mediaDevices
      .getUserMedia({ video: { facingMode: "user" } })
      .then((stream) => {
        visionStreamRef.current = stream;
        const video = videoRef.current;
        if (video) {
          video.srcObject = stream;
        }
      })
      .catch((err) => setVisionError(err instanceof Error ? err.message : String(err)));
    return () => {
      visionStreamRef.current?.getTracks().forEach((t) => t.stop());
      visionStreamRef.current = null;
      if (videoRef.current) videoRef.current.srcObject = null;
    };
  }, [visionEnabled]);

  const addFiles = useCallback(
    (chosen: File[]) => {
      if (chosen.length === 0) return;
      const tooBig = chosen.filter((f) => f.size > MAX_FILE_SIZE);
      // Clipboard images in Electron sometimes report size 0 until read — still accept images.
      const valid = chosen
        .filter((f) => f.size <= MAX_FILE_SIZE && (f.size > 0 || isImageFile(f) || Boolean(f.type)))
        .slice(0, MAX_FILES);
      if (tooBig.length > 0) {
        const mb = (MAX_FILE_SIZE / (1024 * 1024)).toFixed(0);
        setError(t("chat.attachTooLarge", { count: tooBig.length, mb }));
      }
      if (valid.length === 0) {
        if (tooBig.length === 0) setError(t("chat.attachEmpty"));
        return;
      }
      setFiles((prev) => [...prev, ...valid].slice(-MAX_FILES));
    },
    [t]
  );

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    addFiles(Array.from(e.target.files ?? []));
    if (fileInputRef.current) fileInputRef.current.value = "";
  };

  const openFilePicker = () => {
    if (busy) return;
    fileInputRef.current?.click();
  };

  const collectClipboardFiles = (dt: DataTransfer): File[] => {
    const fromFiles = Array.from(dt.files ?? []);
    if (fromFiles.length > 0) return fromFiles;
    const fromItems: File[] = [];
    if (dt.items) {
      for (const item of Array.from(dt.items)) {
        if (item.kind !== "file") continue;
        const f = item.getAsFile();
        if (f) fromItems.push(f);
      }
    }
    return fromItems;
  };

  const namePastedFiles = (raw: File[]): File[] => {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    return raw.map((file, i) => {
      const hasName =
        Boolean(file.name?.trim()) &&
        file.name !== "image.png" &&
        file.name !== "image.jpg" &&
        file.name !== "image.jpeg";
      if (hasName) return file;
      const ext =
        file.type === "image/jpeg"
          ? "jpg"
          : file.type === "image/webp"
            ? "webp"
            : file.type === "image/gif"
              ? "gif"
              : file.type === "application/pdf"
                ? "pdf"
                : file.type?.startsWith("image/")
                  ? file.type.slice("image/".length).replace(/[^a-z0-9]+/gi, "") || "png"
                  : "bin";
      return new File([file], `paste-${stamp}${raw.length > 1 ? `-${i + 1}` : ""}.${ext}`, {
        type: file.type || (ext === "bin" ? "application/octet-stream" : `image/${ext === "jpg" ? "jpeg" : ext}`),
        lastModified: file.lastModified || Date.now(),
      });
    });
  };

  const handlePaste = (e: React.ClipboardEvent) => {
    if (busy) return;
    const dt = e.clipboardData;
    if (!dt) return;

    const raw = collectClipboardFiles(dt);
    if (raw.length === 0) return;

    e.preventDefault();
    e.stopPropagation();
    addFiles(namePastedFiles(raw));

    const text = dt.getData("text/plain");
    if (text && e.target instanceof HTMLTextAreaElement) {
      const el = e.target;
      const cur = composerRef.current?.getValue() ?? "";
      const start = el.selectionStart ?? cur.length;
      const end = el.selectionEnd ?? start;
      const next = cur.slice(0, start) + text + cur.slice(end);
      composerRef.current?.setValue(next);
      requestAnimationFrame(() => {
        const pos = start + text.length;
        el.setSelectionRange(pos, pos);
      });
    } else if (text) {
      const cur = composerRef.current?.getValue() ?? "";
      composerRef.current?.setValue(cur + text);
    }
  };

  const removeFile = (index: number) => {
    setFiles((prev) => prev.filter((_, i) => i !== index));
  };

  const ensureTtsAudioContext = useCallback(async () => {
    let ctx = audioContextRef.current;
    if (!ctx) {
      const Ctx =
        window.AudioContext ||
        (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      ctx = new Ctx();
      audioContextRef.current = ctx;
      ttsNextStartRef.current = 0;
    }
    if (ctx.state === "suspended") {
      try {
        await ctx.resume();
      } catch {
        // the browser may block playback without a user gesture
      }
    }
    return ctx;
  }, []);

  const reportTtsError = useCallback((err: unknown) => {
    if (ttsAbortedRef.current) return;
    const msg = err instanceof Error ? err.message : String(err);
    setError((prev) => (prev ? `${prev}; ${t("chat.ttsAppend", { msg })}` : t("chat.ttsPrefix", { msg })));
  }, [t]);

  const scheduleTtsBuffer = useCallback(async (arrayBuffer: ArrayBuffer) => {
    if (ttsAbortedRef.current || arrayBuffer.byteLength === 0) return;
    const ctx = await ensureTtsAudioContext();
    if (ttsAbortedRef.current) return;
    if (!ctx || ctx.state !== "running") {
      reportTtsError(t("chat.ttsAudioBlocked"));
      return;
    }
    let nextStart = ttsNextStartRef.current;
    if (nextStart < ctx.currentTime) nextStart = ctx.currentTime;
    try {
      const decoded = await ctx.decodeAudioData(arrayBuffer.slice(0));
      const source = ctx.createBufferSource();
      source.buffer = decoded;
      source.connect(ctx.destination);
      source.start(nextStart);
      ttsNextStartRef.current = nextStart + decoded.duration;
    } catch (e) {
      reportTtsError(e);
    }
  }, [ensureTtsAudioContext, reportTtsError, t]);

  const enqueueTts = useCallback(
    (text: string) => {
      const slice = text.trim().slice(0, TTS_MAX_CHARS);
      if (!slice || ttsAbortedRef.current) return;
      ttsQueueRef.current = ttsQueueRef.current
        .then(() =>
          ttsAbortedRef.current
            ? new ArrayBuffer(0)
            : voiceTts(
                slice,
                TTS_MAX_CHARS,
                ttsEngineRef.current,
                ttsAbortControllerRef.current?.signal
              )
        )
        .then(scheduleTtsBuffer)
        .catch(reportTtsError);
    },
    [scheduleTtsBuffer, reportTtsError]
  );

  const flushMossTtsBatch = useCallback(
    (force = false) => {
      const batch = ttsMossBatchRef.current.trim();
      if (!batch) return;
      if (!force && batch.length < MOSS_TTS_BATCH_MIN) return;
      ttsMossBatchRef.current = "";
      enqueueTts(batch);
    },
    [enqueueTts]
  );

  const submitTtsPhrase = useCallback(
    (phrase: string) => {
      const text = phrase.trim().slice(0, TTS_MAX_CHARS);
      if (!text || ttsAbortedRef.current) return;
      if (ttsEngineRef.current === "moss") {
        ttsMossBatchRef.current = ttsMossBatchRef.current
          ? `${ttsMossBatchRef.current} ${text}`
          : text;
        const batch = ttsMossBatchRef.current.trim();
        const endsSentence = /[.!?][\s]*$/.test(text);
        if (
          batch.length >= MOSS_TTS_BATCH_MIN ||
          (endsSentence && batch.length >= MOSS_TTS_FIRST_MIN)
        ) {
          ttsMossBatchRef.current = "";
          enqueueTts(batch);
        }
        return;
      }
      enqueueTts(text);
    },
    [enqueueTts]
  );

  const flushTtsBuffer = useCallback(() => {
    flushMossTtsBatch(true);
    const rest = ttsBufferRef.current.trim();
    ttsBufferRef.current = "";
    if (!rest || ttsAbortedRef.current) return;
    submitTtsPhrase(rest);
  }, [flushMossTtsBatch, submitTtsPhrase]);

  const extractAndScheduleTts = useCallback(
    (appendChunk: string) => {
      if (ttsAbortedRef.current) return;
      ttsBufferRef.current += appendChunk;
      const buf = ttsBufferRef.current;
      const phraseRe = /[.!?]\s|\n/g;
      const phrases: string[] = [];
      let lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = phraseRe.exec(buf)) !== null) {
        const phrase = buf.slice(lastIndex, m.index + m[0].length).trim();
        if (phrase) phrases.push(phrase);
        lastIndex = m.index + m[0].length;
      }
      ttsBufferRef.current = buf.slice(lastIndex);
      phrases.forEach((phrase) => submitTtsPhrase(phrase));
    },
    [submitTtsPhrase]
  );

  const handleSubmit = async (
    e?: React.FormEvent,
    overrideText?: string,
    pageContext?: ChatPageContextPayload | null
  ) => {
    e?.preventDefault();
    const text = (overrideText ?? composerRef.current?.getValue() ?? "").trim();
    const filesToUse = overrideText != null ? [] : files;
    if (!text && filesToUse.length === 0) return;
    if (busy) {
      // A reply is streaming: queue the message instead of dropping it.
      // Attachments cannot be queued — they stay in the composer with the text.
      if (filesToUse.length > 0) {
        setQueueHint(true);
        if (queueHintTimerRef.current) window.clearTimeout(queueHintTimerRef.current);
        queueHintTimerRef.current = window.setTimeout(() => setQueueHint(false), 4000);
        return;
      }
      const sid = sessionIdRef.current || sessionId;
      setQueues((prev) => ({ ...prev, [sid]: enqueueMessage(prev[sid] ?? [], text) }));
      if (overrideText == null) composerRef.current?.clear();
      return;
    }
    setError(null);
    setRatingSent(false);
    setLastRunId(null);
    // In W mode: selection or short rendered snippet + full page text for tools.
    const PAGE_SNIPPET_CHARS = 700;
    let browserPageTextFull: string | null = null;
    let renderedSnippet = "";
    let renderedUrl = "";
    let renderedTitle = "";
    if (isWebSurface) {
      const getPageText = window.claw2Desktop?.browser?.getPageText;
      if (getPageText) {
        try {
          const page = await getPageText();
          if (page?.ok && page.text?.trim()) {
            browserPageTextFull = page.text.trim();
            renderedSnippet =
              browserPageTextFull.length > PAGE_SNIPPET_CHARS
                ? `${browserPageTextFull.slice(0, PAGE_SNIPPET_CHARS)}…`
                : browserPageTextFull;
            renderedUrl = (page.url || "").trim();
            renderedTitle = (page.title || "").trim();
          }
        } catch {
          /* ignore — location-only fallback */
        }
      }
    }
    const effectivePageContext: ChatPageContextPayload | null = (() => {
      const sel = pageContext?.text?.trim() ?? "";
      const url =
        pageContext?.url?.trim() ||
        renderedUrl ||
        (isWebSurface ? browserPageKey?.trim() || "" : "") ||
        "";
      const title =
        pageContext?.title?.trim() ||
        renderedTitle ||
        (isWebSurface ? browserChatTitle?.trim() || "" : "") ||
        "";
      if (!sel && !renderedSnippet && !url && !title) return null;
      return {
        text: sel || undefined,
        snippet: !sel && renderedSnippet ? renderedSnippet : undefined,
        url: url || undefined,
        title: title || undefined,
      };
    })();
    const selection = pageContext?.text?.trim() ?? "";
    let displayText = text || (filesToUse.length ? t("chat.attachedFilesCount", { count: filesToUse.length }) : "");
    if (selection) {
      const quote = selection.length > 600 ? `${selection.slice(0, 600)}…` : selection;
      const from =
        effectivePageContext?.title?.trim() ||
        effectivePageContext?.url?.trim() ||
        t("browser.selectionFallback");
      displayText = `${displayText}\n\n${t("browser.selectionQuote", { from, quote })}`.trim();
    } else if (
      isWebSurface &&
      (effectivePageContext?.title?.trim() || effectivePageContext?.url?.trim())
    ) {
      const from =
        effectivePageContext?.title?.trim() ||
        effectivePageContext?.url?.trim() ||
        t("browser.selectionFallback");
      displayText = `${displayText}\n\n${t("browser.onPage", { from })}`.trim();
    }
    const streamSessionId = sessionIdRef.current || sessionId;
    const attachedFiles = filesToUse.map((f) => {
      const previewUrl = isImageFile(f) ? URL.createObjectURL(f) : undefined;
      trackTranscriptBlobPreviewUrl(streamSessionId, previewUrl);
      return { name: f.name, previewUrl };
    });
    const toOverlayMessages = (list: Message[]) =>
      list
        .filter(
          (m): m is Message & { role: "user" | "assistant" | "visit_marker" } =>
            m.role === "user" || m.role === "assistant" || m.role === "visit_marker"
        )
        .map((m) =>
          m.role === "visit_marker"
            ? { role: "visit_marker" as const, content: m.content, at: m.at ?? m.content }
            : {
                role: m.role,
                content: m.content,
                ...(m.cells?.length ? { cells: m.cells } : {}),
                ...(m.role === "assistant" && m.emotion ? { emotion: m.emotion } : {}),
              }
        );
    const pushWebOverlay = (list: Message[], streaming: boolean) => {
      if (!isWebSurface) return;
      onWebAnswerOverlay?.({ messages: toOverlayMessages(list), streaming });
    };
    const nowIso = new Date().toISOString();
    const siteForMarker =
      (browserChatTitle || "").trim() ||
      (browserPageKey ? pageKeyLabel(browserPageKey) : "") ||
      nowIso;
    // Only when continuing an existing transcript — never invent a marker as the first row of an empty chat.
    const withMarker: Message[] =
      pendingVisitMarker &&
      messages.length > 0 &&
      !messages.some((m, i) => i === messages.length - 1 && m.role === "visit_marker")
        ? [...messages, { role: "visit_marker", content: siteForMarker, at: nowIso }]
        : messages;
    if (pendingVisitMarker) onVisitMarkerConsumed?.();
    const messagesAfterUser: Message[] = [
      ...withMarker,
      { role: "user", content: displayText, attachedFiles: attachedFiles.length ? attachedFiles : undefined },
    ];
    const messagesWithAssistantSlot: Message[] = [
      ...messagesAfterUser,
      { role: "assistant", content: "" },
    ];
    let streamTranscript: Message[] = messagesWithAssistantSlot;
    /** The model's <comment> line that has not been attached to a step yet. */
    const pendingCommentRef = { current: "" };
    const stillOnStreamSession = () => sessionIdRef.current === streamSessionId;
    let pendingStreamUi: { messages: Message[]; streaming: boolean } | null = null;
    let streamUiFrame: number | null = null;
    const flushStreamUi = () => {
      streamUiFrame = null;
      const pending = pendingStreamUi;
      pendingStreamUi = null;
      if (!pending || !mountedRef.current || !stillOnStreamSession()) return;
      setMessages(pending.messages);
      pushWebOverlay(pending.messages, pending.streaming);
    };
    const applyStreamUi = (next: Message[], streaming: boolean, immediate = false) => {
      // Coalesce chunk paints while preserving the exact live Markdown content.
      pendingStreamUi = { messages: next, streaming };
      if (immediate) {
        if (streamUiFrame != null) cancelAnimationFrame(streamUiFrame);
        flushStreamUi();
      } else if (streamUiFrame == null) {
        streamUiFrame = requestAnimationFrame(flushStreamUi);
      }
    };
    let progressTimer: ReturnType<typeof setTimeout> | null = null;
    const pushProgress = (next: Message[], immediate = false) => {
      const flush = () => {
        progressTimer = null;
        onStreamProgress?.(streamSessionId, makeChatTitle(next), next);
      };
      if (immediate) {
        if (progressTimer) clearTimeout(progressTimer);
        flush();
        return;
      }
      if (progressTimer) return;
      progressTimer = setTimeout(flush, 120);
    };
    setMessages(messagesWithAssistantSlot);
    composerRef.current?.clear();
    const filesToSend = [...filesToUse];
    setFiles([]);
    setLoading(true);
    onStreamingChange?.(streamSessionId, true);
    pushWebOverlay(messagesWithAssistantSlot, true);
    pushProgress(messagesWithAssistantSlot, true);
    const ac = new AbortController();
    abortControllerRef.current = ac;
    onRegisterStreamAbort?.(streamSessionId, ac);
    const signal = ac.signal;
    streamRawRef.current = "";
    let aborted = false;
    try {
      let documents: DocumentToSend[] | undefined;
      if (filesToSend.length > 0) {
        documents = await Promise.all(filesToSend.map(readFileAsBase64));
      }
      if (replyWithVoice) {
        ttsAbortControllerRef.current?.abort();
        ttsAbortControllerRef.current = new AbortController();
        ttsAbortedRef.current = false;
        ttsBufferRef.current = "";
        ttsMossBatchRef.current = "";
        ttsQueueRef.current = Promise.resolve();
        ttsNextStartRef.current = 0;
        void ensureTtsAudioContext();
      }
      const voiceGender = pttVoiceGenderRef.current;
      pttVoiceGenderRef.current = undefined;
      const voiceEmotion = pttVoiceEmotionRef.current;
      pttVoiceEmotionRef.current = undefined;
      let recognizedUser: string | undefined;
      if (visionEnabled && visionRecognizeUrl && videoRef.current?.srcObject) {
        try {
          const blob = await captureVideoFrameAsBlob(videoRef.current, "image/png", 1);
          if (blob) {
            const form = new FormData();
            form.append("file", blob, "frame.png");
            const res = await Promise.race([
              fetch(visionRecognizeUrl, { method: "POST", body: form }),
              new Promise<Response>((_, rej) => setTimeout(() => rej(new Error("timeout")), VISION_RECOGNIZE_TIMEOUT_MS)),
            ]);
            if (res.ok) {
              const data = (await res.json()) as { userId?: string };
              const id = data.userId;
              if (id && id !== "unknown") recognizedUser = id;
            }
          }
        } catch {
          recognizedUser = undefined;
        }
      }
      const inject = insightInjectRef.current;
      insightInjectRef.current = null;
      lastUserBriefRef.current = text;
      /** A tool step started or finished: it joins the streaming reply as a step, never as text. */
      const applyToolEvent = (step: ToolStep) => {
        const next = [...streamTranscript];
        const last = next[next.length - 1];
        if (last?.role !== "assistant") return;
        // The model's <comment> line precedes its step: attach it to the step
        // it describes and clear the pending one.
        const pending = pendingCommentRef.current;
        const withComment = pending && step.type === "start" ? { ...step, comment: pending } : step;
        if (step.type === "start") pendingCommentRef.current = "";
        next[next.length - 1] = { ...last, tools: upsertToolStep(last.tools ?? [], withComment) };
        streamTranscript = next;
        applyStreamUi(next, true);
        pushProgress(next);
      };
      /** The model's <comment> line before the next step: shown as the current activity. */
      const applyStepComment = (text: string) => {
        pendingCommentRef.current = text;
        const next = [...streamTranscript];
        const last = next[next.length - 1];
        if (last?.role !== "assistant") return;
        next[next.length - 1] = { ...last, comment: text };
        streamTranscript = next;
        applyStreamUi(next, true);
        pushProgress(next);
      };
      /** The model's mood tag: shown live on the avatar, stored with the answer. */
      const applyEmotion = (value: string) => {
        const next = [...streamTranscript];
        const last = next[next.length - 1];
        if (last?.role !== "assistant") return;
        next[next.length - 1] = { ...last, emotion: value };
        streamTranscript = next;
        applyStreamUi(next, true);
        pushProgress(next);
      };
      const res = await sendMessageStream(
        text || t("chat.seeAttached"),
        streamSessionId || undefined,
        documents,
        (chunk) => {
          streamRawRef.current += chunk;
          const raw = streamRawRef.current;
          const resolved = resolveAssistantDisplay({ content: raw });
          const next = [...streamTranscript];
          const last = next[next.length - 1];
          if (last?.role === "assistant") {
            next[next.length - 1] = {
              ...last,
              content: resolved.cells.length > 0 ? resolved.content : raw,
              cells: resolved.cells.length > 0 ? resolved.cells : undefined,
            };
          }
          streamTranscript = next;
          applyStreamUi(next, true);
          pushProgress(next);
          if (replyWithVoice && !signal.aborted && mountedRef.current && stillOnStreamSession()) {
            extractAndScheduleTts(chunk);
          }
        },
        signal,
        voiceGender,
        voiceEmotion,
        recognizedUser,
        projectId,
        () => onSidebarUpdated?.(),
        effectivePageContext,
        (url) => onOpenBrowserUrl?.(url),
        isWebSurface
          ? browserChatTitle || (browserPageKey ? pageKeyLabel(browserPageKey) : null)
          : null,
        isWebSurface ? browserPageKey : null,
        inject,
        browserPageTextFull,
        (requestId) => answerReadBrowserPage(requestId, browserPageTextFull || ""),
        answerHeadlessPageText,
        chatModelRef.current,
        applyToolEvent,
        applyStepComment,
        applyEmotion
      );
      if (replyWithVoice && !ttsAbortedRef.current && mountedRef.current && stillOnStreamSession()) {
        flushTtsBuffer();
      }
      const finalId = res.sessionId || streamSessionId;
      if (mountedRef.current && stillOnStreamSession() && res.sessionId) setSessionId(res.sessionId);
      {
        const next = [...streamTranscript];
        if (res.userCells && res.userCells.length > 0) {
          for (let i = next.length - 1; i >= 0; i--) {
            if (next[i]?.role !== "user") continue;
            releaseTranscriptBlobPreviewUrls(
              streamSessionId,
              next[i]?.attachedFiles?.map((file) => file.previewUrl) ?? []
            );
            next[i] = {
              ...next[i],
              cells: res.userCells,
              attachedFiles: res.userCells.map((c) => ({
                name: imageFilenameFromUrl(c.content),
                previewUrl: c.type === IMAGE_DELETED_CELL_TYPE ? undefined : c.content,
                deleted: c.type === IMAGE_DELETED_CELL_TYPE,
              })),
            };
            break;
          }
        }
        const last = next[next.length - 1];
        if (last?.role === "assistant") {
          const resolved = resolveAssistantDisplay({
            content: normalizeAssistantMarkdown(res.content || streamRawRef.current || last.content),
            cells: res.cells,
          });
          next[next.length - 1] = {
            ...last,
            content: resolved.content,
            cells: resolved.cells.length > 0 ? resolved.cells : res.cells,
            ...(res.toolLimitReached && { toolLimitReached: true }),
            ...(res.emotion && { emotion: res.emotion }),
            ...(res.code === "gateway_restart" && { interruptedBy: "gateway_restart" as const }),
          };
        }
        streamTranscript = next;
        if (finalId && onSessionUpdate) {
          setTimeout(() => onSessionUpdate(finalId, makeChatTitle(next), next), 0);
        } else {
          pushProgress(next, true);
        }
        applyStreamUi(next, false, true);
      }
      if (mountedRef.current && stillOnStreamSession()) {
        if (res.lastRunId != null) setLastRunId(res.lastRunId);
        // A restart is said by the note under the answer, not as an error.
        if (res.error && res.code !== "gateway_restart") setError(res.error);
        if (res.insightOffer) {
          setInsightOffer(res.insightOffer);
          setInsightText(res.insightOffer.text?.trim() || null);
        }
      }
      if (res.sidebarUpdated) onSidebarUpdated?.();
    } catch (err) {
      const isAbort = err instanceof Error && err.name === "AbortError";
      aborted = isAbort;
      if (!isAbort) {
        if (mountedRef.current && stillOnStreamSession()) {
          setError(err instanceof Error ? err.message : String(err));
        }
        const errText = t("chat.errorPrefix", { error: String(err) });
        const next = [...streamTranscript];
        const last = next[next.length - 1];
        if (last?.role === "assistant" && last.content === "") {
          next[next.length - 1] = { ...last, content: errText };
        } else {
          next.push({ role: "assistant", content: errText });
        }
        streamTranscript = next;
        if (streamSessionId && onSessionUpdate) {
          setTimeout(() => onSessionUpdate(streamSessionId, makeChatTitle(next), next), 0);
        } else {
          pushProgress(next, true);
        }
        applyStreamUi(next, false, true);
      } else {
        const next = [...streamTranscript];
        const last = next[next.length - 1];
        const partial = streamRawRef.current.trim();
        if (last?.role === "assistant") {
          if (partial) {
            next[next.length - 1] = { ...last, content: partial };
          } else if (!last.content.trim()) {
            next.pop();
          }
        }
        streamTranscript = next;
        if (streamSessionId && onSessionUpdate && next.length > 0) {
          setTimeout(() => onSessionUpdate(streamSessionId, makeChatTitle(next), next), 0);
        } else if (next.length > 0) {
          pushProgress(next, true);
        }
        if (mountedRef.current && stillOnStreamSession()) {
          if (next.length > 0) applyStreamUi(next, false, true);
          else {
            if (streamUiFrame != null) cancelAnimationFrame(streamUiFrame);
            pendingStreamUi = null;
            onWebAnswerOverlay?.(null);
            setMessages(next);
          }
        }
      }
    } finally {
      if (progressTimer) clearTimeout(progressTimer);
      if (streamUiFrame != null) cancelAnimationFrame(streamUiFrame);
      pendingStreamUi = null;
      onRegisterStreamAbort?.(streamSessionId, null);
      onStreamingChange?.(streamSessionId, false);
      onStreamComplete?.(streamSessionId, { aborted });
      if (mountedRef.current) setLoading(false);
    }
  };

  useEffect(() => {
    if (!seedPrompt?.trim()) return;
    if (busy) return;
    const text = seedPrompt.trim();
    const ctx = seedPageContext ?? null;
    onSeedPromptConsumed?.();
    void handleSubmit(undefined, text, ctx);
    // Re-run when loading clears so a click during an in-flight reply is not dropped.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seedPrompt, busy]);

  /**
   * Queue drain: when a turn ends (finish, error or abort) send the next
   * queued message of THIS chat — the forced one first, else the head.
   * Only the busy falling edge triggers a send, so editing/removing rows
   * while idle never fires anything.
   */
  const prevQueueBusyRef = useRef(busy);
  useEffect(() => {
    const wasBusy = prevQueueBusyRef.current;
    prevQueueBusyRef.current = busy;
    if (busy || !wasBusy) return;
    const sid = sessionIdRef.current || sessionId;
    const q = queues[sid];
    if (!q?.length) return;
    const forcedId = forcedQueuedRef.current;
    forcedQueuedRef.current = null;
    const next = takeNextQueued(q, forcedId);
    if (!next) return;
    setQueues((prev) => ({ ...prev, [sid]: next.rest }));
    void handleSubmit(undefined, next.item.text);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [busy, queues, sessionId]);

  /** ⚡ in the queue panel: interrupt the running reply and send this message now. */
  const forceQueued = (id: string) => {
    const sid = sessionIdRef.current || sessionId;
    if (busy) {
      forcedQueuedRef.current = id;
      ttsAbortedRef.current = true;
      if (sid) onAbortSession?.(sid);
      else abortControllerRef.current?.abort();
      return;
    }
    const next = takeNextQueued(queues[sid] ?? [], id);
    if (!next) return;
    setQueues((prev) => ({ ...prev, [sid]: next.rest }));
    void handleSubmit(undefined, next.item.text);
  };

  /** ✏️ in the queue panel: move the text back into the composer for editing. */
  const editQueued = (id: string) => {
    const sid = sessionIdRef.current || sessionId;
    const item = (queues[sid] ?? []).find((m) => m.id === id);
    if (!item) return;
    setQueues((prev) => ({ ...prev, [sid]: removeQueued(prev[sid] ?? [], id) }));
    const cur = composerRef.current?.getValue() ?? "";
    composerRef.current?.setValue(
      cur.trim() ? `${cur.replace(/\s+$/, "")}\n\n${item.text}\n\n` : `${item.text}\n\n`
    );
    composerRef.current?.focus();
  };

  const handleRate = async (rating: 0 | 1) => {
    if (lastRunId == null || ratingSent) return;
    try {
      await rateRun(lastRunId, rating);
      setRatingSent(true);
    } catch {
      // ignore
    }
  };

  const handlePttStart = useCallback(async (e: ReactPointerEvent<HTMLButtonElement>) => {
    e.preventDefault();
    if (pttBusyRef.current || pttRecorderRef.current) return;
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      // ignore — capture is optional
    }
    setPttActive(true);
    setError(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      if (!mountedRef.current) {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }
      pttStreamRef.current = stream;
      const mimeCandidates = [
        "audio/webm;codecs=opus",
        "audio/webm",
        "audio/mp4",
      ];
      const mimeType = mimeCandidates.find((m) => MediaRecorder.isTypeSupported(m));
      const recorder = mimeType
        ? new MediaRecorder(stream, { mimeType })
        : new MediaRecorder(stream);
      pttChunksRef.current = [];
      recorder.ondataavailable = (ev) => {
        if (ev.data.size > 0) pttChunksRef.current.push(ev.data);
      };
      // timeslice — chunks arrive as we go, not only on stop
      recorder.start(200);
      pttRecorderRef.current = recorder;
    } catch (err) {
      if (!mountedRef.current) return;
      setPttActive(false);
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  const handlePttEnd = useCallback(async (e?: ReactPointerEvent<HTMLButtonElement>) => {
    if (e) {
      try {
        if (e.currentTarget.hasPointerCapture(e.pointerId)) {
          e.currentTarget.releasePointerCapture(e.pointerId);
        }
      } catch {
        // ignore
      }
    }
    setPttActive(false);
    const recorder = pttRecorderRef.current;
    const stream = pttStreamRef.current;
    pttRecorderRef.current = null;
    pttStreamRef.current = null;
    if (stream) {
      stream.getTracks().forEach((t) => t.stop());
    }
    if (!recorder || recorder.state === "inactive") return;
    if (pttBusyRef.current) return;
    pttBusyRef.current = true;
    try {
      const stopped = new Promise<void>((resolve) => {
        recorder.addEventListener("stop", () => resolve(), { once: true });
      });
      recorder.stop();
      await stopped;
      if (!mountedRef.current) {
        pttChunksRef.current = [];
        return;
      }
      const chunks = pttChunksRef.current;
      pttChunksRef.current = [];
      if (chunks.length === 0) {
        setError(t("chat.sttNoAudio"));
        return;
      }
      const blob = new Blob(chunks, { type: chunks[0]?.type || "audio/webm" });
      if (blob.size < 500) {
        setError(t("chat.sttTooShort"));
        return;
      }
      setError(null);
      setPttRecognizing(true);
      let sttBlob: Blob;
      try {
        sttBlob = await toWavBlob(blob);
      } catch (convErr) {
        if (mountedRef.current) {
          setError(
            convErr instanceof Error
              ? `Не удалось подготовить аудио: ${convErr.message}`
              : t("chat.sttNoAudio"),
          );
        }
        return;
      }
      const result = await voiceStt(sttBlob);
      if (!mountedRef.current) return;
      if (result.error) {
        setError(result.error);
        return;
      }
      if (!result.text) {
        setError(t("chat.sttEmpty"));
        return;
      }
      pttVoiceGenderRef.current = result.gender;
      pttVoiceEmotionRef.current = result.emotion;
      // Cannot setInput + requestSubmit: submit reads the old empty input from the closure.
      await handleSubmit(undefined, result.text);
    } catch (err) {
      if (mountedRef.current) setError(err instanceof Error ? err.message : String(err));
    } finally {
      pttBusyRef.current = false;
      if (mountedRef.current) setPttRecognizing(false);
    }
  }, [t, handleSubmit]);

  return (
    <div className={`chat-root${isWebSurface ? " chat-root--web" : ""}`}>
      <ContextMenu
        menu={chatCtxMenu}
        onClose={() => setChatCtxMenu(null)}
        className="claw-context-menu--chat-log"
      />
      {!isWebSurface && projectName != null && projectName.trim() !== "" && (
        <div className="chat-project-context" role="status">
          {t("chat.projectLabel")} <span className="chat-project-context-name">{projectName.trim()}</span>
        </div>
      )}
      {!isWebSurface && forkedFrom && forkedFromTitle && (
        <div className="chat-project-context chat-fork-context" role="status">
          <button
            type="button"
            className="chat-fork-context-link"
            onClick={() => onOpenPastChat?.(forkedFrom)}
            title={t("chat.forkedFromBannerTitle")}
            aria-label={t("chat.forkedFromBannerAria", { title: forkedFromTitle })}
          >
            {t("chat.forkedFromBanner", { title: forkedFromTitle })}
          </button>
        </div>
      )}
      {!isWebSurface ? (
      <div className="chat-log" ref={logRef}>
        {messages.length === 0 && historyLoading && (
          <div className="chat-welcome" role="status">
            <ChatWorkingIndicator showLabel />
          </div>
        )}
        {messages.length === 0 && !historyLoading && (
          <div className="chat-welcome">
            <AssistantAvatar size="welcome" />
            <p className="chat-welcome-name">{assistantName}</p>
            <p className="chat-welcome-text">
              {(() => {
                const h = new Date().getHours();
                if (h < 5 || h >= 22) return t("chat.greetingLate");
                if (h < 12) return t("chat.greetingMorning");
                if (h < 18) return t("chat.greetingAfternoon");
                return t("chat.greetingEvening");
              })()}
            </p>
          </div>
        )}
        {messages.map((msg, i) => {
          if (msg.role === "visit_marker") {
            return (
              <div key={`visit-${i}`} className="chat-visit-marker" role="separator">
                <span>
                  {formatVisitMarkerLabel(
                    msg.at || msg.content,
                    typeof navigator !== "undefined" && navigator.language.toLowerCase().startsWith("ru")
                      ? "ru"
                      : "en",
                    msg.content
                  )}
                </span>
              </div>
            );
          }
          const display =
            msg.role === "assistant"
              ? resolveAssistantDisplay(msg)
              : {
                  content: msg.content,
                  cells: (msg.cells ?? []).filter(
                    (c) => c.type === "image" || c.type === IMAGE_DELETED_CELL_TYPE
                  ),
                };
          const displayCells = display.cells;
          const displayContent = display.content;
          const userHasImageCells = msg.role === "user" && displayCells.length > 0;
          return (
          <div
            key={i}
            className={`chat-msg chat-msg--${msg.role}`}
            onContextMenu={(e) => {
              if (e.defaultPrevented) return;
              e.preventDefault();
              const msgEl = e.currentTarget;
              const bodyEl = msgEl.querySelector(".chat-msg-body") as HTMLElement | null;
              const selected = selectionTextIn(msgEl).trim();
              const plain =
                msg.role === "assistant"
                  ? markdownToPlainText(displayContent || msg.content || "")
                  : (displayContent || msg.content || "").trim();
              if (!plain && !selected) return;
              const items: ContextMenuItem[] = [];
              if (selected) {
                items.push({
                  type: "item",
                  id: "copy-selection",
                  label: t("chat.ctxCopySelection"),
                  onClick: () => {
                    void writeClipboard(selected);
                  },
                });
              }
              items.push({
                type: "item",
                id: "copy-message",
                label: t("chat.ctxCopyMessage"),
                disabled: !plain,
                onClick: () => {
                  void writeClipboard(plain).then((ok) => {
                    if (!ok) return;
                    setCopiedMessageIndex(i);
                    setTimeout(() => setCopiedMessageIndex(null), 2000);
                  });
                },
              });
              items.push({
                type: "item",
                id: "select-message",
                label: t("chat.ctxSelectMessage"),
                disabled: !bodyEl,
                onClick: () => {
                  if (!bodyEl) return;
                  const range = document.createRange();
                  range.selectNodeContents(bodyEl);
                  const sel = window.getSelection();
                  sel?.removeAllRanges();
                  sel?.addRange(range);
                },
              });
              items.push({ type: "separator", id: "sep-quote" });
              items.push({
                type: "item",
                id: "quote",
                label: t("chat.ctxQuote"),
                disabled: !(selected || plain),
                onClick: () => {
                  const src = selected || plain;
                  const quoted = src
                    .split(/\r?\n/)
                    .map((line) => `> ${line}`)
                    .join("\n");
                  const cur = composerRef.current?.getValue() ?? "";
                  const next = cur.trim() ? `${cur.replace(/\s+$/, "")}\n\n${quoted}\n\n` : `${quoted}\n\n`;
                  composerRef.current?.setValue(next);
                  composerRef.current?.focus();
                },
              });
              setChatCtxMenu({ x: e.clientX, y: e.clientY, items });
            }}
          >
            {msg.role === "assistant" && (
              <AssistantAvatar
                size="msg"
                phase={busy && i === messages.length - 1 ? livePhase.phase : "idle"}
                toolKind={busy && i === messages.length - 1 ? livePhase.toolKind : undefined}
                emotion={msg.emotion}
              />
            )}
            <span className="chat-msg-label">{msg.role === "user" ? t("common.you") : assistantName}: </span>
            <div className="chat-msg-body">
              {(() => {
                const isStreamingAssistant =
                  busy && i === messages.length - 1 && msg.role === "assistant";
                const toolSteps = msg.role === "assistant" ? msg.tools : undefined;
                const hasToolSteps = !!toolSteps?.length;
                const assistantEmpty =
                  msg.role === "assistant" &&
                  !(displayContent || "").trim() &&
                  displayCells.length === 0 &&
                  !hasToolSteps;
                if (assistantEmpty && isStreamingAssistant) {
                  return (
                    <div className="chat-msg-content">
                      <ChatWorkingIndicator showLabel showCursor />
                    </div>
                  );
                }
                // An answer a restart cut short before its first word is only its note.
                if (!(displayContent || isStreamingAssistant || userHasImageCells || hasToolSteps || msg.interruptedBy)) {
                  return null;
                }
                return (
                  <>
                {hasToolSteps && toolSteps ? (
                  <>
                    <ChatToolSteps steps={toolSteps} running={isStreamingAssistant} liveComment={msg.comment} />
                    {msg.toolLimitReached ? (
                      <p className="chat-tool-limit-note">{t("chat.toolLimitReached")}</p>
                    ) : null}
                  </>
                ) : null}
                {msg.role === "assistant" && displayCells.length > 0 ? (
                  <div className="chat-msg-content chat-msg-content--with-cells">
                    {renderCellSegments(
                      displayContent,
                      displayCells,
                      (text, key) => (
                        <span key={key} className="chat-msg-markdown-wrap">
                          <MarkdownContent content={text} onOpenLink={onOpenBrowserUrl} />
                        </span>
                      ),
                      (cell, _index, key) => (
                        <AssistantCell
                          key={key}
                          cell={cell}
                          sessionId={sessionId}
                          onImageRemoved={handleImageRemoved}
                          onSeedPrompt={onSeedPrompt}
                        />
                      )
                    )}
                    {isStreamingAssistant ? <ChatWorkingIndicator showLabel={false} showCursor /> : null}
                  </div>
                ) : msg.role === "assistant" ? (
                  displayContent || isStreamingAssistant ? (
                    <div className="chat-msg-content">
                      <MarkdownContent content={displayContent} onOpenLink={onOpenBrowserUrl} />
                      {isStreamingAssistant ? <ChatWorkingIndicator showLabel={false} showCursor /> : null}
                    </div>
                  ) : null
                ) : userHasImageCells ? (
                  <div className="chat-msg-content chat-msg-content--with-cells">
                    {renderCellSegments(
                      displayContent,
                      displayCells,
                      (text, key) =>
                        text.trim() ? (
                          <span key={key} className="chat-msg-content">
                            <UserMessageContent content={text} onOpenLink={onOpenBrowserUrl} />
                          </span>
                        ) : null,
                      (cell, _index, key) => (
                        <AssistantCell
                          key={key}
                          cell={cell}
                          sessionId={sessionId}
                          onImageRemoved={handleImageRemoved}
                          onSeedPrompt={onSeedPrompt}
                        />
                      )
                    )}
                  </div>
                ) : (
                  <div className="chat-msg-content">
                    <UserMessageContent content={displayContent || "…"} onOpenLink={onOpenBrowserUrl} />
                  </div>
                )}
                {msg.interruptedBy === "gateway_restart" ? (
                  <p className="chat-tool-limit-note">{t("chat.gatewayRestarted")}</p>
                ) : null}
                  </>
                );
              })()}
              {msg.role === "user" &&
                !userHasImageCells &&
                msg.attachedFiles &&
                msg.attachedFiles.length > 0 && (
                <ul className="chat-msg-files" aria-label={t("chat.attachedFilesAria")}>
                  {msg.attachedFiles.map((f, j) => {
                    if (f.deleted) {
                      return (
                        <li key={`${f.name}-${j}`} className="chat-msg-file">
                          <span className="chat-cell-media-fallback">{t("chat.imageDeletedByUser")}</span>
                        </li>
                      );
                    }
                    const thumbSrc = f.previewUrl
                      ? resolveMediaSrc(f.previewUrl, apiBase)
                      : undefined;
                    const showThumb = Boolean(thumbSrc);
                    return (
                      <li
                        key={`${f.name}-${j}`}
                        className={`chat-msg-file${showThumb ? " chat-msg-file--image" : ""}`}
                      >
                        {showThumb && thumbSrc ? (
                          <button
                            type="button"
                            className="chat-msg-file-thumb-wrap"
                            title={`${f.name} — ${t("gallery.fullscreen")}`}
                            aria-label={t("gallery.fullscreen")}
                            onClick={() =>
                              setAttachmentLightbox({ src: thumbSrc, alt: f.name })
                            }
                          >
                            <img className="chat-msg-file-thumb" src={thumbSrc} alt={f.name} />
                          </button>
                        ) : (
                          <span
                            className="chat-msg-file-name"
                            title={`${f.name} — ${getFileTypeLabel(f.name)}`}
                          >
                            <FileIcon filename={f.name} size={18} />
                            {f.name}
                          </span>
                        )}
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>
            {(msg.role === "user" || (msg.role === "assistant" && msg.content)) && (
              <div className="chat-msg-actions">
                {msg.role === "assistant" && msg.content && (
                  <button
                    type="button"
                    className={`chat-msg-copy${copiedMessageIndex === i ? " chat-msg-copy--done" : ""}`}
                    onClick={() => {
                      const raw = msg.content;
                      if (!raw) return;
                      const text = markdownToPlainText(raw);
                      navigator.clipboard.writeText(text).then(
                        () => {
                          setCopiedMessageIndex(i);
                          setTimeout(() => setCopiedMessageIndex(null), 2000);
                        },
                        () => {}
                      );
                    }}
                    title={t("chat.copyTitle")}
                    aria-label={t("chat.copyAria")}
                  >
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                      <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
                      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
                    </svg>
                    {copiedMessageIndex === i ? t("common.copied") : t("common.copy")}
                  </button>
                )}
                <button
                  type="button"
                  className="chat-msg-fork"
                  onClick={() => handleForkFromMessage(i)}
                  disabled={busy}
                  title={t("chat.forkHint")}
                  aria-label={t("chat.forkAria")}
                >
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                    <circle cx="6" cy="4" r="2" />
                    <circle cx="6" cy="20" r="2" />
                    <circle cx="18" cy="6" r="2" />
                    <path d="M6 6v12" />
                    <path d="M18 8a8 8 0 0 1-8 8H6" />
                  </svg>
                  {t("chat.forkTitle")}
                </button>
              </div>
            )}
          </div>
          );
        })}
      </div>
      ) : null}
      {error && !isWebSurface && <p className="chat-error">{error}</p>}
      {!isWebSurface && visionEnabled && (
        <div className="chat-vision">
          <video
            ref={videoRef}
            className="chat-vision-video"
            muted
            playsInline
            autoPlay
            aria-label={t("chat.cameraPreviewAria")}
          />
          {visionError && <span className="chat-vision-error">{visionError}</span>}
        </div>
      )}
      {!isWebSurface && lastRunId != null && !ratingSent && (
        <div className="chat-rate">
          <span className="chat-rate-label">{t("chat.rateLabel")}</span>
          <button type="button" className="chat-rate-btn" onClick={() => handleRate(1)} aria-label={t("chat.like")}>
            <IconThumbUp size={16} />
          </button>
          <button type="button" className="chat-rate-btn" onClick={() => handleRate(0)} aria-label={t("chat.dislike")}>
            <IconThumbDown size={16} />
          </button>
        </div>
      )}
      <div className={`chat-composer-dock${isWebSurface ? " chat-composer-dock--web" : ""}`}>
      {insightOffer && insightText ? (
        <InsightCard
          offer={insightOffer}
          text={insightText}
          onOpenPast={() => onOpenPastChat?.(insightOffer.pastChatId)}
          onDismiss={() => {
            const o = insightOffer;
            setInsightOffer(null);
            setInsightText(null);
            void dismissInsightOffer({
              chatId: sessionId || sessionIdProp,
              pastChatId: o.pastChatId,
              reasonCode: o.reasonCode,
              insightTopic: o.insightTopic,
              score: o.score,
            }).catch(() => undefined);
          }}
        />
      ) : insightOffer ? (
        <InsightOfferCard
          offer={insightOffer}
          busy={insightBusy}
          onAccept={() => {
            const o = insightOffer;
            const chatId = sessionId || sessionIdProp;
            setInsightBusy(true);
            void acceptInsightOffer({
              chatId,
              pastChatId: o.pastChatId,
              reasonCode: o.reasonCode,
              insightTopic: o.insightTopic,
              score: o.score,
              excerpts: o.excerpts,
              currentBrief: lastUserBriefRef.current || o.insightTopic,
              pastChatTitle: o.pastChatTitle,
              dateLabel: new Date(o.pastChatUpdatedAt).toISOString().slice(0, 10),
            })
              .then((res) => {
                const text = res.text?.trim() || o.excerpts[0] || o.pastChatTitle;
                setInsightText(text);
                insightInjectRef.current = {
                  pastChatId: o.pastChatId,
                  reasonCode: o.reasonCode,
                  insightTopic: o.insightTopic,
                  excerpts: o.excerpts,
                  currentBrief: lastUserBriefRef.current || o.insightTopic,
                  pastChatTitle: o.pastChatTitle,
                  formulatedText: text,
                };
                if (o.reasonCode === "unresolved_thread") {
                  onOpenPastChat?.(o.pastChatId);
                }
              })
              .catch(() => undefined)
              .finally(() => setInsightBusy(false));
          }}
          onDismiss={() => {
            const o = insightOffer;
            setInsightOffer(null);
            setInsightText(null);
            void dismissInsightOffer({
              chatId: sessionId || sessionIdProp,
              pastChatId: o.pastChatId,
              reasonCode: o.reasonCode,
              insightTopic: o.insightTopic,
              score: o.score,
            }).catch(() => undefined);
          }}
          onOpenPast={() => onOpenPastChat?.(insightOffer.pastChatId)}
        />
      ) : null}
      <form
        ref={formRef}
        className={`chat-form${isWebSurface ? " chat-form--web" : ""}`}
        onSubmit={handleSubmit}
        onPaste={isWebSurface ? undefined : handlePaste}
        onPointerDownCapture={() => {
          // BrowserView may still own keyboard focus while the DOM composer is clickable.
          void restoreShellFocus().then(() => composerRef.current?.focus());
        }}
      >
        {!isWebSurface ? (
        <div className="chat-composer-top">
          <div className="chat-composer-ctx" role="status">
            <span className="chat-composer-ctx-ico" aria-hidden>
              <IconProject size={14} />
            </span>
            <span className="chat-composer-ctx-name">
              {projectName?.trim() || t("common.noProject")}
            </span>
          </div>
          <label className="chat-voice-toggle" title={t("chat.voiceTitle")}>
            <input
              type="checkbox"
              checked={replyWithVoice}
              onChange={(e) => {
                const on = e.target.checked;
                setReplyWithVoice(on);
                try {
                  localStorage.setItem("claw2.replyWithVoice", on ? "1" : "0");
                } catch {
                  // ignore quota / private mode
                }
                if (on) void ensureTtsAudioContext();
              }}
              aria-label={t("chat.voiceAria")}
            />
            <span className="chat-voice-toggle-track" aria-hidden />
            <span>{t("chat.voice")}</span>
          </label>
        </div>
        ) : null}
        <ChatQueuePanel
          queue={currentQueue}
          onSendNow={forceQueued}
          onEdit={editQueued}
          onRemove={(id) =>
            setQueues((prev) => ({
              ...prev,
              [queueSid]: removeQueued(prev[queueSid] ?? [], id),
            }))
          }
          onMove={(from, to) =>
            setQueues((prev) => ({
              ...prev,
              [queueSid]: moveQueued(prev[queueSid] ?? [], from, to),
            }))
          }
        />
        {queueHint && (
          <p className="chat-queue-hint" role="status">
            {t("chat.queueAttachmentsHint")}
          </p>
        )}
        <div className="chat-composer-input-row">
          {!isWebSurface && (
            <AssistantAvatar size="bar" />
          )}
          <ChatComposerInput
            ref={composerRef}
            resetKey={sessionIdProp}
            variant={isWebSurface ? "web" : "default"}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                formRef.current?.requestSubmit();
              }
            }}
            placeholder={
              busy
                ? t("chat.queuePlaceholder")
                : isWebSurface
                  ? t("browser.askPlaceholder")
                  : t("chat.placeholder")
            }
            aria-label={t("chat.messageAria")}
          />
        </div>
        {isWebSurface ? (
          <div className="chat-composer-web-actions">
            <button
              type="submit"
              className="chat-submit chat-submit--web"
              title={t("chat.sendTitle")}
              aria-label={t("chat.sendAria")}
            >
              <IconArrowUp size={18} />
            </button>
            {busy && (
              <button
                type="button"
                className="chat-submit chat-submit--web"
                onClick={() => {
                  ttsAbortedRef.current = true;
                  const sid = sessionIdRef.current || sessionId;
                  if (sid) onAbortSession?.(sid);
                  else abortControllerRef.current?.abort();
                }}
                title={t("chat.stopTitle")}
                aria-label={t("chat.stopAria")}
              >
                <IconStop size={14} />
              </button>
            )}
          </div>
        ) : null}
        {!isWebSurface ? (
        <div className="chat-composer-bottom">
          <div className="chat-file-label">
            <button
              type="button"
              className="chat-file-btn"
              title={t("chat.attachTitle")}
              aria-label={t("chat.attachAria")}
              onClick={openFilePicker}
            >
              <IconPlus size={18} />
            </button>
            <input
              ref={fileInputRef}
              type="file"
              multiple
              accept="image/*,.pdf,.txt,.md,.json,.csv,.doc,.docx,.xls,.xlsx,.zip"
              onChange={handleFileChange}
              className="chat-file-input"
              tabIndex={-1}
            />
          </div>
          {files.length > 0 && (
            <ul className="chat-files">
              {files.map((f, i) => {
                const preview = filePreviewUrls[i];
                const image = Boolean(preview);
                return (
                  <li
                    key={`${f.name}-${i}`}
                    className={`chat-file-item${image ? " chat-file-item--image" : ""}`}
                    title={f.name}
                  >
                    {image && preview ? (
                      <button
                        type="button"
                        className="chat-file-thumb-btn"
                        title={`${f.name} — ${t("gallery.fullscreen")}`}
                        aria-label={t("gallery.fullscreen")}
                        onClick={() => setAttachmentLightbox({ src: preview, alt: f.name })}
                      >
                        <img className="chat-file-thumb" src={preview} alt="" />
                      </button>
                    ) : (
                      <FileIcon filename={f.name} size={18} />
                    )}
                    {!image && <span className="chat-file-name">{f.name}</span>}
                    <button
                      type="button"
                      className="chat-file-remove"
                      onClick={() => removeFile(i)}
                      aria-label={t("chat.removeFile")}
                    >
                      <IconClose size={12} />
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
          <div className="chat-composer-actions">
            <ModelPicker
              sessionId={sessionIdProp || sessionId}
              chatModel={chatModel}
              onChatModelChange={onChatModelChange}
            />
            <button
              type="button"
              className={`chat-submit chat-ptt-btn${pttActive ? " chat-ptt-btn--active" : ""}${pttRecognizing ? " chat-ptt-btn--busy" : ""}`}
              title={pttRecognizing ? t("chat.sttRecognizing") : t("chat.pttTitle")}
              aria-label={t("chat.pttAria")}
              aria-pressed={pttActive}
              onPointerDown={(e) => void handlePttStart(e)}
              onPointerUp={(e) => void handlePttEnd(e)}
              onPointerCancel={(e) => void handlePttEnd(e)}
              disabled={busy || pttRecognizing}
            >
              <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
                <path d="M12 14c1.66 0 3-1.34 3-3V5c0-1.66-1.34-3-3-3S9 3.34 9 5v6c0 1.66 1.34 3 3 3zm5.91-3c-.49 0-.9.36-.98.85C16.52 14.2 14.47 16 12 16s-4.52-1.8-4.93-4.15c-.08-.49-.49-.85-.98-.85-.61 0-1.09.54-1 1.14.49 3 2.89 5.35 5.91 5.78V20c0 .55.45 1 1 1s1-.45 1-1v-2.08c3.02-.43 5.42-2.78 5.91-5.78.1-.6-.39-1.14-1-1.14z" />
              </svg>
            </button>
            <button
              type="submit"
              className="chat-submit"
              title={t("chat.sendTitle")}
              aria-label={t("chat.sendAria")}
            >
              <IconArrowUp size={18} />
            </button>
            {busy && (
              <button
                type="button"
                className="chat-submit"
                onClick={() => {
                  ttsAbortedRef.current = true;
                  const sid = sessionIdRef.current || sessionId;
                  if (sid) onAbortSession?.(sid);
                  else abortControllerRef.current?.abort();
                }}
                title={t("chat.stopTitle")}
                aria-label={t("chat.stopAria")}
              >
                <IconStop size={14} />
              </button>
            )}
          </div>
        </div>
        ) : null}
      </form>
      </div>
      {attachmentLightbox && (
        <ImageLightbox
          src={attachmentLightbox.src}
          alt={attachmentLightbox.alt}
          onClose={() => setAttachmentLightbox(null)}
        />
      )}
    </div>
  );
}
