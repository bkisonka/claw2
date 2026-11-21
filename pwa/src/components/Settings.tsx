// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Vitaliy Bondar

import { useCallback, useEffect, useState } from "react";
import { getSettings, saveSettings, type AppSettings } from "../engine/settings";
import { clearMemory, memoryCount } from "../engine/db";
import { ProvidersSettings } from "./settings/ProvidersFold";
import {
  SettingsFold,
  Field,
  Toggle,
  SelectField,
  NumberField,
  TextArea,
  Hint,
  BtnRow,
  ActionBtn,
} from "./settings/common";

/**
 * Local app settings — everything is stored on-device and used by the
 * in-app engine (no gateway, no remote config).
 */
export function Settings() {
  const [s, setS] = useState<AppSettings>(() => getSettings());
  const [memCount, setMemCount] = useState(0);
  const [toast, setToast] = useState<string | null>(null);

  useEffect(() => {
    void memoryCount().then(setMemCount);
  }, [s.memory.enabled]);

  const patch = useCallback((p: Parameters<typeof saveSettings>[0]) => {
    setS(saveSettings(p));
    setToast("Сохранено");
    window.setTimeout(() => setToast(null), 1500);
  }, []);

  return (
    <div className="settings-root">
      <p className="settings-intro">
        Всё хранится и выполняется на устройстве: приложение говорит с LLM напрямую. Данные — в локальной базе
        (чаты, память), настройки — в приложении.
      </p>

      <SettingsFold title="Провайдеры (LLM)" defaultOpen>
        <ProvidersSettings />
        <Toggle
          label="Thinking модели (enable_thinking)"
          checked={s.llm.enableThinking}
          onChange={(v) => patch({ llm: { enableThinking: v } })}
          hint="Выключено — на MiniMax/DeepSeek отключают reasoning-параметрами автоматически."
        />
        <NumberField label="Max tokens" value={s.llm.maxTokens} onChange={(v) => patch({ llm: { maxTokens: v } })} placeholder="2048" min={1} />
        <Field label="Имя ассистента" value={s.assistantName} onChange={(v) => patch({ assistantName: v })} placeholder="Claw2" />
      </SettingsFold>

      <SettingsFold title="Персона">
        <TextArea
          label="Full (полная — основной промпт)"
          value={s.persona.full}
          onChange={(v) => patch({ persona: { full: v } })}
          rows={7}
          placeholder="Опиши характер, стиль и правила ассистента…"
        />
        <TextArea
          label="Compact (для коротких режимов)"
          value={s.persona.compact}
          onChange={(v) => patch({ persona: { compact: v } })}
          rows={3}
        />
      </SettingsFold>

      <SettingsFold title="Память">
        <Toggle label="Долговременная память" checked={s.memory.enabled} onChange={(v) => patch({ memory: { enabled: v } })} hint="Инструменты remember/recall доступны модели." />
        <Field label="Embedding base URL (необязательно)" value={s.memory.embeddingBaseURL} onChange={(v) => patch({ memory: { embeddingBaseURL: v } })} placeholder="https://api.openai.com/v1" hint="Без него поиск по памяти — по ключевым словам." />
        <Field label="Embedding API key" type="password" value={s.memory.embeddingApiKey} onChange={(v) => patch({ memory: { embeddingApiKey: v } })} />
        <Field label="Embedding модель" value={s.memory.embeddingModel} onChange={(v) => patch({ memory: { embeddingModel: v } })} placeholder="text-embedding-3-small" />
        <BtnRow>
          <ActionBtn onClick={() => void memoryCount().then(setMemCount)}>Записей: {memCount}</ActionBtn>
          <ActionBtn
            danger
            onClick={() => {
              if (!window.confirm("Очистить всю память?")) return;
              void clearMemory().then(() => setMemCount(0));
            }}
          >
            Очистить
          </ActionBtn>
        </BtnRow>
      </SettingsFold>

      <SettingsFold title="Поиск в интернете">
        <SelectField
          label="Провайдер"
          value={s.search.provider}
          options={[
            { value: "off", label: "выключен" },
            { value: "tavily", label: "Tavily" },
            { value: "searxng", label: "SearXNG" },
            { value: "other", label: "Other (SearXNG-совместимый)" },
          ]}
          onChange={(v) => patch({ search: { provider: v as AppSettings["search"]["provider"] } })}
        />
        {s.search.provider === "tavily" && (
          <Field label="Tavily API key" type="password" value={s.search.tavilyApiKey} onChange={(v) => patch({ search: { tavilyApiKey: v } })} />
        )}
        {s.search.provider === "searxng" && (
          <Field label="SearXNG URL" value={s.search.searxngUrl} onChange={(v) => patch({ search: { searxngUrl: v } })} placeholder="https://searx.be" />
        )}
        {s.search.provider === "other" && (
          <>
            <Field label="URL" value={s.search.otherUrl} onChange={(v) => patch({ search: { otherUrl: v } })} placeholder="https://…/search" />
            <Field label="API key" type="password" value={s.search.otherApiKey} onChange={(v) => patch({ search: { otherApiKey: v } })} />
          </>
        )}
      </SettingsFold>

      <SettingsFold title="Генерация картинок">
        <Field label="URL (OpenAI-совместимый или A1111)" value={s.images.sdUrl} onChange={(v) => patch({ images: { sdUrl: v } })} placeholder="https://… или http://192.168.50.10:7860" />
        <Field label="API key" type="password" value={s.images.sdApiKey} onChange={(v) => patch({ images: { sdApiKey: v } })} />
        <Field label="Модель" value={s.images.sdModel} onChange={(v) => patch({ images: { sdModel: v } })} />
      </SettingsFold>

      <SettingsFold title="Контекст">
        <NumberField
          label="Макс. история, реплик"
          value={s.context.maxHistoryTurns}
          onChange={(v) => patch({ context: { maxHistoryTurns: v } })}
          placeholder="10"
          min={1}
          hint="Сколько последних реплик уходит модели дословно (2 × реплик = сообщений)."
        />
        <NumberField
          label="Сжимать когда сообщений больше"
          value={s.context.summarizeWhenMessagesAbove}
          onChange={(v) => patch({ context: { summarizeWhenMessagesAbove: v } })}
          placeholder="12"
          min={0}
          hint="0 — никогда. При превышении старые реплики сворачиваются в рекап (только в системный промпт, лента в чате не меняется)."
        />
        <NumberField
          label="Сохранять свежими, сообщений"
          value={s.context.keepRecentMessages}
          onChange={(v) => patch({ context: { keepRecentMessages: v } })}
          placeholder="6"
          min={2}
        />
      </SettingsFold>

      <SettingsFold title="Достоверность">
        <Toggle
          label="Политика честности в промпте"
          checked={s.honesty.promptPolicy}
          onChange={(v) => patch({ honesty: { promptPolicy: v } })}
          hint="Правила для модели: опираться на источники и память, не выдумывать факты и ссылки, при неуверенности прямо говорить «не знаю». Бесплатно — просто текст в системном промпте."
        />
        <Toggle
          label="Проверка ответа после генерации"
          checked={s.honesty.verifyAnswers}
          onChange={(v) => patch({ honesty: { verifyAnswers: v } })}
          hint="Второй вызов модели перечитывает черновик ответа против результатов инструментов (поиск, файлы, память) и убирает неподтверждённые утверждения. Работает только на ответах после инструментов; замедляет ответ на один вызов LLM."
        />
        <Hint>Политика промпта включена по умолчанию. Проверка — опциональна: включай, когда нужны максимально осторожные ответы (факты, даты, цитаты).</Hint>
      </SettingsFold>

      <SettingsFold title="Голос (PTT)">
        <Field
          label="STT Base URL"
          value={s.voice.sttBaseURL}
          onChange={(v) => patch({ voice: { sttBaseURL: v } })}
          placeholder="https://api.openai.com/v1"
          hint="OpenAI-совместимый: запрос уйдёт на {base}/audio/transcriptions. Локальный сервис с готовым /stt — укажи его URL целиком."
        />
        <Field label="STT API key" type="password" value={s.voice.sttApiKey} onChange={(v) => patch({ voice: { sttApiKey: v } })} />
        <Field
          label="STT модель"
          value={s.voice.sttModel}
          onChange={(v) => patch({ voice: { sttModel: v } })}
          placeholder="whisper-1"
          hint="Например whisper-1, gpt-4o-mini-transcribe или модель локального сервиса."
        />
      </SettingsFold>

      {toast && <p className="settings-status settings-status--ok">{toast}</p>}
    </div>
  );
}
