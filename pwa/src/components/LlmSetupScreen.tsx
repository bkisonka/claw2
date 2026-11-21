// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Vitaliy Bondar

import { useState } from "react";
import { getSettings, saveOnboardingConnection, saveSettings } from "../engine/settings";
import { listModels } from "../engine/llm";
import { ModelPicker } from "./settings/ModelPicker";

/**
 * First-run wizard, fully local: the app talks to the LLM API directly,
 * so "onboarding" = point at an endpoint (cloud or LAN) and pick a model.
 */
export function LlmSetupScreen({ onReady }: { onReady: () => void }) {
  const initial = getSettings().llm;
  const [baseURL, setBaseURL] = useState(initial.baseURL);
  const [model, setModel] = useState(initial.model);
  const [apiKey, setApiKey] = useState(initial.apiKey);
  const [error, setError] = useState<string | null>(null);

  // The combobox fetches the list itself; local fields must reach the store
  // first because listModels() reads the saved connection settings.
  const fetchModels = async () => {
    saveSettings({ llm: { baseURL, apiKey, model: model || undefined } });
    return listModels();
  };

  const saveAndStart = () => {
    const base = baseURL.trim();
    if (!base) {
      setError("Укажи Base URL — облачный API или локальный сервер (LM Studio, Ollama)");
      return;
    }
    if (!model.trim()) {
      setError("Укажи модель (или нажми «Загрузить модели»)");
      return;
    }
    // Into the provider registry, not just legacy llm.* — otherwise the
    // connection is invisible in Настройки → Провайдеры until next cold start.
    saveOnboardingConnection({ baseURL: base, apiKey: apiKey.trim(), model: model.trim() });
    if (!getSettings().llm.apiKey && !/localhost|127\.0\.0\.1|192\.168\.|10\.|172\.(1[6-9]|2\d|3[01])\./i.test(base)) {
      setError("Для облачного API нужен ключ");
      return;
    }
    onReady();
  };

  return (
    <div className="login-root">
      <form
        className="login-form"
        onSubmit={(e) => {
          e.preventDefault();
          saveAndStart();
        }}
      >
        <h1 className="login-title">Claw2</h1>
        <p className="login-sub">Подключи модель — приложение работает с ней напрямую</p>
        <label className="login-field">
          <span>Base URL</span>
          <input
            type="text"
            inputMode="url"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            value={baseURL}
            onChange={(e) => setBaseURL(e.target.value)}
            placeholder="https://api.openai.com/v1 или http://192.168.50.10:1234/v1"
            required
          />
        </label>
        <label className="login-field">
          <span>API key</span>
          <input
            type="password"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            placeholder="sk-…"
            autoComplete="off"
          />
        </label>
        <ModelPicker
          variant="login"
          value={model}
          onChange={setModel}
          fetchModels={() => fetchModels()}
        />
        <p className="settings-hint">
          Локально: LM Studio — http://IP-компьютера:1234/v1, Ollama — http://IP:11434/v1 (нужен
          OLLAMA_ORIGINS=*). Облако — любой OpenAI-совместимый API. Список моделей подтянется в поле
          «Модель» из /models выбранного API — по фокусу на поле.
        </p>
        {error && <p className="login-error">{error}</p>}
        <button type="submit" className="login-submit">
          Сохранить и начать
        </button>
      </form>
    </div>
  );
}
