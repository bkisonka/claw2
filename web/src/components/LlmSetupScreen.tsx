// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Vitaliy Bondar

import { useCallback, useEffect, useState } from "react";
import { getConfig, putConfig } from "../api/config";
import { fetchConnectionsStatus } from "../api/connections";
import { useT } from "../i18n";

type Props = {
  onReady: () => void;
};

/**
 * First-run / missing LLM credentials: baseURL, model, apiKey → save → verify.
 */
export function LlmSetupScreen({ onReady }: Props) {
  const t = useT();
  const [baseURL, setBaseURL] = useState("");
  const [model, setModel] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hint, setHint] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const c = await getConfig();
        const llm = (c.llm as Record<string, unknown> | undefined) ?? {};
        if (!cancelled) {
          setBaseURL(typeof llm.baseURL === "string" ? llm.baseURL : "");
          setModel(typeof llm.model === "string" ? llm.model : "");
          const key = typeof llm.apiKey === "string" ? llm.apiKey : "";
          setApiKey(key === "***" ? "" : key);
        }
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const saveAndContinue = useCallback(async () => {
    setSaving(true);
    setTesting(true);
    setError(null);
    setHint(null);
    try {
      const current = await getConfig();
      const llm = {
        ...((current.llm as Record<string, unknown>) ?? {}),
        baseURL: baseURL.trim() || undefined,
        model: model.trim() || undefined,
        apiKey: apiKey.trim() || undefined,
      };
      await putConfig({ ...current, llm });
      const status = await fetchConnectionsStatus();
      if (status.onboarding?.needsLlmSetup) {
        setError(status.onboarding.reason || t("onboarding.stillMissing"));
        setHint(t("onboarding.localHint"));
        return;
      }
      const llmConn = status.connections.find((c) => c.id === "llm");
      if (llmConn && llmConn.status !== "ok") {
        setError(llmConn.error || t("onboarding.unreachable"));
        setHint(t("onboarding.localHint"));
        return;
      }
      onReady();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
      setTesting(false);
    }
  }, [apiKey, baseURL, model, onReady, t]);

  if (loading) {
    return (
      <div className="llm-setup-page">
        <div className="llm-setup-card">{t("app.loading")}</div>
      </div>
    );
  }

  return (
    <div className="llm-setup-page">
      <div className="llm-setup-card">
        <h1 className="llm-setup-title">{t("onboarding.title")}</h1>
        <p className="llm-setup-lead">{t("onboarding.lead")}</p>
        <form
          className="llm-setup-form"
          onSubmit={(e) => {
            e.preventDefault();
            void saveAndContinue();
          }}
        >
          <label>
            <span>{t("settings.baseUrl")}</span>
            <input
              value={baseURL}
              onChange={(e) => setBaseURL(e.target.value)}
              placeholder="https://api.openai.com/v1"
              autoComplete="off"
              required
            />
          </label>
          <label>
            <span>{t("settings.model")}</span>
            <input
              value={model}
              onChange={(e) => setModel(e.target.value)}
              placeholder="gpt-4o-mini"
              autoComplete="off"
            />
          </label>
          <label>
            <span>{t("settings.apiKey")}</span>
            <input
              type="password"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              placeholder={t("onboarding.apiKeyPlaceholder")}
              autoComplete="off"
            />
          </label>
          <p className="llm-setup-hint">{t("onboarding.localHint")}</p>
          {error && <p className="llm-setup-error">{error}</p>}
          {hint && !error && <p className="llm-setup-hint">{hint}</p>}
          <button type="submit" className="llm-setup-submit" disabled={saving || testing}>
            {saving || testing ? t("onboarding.checking") : t("onboarding.saveStart")}
          </button>
        </form>
      </div>
    </div>
  );
}
