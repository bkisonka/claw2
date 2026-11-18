import type OpenAI from "openai";
import { applyBuiltinRules, applyIdentityHeuristics } from "./rules-builtin.js";
import { applyCustomRules, compileCustomRules, type CompiledCustomRule } from "./rules-custom.js";
import type { PrivacyCustomRule } from "./types.js";

/**
 * In-memory PII tokenization for one LLM turn (XZDR semantics).
 * Placeholders: [PII_{KIND}_{n}]. Not persisted.
 */
export class PiiMasker {
  private placeholders = new Map<string, string>();
  private counters = new Map<string, number>();
  private readonly customRules: CompiledCustomRule[];

  constructor(customRules?: PrivacyCustomRule[]) {
    this.customRules = compileCustomRules(customRules);
  }

  get tokenCount(): number {
    return this.placeholders.size;
  }

  maskText(text: string): string {
    if (!text) return text;
    let out = applyBuiltinRules(text, (kind, value) => this.replace(kind, value));
    if (this.customRules.length > 0) {
      out = applyCustomRules(out, this.customRules, (kind, value) => this.replace(kind, value));
    }
    out = applyIdentityHeuristics(out, (kind, value) => this.replace(kind, value));
    return out;
  }

  unmaskText(text: string): string {
    if (!text || this.placeholders.size === 0) return text;
    let out = text;
    const keys = [...this.placeholders.keys()].sort((a, b) => b.length - a.length);
    for (const key of keys) {
      out = out.split(key).join(this.placeholders.get(key)!);
    }
    return out;
  }

  clear(): void {
    this.placeholders.clear();
    this.counters.clear();
  }

  private replace(kind: string, value: string): string {
    for (const [placeholder, original] of this.placeholders) {
      if (original === value) return placeholder;
    }
    const index = (this.counters.get(kind) ?? 0) + 1;
    this.counters.set(kind, index);
    const placeholder = `[PII_${kind}_${index}]`;
    this.placeholders.set(placeholder, value);
    return placeholder;
  }
}

function maskMessageContent(content: unknown, masker: PiiMasker): unknown {
  if (typeof content === "string") return masker.maskText(content);
  if (Array.isArray(content)) {
    return content.map((part) => {
      if (!part || typeof part !== "object") return part;
      const copy = { ...(part as Record<string, unknown>) };
      if (copy.type === "text" && typeof copy.text === "string") {
        copy.text = masker.maskText(copy.text);
      }
      return copy;
    });
  }
  return content;
}

function unmaskMessageContent(content: unknown, masker: PiiMasker): unknown {
  if (typeof content === "string") return masker.unmaskText(content);
  if (Array.isArray(content)) {
    return content.map((part) => {
      if (!part || typeof part !== "object") return part;
      const copy = { ...(part as Record<string, unknown>) };
      if (copy.type === "text" && typeof copy.text === "string") {
        copy.text = masker.unmaskText(copy.text);
      }
      return copy;
    });
  }
  return content;
}

/** Deep-ish copy + mask OpenAI chat messages (content + tool call args). */
export function maskChatMessages(
  messages: OpenAI.Chat.ChatCompletionMessageParam[],
  masker: PiiMasker
): OpenAI.Chat.ChatCompletionMessageParam[] {
  return messages.map((message) => {
    const msg = { ...(message as unknown as Record<string, unknown>) };
    if ("content" in msg) {
      msg.content = maskMessageContent(msg.content, masker);
    }
    const toolCalls = msg.tool_calls;
    if (Array.isArray(toolCalls)) {
      msg.tool_calls = toolCalls.map((call) => {
        if (!call || typeof call !== "object") return call;
        const c = { ...(call as Record<string, unknown>) };
        const fn = c.function;
        if (fn && typeof fn === "object") {
          const f = { ...(fn as Record<string, unknown>) };
          if (typeof f.arguments === "string") {
            f.arguments = masker.maskText(f.arguments);
          }
          c.function = f;
        }
        return c;
      });
    }
    return msg as unknown as OpenAI.Chat.ChatCompletionMessageParam;
  });
}

export function unmaskToolCalls(
  toolCalls: OpenAI.Chat.ChatCompletionMessageToolCall[] | undefined,
  masker: PiiMasker
): OpenAI.Chat.ChatCompletionMessageToolCall[] | undefined {
  if (!toolCalls?.length) return toolCalls;
  return toolCalls.map((tc) => {
    if (!tc || typeof tc !== "object") return tc;
    const copy = { ...tc } as OpenAI.Chat.ChatCompletionMessageToolCall & {
      function?: { name: string; arguments: string };
    };
    if (copy.function && typeof copy.function.arguments === "string") {
      copy.function = {
        ...copy.function,
        arguments: masker.unmaskText(copy.function.arguments),
      };
    }
    return copy;
  });
}

export { unmaskMessageContent };
