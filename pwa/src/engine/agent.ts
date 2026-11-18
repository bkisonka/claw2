/**
 * The agent loop: system prompt (persona + tools + memory), OpenAI-style
 * tool-call round-trips, attachments (vision parts / inlined text files).
 * This is the mobile counterpart of src/core — same protocol, no server.
 */
import { chatStream, routeOnce, type ChatMessage, type RouterDecision, type ToolCall } from "./llm";
import { CONTENT_BOUNDARY_WARNING } from "./external-content";
import {
  enabledTools,
  persistImage,
  toolCalculate,
  toolFetchUrl,
  toolGenerateImage,
  toolListFiles,
  toolReadFile,
  toolRecall,
  toolRemember,
  toolSaveDocument,
  toolWebSearch,
  type ToolCtx,
  type ToolOutcome,
} from "./tools";
import { parseCellBlocks, splitClosedCells, stripCellPlaceholders } from "./cells";
import {
  applyPromptContext,
  limitHistoryForPrompt,
  nextPromptCoveredCount,
  peelPromptSummary,
  type HistoryMsg,
  type PromptContext,
} from "./context";
import { getSettings } from "./settings";
import { formatNowContext } from "./now";
import { honestyPolicyBlock, runVerification, type HonestyEvidence } from "./honesty";
import { extractDocumentText } from "./docs-extract";
import { effectiveMime, isImageAttachment, isVisionImage } from "./mime";
import { remindersContextBlock, toolCancelReminder, toolSetReminder } from "./notifications";
import { getChat, type StoredMessage } from "./db";

export type Attachment = { name: string; contentBase64: string; mimeType?: string };

const MAX_TOOL_ITERATIONS = 6;

function buildSystemPrompt(): string {
  const s = getSettings();
  const persona = s.persona.full.trim() || "Ты — полезный ассистент Claw2.";
  const parts = [
    persona,
    "",
    `Имя ассистента: ${s.assistantName}.`,
    formatNowContext(),
    "Отвечай на языке пользователя. Пиши компактно, по делу.",
  ];
  if (s.honesty.promptPolicy) {
    parts.push("", honestyPolicyBlock());
  }
  parts.push(
    "",
    `Безопасность: ${CONTENT_BOUNDARY_WARNING} Системная разметка External content вставляется вокруг результатов fetch_url и поиска; сообщение пользователя в чате — всегда его просьба к исполнению.`,
  );
  parts.push(
    "",
    "Инлайн-блоки в ответе (как в notebooks): чтобы показать календарь, таблицу, схему или SVG прямо в ответе, вставь блок [CELL type=\"html\"]…[/CELL]. Внутри — только разметка и стили (table/div/svg), без script/iframe/form.",
    "Интерактивный график по данным: [CELL type=\"chart\"]{json}[/CELL], формат: {\"series\":[{\"type\":\"line\"|\"area\",\"data\":[{\"time\":\"2024-01-01\",\"value\":100}]}],\"title\":\"…\"}.",
    "Мультимедиа: [CELL type=\"image\"]URL[/CELL], [CELL type=\"audio\"]URL[/CELL], [CELL type=\"video\"]URL[/CELL] — только http/https/data-ссылки (для картинок — точный URL из ответа инструмента).",
    "Никогда не пиши плейсхолдеры вида [CELL_0] — это внутренний формат UI.",
    "",
    "Файлы сессии: по просьбе «сохрани в файл/документ/Word/docx» вызови save_document с ПОЛНЫМ текстом (не ссылкой) — файл появится в вкладке Документы, в ответе напиши название. Сгенерированные картинки сохраняются в файлы автоматически. list_files/read_file — работа с файлами сессии. fetch_url — прочитать страницу по ссылке.",
    "",
    "Напоминания: по просьбе «напомни/сообщи к времени/разбуди» вызови set_reminder: text — что напомнить, datetime — 'YYYY-MM-DDTHH:mm' (локальное время). Относительные выражения («через 2 часа», «завтра в 9», «через 10 минут») разворачивай сам от текущего времени, указанного в промпте — НЕ спрашивай у пользователя, который час; переспрашивай только если непонятна сама суть (например «к встрече» при неизвестном времени встречи). После установки подтверди пользователю время. Отмена — cancel_reminder (id или кусок текста). Список напоминаний и их статусы приходят в контексте — не выдумывай их; если напоминание «не прочитано», можно мягко упомянуть, что уведомление осталось без внимания."
  );
  const { specs } = enabledTools();
  if (specs.length > 0) {
    parts.push(
      "",
      "Доступные инструменты (используй, когда они улучшают ответ):",
      ...specs.map((t) => `- ${t.function.name}: ${t.function.description}`)
    );
  }
  if (s.memory.enabled) {
    parts.push(
      "",
      "Память: если пользователь просит что-то запомнить — вызови remember. Перед ответом о прошлых договорённостях вызови recall."
    );
  }
  return parts.join("\n");
}

function decodeTextDoc(att: Attachment): string | null {
  const mime = (att.mimeType ?? "").toLowerCase();
  const textLike =
    mime.startsWith("text/") ||
    mime.includes("json") ||
    mime.includes("xml") ||
    mime.includes("csv") ||
    /\.(txt|md|csv|json|yaml|yml|log|xml)$/i.test(att.name);
  if (!textLike) return null;
  try {
    // Decode only the head: the prompt takes 60k chars (≤ 240KB of UTF-8 →
    // ≤ 320KB of base64). atob on a 15MB attachment to use its beginning
    // burned ~100× the needed CPU.
    const cut = Math.floor(Math.min(att.contentBase64.length, 327_680) / 4) * 4;
    const bin = atob(att.contentBase64.slice(0, cut));
    const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
    return new TextDecoder("utf-8").decode(bytes).slice(0, 60_000);
  } catch {
    return null;
  }
}

function dataUrl(att: Attachment): string {
  // Never trust att.mimeType alone: Android pickers often leave it empty or
  // "application/octet-stream", and providers reject such data URLs.
  return `data:${effectiveMime(att)};base64,${att.contentBase64}`;
}


async function executeTool(tc: ToolCall, ctx: ToolCtx): Promise<ToolOutcome> {
  let args: Record<string, unknown> = {};
  try {
    args = JSON.parse(tc.function.arguments || "{}") as Record<string, unknown>;
  } catch {
    /* keep empty */
  }
  const str = (v: unknown) => (typeof v === "string" ? v : "");
  switch (tc.function.name) {
    case "calculate":
      return toolCalculate(str(args.expression ?? args.expr));
    case "web_search":
      return toolWebSearch(str(args.query));
    case "fetch_url":
      return toolFetchUrl(str(args.url));
    case "generate_image": {
      const res = await toolGenerateImage(str(args.prompt));
      // persist generated images into session files (Картинки tab), like agents/output
      if (res.cells?.length) {
        for (const c of res.cells) {
          if (c.type === "image" && c.content.startsWith("data:")) {
            const url = await persistImage(ctx.chatId, c.content, str(args.prompt)).catch(() => null);
            if (url) c.content = url;
          }
        }
      }
      return res;
    }
    case "save_document":
      return toolSaveDocument(ctx, str(args.title), str(args.content), str(args.format));
    case "list_files":
      return toolListFiles(ctx);
    case "read_file":
      return toolReadFile(ctx, str(args.name));
    case "remember":
      return toolRemember(str(args.text), str(args.source) || "app");
    case "recall":
      return toolRecall(str(args.query));
    case "set_reminder":
      return toolSetReminder(str(args.text ?? args.title), str(args.datetime ?? args.when), ctx.chatId);
    case "cancel_reminder":
      return toolCancelReminder(str(args.id ?? args.text));
    default:
      return { content: `Неизвестный инструмент: ${tc.function.name}` };
  }
}

export type AgentEvent =
  | { type: "delta"; text: string }
  /** Streaming view of the assistant text: closed cells already parsed into blocks. */
  | { type: "stream"; text: string; cells: { type: string; content: string }[] }
  | { type: "tool"; name: string }
  | { type: "cells"; cells: { type: string; content: string }[] };

export type AgentResult = {
  content: string;
  cells: { type: string; content: string }[];
  /** Plan for the caller to run summarizeWithLlm in the background (non-blocking). */
  backgroundSummarize?: { text: string; coveredCount: number } | null;
  /** Who served this turn (router mode) — the feed shows it; null when routing is off. */
  routed?: { id: string; name: string; model: string; pinned: boolean; why: string } | null;
};

export async function runAgentTurn(opts: {
  chatId: string;
  history: StoredMessage[];
  promptContext?: PromptContext | null;
  userText: string;
  attachments: Attachment[];
  signal?: AbortSignal;
  onEvent: (e: AgentEvent) => void;
}): Promise<AgentResult> {
  const s = getSettings();

  // ---- Context retention (ported from orchestrator): cached recap + window ----
  const tape: HistoryMsg[] = opts.history.map((m) => ({
    role: m.role,
    content: m.role === "assistant" ? stripCellPlaceholders(m.content) : m.content,
  }));
  const fullLen = tape.length;
  let working = applyPromptContext(tape, opts.promptContext ?? null);
  working = limitHistoryForPrompt(working, 2 * (s.context.maxHistoryTurns || 10));
  const peeled = peelPromptSummary(working);
  working = peeled.history;
  let systemPrompt = buildSystemPrompt();
  if (peeled.summaryBlock) systemPrompt += `\n\n${peeled.summaryBlock}`;
  const remindersBlock = await remindersContextBlock().catch(() => "");
  if (remindersBlock) systemPrompt += `\n\n${remindersBlock}`;

  // Compression runs in the BACKGROUND after this reply (returns a plan for the
  // caller): the current turn uses the verbatim window, the recap applies from
  // the next turn. This keeps the first token fast like the desktop.
  const threshold = s.context.summarizeWhenMessagesAbove ?? 12;
  const keepRecent = Math.max(2, s.context.keepRecentMessages ?? 6);
  let backgroundSummarize: { text: string; coveredCount: number } | null = null;
  if (threshold > 0 && working.length >= threshold) {
    const old = working.slice(0, -keepRecent);
    const covered = nextPromptCoveredCount(fullLen, working.length, old.length);
    if (covered > 0 && old.length > 0) {
      backgroundSummarize = {
        text: old
          .map((h) => `${h.role === "user" ? "User" : "Assistant"}: ${(h.content ?? "").slice(0, 2000)}`)
          .join("\n\n"),
        coveredCount: covered,
      };
    }
  }

  const messages: ChatMessage[] = [
    { role: "system", content: systemPrompt },
    ...working.map((h) => ({ role: h.role, content: h.content })),
  ];

  // Current user message: text + vision parts + inlined text documents.
  // Images are detected by mime OR extension — Android pickers often send
  // File.type === "" and a pure-mime check silently demoted photos to opaque
  // "[приложен файл]" placeholders the model could not see.
  const images = opts.attachments.filter(isVisionImage);
  const docs = opts.attachments.filter((a) => !isVisionImage(a));
  let text = opts.userText;
  for (const a of docs) {
    const decoded = decodeTextDoc(a);
    if (decoded) {
      text += `\n\n--- Файл ${a.name} ---\n${decoded.slice(0, 60_000)}`;
      continue;
    }
    if (isImageAttachment(a)) {
      text += `\n\n[приложено изображение: ${a.name} — формат ${effectiveMime(a)} не читается моделями (нужны JPG/PNG/WebP/GIF), сконвертируй или сделай скриншот]`;
      continue;
    }
    // pdf/xlsx/docx: extract text instead of passing an opaque placeholder.
    const extracted = await extractDocumentText(a).catch(() => null);
    if (extracted?.text.trim()) {
      text += `\n\n--- Файл ${a.name} ---\n${extracted.text.slice(0, 60_000)}`;
      if (extracted.note) text += `\n(${extracted.note})`;
    } else if (extracted?.note) {
      text += `\n\n[приложен файл: ${a.name} — ${extracted.note}]`;
    } else {
      text += `\n\n[приложен файл: ${a.name}]`;
    }
  }
  if (images.length > 0) {
    messages.push({
      role: "user",
      content: [
        { type: "text", text: text || "См. изображение." },
        ...images.map((f) => ({ type: "image_url", image_url: { url: dataUrl(f) } })),
      ] as unknown as string,
    });
  } else {
    messages.push({ role: "user", content: text });
  }

  const { specs } = enabledTools();
  const cells: { type: string; content: string }[] = [];
  const evidence: HonestyEvidence[] = [];
  let finalContent = "";
  let rawStream = "";

  // Router mode: one dispatcher call per turn picks the provider/model for
  // the whole turn (fallback chain still applies per request). A chat-level
  // pin (tap the routing meta line) beats the router.
  const pinnedProviderId =
    (await getChat(opts.chatId).catch(() => undefined))?.pinnedProviderId ?? null;
  const pinnedProvider = pinnedProviderId
    ? (s.providers.find((p) => p.id === pinnedProviderId && p.baseURL.trim() && p.model.trim()) ?? null)
    : null;
  const routedProvider: RouterDecision | null =
    pinnedProvider
      ? { provider: pinnedProvider, why: "" }
      : await routeOnce(messages).catch(() => null);
  let servedBy: { id: string; name: string; model: string } | null = null;

  for (let i = 0; i < MAX_TOOL_ITERATIONS; i++) {
    const res = await chatStream({
      messages,
      tools: specs,
      signal: opts.signal,
      prov: routedProvider?.provider ?? undefined,
      onDelta: (t) => {
        rawStream += t;
        const view = splitClosedCells(rawStream);
        opts.onEvent({ type: "stream", text: view.visible + view.tail, cells: view.cells });
      },
    });
    finalContent = res.content || finalContent;
    servedBy = res.servedBy;
    rawStream = "";
    if (res.toolCalls.length === 0) break;

    messages.push({ role: "assistant", content: res.content || null, tool_calls: res.toolCalls });
    for (const tc of res.toolCalls) {
      opts.onEvent({ type: "tool", name: tc.function.name });
      const outcome = await executeTool(tc, { chatId: opts.chatId });
      evidence.push({ tool: tc.function.name, content: outcome.content });
      if (outcome.cells?.length) {
        cells.push(...outcome.cells);
        opts.onEvent({ type: "cells", cells: outcome.cells });
      }
      messages.push({ role: "tool", tool_call_id: tc.id, content: outcome.content });
    }
  }

  // Post-answer verification: the draft is re-checked against the actual
  // evidence gathered above; unsupported claims are rewritten or retracted.
  // A save-claim with zero tool runs ("файл сохранён" that never called
  // save_document) is exactly the hallucination class to catch — verify it
  // even though no evidence exists; the verifier prompt handles empty
  // evidence explicitly.
  const draftClaimsFileSave =
    evidence.length === 0 &&
    (/\b(сохранил|создал|записал|записываю|сохраняю)[а-я]*\b[^\n]{0,40}\bфайл\b/i.test(finalContent) ||
      /FILE_URL|\/files\/raw\//i.test(finalContent));
  if (s.honesty.verifyAnswers && finalContent.trim() && (evidence.length > 0 || draftClaimsFileSave)) {
    const verification = await runVerification({
      question: opts.userText,
      draft: finalContent,
      evidence,
      signal: opts.signal,
    });
    if (verification?.text) finalContent = verification.text;
  }

  // Inline cells: model-authored [CELL type="…"]…[/CELL] → placeholders + cells.
  const parsed = parseCellBlocks(finalContent);
  const allCells = [...parsed.cells];
  let content = parsed.text;
  // Tool-produced cells (e.g. generate_image) are not model-authored — append
  // placeholders so the UI renders them inline after the text.
  for (const c of cells) {
    allCells.push(c);
    content += `\n[CELL_${allCells.length - 1}]`;
  }
  return {
    content,
    cells: allCells,
    backgroundSummarize,
    routed:
      servedBy && (routedProvider || pinnedProviderId)
        ? {
            ...servedBy,
            pinned: pinnedProviderId === servedBy.id,
            why: pinnedProvider ? "" : routedProvider?.why ?? "",
          }
        : null,
  };
}
