// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Vitaliy Bondar

/**
 * VK channel: Long Poll community → orchestrator → reply in DM.
 * Session by peer_id (vk:<peer_id>). The functionality is similar to Telegram:
 * voice (audio_message → STT, TTS response), attachments (doc/photo/audio), “printing” indicator.
 */
import type { Claw2Config } from "../config/index.js";
import { wrapExternalContent } from "../security/content-boundary.js";
import { runOrchestrator } from "../core/orchestrator.js";
import { getSessionHistory, appendToSession } from "../gateway/sessions.js";
import { markUntrustedOrigin, hasUntrustedOrigin } from "../security/origin.js";
import { channelIngressConfig, resolveChannelIngressTrust } from "./ingress.js";
import { saveUploadedDocuments, type IncomingDocument } from "../gateway/documents.js";
import { stt, tts } from "./voice-client.js";
import { markdownToPlainText } from "./markdown-to-channel.js";

const VK_API = "https://api.vk.com/method";
const VK_API_VERSION = "5.199";
const POLL_WAIT = 25;

interface VkLongPollServerResponse {
  response?: { key: string; server: string; ts: string };
  error?: { error_code: number; error_msg: string };
}

interface VkDoc {
  id: number;
  owner_id: number;
  title?: string;
  url?: string;
}

interface VkPhotoSize {
  url?: string;
  width?: number;
  height?: number;
  type?: string;
}

interface VkPhoto {
  id: number;
  owner_id: number;
  sizes?: VkPhotoSize[];
}

interface VkAttachment {
  type: string;
  doc?: VkDoc;
  photo?: VkPhoto;
}

interface VkMessage {
  id: number;
  peer_id: number;
  from_id: number;
  date: number;
  text?: string;
  attachments?: VkAttachment[];
}

interface VkLongPollUpdate {
  type: string;
  object?: {
    message?: VkMessage;
  };
}

interface VkLongPollResponse {
  ts: string;
  updates?: VkLongPollUpdate[];
  failed?: number;
}

interface VkApiResponse<T = unknown> {
  response?: T;
  error?: { error_code: number; error_msg: string };
}

async function runStt(sttEndpoint: string, audioBuffer: Buffer) {
  return stt(sttEndpoint, audioBuffer);
}

/** Get a Long Poll server for the community.*/
async function getLongPollServer(accessToken: string, groupId: number): Promise<{ key: string; server: string; ts: string }> {
  const url = `${VK_API}/groups.getLongPollServer?group_id=${groupId}&access_token=${encodeURIComponent(accessToken)}&v=${VK_API_VERSION}`;
  const res = await fetch(url);
  const data = (await res.json()) as VkLongPollServerResponse;
  if (data.error) {
    throw new Error(`VK getLongPollServer: ${data.error.error_msg} (${data.error.error_code})`);
  }
  const r = data.response;
  if (!r?.key || !r.server || r.ts === undefined) {
    throw new Error("VK getLongPollServer: missing key/server/ts");
  }
  return { key: r.key, server: r.server, ts: String(r.ts) };
}

/** Calling the VK API method (GET).*/
async function vkGet<T>(method: string, params: Record<string, string>): Promise<T> {
  const q = new URLSearchParams({ ...params, v: VK_API_VERSION });
  const res = await fetch(`${VK_API}/${method}?${q.toString()}`);
  const data = (await res.json()) as VkApiResponse<T>;
  if (data.error) {
    throw new Error(`VK ${method}: ${data.error.error_msg} (${data.error.error_code})`);
  }
  if (data.response === undefined) throw new Error(`VK ${method}: no response`);
  return data.response;
}

/** Send a message to the conversation.*/
async function sendMessage(accessToken: string, peerId: number, text: string, attachment?: string): Promise<void> {
  const params: Record<string, string> = {
    peer_id: String(peerId),
    message: text,
    random_id: String(Math.floor(Math.random() * 1e9)),
    access_token: accessToken,
    v: VK_API_VERSION,
  };
  if (attachment) params.attachment = attachment;
  const q = new URLSearchParams(params);
  const res = await fetch(`${VK_API}/messages.send`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: q.toString(),
  });
  const data = (await res.json()) as VkApiResponse<number>;
  if (data.error) {
    throw new Error(`VK messages.send: ${data.error.error_msg} (${data.error.error_code})`);
  }
}

/** The indicator is "printing".*/
function setTyping(accessToken: string, peerId: number, groupId: number): void {
  const params = new URLSearchParams({
    peer_id: String(peerId),
    type: "typing",
    group_id: String(groupId),
    access_token: accessToken,
    v: VK_API_VERSION,
  });
  fetch(`${VK_API}/messages.setActivity?${params.toString()}`).catch(() => {});
}

/** Get the full message with attachments (messages.getById).*/
async function getMessageById(accessToken: string, peerId: number, messageId: number): Promise<VkMessage | null> {
  const response = await vkGet<{ items?: VkMessage[] }>( "messages.getById", {
    access_token: accessToken,
    message_ids: String(messageId),
    peer_id: String(peerId),
  });
  const items = response?.items;
  return items?.[0] ?? null;
}

/** Get the document URL (docs.getById if the url is not in the object).*/
async function getDocUrl(accessToken: string, ownerId: number, docId: number): Promise<string> {
  const response = await vkGet<{ type?: number; doc?: VkDoc }[]>("docs.getById", {
    access_token: accessToken,
    docs: `${ownerId}_${docId}`,
  });
  const doc = Array.isArray(response) ? response[0]?.doc : undefined;
  if (doc?.url) return doc.url;
  throw new Error("VK doc: no url");
}

/** Download file from URL.*/
async function downloadUrl(url: string): Promise<Buffer> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Download failed: ${res.status}`);
  const buf = await res.arrayBuffer();
  return Buffer.from(buf);
}

/** Get the URL from the attachment and download.*/
async function resolveAttachmentToBuffer(
  accessToken: string,
  att: VkAttachment
): Promise<{ buffer: Buffer; name: string } | null> {
  if (att.type === "doc" && att.doc) {
    const url = att.doc.url ?? (await getDocUrl(accessToken, att.doc.owner_id, att.doc.id));
    const buffer = await downloadUrl(url);
    const name = (att.doc.title ?? "document").trim() || "document";
    return { buffer, name };
  }
  if (att.type === "photo" && att.photo?.sizes?.length) {
    const sizes = att.photo.sizes.filter((s) => s.url);
    const largest = sizes.reduce((a, b) => ((a.width ?? 0) >= (b.width ?? 0) ? a : b));
    if (largest.url) {
      const buffer = await downloadUrl(largest.url);
      return { buffer, name: "photo.jpg" };
    }
  }
  return null;
}

/** Upload the document and get the attachment string for messages.send.*/
async function uploadDocAndGetAttachment(
  accessToken: string,
  peerId: number,
  buffer: Buffer,
  filename: string
): Promise<string> {
  const uploadServer = await vkGet<{ upload_url?: string }>("docs.getMessagesUploadServer", {
    access_token: accessToken,
    type: "doc",
    peer_id: String(peerId),
  });
  const uploadUrl = uploadServer?.upload_url;
  if (!uploadUrl) throw new Error("VK docs.getMessagesUploadServer: no upload_url");

  const form = new FormData();
  form.append("file", new Blob([new Uint8Array(buffer)]), filename);
  const uploadRes = await fetch(uploadUrl, { method: "POST", body: form });
  const uploadData = (await uploadRes.json()) as { file?: string };
  const file = uploadData?.file;
  if (!file) throw new Error("VK upload: no file in response");

  const saveRes = await vkGet<{ doc?: VkDoc }>("docs.save", {
    access_token: accessToken,
    file,
  });
  const doc = saveRes?.doc;
  if (!doc) throw new Error("VK docs.save: no doc");
  return `doc${doc.owner_id}_${doc.id}`;
}

export function startVkBot(config: Claw2Config): void {
  const token = config.channels?.vk?.accessToken?.trim();
  const groupId = config.channels?.vk?.groupId;
  if (!token) {
    console.error("VK: accessToken not set (channels.vk.accessToken or VK_ACCESS_TOKEN)");
    return;
  }
  if (!groupId || groupId < 1) {
    console.error("VK: groupId not set or invalid (channels.vk.groupId or VK_GROUP_ID)");
    return;
  }

  const accessToken = token;
  const groupIdNum: number = groupId;
  const voiceConf = config.channels?.vk?.voice;
  const sttUrl = (voiceConf?.sttUrl ?? "").trim();
  const ttsUrl = (voiceConf?.ttsUrl ?? "").trim();
  const voiceEnabled = !!voiceConf && !!sttUrl;
  const replyWithVoice = !!voiceConf?.replyWithVoice && !!ttsUrl;
  const ttsMaxChars = voiceConf?.ttsMaxChars ?? 1000;

  let server = "";
  let key = "";
  let ts = "";

  async function processMessage(
    peerId: number,
    userText: string,
    attachedDocuments?: { path: string; name: string }[],
    userVoiceGender?: "male" | "female",
    userVoiceEmotion?: "angry" | "happy" | "neutral" | "sad"
  ): Promise<string> {
    const sessionId = `vk:${peerId}`;
    // Community DMs are untrusted-origin content by default (see telegram
    // ingress note); trustedUserIds soften it for the operator's own ID.
    const trust = resolveChannelIngressTrust(channelIngressConfig(config, "vk"), peerId);
    const wrapped = trust.trusted
      ? userText
      : wrapExternalContent(userText, { source: "vk" });
    if (!trust.trusted) markUntrustedOrigin(sessionId);
    const history = getSessionHistory(sessionId);
    const result = await runOrchestrator({
      config,
      userMessage: wrapped,
      sessionHistory: history,
      attachedDocuments: attachedDocuments?.length ? attachedDocuments : undefined,
      userVoiceGender,
      userVoiceEmotion,
      sessionId,
    });
    appendToSession(
      sessionId,
      "user",
      userText,
      trust.trusted ? undefined : { source: "channel", untrusted: true }
    );
    appendToSession(
      sessionId,
      "assistant",
      result.content,
      hasUntrustedOrigin(sessionId) ? { source: "derived", untrusted: true } : undefined
    );
    return result.error ? `Error:${result.error}` : result.content;
  }

  async function sendReply(peerId: number, reply: string): Promise<void> {
    const raw = (reply || "").trim() || "—";
    const textToSend = markdownToPlainText(raw);
    await sendMessage(accessToken, peerId, textToSend);

    if (replyWithVoice && ttsUrl && reply) {
      try {
        const wavBuffer = await tts(ttsUrl, reply, ttsMaxChars, config.voice?.ttsEngine);
        const attachment = await uploadDocAndGetAttachment(
          accessToken,
          peerId,
          wavBuffer,
          `speech-${Date.now()}.wav`
        );
        await sendMessage(accessToken, peerId, "", attachment);
      } catch (err) {
        console.error("VK TTS/upload/send error:", err);
      }
    }
  }

  async function ensureLongPollServer(): Promise<boolean> {
    if (server && key) return true;
    try {
      const r = await getLongPollServer(accessToken, groupIdNum);
      server = r.server;
      key = r.key;
      ts = r.ts;
      return true;
    } catch (err) {
      console.error("VK getLongPollServer error:", err);
      return false;
    }
  }

  async function poll(): Promise<void> {
    if (!(await ensureLongPollServer())) {
      setTimeout(poll, 5000);
      return;
    }
    try {
      const url = `https://${server}?act=a_check&key=${encodeURIComponent(key)}&ts=${encodeURIComponent(ts)}&wait=${POLL_WAIT}`;
      const res = await fetch(url);
      const data = (await res.json()) as VkLongPollResponse;

      if (data.failed) {
        server = "";
        key = "";
        ts = "";
        setTimeout(poll, 1000);
        return;
      }

      if (data.ts) ts = String(data.ts);
      const updates = data.updates ?? [];

      for (const u of updates) {
        if (u.type !== "message_new" || !u.object?.message) continue;
        const msg = u.object.message;
        const peerId = msg.peer_id;
        if (msg.from_id < 0) continue;

        let userText = (msg.text ?? "").trim();
        let userVoiceGender: "male" | "female" | undefined;
        let userVoiceEmotion: "angry" | "happy" | "neutral" | "sad" | undefined;
        let fullMessage: VkMessage | null = msg;

        if ((msg.attachments?.length ?? 0) > 0) {
          fullMessage = msg;
        } else if (msg.id) {
          fullMessage = await getMessageById(accessToken, peerId, msg.id);
        }

        const attachments = fullMessage?.attachments ?? [];
        const hasAudioMessage = attachments.some((a) => a.type === "audio_message");

        if (hasAudioMessage && !voiceEnabled) {
          await sendMessage(
            accessToken,
            peerId,
            "Voice messages are not configured (add channels.vk.voice.sttUrl to the config). Write in text."
          );
          continue;
        }

        if (hasAudioMessage && voiceEnabled) {
          const voiceAtt = attachments.find((a) => a.type === "audio_message");
          if (voiceAtt) {
            try {
              const resolved = await resolveAttachmentToBuffer(accessToken, voiceAtt);
              if (resolved) {
                const ext = (resolved.name.split(".").pop() ?? "ogg").toLowerCase();
                const sttResult = await runStt(sttUrl, resolved.buffer);
                userText = sttResult.text;
                userVoiceGender = sttResult.gender;
                userVoiceEmotion = sttResult.emotion;
                if (!userText?.trim()) {
                  await sendMessage(accessToken, peerId, "Speech recognition failed.");
                  continue;
                }
              }
            } catch (err) {
              console.error("VK voice/STT error:", err);
              await sendMessage(accessToken, peerId, `Recognition error:${String(err)}`);
              continue;
            }
          }
        }

        const docs: IncomingDocument[] = [];
        for (const att of attachments) {
          if (att.type === "audio_message" && userText) continue;
          try {
            const resolved = await resolveAttachmentToBuffer(accessToken, att);
            if (resolved) {
              docs.push({ name: resolved.name, contentBase64: resolved.buffer.toString("base64") });
            }
          } catch (err) {
            console.error("VK attachment download error:", err);
          }
        }

        const sessionId = `vk:${peerId}`;
        const attachedDocuments = docs.length > 0 ? saveUploadedDocuments(docs, sessionId, config) : undefined;
        if (!userText && attachedDocuments?.length) {
          userText =
            attachedDocuments.length === 1
              ? `File attached:${attachedDocuments[0].name}`
              : `Files attached:${attachedDocuments.length}`;
        }

        if (!userText?.trim()) continue;

        try {
          setTyping(accessToken, peerId, groupIdNum);
          const typingInterval = setInterval(() => setTyping(accessToken, peerId, groupIdNum), 4000);
          let reply: string;
          try {
            reply = await processMessage(peerId, userText, attachedDocuments, userVoiceGender, userVoiceEmotion);
          } finally {
            clearInterval(typingInterval);
          }
          await sendReply(peerId, reply);
        } catch (err) {
          console.error("VK orchestrator/send error:", err);
          try {
            await sendMessage(accessToken, peerId, `Error:${String(err)}`);
          } catch {
            // ignore
          }
        }
      }
    } catch (err) {
      console.error("VK poll error:", err);
      server = "";
      key = "";
    }
    setTimeout(poll, 100);
  }

  console.error("VK bot started (Long Poll, group_id=%s)", groupIdNum);
  poll();
}
