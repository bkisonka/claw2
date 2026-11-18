import type { IncomingMessage, ServerResponse } from "node:http";
import type { Claw2Config } from "../config/types.js";
import {
  bridgeFetchMessages,
  bridgePostMessage,
  resolveLlmBridgeConfig,
} from "../llm-bridge/client.js";
import { resolveCorsAllowOrigin } from "./cors.js";

const JSON_TYPE = "application/json; charset=utf-8";

function json(res: ServerResponse, status: number, body: unknown, allowOrigin = "*"): void {
  res.writeHead(status, {
    "Content-Type": JSON_TYPE,
    "Access-Control-Allow-Origin": allowOrigin,
  });
  res.end(JSON.stringify(body));
}

async function parseBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString("utf-8");
}

export function getLlmRoomPublicInfo(config: Claw2Config): Record<string, unknown> | null {
  const resolved = resolveLlmBridgeConfig(config);
  if (!resolved) return null;
  return {
    enabled: true,
    conversationId: resolved.conversationId,
    localAgentId: resolved.agentId,
    displayName: resolved.displayName,
    participantLabels: resolved.participantLabels,
    autoReplyMode: config.llmBridge?.autoReplyMode === "mention" ? "mention" : "all",
    mentionAliases: [
      resolved.agentId,
      resolved.displayName,
      resolved.participantLabels[resolved.agentId],
    ].filter((x): x is string => !!x?.trim()),
  };
}

export async function handleLlmRoomRoute(
  config: Claw2Config,
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
  userId: string,
  login: string
): Promise<boolean> {
  if (!pathname.startsWith("/api/llm-room")) return false;

  // Same CORS policy as the main router (desktop mode restricts to loopback).
  const reply = (res2: ServerResponse, status: number, body: unknown): void =>
    json(res2, status, body, resolveCorsAllowOrigin(req));

  if (req.method === "GET" && pathname === "/api/llm-room/info") {
    const publicInfo = getLlmRoomPublicInfo(config);
    if (!publicInfo) {
      reply(res, 200, { enabled: false });
      return true;
    }
    reply(res, 200, {
      ...publicInfo,
      humanAuthorId: `user:${userId}`,
      humanLabel: login || userId,
    });
    return true;
  }

  const resolved = resolveLlmBridgeConfig(config);
  if (!resolved) {
    reply(res, 503, { error: "LLM room not configured" });
    return true;
  }

  if (req.method === "GET" && pathname === "/api/llm-room/messages") {
    const url = new URL(req.url ?? "/", "http://localhost");
    const after = parseInt(url.searchParams.get("after") ?? "0", 10) || 0;
    const all = url.searchParams.get("all") === "1";
    const result = await bridgeFetchMessages(resolved, after, { all, limit: 500 });
    if (!result.ok) {
      reply(res, 502, { error: result.error });
      return true;
    }
    reply(res, 200, { ok: true, messages: result.messages });
    return true;
  }

  if (req.method === "POST" && pathname === "/api/llm-room/messages") {
    try {
      const body = await parseBody(req);
      const data = body ? (JSON.parse(body) as { text?: string }) : {};
      const text = typeof data.text === "string" ? data.text.trim() : "";
      if (!text) {
        reply(res, 400, { error: "text required" });
        return true;
      }
      const authorId = `user:${userId}`;
      const label = login?.trim() || userId;
      const labels = { ...resolved.participantLabels, [authorId]: label };
      const post = await bridgePostMessage(
        { ...resolved, participantLabels: labels },
        authorId,
        "human",
        text
      );
      if (!post.ok) {
        reply(res, 502, { error: post.error });
        return true;
      }
      reply(res, 201, { ok: true, message: post.message });
      return true;
    } catch (e) {
      reply(res, 500, { error: String(e) });
      return true;
    }
  }

  reply(res, 404, { error: "Not found" });
  return true;
}
