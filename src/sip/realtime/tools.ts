/**
 * Bridge Realtime function_call ↔ claw2 tools (voice-safe subset).
 * Uplink mute during tool wait is handled inside OpenAiStyleRealtimeProvider.
 */
import type OpenAI from "openai";
import type { Claw2Config } from "../../config/types.js";
import { createClient, getChatTools } from "../../core/llm.js";
import { memoryRecall, memoryWrite } from "../../memory/index.js";
import { toolPhoneCall } from "../../tools/phone-call.js";
import { toolSearch } from "../../tools/search.js";
import { toolWebFetch } from "../../tools/web-fetch.js";
import type { RealtimeProvider } from "./provider.js";
import type { RealtimeToolCall, RealtimeToolDefinition } from "./types.js";

/** Tools useful on a live call (no FS write / agents / image gen). */
const REALTIME_TOOL_ALLOWLIST = new Set([
  "phone_call",
  "remember",
  "memory_search",
  "search",
  "web_fetch",
]);

const MAX_TOOL_OUTPUT_CHARS = 1_800;

export type RealtimeToolsContext = {
  /** Call log id / SIP call id for correlation. */
  callId?: string;
  sessionId?: string;
};

export function chatToolToRealtimeDefinition(
  tool: OpenAI.Chat.ChatCompletionTool
): RealtimeToolDefinition | null {
  if (tool.type !== "function" || !tool.function?.name) return null;
  const fn = tool.function;
  return {
    type: "function",
    name: fn.name,
    description: fn.description || "",
    parameters:
      fn.parameters && typeof fn.parameters === "object"
        ? (fn.parameters as Record<string, unknown>)
        : { type: "object", properties: {} },
  };
}

/** Flat Realtime tools for session.update from claw2 chat tool schemas. */
export function getRealtimeToolDefinitions(config: Claw2Config): RealtimeToolDefinition[] {
  const out: RealtimeToolDefinition[] = [];
  for (const tool of getChatTools(config)) {
    const name = tool.type === "function" ? tool.function?.name : undefined;
    if (!name || !REALTIME_TOOL_ALLOWLIST.has(name)) continue;
    const def = chatToolToRealtimeDefinition(tool);
    if (!def) continue;
    if (name === "phone_call") {
      def.description =
        "Manage the active SIP call. Prefer hangup, transfer, dtmf, status. " +
        "Do NOT use say/listen while Realtime speech-to-speech is active (audio is already duplex). " +
        "dial/answer only if starting another call is required.";
    }
    out.push(def);
  }
  return out;
}

export function compactRealtimeToolOutput(text: string, maxChars = MAX_TOOL_OUTPUT_CHARS): string {
  const raw = (text || "").trim();
  if (raw.length <= maxChars) return raw;
  const lines = raw.split(/\r?\n/).filter((ln) => ln.trim());
  const keep: string[] = [];
  let size = 0;
  for (const ln of lines) {
    if (size + ln.length + 1 > maxChars) break;
    keep.push(ln);
    size += ln.length + 1;
  }
  if (!keep.length) return raw.slice(0, Math.max(0, maxChars - 1)) + "…";
  let out = keep.join("\n");
  if (lines.length > keep.length) out += "\n…";
  return out;
}

function asArgsObject(args: RealtimeToolCall["arguments"]): Record<string, unknown> {
  if (args && typeof args === "object" && !Array.isArray(args)) return args;
  if (typeof args === "string") {
    try {
      const parsed = JSON.parse(args) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      /* ignore */
    }
  }
  return {};
}

/**
 * Execute one Realtime tool call; returns text for function_call_output.
 * Mute is already on while the provider awaits sendToolResult.
 */
export async function executeRealtimeToolCall(
  config: Claw2Config,
  call: RealtimeToolCall,
  _ctx?: RealtimeToolsContext
): Promise<string> {
  const name = call.name.trim();
  const args = asArgsObject(call.arguments);

  try {
    if (name === "phone_call") {
      const result = await toolPhoneCall(config, {
        action: typeof args.action === "string" ? args.action : undefined,
        to: typeof args.to === "string" ? args.to : undefined,
        text: typeof args.text === "string" ? args.text : undefined,
        seconds: typeof args.seconds === "number" ? args.seconds : undefined,
        digits: typeof args.digits === "string" ? args.digits : undefined,
        target: typeof args.target === "string" ? args.target : undefined,
      });
      return compactRealtimeToolOutput(result.content);
    }

    if (name === "remember") {
      if (!config.memory?.enabled) return "Error: memory is disabled";
      const text = String(args.text ?? "").trim();
      if (!text) return "Error: remember requires text";
      const client = createClient(config);
      const source = args.source === "internal" ? "internal" : "user";
      const importance = typeof args.importance === "number" ? args.importance : undefined;
      const result = await memoryWrite(client, config, text, source, undefined, importance);
      return result.ok
        ? compactRealtimeToolOutput(`Saved: ${result.id ?? "ok"}`)
        : `Error: ${result.reason ?? "unknown"}`;
    }

    if (name === "memory_search") {
      if (!config.memory?.enabled) return "Error: memory is disabled";
      const query = String(args.query ?? "").trim();
      if (!query) return "Error: memory_search requires query";
      const limit =
        typeof args.limit === "number" && args.limit > 0 ? Math.min(args.limit, 20) : 5;
      const client = createClient(config);
      const { chunks } = await memoryRecall(client, config, query, limit);
      if (!chunks.length) return "No relevant chunks found.";
      const lines = chunks.map((c, i) => `[${i + 1}] (${c.source}) ${c.text}`).join("\n\n");
      return compactRealtimeToolOutput(lines);
    }

    if (name === "search") {
      const query = String(args.query ?? "").trim();
      if (!query) return "Error: search requires query";
      const result = await toolSearch(config, query);
      return result.ok
        ? compactRealtimeToolOutput(result.content ?? "No results.")
        : `Error: ${result.error ?? "search failed"}`;
    }

    if (name === "web_fetch") {
      const url = String(args.url ?? "").trim();
      if (!url) return "Error: web_fetch requires url";
      const result = await toolWebFetch(config, url);
      return result.ok
        ? compactRealtimeToolOutput(result.content ?? "")
        : `Error: ${result.error ?? "web_fetch failed"}`;
    }

    return `Error: tool "${name}" is not available in Realtime voice mode`;
  } catch (err) {
    return `Error: ${err instanceof Error ? err.message : String(err)}`;
  }
}

/**
 * Attach tool_call handler: execute → sendToolResult (keeps uplink muted until done).
 */
export function wireRealtimeTools(
  provider: RealtimeProvider,
  config: Claw2Config,
  ctx?: RealtimeToolsContext
): void {
  provider.on("tool_call", (toolCall) => {
    void (async () => {
      const t0 = performance.now();
      const output = await executeRealtimeToolCall(config, toolCall, ctx);
      const ms = Math.round(performance.now() - t0);
      console.info(`[sip/realtime/tools] executed`, {
        callId: ctx?.callId,
        tool: toolCall.name,
        ms,
        chars: output.length,
      });
      try {
        await provider.sendToolResult(toolCall.callId, output);
      } catch (err) {
        console.error("[sip/realtime/tools] sendToolResult failed:", err);
      }
    })();
  });
}
