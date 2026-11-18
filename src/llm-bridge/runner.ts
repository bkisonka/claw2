/**
 * Common room poll: new message not from this agent → orchestrator with full feed → reply to room.
 */
import type { Claw2Config } from "../config/types.js";
import { runOrchestrator } from "../core/orchestrator.js";
import { buildOrchestratorTurn } from "./conversation-history.js";
import {
  bridgeEnsureConversation,
  bridgeFetchMessages,
  bridgePostMessage,
  resolveLlmBridgeConfig,
  type ConversationMessage,
} from "./client.js";
import {
  getMentionAliases,
  isAddressedByName,
  isAgentMentioned,
  normalizeAutoReplyMode,
} from "./mentions.js";

let lastPollAfter = 0;
let processing = false;
const handledIds = new Set<string>();

function shouldAutoReply(config: Claw2Config, msg: ConversationMessage, resolved: NonNullable<ReturnType<typeof resolveLlmBridgeConfig>>): boolean {
  const mode = normalizeAutoReplyMode(config.llmBridge?.autoReplyMode);
  if (mode === "all") return true;
  const aliases = getMentionAliases(
    resolved.agentId,
    resolved.displayName,
    resolved.participantLabels
  );
  if (isAgentMentioned(msg.text, aliases)) return true;
  // mention: person - @ only; another LLM - another call by name (peer↔peer dialogue)
  if (msg.authorKind === "llm") {
    return isAddressedByName(msg.text, aliases);
  }
  return false;
}

async function handleNewMessage(config: Claw2Config, msg: ConversationMessage): Promise<void> {
  const resolved = resolveLlmBridgeConfig(config);
  if (!resolved || msg.authorId === resolved.agentId) return;
  if (handledIds.has(msg.id)) return;
  handledIds.add(msg.id);
  if (handledIds.size > 2000) {
    handledIds.clear();
    handledIds.add(msg.id);
  }
  if (!shouldAutoReply(config, msg, resolved)) return;

  const all = await bridgeFetchMessages(resolved, 0, { all: true, limit: 500 });
  if (!all.ok) {
    console.error("[llm-room] fetch history failed:", all.error);
    return;
  }
  const roomMessages = all.messages.map((m) => ({
    authorId: m.authorId,
    authorKind: m.authorKind,
    text: m.text,
  }));
  const { history, userMessage } = buildOrchestratorTurn(
    roomMessages,
    resolved.agentId,
    resolved.participantLabels
  );
  if (!userMessage.trim()) return;

  const result = await runOrchestrator({
    config,
    userMessage,
    sessionHistory: history,
    sessionId: `llm-room:${resolved.conversationId}:${resolved.agentId}`,
    recognizedUser: `llm-room:${msg.authorId}`,
  });
  const reply = (result.error ? `Error:${result.error}` : result.content).trim();
  if (!reply) return;
  const send = await bridgePostMessage(resolved, resolved.agentId, "llm", reply);
  if (!send.ok) {
    console.error("[llm-room] post reply failed:", send.error);
  }
}

async function tick(config: Claw2Config): Promise<void> {
  if (processing) return;
  const resolved = resolveLlmBridgeConfig(config);
  if (!resolved || config.llmBridge?.autoReply !== true) return;
  processing = true;
  try {
    await bridgeEnsureConversation(resolved, Object.keys(resolved.participantLabels));
    const poll = await bridgeFetchMessages(resolved, lastPollAfter);
    if (!poll.ok) {
      console.error("[llm-room] poll failed:", poll.error);
      return;
    }
    for (const msg of poll.messages) {
      if (msg.authorId !== resolved.agentId) {
        await handleNewMessage(config, msg);
      }
      if (msg.createdAt > lastPollAfter) lastPollAfter = msg.createdAt;
    }
  } finally {
    processing = false;
  }
}

export function startLlmBridge(config: Claw2Config): void {
  const resolved = resolveLlmBridgeConfig(config);
  if (!resolved) return;
  const interval = config.llmBridge?.pollIntervalMs ?? 3000;
  const mode = normalizeAutoReplyMode(config.llmBridge?.autoReplyMode);
  console.error(
    `[llm-room] agent=${resolved.agentId} room=${resolved.conversationId} url=${resolved.baseUrl} autoReply=${config.llmBridge?.autoReply === true} mode=${mode}`
  );
  if (config.llmBridge?.autoReply === true) {
    tick(config);
    setInterval(() => tick(config), interval);
  }
}

export function resetLlmRoomPollCursor(): void {
  lastPollAfter = 0;
  handledIds.clear();
}
