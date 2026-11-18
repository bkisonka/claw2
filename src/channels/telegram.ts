/**
 * Telegram channel: long poll getUpdates → Content Boundary → orchestrator → reply to chat.
 * Session by chat_id (telegram:<chat_id>).
 * Support: voice (voice → STT), attachments (document/photo/audio → saving to uploads and transferring the model).
 */
import type { Claw2Config } from "../config/index.js";
import { wrapExternalContent } from "../security/content-boundary.js";
import { runOrchestrator } from "../core/orchestrator.js";
import { getSessionHistory, appendToSession } from "../gateway/sessions.js";
import { saveUploadedDocuments, type IncomingDocument } from "../gateway/documents.js";
import { stt, tts } from "./voice-client.js";
import { markdownToTelegramHtml, markdownToPlainText } from "./markdown-to-channel.js";
import {
  initAllowlistDb,
  isAllowed,
  createToken,
  consumeToken,
  getPendingRequest,
  approveRequest,
  rejectRequest,
} from "./telegram-allowlist.js";
import { createTelegramHttpClient, type TelegramHttpClient } from "./telegram-http.js";

/** Call STT (returns text and optionally gender by voice).*/
async function runStt(sttEndpoint: string, audioBuffer: Buffer) {
  return stt(sttEndpoint, audioBuffer);
}

const POLL_TIMEOUT = 30;
/** Length limit for one message in Telegram (in characters). We divide the long answer into parts.*/
const TELEGRAM_MAX_MESSAGE_LENGTH = 4000;
/** When sending with parse_mode, the HTML markup lengthens the text - we cut the chunks shorter.*/
const TELEGRAM_MAX_HTML_CHUNK = 3800;

/** Menu commands for the owner (full menu, including config settings).*/
const OWNER_MENU_COMMANDS = [
  { command: "start", description: "Begin" },
  { command: "invite", description: "Invitation" },
  { command: "config", description: "Config settings" },
];

/** Shortened menu for users without ownerId (without config settings).*/
const SHORT_MENU_COMMANDS = [{ command: "start", description: "Begin" }];

function setMyCommands(
  http: TelegramHttpClient,
  commands: { command: string; description: string }[],
  scope: { type: "default" } | { type: "chat_member"; chat_id: number; user_id: number }
): void {
  const body: Record<string, unknown> = { commands };
  if (scope.type === "chat_member") {
    body.scope = { type: "chat_member", chat_id: scope.chat_id, user_id: scope.user_id };
  } else {
    body.scope = { type: "default" };
  }
  http.fetch(`${http.apiBase}/setMyCommands`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }).catch((err) => console.error("[Telegram] setMyCommands error:", err));
}

function splitMessageIntoChunks(text: string, maxLen: number): string[] {
  if (text.length <= maxLen) return [text];
  const chunks: string[] = [];
  let start = 0;
  while (start < text.length) {
    let end = Math.min(start + maxLen, text.length);
    if (end < text.length) {
      const slice = text.slice(start, end);
      const lastNewline = slice.lastIndexOf("\n");
      const lastSpace = slice.lastIndexOf(" ");
      const breakAt = lastNewline >= maxLen >> 1 ? lastNewline + 1 : lastSpace >= maxLen >> 1 ? lastSpace + 1 : slice.length;
      end = start + breakAt;
    }
    chunks.push(text.slice(start, end).trim());
    start = end;
  }
  return chunks.filter((c) => c.length > 0);
}

/**
 * Send a notification to the owner in Telegram (for reminders and /api/notify/telegram).
 * Config from claw2.yaml: channels.telegram.botToken, channels.telegram.ownerId.
 */
export async function sendNotifyToOwner(config: Claw2Config, text: string): Promise<{ ok: true } | { ok: false; error: string }> {
  const token = config.channels?.telegram?.botToken?.trim();
  const chatId = config.channels?.telegram?.ownerId;
  if (!token || chatId == null) return { ok: false, error: "Telegram not configured or ownerId missing" };
  const http = createTelegramHttpClient(config, token);
  const raw = (text || "").trim() || "—";
  const chunks = splitMessageIntoChunks(raw, TELEGRAM_MAX_MESSAGE_LENGTH);
  for (const chunk of chunks) {
    const res = await http.fetch(`${http.apiBase}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text: chunk }),
    });
    if (!res.ok) {
      const errBody = await res.text();
      return { ok: false, error: `Telegram sendMessage: ${errBody}` };
    }
  }
  return { ok: true };
}

interface TelegramPhotoSize {
  file_id: string;
  width: number;
  height: number;
}

interface TelegramUpdate {
  update_id: number;
  message?: {
    chat: { id: number };
    from?: { id: number; username?: string; first_name?: string; last_name?: string };
    text?: string;
    caption?: string;
    voice?: { file_id: string };
    document?: { file_id: string; file_name?: string };
    photo?: TelegramPhotoSize[];
    audio?: { file_id: string; file_name?: string };
  };
  callback_query?: {
    id: string;
    from: { id: number };
    message?: { chat: { id: number }; message_id: number; text?: string };
    data?: string;
  };
}

interface GetUpdatesResponse {
  ok: boolean;
  result?: TelegramUpdate[];
}

interface GetFileResponse {
  ok: boolean;
  result?: { file_path: string };
}

/** Show the “typing...” indicator in the chat (lasts for ~5 seconds, repeat if the response takes a long time).*/
function sendTyping(http: TelegramHttpClient, chatId: number): void {
  http.fetch(`${http.apiBase}/sendChatAction`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, action: "typing" }),
  }).catch(() => {});
}

/** Download file by file_id (voice, document, photo, audio).*/
async function downloadTelegramFile(http: TelegramHttpClient, fileId: string): Promise<Buffer> {
  const getRes = await http.fetch(`${http.apiBase}/getFile?file_id=${encodeURIComponent(fileId)}`);
  const getData = (await getRes.json()) as GetFileResponse;
  if (!getData.ok || !getData.result?.file_path) {
    throw new Error("Telegram getFile failed or no file_path");
  }
  const fileRes = await http.fetch(`${http.fileBase}/${getData.result.file_path}`);
  if (!fileRes.ok) throw new Error(`Failed to download file: ${fileRes.status}`);
  const buf = await fileRes.arrayBuffer();
  return Buffer.from(buf);
}

export function startTelegramBot(config: Claw2Config): void {
  console.error("Telegram: starting bot...");
  const token = config.channels?.telegram?.botToken?.trim();
  if (!token) {
    console.error("Telegram: botToken not set (channels.telegram.botToken or TELEGRAM_BOT_TOKEN)");
    return;
  }
  const botToken: string = token;
  const http = createTelegramHttpClient(config, botToken);
  const base = http.apiBase;
  const tgFetch = http.fetch;
  if (http.proxyUrl) {
    console.error(`Telegram: Bot API only via proxy ${http.proxyUrl}`);
  }
  const voiceConf = config.channels?.telegram?.voice;
  const sttUrl = (voiceConf?.sttUrl ?? "").trim();
  const ttsUrl = (voiceConf?.ttsUrl ?? "").trim();
  const voiceEnabled = !!voiceConf && !!sttUrl;
  const replyWithVoice = !!voiceConf?.replyWithVoice && !!ttsUrl;
  const ttsMaxChars = voiceConf?.ttsMaxChars ?? 1000;
  const ownerId = config.channels?.telegram?.ownerId;
  const allowlistDbPath = (config.channels?.telegram?.allowlistDbPath ?? "").trim();

  let offset = 0;
  let botUsername = "";

  if (ownerId != null && ownerId > 0) {
    try {
      initAllowlistDb(allowlistDbPath);
    } catch (err) {
      console.error("Telegram allowlist DB init failed (poll will still run):", err);
    }
    setMyCommands(http, SHORT_MENU_COMMANDS, { type: "default" });
    tgFetch(`${base}/getMe`)
      .then((r) => r.json())
      .then((d: { ok?: boolean; result?: { username?: string } }) => {
        if (d.ok && d.result?.username) botUsername = d.result.username;
      })
      .catch(() => {});
  }

  async function processMessage(
    chatId: number,
    userText: string,
    attachedDocuments?: { path: string; name: string }[],
    userVoiceGender?: "male" | "female",
    userVoiceEmotion?: "angry" | "happy" | "neutral" | "sad",
    telegramUserId?: number
  ): Promise<string> {
    const sessionId = `telegram:${chatId}`;
    const wrapped = wrapExternalContent(userText, { source: "telegram" });
    const history = getSessionHistory(sessionId);
    const recognizedUser =
      telegramUserId != null ? `telegram:${telegramUserId}` : undefined;

    const result = await runOrchestrator({
      config,
      userMessage: wrapped,
      sessionHistory: history,
      attachedDocuments: attachedDocuments?.length ? attachedDocuments : undefined,
      userVoiceGender,
      userVoiceEmotion,
      recognizedUser,
      sessionId,
    });
    appendToSession(sessionId, "user", userText);
    appendToSession(sessionId, "assistant", result.content);
    return result.error ? `Error:${result.error}` : result.content;
  }

  async function sendReply(chatId: number, reply: string): Promise<void> {
    const raw = (reply || "").trim() || "—";
    const chunks = splitMessageIntoChunks(raw, TELEGRAM_MAX_HTML_CHUNK);
    for (const chunk of chunks) {
      let textToSend = markdownToTelegramHtml(chunk);
      const payload: { chat_id: number; text: string; parse_mode?: string } = { chat_id: chatId, text: textToSend, parse_mode: "HTML" };
      let msgRes = await tgFetch(`${base}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!msgRes.ok) {
        const errBody = await msgRes.text();
        const retryPlain =
          msgRes.status === 400 &&
          (errBody.includes("parse entities") ||
            errBody.includes("can't parse") ||
            errBody.includes("message is too long"));
        if (retryPlain) {
          textToSend = markdownToPlainText(chunk);
          if (textToSend.length > TELEGRAM_MAX_MESSAGE_LENGTH) {
            const plainChunks = splitMessageIntoChunks(textToSend, TELEGRAM_MAX_MESSAGE_LENGTH);
            for (const pc of plainChunks) {
              const r = await tgFetch(`${base}/sendMessage`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ chat_id: chatId, text: pc }),
              });
              if (!r.ok) throw new Error(`Telegram sendMessage ${r.status}: ${await r.text()}`);
            }
          } else {
            msgRes = await tgFetch(`${base}/sendMessage`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ chat_id: chatId, text: textToSend }),
            });
            if (!msgRes.ok) throw new Error(`Telegram sendMessage ${msgRes.status}: ${await msgRes.text()}`);
          }
        } else {
          throw new Error(`Telegram sendMessage ${msgRes.status}: ${errBody}`);
        }
      }
    }

    if (replyWithVoice && ttsUrl && reply) {
      try {
        const wavBuffer = await tts(
          ttsUrl ?? "",
          reply,
          ttsMaxChars,
          config.voice?.ttsEngine
        );
        const form = new FormData();
        form.append("chat_id", String(chatId));
        form.append("audio", new Blob([new Uint8Array(wavBuffer)]), `speech-${Date.now()}.wav`);
        await tgFetch(`${base}/sendAudio`, {
          method: "POST",
          body: form,
        });
      } catch (err) {
        console.error("Telegram TTS/sendAudio error:", err);
      }
    }
  }

  async function poll(): Promise<void> {
    try {
      const url = `${base}/getUpdates?timeout=${POLL_TIMEOUT}&offset=${offset}`;
      const res = await tgFetch(url);
      const data = (await res.json()) as GetUpdatesResponse;
      if (!data.ok || !Array.isArray(data.result)) {
        setTimeout(poll, 2000);
        return;
      }
      for (const u of data.result) {
        offset = Math.max(offset, u.update_id + 1);

        if (u.callback_query && ownerId != null) {
          const cq = u.callback_query;
          const fromId = cq.from?.id;
          if (fromId !== ownerId) {
            await tgFetch(`${base}/answerCallbackQuery`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ callback_query_id: cq.id }),
            }).catch(() => {});
            continue;
          }
          const dataStr = (cq.data ?? "").trim();
          const allowMatch = dataStr.match(/^allow:(\d+)$/);
          const rejectMatch = dataStr.match(/^reject:(\d+)$/);
          const requestId = allowMatch?.[1] ?? rejectMatch?.[1];
          if (requestId) {
            const id = parseInt(requestId, 10);
            if (allowMatch) {
              const candidateUserId = approveRequest(id);
              await tgFetch(`${base}/answerCallbackQuery`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ callback_query_id: cq.id, text: candidateUserId != null ? "Access allowed." : "The application has already been processed." }),
              }).catch(() => {});
              if (cq.message) {
                await tgFetch(`${base}/editMessageText`, {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({
                    chat_id: cq.message.chat.id,
                    message_id: cq.message.message_id,
                    text: (cq.message.text ?? "") + "\n\n✅ Approved.",
                  }),
                }).catch(() => {});
              }
              if (candidateUserId != null) {
                await tgFetch(`${base}/sendMessage`, {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({
                    chat_id: candidateUserId,
                    text: "You have access to the bot. You can write messages.",
                  }),
                }).catch(() => {});
              }
            } else {
              const ok = rejectRequest(id);
              await tgFetch(`${base}/answerCallbackQuery`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ callback_query_id: cq.id, text: ok ? "The application was rejected." : "The application has already been processed." }),
              }).catch(() => {});
              if (ok && cq.message) {
                await tgFetch(`${base}/editMessageText`, {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({
                    chat_id: cq.message.chat.id,
                    message_id: cq.message.message_id,
                    text: (cq.message.text ?? "") + "\n\n❌ Rejected.",
                  }),
                }).catch(() => {});
              }
            }
          }
          continue;
        }

        const chatId = u.message?.chat?.id;
        if (chatId === undefined) continue;

        const fromId = u.message?.from?.id;
        const textForCommands = u.message?.text?.trim() ?? "";

        if (ownerId != null && ownerId > 0) {
          const startMatch = textForCommands.match(/^\/start\s+([a-f0-9]+)$/i);
          if (startMatch && fromId !== undefined) {
            const token = startMatch[1];
            const result = consumeToken(token, fromId, u.message?.from?.username, u.message?.from?.first_name);
            if (!result.ok) {
              await tgFetch(`${base}/sendMessage`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ chat_id: chatId, text: result.reason }),
              }).catch(() => {});
              continue;
            }
            const label = [u.message?.from?.first_name, u.message?.from?.username].filter(Boolean).join(" @") || `ID ${fromId}`;
            const keyboard = {
              inline_keyboard: [
                [
                  { text: "✅ Allow", callback_data: `allow:${result.requestId}` },
                  { text: "❌ Reject", callback_data: `reject:${result.requestId}` },
                ],
              ],
            };
            await tgFetch(`${base}/sendMessage`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                chat_id: ownerId,
                text: `User ${label} (ID ${fromId}) wants to join the bot.`,
                reply_markup: keyboard,
              }),
            }).catch(() => {});
            await tgFetch(`${base}/sendMessage`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                chat_id: chatId,
                text: "The application has been sent to the bot owner. Wait for a decision.",
              }),
            }).catch(() => {});
            continue;
          }

          if (fromId === undefined) continue;
          if (!isAllowed(fromId, ownerId)) {
            await tgFetch(`${base}/sendMessage`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                chat_id: chatId,
                text: "Access to the bot is limited. Request an invitation from the owner.",
              }),
            }).catch(() => {});
            continue;
          }
          if (fromId === ownerId && chatId === fromId) {
            setMyCommands(http, OWNER_MENU_COMMANDS, { type: "chat_member", chat_id: chatId, user_id: fromId });
          }
          if (textForCommands === "/config" || textForCommands.toLowerCase() === "config settings" || textForCommands.toLowerCase() === "настройки конфига") {
            if (fromId !== ownerId) {
              await tgFetch(`${base}/sendMessage`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                  chat_id: chatId,
                  text: "Config settings are available only to the bot owner.",
                }),
              }).catch(() => {});
              continue;
            }
            const gatewayPort = config.gateway?.port ?? 3000;
            await tgFetch(`${base}/sendMessage`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                chat_id: chatId,
                text: `Config settings (.claw2/claw2.yaml): open the web interface on port ${gatewayPort} — Settings section.`,
              }),
            }).catch(() => {});
            continue;
          }
          if (textForCommands === "/invite" || textForCommands.toLowerCase() === "invitation" || textForCommands.toLowerCase() === "create an invitation" || textForCommands.toLowerCase() === "приглашение" || textForCommands.toLowerCase() === "создать приглашение") {
            if (fromId !== ownerId) {
              await tgFetch(`${base}/sendMessage`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                  chat_id: chatId,
                  text: "Only the bot owner can create invitations.",
                }),
              }).catch(() => {});
              continue;
            }
            const { token, expiresAt } = createToken(ownerId);
            const link = botUsername
              ? `https://t.me/${botUsername}?start=${token}`
              : `(bot name is still loading) Token: ${token}. Link: https://t.me/BOT_NAME?start=${token}. The token expires in 10 minutes.`;
            const expiresAtDate = new Date(expiresAt);
            await tgFetch(`${base}/sendMessage`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                chat_id: chatId,
                text: `Invitation (valid for 10 minutes, until ${expiresAtDate.toLocaleTimeString("en")}):\n${link}\n\nForward the link to the candidate.`,
              }),
            }).catch(() => {});
            continue;
          }
        }

        let userText: string | undefined;
        let userVoiceGender: "male" | "female" | undefined;
        let userVoiceEmotion: "angry" | "happy" | "neutral" | "sad" | undefined;

        if (u.message?.voice && !voiceEnabled) {
          await tgFetch(`${base}/sendMessage`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              chat_id: chatId,
              text: "Voice messages are not configured (add channels.telegram.voice.sttUrl to the config). Write in text.",
            }),
          });
          continue;
        }
        if (u.message?.voice && voiceEnabled) {
          const fileId = u.message.voice.file_id;
          if (typeof fileId !== "string" || fileId.length === 0) {
            console.error("[Telegram] voice: empty file_id, skip");
            continue;
          }
          const endpoint = sttUrl.length > 0 ? sttUrl : "";
          if (!endpoint) {
            console.error("[Telegram] voice: sttUrl not set, skip");
            continue;
          }
          console.error("[Telegram] voice: downloading file_id=%s, then STT %s", fileId.slice(0, 12), endpoint);
          try {
            const audioBuffer: Buffer = await downloadTelegramFile(http, fileId);
            console.error("[Telegram] voice: downloaded %d bytes, calling STT", audioBuffer.length);
            const sttResult = await runStt(endpoint, audioBuffer);
            userText = sttResult.text;
            userVoiceGender = sttResult.gender;
            userVoiceEmotion = sttResult.emotion;
            if (userText === undefined || userText === "") {
              await tgFetch(`${base}/sendMessage`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ chat_id: chatId, text: "Speech recognition failed." }),
              });
              continue;
            }
          } catch (err) {
            console.error("Telegram voice/STT error:", err);
            await tgFetch(`${base}/sendMessage`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                chat_id: chatId,
                text: `Recognition error:${String(err)}`,
              }),
            });
            continue;
          }
        } else if (u.message?.text !== undefined) {
          userText = u.message.text.trim();
        }

        // Attachments: document, photo (last = largest), audio
        const docs: IncomingDocument[] = [];
        const fileIds: { fileId: string; name: string }[] = [];
        if (u.message?.document) {
          fileIds.push({
            fileId: u.message.document.file_id,
            name: u.message.document.file_name?.trim() || "document",
          });
        }
        if (u.message?.photo?.length) {
          const largest = u.message.photo[u.message.photo.length - 1];
          fileIds.push({ fileId: largest.file_id, name: "photo.jpg" });
        }
        if (u.message?.audio) {
          fileIds.push({
            fileId: u.message.audio.file_id,
            name: u.message.audio.file_name?.trim() || "audio",
          });
        }
        for (const { fileId, name } of fileIds) {
          try {
            const buf = await downloadTelegramFile(http, fileId);
            docs.push({ name, contentBase64: buf.toString("base64") });
          } catch (err) {
            console.error("Telegram file download error:", err);
          }
        }
        const sessionId = `telegram:${chatId}`;
        const attachedDocuments =
          docs.length > 0 ? saveUploadedDocuments(docs, sessionId, config) : undefined;
        if (u.message?.caption !== undefined && u.message.caption.trim()) {
          userText = userText ?? u.message.caption.trim();
        }
        if (userText === undefined && attachedDocuments?.length) {
          userText =
            attachedDocuments.length === 1
              ? `File attached:${attachedDocuments[0].name}`
              : `Files attached:${attachedDocuments.length}`;
        }

        if (userText === undefined) continue;

        try {
          sendTyping(http, chatId);
          const typingInterval = setInterval(() => sendTyping(http, chatId), 4000);
          let reply: string;
          try {
            const telegramUserId = u.message?.from?.id;
            reply = await processMessage(
              chatId,
              userText,
              attachedDocuments,
              userVoiceGender,
              userVoiceEmotion,
              telegramUserId
            );
          } finally {
            clearInterval(typingInterval);
          }
          await sendReply(chatId, reply);
        } catch (err) {
          console.error("Telegram orchestrator error:", err);
          await tgFetch(`${base}/sendMessage`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              chat_id: chatId,
              text: `Error:${String(err)}`,
            }),
          });
        }
      }
    } catch (err) {
      console.error("Telegram poll error:", err);
    }
    setTimeout(poll, 100);
  }

  console.error("Telegram bot started (long poll)");
  poll();
}
