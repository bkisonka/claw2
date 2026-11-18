import { useState, useRef, useEffect, useCallback, memo, type PointerEvent as ReactPointerEvent, type MouseEvent as ReactMouseEvent } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeSanitize from "rehype-sanitize";
import {
  sendMessageStream,
  readFileAsBase64,
  downloadChatFile,
  type DocumentToSend,
  type ChatCell,
  type HistoryMessageApi,
} from "../api/chat";
import { voiceStt } from "../api/voice";
import { toWavBlob } from "../lib/audioToWav";
import { rateRun } from "../api/agentSelection";
import { FileIcon, getFileTypeLabel } from "./FileIcon";
import { ContextMenu, selectionTextIn, writeClipboard, type ContextMenuItem, type ContextMenuState } from "./ContextMenu";
import { messagePlainText } from "../utils/markdown-to-plain";
import { setChatPinnedProvider } from "../engine/db";
import { isStoredFileUrl, resolveStoredFileUrl } from "../engine/files";
import { sanitizeCellHtml } from "../engine/cells";
import { useNearViewport } from "../lib/useNearViewport";
import { ChartCell } from "./ChartCell";
import { IconAttach, IconCamera, IconMic, IconSend, IconVideo } from "./icons";

/**
 * Renders Markdown in assistant messages. memo is the energy/perf anchor of
 * the feed: a stream paints ~12×/s, and without memo every paint re-parsed
 * the markdown of EVERY message in the chat, not just the growing one.
 */
const MarkdownContent = memo(function MarkdownContent({ content }: { content: string }) {
  if (!content.trim()) return null;
  return (
    <div className="chat-msg-markdown-wrapper">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[rehypeSanitize]}
        className="chat-msg-markdown"
        components={{
          a: ({ href, children }) => (
            <a href={href} target="_blank" rel="noopener noreferrer">
              {children}
            </a>
          ),
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
});

/** Sanitized HTML cell — memo keeps the sanitizer from re-running on stable cells. */
const HtmlCell = memo(function HtmlCell({ html }: { html: string }) {
  // Re-sanitized at render: cells stored by older app versions were sanitized
  // with weaker rules. The pass is idempotent.
  return <div className="chat-cell-html" dangerouslySetInnerHTML={{ __html: sanitizeCellHtml(html) }} />;
});

/**
 * Lazy media source: a /files/raw/<id> ref resolves to its data: URL only when
 * the cell is near the viewport AND mounted — opening a chat never pulls every
 * attachment's bytes through IndexedDB.
 */
function useMediaUrl(ref: string, enabled: boolean): { url: string; ready: boolean } {
  const stored = isStoredFileUrl(ref);
  const [resolved, setResolved] = useState<string | null>(stored ? null : ref);
  useEffect(() => {
    if (!enabled) return;
    if (!isStoredFileUrl(ref)) {
      setResolved(ref);
      return;
    }
    let cancelled = false;
    setResolved(null);
    resolveStoredFileUrl(ref)
      .then((d) => {
        if (!cancelled) setResolved(d ?? ref);
      })
      .catch(() => {
        if (!cancelled) setResolved(ref);
      });
    return () => {
      cancelled = true;
    };
  }, [ref, enabled]);
  return { url: resolved ?? "", ready: resolved !== null };
}

/** Renders an audio/video/image cell with fallback on load error or empty URL. */
const MediaCell = memo(function MediaCell({ cell }: { cell: ChatCell }) {
  const [viewRef, near] = useNearViewport<HTMLDivElement>();
  const [loadError, setLoadError] = useState(false);
  const [sharing, setSharing] = useState(false);
  const { url, ready } = useMediaUrl(cell.content, near);
  // A resolution swap (ref → data URL) must clear a load error from the old src.
  useEffect(() => setLoadError(false), [url]);
  const shareImage = async () => {
    setSharing(true);
    try {
      // data:/files/raw URLs carry no usable name — make one from the mime.
      const mime = url.startsWith("data:") ? url.slice(5, url.indexOf(";")) : "image/png";
      const ext = mime.includes("png") ? "png" : mime.includes("webp") ? "webp" : mime.includes("gif") ? "gif" : "jpg";
      const name = `claw2-${new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)}.${ext}`;
      await downloadChatFile(url, name);
    } catch (e) {
      window.alert(`Не удалось поделиться изображением: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setSharing(false);
    }
  };
  if (!near) {
    return <div ref={viewRef} className="chat-cell-media-placeholder" aria-hidden />;
  }
  if (!ready) {
    return <div className="chat-cell-media-fallback">Загрузка…</div>;
  }
  if (!url) {
    return <div className="chat-cell-media-fallback">Ссылка не прошла проверку.</div>;
  }
  if (loadError) {
    return (
      <div className="chat-cell-media-fallback">
        Не удалось загрузить.{" "}
        <a href={url} target="_blank" rel="noopener noreferrer">
          Открыть
        </a>
      </div>
    );
  }
  if (cell.type === "audio") {
    return (
      <audio
        className="chat-cell-audio"
        controls
        playsInline
        src={url}
        preload="metadata"
        onError={() => setLoadError(true)}
      />
    );
  }
  if (cell.type === "video") {
    return (
      <video
        className="chat-cell-video"
        controls
        playsInline
        src={url}
        preload="metadata"
        onError={() => setLoadError(true)}
      />
    );
  }
  if (cell.type === "image") {
    return (
      <button
        type="button"
        className="chat-cell-image-btn"
        disabled={sharing}
        title="Поделиться или сохранить"
        aria-label="Поделиться изображением"
        onClick={() => void shareImage()}
      >
        <img className="chat-cell-image" src={url} alt="" loading="lazy" onError={() => setLoadError(true)} />
      </button>
    );
  }
  return <pre className="chat-cell-raw">{cell.content}</pre>;
});

const MAX_FILE_SIZE = 15 * 1024 * 1024;
const MAX_FILES = 20;
const OCR_MESSAGE = "Распознай прикреплённый документ и сохрани результат в файл.";

interface Message {
  role: "user" | "assistant";
  content: string;
  attachedFiles?: { name: string }[];
  cells?: ChatCell[];
  /** Tool currently executing for this reply (feed status line). */
  toolActive?: string;
  /** Router info: who served this reply (tap → pin/unpin this chat). */
  routed?: { id: string; name: string; model: string; pinned: boolean; why: string } | null;
}

interface ChatProps {
  sessionId: string;
  onSessionIdChange: (id: string) => void;
  onSessionFilesRefresh?: () => void;
  onChatListRefresh?: () => void;
  /** History from the server; reapplied when sessionId changes. */
  initialMessages?: HistoryMessageApi[];
  historyKey?: string;
}

function historyToMessages(history: HistoryMessageApi[] | undefined): Message[] {
  if (!history?.length) return [];
  return history.map((m) => ({
    role: m.role,
    content: m.content ?? "",
    cells: m.cells,
    attachedFiles: m.attachedFiles
      ?.filter((f) => !f.deleted)
      .map((f) => ({ name: f.name })),
  }));
}

export function Chat({
  sessionId,
  onSessionIdChange,
  onSessionFilesRefresh,
  onChatListRefresh,
  initialMessages,
  historyKey,
}: ChatProps) {
  const [messages, setMessages] = useState<Message[]>(() => historyToMessages(initialMessages));
  const [input, setInput] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastRunId, setLastRunId] = useState<number | null>(null);
  const [ratingSent, setRatingSent] = useState(false);
  const [pttActive, setPttActive] = useState(false);
  const [pttBusy, setPttBusy] = useState(false);
  const [attachOpen, setAttachOpen] = useState(false);
  const [ctxMenu, setCtxMenu] = useState<ContextMenuState | null>(null);
  const [copiedMsgIndex, setCopiedMsgIndex] = useState<number | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const photoInputRef = useRef<HTMLInputElement>(null);
  const videoInputRef = useRef<HTMLInputElement>(null);
  const logRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const formRef = useRef<HTMLFormElement>(null);
  const abortControllerRef = useRef<AbortController | null>(null);
  /** True while send() is between entry and finally — beats stale `loading` closures. */
  const sendInFlightRef = useRef(false);
  const pttChunksRef = useRef<Blob[]>([]);
  const pttRecorderRef = useRef<MediaRecorder | null>(null);
  const pttStreamRef = useRef<MediaStream | null>(null);
  const pttBusyRef = useRef(false);
  /** Finger is currently down on the mic — sync flag to beat async getUserMedia race. */
  const pttHoldingRef = useRef(false);
  const pttPointerIdRef = useRef<number | null>(null);
  const pttMicUnlockedRef = useRef(false);
  const pttBtnRef = useRef<HTMLButtonElement>(null);
  const sendRef = useRef<(messageText: string, filesToSend: File[]) => Promise<void>>(async () => {});

  useEffect(() => {
    setMessages(historyToMessages(initialMessages));
    setError(null);
    setLastRunId(null);
    setRatingSent(false);
    setInput("");
    setFiles([]);
    setAttachOpen(false);
    abortControllerRef.current?.abort();
    setLoading(false);
  }, [historyKey]);

  // Quiet live sync while this chat stays open (other client / desktop)
  useEffect(() => {
    if (loading) return;
    const next = historyToMessages(initialMessages);
    setMessages((prev) => {
      if (next.length > prev.length) return next;
      if (next.length < prev.length) return prev;
      const a = prev[prev.length - 1];
      const b = next[next.length - 1];
      if (!a || !b) return next.length ? next : prev;
      if (a.role !== b.role || a.content !== b.content) return next;
      return prev;
    });
  }, [initialMessages, loading]);

  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [messages]);

  const adjustTextareaHeight = () => {
    const ta = textareaRef.current;
    if (!ta) return;
    ta.style.height = "auto";
    ta.style.height = `${Math.min(ta.scrollHeight, 160)}px`;
  };
  useEffect(() => adjustTextareaHeight(), [input]);

  const addFiles = (chosen: File[]) => {
    const valid = chosen.filter((f) => f.size <= MAX_FILE_SIZE).slice(0, MAX_FILES);
    if (valid.length < chosen.length) {
      setError(`Часть файлов пропущена (лимит ${MAX_FILE_SIZE / (1024 * 1024)} МБ / файл).`);
    }
    setFiles((prev) => [...prev, ...valid].slice(-MAX_FILES));
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    addFiles(Array.from(e.target.files ?? []));
    e.target.value = "";
  };

  const stampName = (prefix: string, ext: string) => {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    return `${prefix}-${stamp}.${ext}`;
  };

  const handleCaptureChange = (e: React.ChangeEvent<HTMLInputElement>, kind: "photo" | "video") => {
    const list = Array.from(e.target.files ?? []);
    e.target.value = "";
    if (!list.length) return;
    const named = list.map((f) => {
      const type = f.type || (kind === "photo" ? "image/jpeg" : "video/mp4");
      const ext =
        kind === "photo"
          ? type.includes("png")
            ? "png"
            : type.includes("webp")
              ? "webp"
              : "jpg"
          : type.includes("webm")
            ? "webm"
            : "mp4";
      const name = f.name && f.name !== "image.jpg" && f.name !== "image.png" ? f.name : stampName(kind, ext);
      return f.name === name ? f : new File([f], name, { type });
    });
    addFiles(named);
  };

  const handlePaste = (e: React.ClipboardEvent) => {
    const items = Array.from(e.clipboardData?.items ?? []);
    const pasted: File[] = [];
    for (const item of items) {
      if (item.kind === "file") {
        const f = item.getAsFile();
        if (f) pasted.push(f);
      }
    }
    if (pasted.length) {
      e.preventDefault();
      addFiles(pasted);
    }
  };

  const removeFile = (index: number) => setFiles((prev) => prev.filter((_, i) => i !== index));

  const send = async (messageText: string, filesToSend: File[]) => {
    // Ref, not just state: a double-tap can hit two renders where `loading`
    // is still stale-false; the ref is the authoritative in-flight flag.
    if (loading || sendInFlightRef.current) return;
    sendInFlightRef.current = true;
    try {
      await sendInner(messageText, filesToSend);
    } finally {
      sendInFlightRef.current = false;
    }
  };

  const sendInner = async (messageText: string, filesToSend: File[]) => {
    setError(null);
    setRatingSent(false);
    setLastRunId(null);
    const displayText =
      messageText || (filesToSend.length ? `Прикреплено файлов: ${filesToSend.length}` : "");
    const attachedFiles = filesToSend.map((f) => ({ name: f.name }));
    setMessages((prev) => [
      ...prev,
      {
        role: "user",
        content: displayText,
        attachedFiles: attachedFiles.length ? attachedFiles : undefined,
      },
    ]);
    setInput("");
    setFiles([]);
    setLoading(true);
    abortControllerRef.current?.abort();
    abortControllerRef.current = new AbortController();
    const signal = abortControllerRef.current.signal;
    setMessages((prev) => [...prev, { role: "assistant", content: "" }]);
    try {
      let documents: DocumentToSend[] | undefined;
      if (filesToSend.length > 0) {
        // Sequential read: one base64 string at a time. Promise.all over 20
        // files × 15MB spiked ~300MB of strings before the upload — pure GC
        // pressure; the turn waits for all of them either way.
        documents = [];
        for (const f of filesToSend) {
          documents.push(await readFileAsBase64(f));
        }
      }
      // Throttle stream paints (~80ms) and replace (not append) the last bubble
      // with the parsed snapshot — closed [CELL] blocks render live.
      // setTimeout, NOT requestAnimationFrame: rAF is frozen in hidden tabs and
      // backgrounded WebViews, which made every reply appear only at stream end.
      let pendingSnap: { text: string; cells: ChatCell[]; tool?: string } | null = null;
      let timer = 0;
      let lastPaint = 0;
      const flushSnap = () => {
        timer = 0;
        lastPaint = Date.now();
        const snap = pendingSnap;
        if (!snap) return;
        setMessages((prev) => {
          const next = [...prev];
          const last = next[next.length - 1];
          if (last?.role === "assistant") {
            next[next.length - 1] = {
              ...last,
              content: snap.tool ? last.content : snap.text,
              cells: snap.cells.length ? snap.cells : undefined,
              toolActive: snap.tool,
            };
          }
          return next;
        });
      };
      const res = await sendMessageStream(
        messageText || "См. прикреплённые файлы.",
        sessionId || undefined,
        documents,
        (snap) => {
          pendingSnap = snap;
          if (document.hidden) {
            flushSnap();
            return;
          }
          const wait = Math.max(0, 80 - (Date.now() - lastPaint));
          if (!timer) timer = window.setTimeout(flushSnap, wait);
        },
        signal
      );
      if (timer) window.clearTimeout(timer);
      flushSnap();
      if (res.sessionId) {
        onSessionIdChange(res.sessionId);
      }
        setMessages((prev) => {
          const next = [...prev];
          const last = next[next.length - 1];
          if (last?.role === "assistant") {
            next[next.length - 1] = {
              ...last,
              content: res.content || last.content,
              cells: res.cells,
              toolActive: undefined,
              routed: res.routed ?? null,
            };
          }
        // Preview of uploaded user images (persistent URLs)
        if (res.userCells?.length) {
          for (let i = next.length - 1; i >= 0; i--) {
            if (next[i].role === "user") {
              next[i] = { ...next[i], cells: res.userCells };
              break;
            }
          }
        }
        return next;
      });
      if (res.lastRunId != null) setLastRunId(res.lastRunId);
      if (res.error) setError(res.error);
      onSessionFilesRefresh?.();
      onChatListRefresh?.();
    } catch (err) {
      const isAbort = err instanceof Error && err.name === "AbortError";
      if (!isAbort) {
        setError(err instanceof Error ? err.message : String(err));
        setMessages((prev) => {
          const next = [...prev];
          const last = next[next.length - 1];
          if (last?.role === "assistant" && last.content === "") {
            next[next.length - 1] = { ...last, content: `Ошибка: ${err}` };
          } else {
            next.push({ role: "assistant", content: `Ошибка: ${err}` });
          }
          return next;
        });
      }
    } finally {
      setLoading(false);
    }
  };

  sendRef.current = send;

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const text = input.trim();
    if (!text && files.length === 0) return;
    void send(text, [...files]);
  };

  const handleOcr = () => {
    if (files.length === 0) return;
    void send(OCR_MESSAGE, [...files]);
  };

  const stopPttTracks = useCallback(() => {
    const stream = pttStreamRef.current;
    pttStreamRef.current = null;
    if (!stream) return;
    for (const track of stream.getTracks()) {
      try {
        track.stop();
      } catch {
        // ignore
      }
    }
  }, []);

  const ensureMicStream = useCallback(async (): Promise<MediaStream> => {
    stopPttTracks();
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
      },
    });
    pttStreamRef.current = stream;
    pttMicUnlockedRef.current = true;
    return stream;
  }, [stopPttTracks]);

  const finalizePttRecording = useCallback(async () => {
    const recorder = pttRecorderRef.current;
    pttRecorderRef.current = null;
    setPttActive(false);

    if (!recorder || recorder.state === "inactive") {
      stopPttTracks();
      return;
    }
    if (pttBusyRef.current) {
      stopPttTracks();
      return;
    }
    pttBusyRef.current = true;
    setPttBusy(true);
    try {
      const stopped = new Promise<void>((resolve) => {
        recorder.addEventListener("stop", () => resolve(), { once: true });
      });
      recorder.stop();
      await stopped;
      // Release mic as soon as recording is done (before STT / send)
      stopPttTracks();
      const chunks = pttChunksRef.current;
      pttChunksRef.current = [];
      if (chunks.length === 0) {
        setError("Не удалось записать звук");
        return;
      }
      const blob = new Blob(chunks, { type: chunks[0]?.type || "audio/webm" });
      if (blob.size < 800) {
        setError("Слишком короткая запись — удерживайте кнопку, пока говорите");
        return;
      }

      let text = "";
      try {
        // Happy path sends the recorded container as-is (opus/webm/mp4 —
        // OpenAI-compatible STT takes them natively): ~25× fewer bytes than
        // PCM WAV and no decode pass. WAV re-encode only as a fallback for
        // servers that answered and rejected the request.
        let result = await voiceStt(blob);
        if (result.status != null && result.status >= 400) {
          result = await voiceStt(await toWavBlob(blob));
        }
        if (result.text) text = result.text;
        else {
          setError(result.error ? `Не распознано: ${result.error}` : "Не удалось распознать речь — попробуйте ещё раз");
          return;
        }
      } catch (err) {
        setError(err instanceof Error ? `Не удалось распознать речь: ${err.message}` : "Не удалось распознать речь");
        return;
      }

      await sendRef.current(text, []);
    } catch (err) {
      stopPttTracks();
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      pttBusyRef.current = false;
      setPttBusy(false);
    }
  }, [stopPttTracks]);

  const handlePttEnd = useCallback(() => {
    if (!pttHoldingRef.current && !pttRecorderRef.current) return;
    pttHoldingRef.current = false;
    pttPointerIdRef.current = null;
    void finalizePttRecording();
  }, [finalizePttRecording]);

  const handlePttStart = useCallback(
    (e: ReactPointerEvent<HTMLButtonElement> | React.TouchEvent<HTMLButtonElement>) => {
      e.preventDefault();
      e.stopPropagation();
      if (loading || pttBusyRef.current) return;

      // Already holding (duplicate touch+pointer) — ignore
      if (pttHoldingRef.current) return;
      pttHoldingRef.current = true;
      setError(null);
      setPttActive(true);

      if ("pointerId" in e) {
        pttPointerIdRef.current = e.pointerId;
        try {
          e.currentTarget.setPointerCapture(e.pointerId);
        } catch {
          // ignore
        }
      }

      const onWinPointerUp = (ev: PointerEvent) => {
        if (pttPointerIdRef.current != null && ev.pointerId !== pttPointerIdRef.current) return;
        window.removeEventListener("pointerup", onWinPointerUp, true);
        window.removeEventListener("pointercancel", onWinPointerUp, true);
        window.removeEventListener("touchend", onWinTouchEnd, true);
        window.removeEventListener("touchcancel", onWinTouchEnd, true);
        handlePttEnd();
      };
      const onWinTouchEnd = () => {
        window.removeEventListener("pointerup", onWinPointerUp, true);
        window.removeEventListener("pointercancel", onWinPointerUp, true);
        window.removeEventListener("touchend", onWinTouchEnd, true);
        window.removeEventListener("touchcancel", onWinTouchEnd, true);
        handlePttEnd();
      };
      window.addEventListener("pointerup", onWinPointerUp, true);
      window.addEventListener("pointercancel", onWinPointerUp, true);
      window.addEventListener("touchend", onWinTouchEnd, true);
      window.addEventListener("touchcancel", onWinTouchEnd, true);

      void (async () => {
        try {
          const stream = await ensureMicStream();
          if (!pttHoldingRef.current) {
            stopPttTracks();
            setPttActive(false);
            return;
          }
          const mimeCandidates = ["audio/mp4", "audio/webm;codecs=opus", "audio/webm"];
          const mimeType = mimeCandidates.find((m) => MediaRecorder.isTypeSupported(m));
          const recorder = mimeType
            ? new MediaRecorder(stream, { mimeType })
            : new MediaRecorder(stream);
          pttChunksRef.current = [];
          recorder.ondataavailable = (ev) => {
            if (ev.data.size > 0) pttChunksRef.current.push(ev.data);
          };
          recorder.start(250);
          pttRecorderRef.current = recorder;
          // Released while getUserMedia / recorder setup was in flight
          if (!pttHoldingRef.current) {
            void finalizePttRecording();
          }
        } catch (err) {
          pttHoldingRef.current = false;
          setPttActive(false);
          stopPttTracks();
          setError(
            err instanceof Error
              ? err.message.includes("Permission") || err.name === "NotAllowedError"
                ? "Нет доступа к микрофону. Разрешите запись звука в настройках приложения."
                : err.message
              : String(err)
          );
        }
      })();
    },
    [loading, ensureMicStream, stopPttTracks, handlePttEnd, finalizePttRecording]
  );

  useEffect(() => {
    return () => {
      pttHoldingRef.current = false;
      try {
        pttRecorderRef.current?.stop();
      } catch {
        // ignore
      }
      pttRecorderRef.current = null;
      stopPttTracks();
    };
  }, [stopPttTracks]);

  const handleRate = async (rating: 0 | 1) => {
    if (lastRunId == null || ratingSent) return;
    try {
      await rateRun(lastRunId, rating);
      setRatingSent(true);
    } catch {
      // ignore
    }
  };

  const renderCellsContent = (msg: Message, placeholder: string) => {
    if (msg.cells && msg.cells.length > 0) {
      const parts = (msg.content || placeholder).split(/(\[CELL_(\d+)\])/g);
      const renderCell = (cell: ChatCell, key: string) => {
        const isMedia = cell.type === "audio" || cell.type === "video" || cell.type === "image";
        return (
          <div key={key} className="chat-cell">
            {cell.type === "html" ? (
              <HtmlCell html={cell.content} />
            ) : cell.type === "chart" ? (
              <ChartCell content={cell.content} />
            ) : isMedia ? (
              <MediaCell cell={cell} />
            ) : (
              <pre className="chat-cell-raw">{cell.content}</pre>
            )}
          </div>
        );
      };
      // Placeholder-driven cells (assistant). User attachments carry cells
      // WITHOUT a [CELL_N] marker in the text — they render after the text so
      // attached-image previews survive history reloads.
      const referenced = new Set<number>();
      const renderedParts = parts.map((part, k) => {
        if (/^\[CELL_\d+\]$/.test(part)) {
          const idx = parseInt(parts[k + 1], 10);
          const cell = !isNaN(idx) ? msg.cells?.[idx] : null;
          if (cell) {
            referenced.add(idx);
            return renderCell(cell, `cell-${k}`);
          }
          return null;
        }
        if (k > 0 && /^\d+$/.test(part)) return null;
        return part ? (
          <span key={k} className="chat-msg-markdown-wrap">
            {msg.role === "assistant" ? <MarkdownContent content={part} /> : part}
          </span>
        ) : null;
      });
      const unrefCells = msg.cells
        .map((cell, i) => ({ cell, i }))
        .filter(({ i }) => !referenced.has(i));
      return (
        <div className="chat-msg-content chat-msg-content--with-cells">
          {renderedParts}
          {unrefCells.map(({ cell, i }) => renderCell(cell, `cell-plain-${i}`))}
        </div>
      );
    }
    if (msg.role === "assistant") {
      return (
        <div className="chat-msg-content">
          <MarkdownContent content={msg.content || placeholder} />
        </div>
      );
    }
    return <span className="chat-msg-content">{msg.content || placeholder}</span>;
  };

  /** Routing meta: tap → pin/unpin this chat to the provider that answered. */
  const openRoutedMenu = (e: ReactMouseEvent, i: number, routed: NonNullable<Message["routed"]>) => {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    setCtxMenu({
      x: r.left,
      y: r.bottom + 4,
      preferUp: r.bottom > window.innerHeight - 200,
      items: [
        ...(routed.why
          ? [{ type: "item" as const, id: "why", label: `Почему: ${routed.why}`, disabled: true }]
          : []),
        routed.pinned
          ? {
              type: "item" as const,
              id: "unpin",
              label: "Открепить от чата",
              onClick: () => {
                void setChatPinnedProvider(sessionId, null);
                setMessages((prev) =>
                  prev.map((m, k) =>
                    k === i && m.routed ? { ...m, routed: { ...m.routed, pinned: false } } : m
                  )
                );
              },
            }
          : {
              type: "item" as const,
              id: "pin",
              label: "Закрепить за чатом",
              onClick: () => {
                void setChatPinnedProvider(sessionId, routed.id);
                setMessages((prev) =>
                  prev.map((m, k) =>
                    k === i && m.routed ? { ...m, routed: { ...m.routed, pinned: true } } : m
                  )
                );
              },
            },
      ],
    });
  };

  /** Desktop-parity message menu (long-press on mobile / right-click on desktop). */
  const openMessageMenu = (e: ReactMouseEvent, i: number, msg: Message) => {
    const msgEl = e.currentTarget as HTMLElement;
    const bodyEl = msgEl.querySelector("[data-msg-body]") as HTMLElement | null;
    const selected = selectionTextIn(msgEl).trim();
    const plain = messagePlainText(msg.content || "");
    if (!plain && !selected) return;
    const items: ContextMenuItem[] = [];
    if (selected) {
      items.push({
        type: "item",
        id: "copy-selection",
        label: "Копировать выделение",
        onClick: () => {
          void writeClipboard(selected);
        },
      });
    }
    items.push({
      type: "item",
      id: "copy-message",
      label: "Копировать сообщение",
      onClick: () => {
        void writeClipboard(plain).then((ok) => {
          if (!ok) return;
          setCopiedMsgIndex(i);
          window.setTimeout(() => setCopiedMsgIndex((cur) => (cur === i ? null : cur)), 2000);
        });
      },
    });
    items.push({
      type: "item",
      id: "select-message",
      label: "Выделить сообщение",
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
      label: "Цитировать в поле ввода",
      onClick: () => {
        const src = selected || plain;
        const quoted = src
          .split(/\r?\n/)
          .map((line) => `> ${line}`)
          .join("\n");
        setInput((cur) => (cur.trim() ? `${cur.replace(/\s+$/, "")}\n\n${quoted}\n\n` : `${quoted}\n\n`));
        window.setTimeout(() => {
          textareaRef.current?.focus();
          adjustTextareaHeight();
        }, 0);
      },
    });
    setCtxMenu({
      x: e.clientX,
      y: e.clientY,
      items,
      preferUp: e.clientY > window.innerHeight - 240,
    });
  };

  return (
    <div className="chat-root">
      <div className="chat-log" ref={logRef}>
        {messages.length === 0 && (
          <div className="chat-welcome">
            <p className="chat-welcome-text">Готов. Напишите сообщение или прикрепите документ.</p>
          </div>
        )}
        {messages.map((msg, i) => (
          <div
            key={i}
            className={`chat-msg chat-msg--${msg.role}`}
            onContextMenu={(e) => {
              // Right-click on desktop; Android WebView fires the same event on
              // long-press (Telegram-style menu; native text selection is
              // suppressed for that gesture — «Выделить сообщение» restores it).
              e.preventDefault();
              openMessageMenu(e, i, msg);
            }}
          >
            {copiedMsgIndex === i && <span className="chat-msg-copied">Скопировано</span>}
            <div className="chat-msg-body" data-msg-body={i}>
              {msg.toolActive && (
                <div className="chat-tool-status">🔧 Вызов инструмента: {msg.toolActive}…</div>
              )}
              {(msg.content || (loading && i === messages.length - 1 && msg.role === "assistant") || msg.cells)
                ? renderCellsContent(
                    msg,
                    loading && i === messages.length - 1 && msg.role === "assistant" ? "…" : ""
                  )
                : null}
              {msg.role === "user" && msg.attachedFiles && msg.attachedFiles.length > 0 && (
                <ul className="chat-msg-files" aria-label="Прикреплённые файлы">
                  {msg.attachedFiles.map((f, j) => (
                    <li key={`${f.name}-${j}`} className="chat-msg-file">
                      <span className="chat-msg-file-name" title={getFileTypeLabel(f.name)}>
                        <FileIcon filename={f.name} size={18} />
                        {f.name}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
            {msg.role === "assistant" && msg.routed && (
              <button
                type="button"
                className="chat-routed-meta"
                onClick={(e) => openRoutedMenu(e, i, msg.routed!)}
                title="Кто отвечал; тап — закрепить/открепить модель за чатом"
              >
                → {msg.routed.model} · {msg.routed.name}
                {msg.routed.pinned ? " · закреплено" : ""}
              </button>
            )}
          </div>
        ))}
      </div>
      {error && <p className="chat-error">{error}</p>}
      {lastRunId != null && !ratingSent && (
        <div className="chat-rate">
          <span className="chat-rate-label">Оценка:</span>
          <button type="button" className="chat-rate-btn" onClick={() => handleRate(1)} aria-label="Нравится">
            👍
          </button>
          <button type="button" className="chat-rate-btn" onClick={() => handleRate(0)} aria-label="Не нравится">
            👎
          </button>
        </div>
      )}
      <form ref={formRef} className="chat-form" onSubmit={handleSubmit}>
        {attachOpen && (
          <div className="chat-attach-sheet" role="dialog" aria-label="Вложение">
            <button
              type="button"
              className="chat-attach-backdrop"
              aria-label="Закрыть"
              onClick={() => setAttachOpen(false)}
            />
            <div className="chat-attach-panel">
              <button
                type="button"
                className="chat-attach-item"
                disabled={loading || pttBusy}
                onClick={() => {
                  setAttachOpen(false);
                  fileInputRef.current?.click();
                }}
              >
                <span className="chat-attach-item-icon">
                  <IconAttach size={22} />
                </span>
                <span className="chat-attach-item-label">Файл</span>
              </button>
              <button
                type="button"
                className="chat-attach-item"
                disabled={loading || pttBusy}
                onClick={() => {
                  setAttachOpen(false);
                  photoInputRef.current?.click();
                }}
              >
                <span className="chat-attach-item-icon">
                  <IconCamera size={22} />
                </span>
                <span className="chat-attach-item-label">Фото</span>
              </button>
              <button
                type="button"
                className="chat-attach-item"
                disabled={loading || pttBusy}
                onClick={() => {
                  setAttachOpen(false);
                  videoInputRef.current?.click();
                }}
              >
                <span className="chat-attach-item-icon">
                  <IconVideo size={22} />
                </span>
                <span className="chat-attach-item-label">Видео</span>
              </button>
            </div>
          </div>
        )}
        <input
          ref={fileInputRef}
          type="file"
          multiple
          accept="image/*,video/*,audio/*,.pdf,.doc,.docx,.txt,.md,.csv,.xlsx,.xls,.rtf,.png,.jpg,.jpeg,.heic,.webp,.webm,.mp4,.mov,.m4a,.wav"
          onChange={handleFileChange}
          disabled={loading || pttBusy}
          className="chat-file-input"
          aria-hidden
          tabIndex={-1}
        />
        <input
          ref={photoInputRef}
          type="file"
          accept="image/*"
          className="chat-file-input"
          aria-hidden
          tabIndex={-1}
          onChange={(e) => handleCaptureChange(e, "photo")}
        />
        <input
          ref={videoInputRef}
          type="file"
          accept="video/*"
          className="chat-file-input"
          aria-hidden
          tabIndex={-1}
          onChange={(e) => handleCaptureChange(e, "video")}
        />
        <div className="chat-input-wrap">
          <button
            type="button"
            className={`chat-file-label${attachOpen ? " chat-file-label--open" : ""}`}
            title="Прикрепить"
            aria-label="Прикрепить"
            aria-expanded={attachOpen}
            disabled={loading || pttBusy}
            onClick={() => setAttachOpen((v) => !v)}
          >
            <IconAttach size={22} />
          </button>
          <textarea
            ref={textareaRef}
            className="chat-input"
            value={input}
            onChange={(e) => {
              setInput(e.target.value);
              adjustTextareaHeight();
            }}
            onPaste={handlePaste}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                formRef.current?.requestSubmit();
              }
            }}
            placeholder={pttActive ? "Говорите…" : pttBusy ? "Распознаю…" : "Сообщение"}
            disabled={loading || pttBusy}
            rows={1}
            aria-label="Сообщение"
            enterKeyHint="send"
          />
          <div className="chat-submit-wrap">
            {files.length > 0 && (
              <button
                type="button"
                className="chat-submit chat-submit-ocr"
                onClick={handleOcr}
                disabled={loading || pttBusy}
                title="Отправить на распознавание"
                aria-label="Отправить на распознавание"
              >
                OCR
              </button>
            )}
            {loading ? (
              <button
                type="button"
                className="chat-submit chat-submit-stop"
                onClick={() => abortControllerRef.current?.abort()}
                title="Остановить"
                aria-label="Остановить"
              >
                <span className="chat-submit-stop-icon" />
              </button>
            ) : input.trim() || files.length > 0 ? (
              <button
                type="submit"
                className="chat-submit"
                disabled={pttBusy}
                title="Отправить"
                aria-label="Отправить"
              >
                <IconSend size={20} />
              </button>
            ) : (
              <button
                ref={pttBtnRef}
                type="button"
                className={`chat-submit chat-ptt-btn${pttActive ? " chat-ptt-btn--active" : ""}${pttBusy ? " chat-ptt-btn--busy" : ""}`}
                title={pttBusy ? "Распознавание…" : "Удерживайте, чтобы говорить"}
                aria-label="Голосовое сообщение — удерживайте"
                aria-pressed={pttActive}
                disabled={pttBusy}
                onContextMenu={(e) => e.preventDefault()}
                onPointerDown={handlePttStart}
                onTouchStart={handlePttStart}
              >
                <IconMic size={20} />
              </button>
            )}
          </div>
        </div>
        {files.length > 0 && (
          <ul className="chat-files">
            {files.map((f, i) => (
              <li key={`${f.name}-${i}`} className="chat-file-item">
                <FileIcon filename={f.name} size={18} />
                <span className="chat-file-name">{f.name}</span>
                <button type="button" className="chat-file-remove" onClick={() => removeFile(i)} aria-label="Удалить">
                  ×
                </button>
              </li>
            ))}
          </ul>
        )}
      </form>
      <ContextMenu menu={ctxMenu} onClose={() => setCtxMenu(null)} />
    </div>
  );
}
