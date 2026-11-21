// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Vitaliy Bondar

import { useCallback, useEffect, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { getAssistantPersona, putAssistantPersona } from "../api/assistantPersona";
import { useT } from "../i18n";

export function PersonaTab() {
  const t = useT();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const welcome = searchParams.get("welcome") === "1" || searchParams.get("onboarding") === "1";

  const [full, setFull] = useState("");
  const [compact, setCompact] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await getAssistantPersona();
      setFull(data.full ?? "");
      setCompact(data.compact ?? "");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const finishWelcome = (toChat: boolean) => {
    if (toChat) navigate("/chat", { replace: true });
    else navigate("/cabinet/persona", { replace: true });
  };

  const save = async (andContinue: boolean) => {
    setSaving(true);
    setError(null);
    setSaved(false);
    try {
      await putAssistantPersona({ full, compact });
      setSaved(true);
      if (andContinue || welcome) finishWelcome(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return <div className="persona-tab">{t("app.loading")}</div>;
  }

  return (
    <div className="persona-tab">
      {welcome && (
        <div className="persona-welcome" role="status">
          <h3 className="persona-welcome-title">{t("persona.welcomeTitle")}</h3>
          <p className="persona-welcome-lead">{t("persona.welcomeLead")}</p>
        </div>
      )}

      <section className="settings-section">
        <h2 className="settings-section-title">
          <span className="settings-section-title-label">{t("persona.title")}</span>
        </h2>
        <p className="settings-hint">{t("persona.hint")}</p>

        <label>
          <span>{t("persona.fullLabel")}</span>
          <textarea
            className="persona-full"
            value={full}
            onChange={(e) => {
              setFull(e.target.value);
              setSaved(false);
            }}
            rows={20}
            spellCheck
          />
        </label>

        <label>
          <span>{t("persona.compactLabel")}</span>
          <textarea
            className="persona-compact"
            value={compact}
            onChange={(e) => {
              setCompact(e.target.value);
              setSaved(false);
            }}
            rows={5}
            spellCheck
          />
        </label>

        {error && <p className="settings-error">{error}</p>}
        {saved && !welcome && <p className="settings-ok">{t("persona.saved")}</p>}

        <div className="persona-actions settings-actions">
          {welcome ? (
            <>
              <button
                type="button"
                disabled={saving || !full.trim()}
                onClick={() => void save(true)}
              >
                {saving ? t("persona.saving") : t("persona.saveContinue")}
              </button>
              <button
                type="button"
                className="settings-btn-secondary"
                disabled={saving}
                onClick={() => finishWelcome(true)}
              >
                {t("persona.skipLater")}
              </button>
            </>
          ) : (
            <button type="button" disabled={saving || !full.trim()} onClick={() => void save(false)}>
              {saving ? t("persona.saving") : t("persona.save")}
            </button>
          )}
        </div>
      </section>
    </div>
  );
}
