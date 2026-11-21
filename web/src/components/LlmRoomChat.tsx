// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Vitaliy Bondar

import { useState, useRef, useEffect, useCallback } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeSanitize from "rehype-sanitize";
import {
  fetchLlmRoomInfo,
  fetchLlmRoomMessages,
  postLlmRoomMessage,
  type LlmRoomInfo,
  type LlmRoomMessage,
} from "../api/llmRoom";
import { useI18n } from "../i18n";
import { markdownComponents } from "./markdownComponents";

const POLL_MS = 2000;

function authorLabel(msg: LlmRoomMessage, info: LlmRoomInfo, you: string): string {
  if (msg.authorId === info.humanAuthorId) return info.humanLabel || you;
  return info.participantLabels[msg.authorId] ?? msg.authorId;
}

function messageSide(msg: LlmRoomMessage, info: LlmRoomInfo): "self" | "llm" | "other-human" {
  if (msg.authorId === info.humanAuthorId) return "self";
  if (msg.authorKind === "human") return "other-human";
  return "llm";
}

export function LlmRoomChat() {
  const { locale, t } = useI18n();
  const [info, setInfo] = useState<LlmRoomInfo | null>(null);
  const [messages, setMessages] = useState<LlmRoomMessage[]>([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const logRef = useRef<HTMLDivElement>(null);
  const lastTsRef = useRef(0);
  const knownIdsRef = useRef(new Set<string>());

  const mergeMessages = useCallback((incoming: LlmRoomMessage[]) => {
    if (incoming.length === 0) return;
    setMessages((prev) => {
      const map = new Map(prev.map((m) => [m.id, m]));
      for (const m of incoming) map.set(m.id, m);
      return [...map.values()].sort((a, b) => a.createdAt - b.createdAt);
    });
    for (const m of incoming) {
      knownIdsRef.current.add(m.id);
      if (m.createdAt > lastTsRef.current) lastTsRef.current = m.createdAt;
    }
  }, []);

  useEffect(() => {
    fetchLlmRoomInfo()
      .then((i) => {
        setInfo(i);
        if (!i) setError(t("llmRoom.notConfigured"));
      })
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setLoading(false));
  }, [t]);

  useEffect(() => {
    if (!info) return;
    const load = () => {
      fetchLlmRoomMessages(lastTsRef.current)
        .then(mergeMessages)
        .catch(() => {});
    };
    load();
    const id = setInterval(load, POLL_MS);
    return () => clearInterval(id);
  }, [info, mergeMessages]);

  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [messages]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const text = input.trim();
    if (!text || sending || !info) return;
    setSending(true);
    setError(null);
    setInput("");
    try {
      const msg = await postLlmRoomMessage(text);
      mergeMessages([msg]);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setInput(text);
    } finally {
      setSending(false);
    }
  };

  if (loading) {
    return <p className="llm-room-loading">{t("llmRoom.loading")}</p>;
  }
  if (!info) {
    return <p className="llm-room-error">{error ?? t("llmRoom.unavailable")}</p>;
  }

  const participants = Object.entries(info.participantLabels)
    .filter(([id]) => !id.startsWith("user:"))
    .map(([id, label]) => `${label || id}`)
    .join(", ");

  const llmMentionHints = Object.entries(info.participantLabels)
    .filter(([id]) => !id.startsWith("user:"))
    .flatMap(([id, label]) => {
      const parts = [`@${id}`];
      if (label && label !== id) parts.push(`@${label}`);
      return parts;
    });

  return (
    <div className="llm-room">
      <header className="llm-room-header">
        <h2 className="llm-room-title">{t("llmRoom.title")}</h2>
        <p className="llm-room-meta">
          {info.conversationId}
          {participants ? t("llmRoom.participants", { count: participants }) : ""}
        </p>
        <p className="llm-room-hint">
          {t("llmRoom.shared")}
          {info.autoReplyMode === "mention" && llmMentionHints.length > 0 ? (
            <>
              {" "}
              {t("llmRoom.mentionHint", { hints: llmMentionHints.join(", ") })}
            </>
          ) : (
            t("llmRoom.autoReplies")
          )}
        </p>
      </header>
      <div className="llm-room-log" ref={logRef} role="log" aria-live="polite">
        {messages.length === 0 && (
          <p className="llm-room-empty">{t("llmRoom.empty")}</p>
        )}
        {messages.map((msg) => {
          const side = messageSide(msg, info);
          const label = authorLabel(msg, info, t("common.you"));
          return (
            <div
              key={msg.id}
              className={`llm-room-msg llm-room-msg--${side}`}
              data-author={msg.authorId}
            >
              <div className="llm-room-msg-author">{label}</div>
              <div className="llm-room-msg-body">
                {msg.authorKind === "llm" ? (
                  <ReactMarkdown
                    remarkPlugins={[remarkGfm]}
                    rehypePlugins={[rehypeSanitize]}
                    className="llm-room-markdown"
                    components={markdownComponents}
                  >
                    {msg.text}
                  </ReactMarkdown>
                ) : (
                  <span>{msg.text}</span>
                )}
              </div>
              <time className="llm-room-msg-time" dateTime={new Date(msg.createdAt).toISOString()}>
                {new Date(msg.createdAt).toLocaleTimeString(locale)}
              </time>
            </div>
          );
        })}
      </div>
      {error && <p className="llm-room-error">{error}</p>}
      <form className="llm-room-form" onSubmit={handleSubmit}>
        <textarea
          className="llm-room-input"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder={t("llmRoom.placeholder")}
          rows={2}
          disabled={sending}
        />
        <button type="submit" className="llm-room-send" disabled={sending || !input.trim()}>
          {sending ? "…" : t("common.send")}
        </button>
      </form>
    </div>
  );
}
