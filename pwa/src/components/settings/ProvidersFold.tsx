import { useState } from "react";
import { getSettings, saveSettings, type ProviderConfig } from "../../engine/settings";
import { listModels } from "../../engine/llm";
import { ModelPicker } from "./ModelPicker";
import { CapabilityPicker } from "./CapabilityPicker";
import { Field, Hint, Toggle } from "./common";

/**
 * Provider registry for Настройки → Провайдеры (LLM): add / edit / delete
 * providers, mark one active, toggle router mode (quick switcher in the chat
 * + automatic fallback across the list).
 */

function newProvider(): ProviderConfig {
  return {
    id: `p_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    name: "",
    baseURL: "",
    apiKey: "",
    model: "",
    routerModel: "",
    notes: "",
    vision: false,
  };
}

function hostOf(baseURL: string): string {
  try {
    return new URL(baseURL).host;
  } catch {
    return "";
  }
}

/** Plain http:// to a non-local host sends the API key in the clear (MITM). */
function isPlaintextRemote(baseURL: string): boolean {
  try {
    const u = new URL(baseURL.trim());
    if (u.protocol !== "http:") return false;
    const h = u.hostname.toLowerCase();
    return !/^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|\[::1\])/.test(h);
  } catch {
    return false;
  }
}

function ProviderForm({
  draft,
  onChange,
}: {
  draft: ProviderConfig;
  onChange: (next: ProviderConfig) => void;
}) {
  return (
    <div className="provider-form">
      <Field
        label="Название"
        value={draft.name}
        onChange={(v) => onChange({ ...draft, name: v })}
        placeholder={hostOf(draft.baseURL) || "Основной"}
      />
      <Field
        label="Base URL"
        value={draft.baseURL}
        onChange={(v) => onChange({ ...draft, baseURL: v })}
        placeholder="https://api.openai.com/v1"
      />
      {isPlaintextRemote(draft.baseURL) && (
        <p className="provider-error" role="alert">
          Внешний http://: трафик и API-ключ идут в открытом виде — любой в сети видит их. Для облака
          используйте https://, http:// оставьте только для локальной сети.
        </p>
      )}
      <Field
        label="API key"
        type="password"
        value={draft.apiKey}
        onChange={(v) => onChange({ ...draft, apiKey: v })}
        placeholder="sk-…"
      />
      <ModelPicker
        value={draft.model}
        onChange={(m) => onChange({ ...draft, model: m })}
        fetchModels={() => listModels({ baseURL: draft.baseURL, apiKey: draft.apiKey })}
      />
      <CapabilityPicker
        notes={draft.notes}
        vision={draft.vision}
        onChange={({ notes, vision }) => onChange({ ...draft, notes, vision })}
      />
      <ModelPicker
        label="Модель-роутер"
        placeholder="не используется"
        value={draft.routerModel}
        onChange={(m) => onChange({ ...draft, routerModel: m })}
        fetchModels={() => listModels({ baseURL: draft.baseURL, apiKey: draft.apiKey })}
      />
      <Hint>
        Модель-роутер — дешёвая, быстрая и лучше не-reasoning: в режиме роутера она читает контекст
        диалога и список моделей всех провайдеров и решает, какая ответит. Пусто — не маршрутизирует.
      </Hint>
    </div>
  );
}

export function ProvidersSettings() {
  const [s, setS] = useState(() => getSettings());
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState<ProviderConfig | null>(null);
  const [error, setError] = useState<string | null>(null);

  const commit = (updater: (prev: ProviderConfig[]) => ProviderConfig[], extra?: Partial<typeof s>) => {
    const cur = getSettings();
    const providers = updater(cur.providers);
    const next = saveSettings({ providers, ...extra });
    setS(next);
  };

  const startEdit = (p: ProviderConfig) => {
    setEditingId(p.id);
    setDraft({ ...p });
  };

  const saveEdit = () => {
    if (!draft) return;
    const name = draft.name.trim() || hostOf(draft.baseURL) || "Провайдер";
    if (!draft.baseURL.trim()) {
      setError("Base URL обязателен");
      return;
    }
    commit((prev) => prev.map((p) => (p.id === draft.id ? { ...draft, name } : p)));
    setEditingId(null);
    setDraft(null);
    setError(null);
  };

  const addProvider = () => {
    const p = newProvider();
    commit((prev) => [...prev, p]);
    // First provider becomes active automatically.
    if (getSettings().providers.length === 1) {
      saveSettings({ activeProviderId: p.id });
    }
    startEdit(p);
  };

  const removeProvider = (id: string) => {
    if (!window.confirm("Удалить провайдера?")) return;
    const cur = getSettings();
    const extra: Partial<typeof s> = {};
    if (cur.activeProviderId === id) {
      const rest = cur.providers.filter((p) => p.id !== id);
      extra.activeProviderId = rest[0]?.id ?? "";
      if (rest.length < 2) extra.routerMode = false;
    }
    commit((prev) => prev.filter((p) => p.id !== id), extra);
  };

  const setActive = (id: string) => {
    const next = saveSettings({ activeProviderId: id });
    setS(next);
  };

  const setRouter = (v: boolean) => {
    const next = saveSettings({ routerMode: v });
    setS(next);
  };

  const providers = s.providers;
  const routerAvailable = providers.length >= 2;

  return (
    <div className="providers-root">
      <ul className="provider-list">
        {providers.map((p) => {
          const active = p.id === s.activeProviderId;
          const editing = editingId === p.id && draft?.id === p.id;
          return (
            <li key={p.id} className={`provider-card${active ? " provider-card--active" : ""}`}>
              {editing ? (
                <>
                  <ProviderForm draft={draft!} onChange={setDraft} />
                  {error && <p className="provider-error">{error}</p>}
                  <div className="provider-actions">
                    <button type="button" className="provider-btn provider-btn--primary" onClick={saveEdit}>
                      Сохранить
                    </button>
                    <button
                      type="button"
                      className="provider-btn"
                      onClick={() => {
                        setEditingId(null);
                        setDraft(null);
                        setError(null);
                      }}
                    >
                      Отмена
                    </button>
                  </div>
                </>
              ) : (
                <>
                  <button
                    type="button"
                    className="provider-main"
                    onClick={() => setActive(p.id)}
                    title={active ? "Активный провайдер" : "Сделать активным"}
                  >
                    <span className="provider-radio" aria-hidden>
                      {active ? "●" : "○"}
                    </span>
                    <span className="provider-info">
                      <span className="provider-name">
                        {p.name || hostOf(p.baseURL) || "Провайдер"}
                        {active && <span className="provider-active-tag">активный</span>}
                      </span>
                      <span className="provider-line">
                        {p.model ? `${p.model}` : "без модели"}
                        {p.routerModel ? ` · роутер: ${p.routerModel}` : ""}
                        {` · ${hostOf(p.baseURL) || p.baseURL}`}
                      </span>
                    </span>
                  </button>
                  <div className="provider-actions">
                    <button type="button" className="provider-btn" onClick={() => startEdit(p)}>
                      Изменить
                    </button>
                    <button type="button" className="provider-btn provider-btn--danger" onClick={() => removeProvider(p.id)}>
                      Удалить
                    </button>
                  </div>
                </>
              )}
            </li>
          );
        })}
      </ul>

      <button type="button" className="provider-add" onClick={addProvider}>
        + Добавить провайдера
      </button>

      <Toggle
        label="Режим роутера"
        checked={s.routerMode && routerAvailable}
        disabled={!routerAvailable}
        onChange={setRouter}
        hint={
          routerAvailable
            ? "На каждом ходу модель-роутер активного провайдера оценивает кандидатов и направляет запрос лучшей; молчащий или упавший провайдер заменяется следующим из списка."
            : "Доступен, когда добавлено минимум два провайдера."
        }
      />
      {providers.length === 0 && (
        <Hint>Провайдеров нет — добавь хотя бы один, иначе запросы уходить не будут.</Hint>
      )}
    </div>
  );
}
