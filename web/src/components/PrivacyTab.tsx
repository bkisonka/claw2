import { useCallback, useEffect, useMemo, useState } from "react";
import { getConfig, putConfig, type Config } from "../api/config";
import {
  fetchPrivacySidecarStatus,
  previewPrivacyMask,
  type PrivacyCustomRule,
  type PrivacySidecarStatus,
} from "../api/privacy";
import { useT } from "../i18n";
import { isLikelyLocalBaseUrl } from "../lib/llmLocal";

type MultimodalBackend = "auto" | "off" | "sidecar";

type PrivacyState = {
  enabled: boolean;
  applyToLocal: boolean;
  multimodalBackend: MultimodalBackend;
  multimodalMaxSizeMb: number;
  ocrTimeoutSeconds: number;
  customRules: PrivacyCustomRule[];
};

function readPrivacy(cfg: Config | null): PrivacyState {
  const p = (cfg?.privacy && typeof cfg.privacy === "object" ? cfg.privacy : {}) as Record<
    string,
    unknown
  >;
  const rules = Array.isArray(p.customRules) ? (p.customRules as PrivacyCustomRule[]) : [];
  const backend =
    p.multimodalBackend === "off" || p.multimodalBackend === "sidecar" || p.multimodalBackend === "auto"
      ? p.multimodalBackend
      : "auto";
  return {
    enabled: p.enabled === true,
    applyToLocal: p.applyToLocal === true,
    multimodalBackend: backend,
    multimodalMaxSizeMb:
      typeof p.multimodalMaxSizeMb === "number" && p.multimodalMaxSizeMb > 0
        ? p.multimodalMaxSizeMb
        : 10,
    ocrTimeoutSeconds:
      typeof p.ocrTimeoutSeconds === "number" && p.ocrTimeoutSeconds > 0
        ? p.ocrTimeoutSeconds
        : 30,
    customRules: rules.map((r, i) => ({
      id: r.id || `rule_${i + 1}`,
      name: r.name || "RULE",
      ruleType: r.ruleType === "regex" ? "regex" : "keyword",
      pattern: r.pattern || "",
      caseSensitive: r.caseSensitive === true,
      wholeWord: r.wholeWord === true,
      enabled: r.enabled !== false,
      sortOrder: typeof r.sortOrder === "number" ? r.sortOrder : i,
    })),
  };
}

function newRuleId(): string {
  return `rule_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
}

export function PrivacyTab() {
  const t = useT();
  const [config, setConfig] = useState<Config | null>(null);
  const [privacy, setPrivacy] = useState<PrivacyState>({
    enabled: false,
    applyToLocal: false,
    multimodalBackend: "auto",
    multimodalMaxSizeMb: 10,
    ocrTimeoutSeconds: 30,
    customRules: [],
  });
  const [sidecar, setSidecar] = useState<PrivacySidecarStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedOk, setSavedOk] = useState(false);
  const [previewText, setPreviewText] = useState(
    "Пиши на test@example.com, тел. +7 (999) 123-45-67, ИНН 7707083893"
  );
  const [previewResult, setPreviewResult] = useState<string | null>(null);
  const [previewMeta, setPreviewMeta] = useState<string | null>(null);
  const [previewing, setPreviewing] = useState(false);

  const baseURL =
    typeof (config?.llm as { baseURL?: string } | undefined)?.baseURL === "string"
      ? (config!.llm as { baseURL: string }).baseURL
      : "";
  const localEndpoint = useMemo(() => isLikelyLocalBaseUrl(baseURL), [baseURL]);
  const wouldApply =
    privacy.enabled && (!localEndpoint || privacy.applyToLocal);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [cfg, status] = await Promise.all([getConfig(), fetchPrivacySidecarStatus()]);
      setConfig(cfg);
      setPrivacy(readPrivacy(cfg));
      setSidecar(status);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const persist = useCallback(async () => {
    if (!config) return;
    setSaving(true);
    setError(null);
    setSavedOk(false);
    try {
      const updated: Config = {
        ...config,
        privacy: {
          ...(typeof config.privacy === "object" && config.privacy ? config.privacy : {}),
          enabled: privacy.enabled,
          applyToLocal: privacy.applyToLocal,
          multimodalBackend: privacy.multimodalBackend,
          multimodalMaxSizeMb: privacy.multimodalMaxSizeMb,
          ocrTimeoutSeconds: privacy.ocrTimeoutSeconds,
          customRules: privacy.customRules,
        },
      };
      await putConfig(updated);
      setConfig(updated);
      setSavedOk(true);
      try {
        setSidecar(await fetchPrivacySidecarStatus());
      } catch {
        /* ignore status refresh */
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }, [config, privacy]);

  const updateRule = (id: string, patch: Partial<PrivacyCustomRule>) => {
    setPrivacy((prev) => ({
      ...prev,
      customRules: prev.customRules.map((r) => (r.id === id ? { ...r, ...patch } : r)),
    }));
  };

  const addRule = () => {
    setPrivacy((prev) => ({
      ...prev,
      customRules: [
        ...prev.customRules,
        {
          id: newRuleId(),
          name: "custom",
          ruleType: "keyword",
          pattern: "",
          caseSensitive: false,
          wholeWord: true,
          enabled: true,
          sortOrder: prev.customRules.length,
        },
      ],
    }));
  };

  const removeRule = (id: string) => {
    setPrivacy((prev) => ({
      ...prev,
      customRules: prev.customRules.filter((r) => r.id !== id),
    }));
  };

  const runPreview = async () => {
    setPreviewing(true);
    setError(null);
    try {
      const res = await previewPrivacyMask({
        text: previewText,
        enabled: privacy.enabled,
        applyToLocal: privacy.applyToLocal,
        customRules: privacy.customRules,
      });
      setPreviewResult(res.masked);
      setPreviewMeta(
        t("privacy.previewMeta", {
          tokens: String(res.tokenCount),
          apply: res.wouldApply ? t("privacy.yes") : t("privacy.no"),
        })
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setPreviewing(false);
    }
  };

  if (loading) {
    return <p className="muted">{t("privacy.loading")}</p>;
  }

  return (
    <div className="privacy-tab">
      <p className="muted">{t("privacy.lead")}</p>

      <label className="privacy-toggle">
        <input
          type="checkbox"
          checked={privacy.enabled}
          onChange={(e) => setPrivacy((p) => ({ ...p, enabled: e.target.checked }))}
        />
        <span>{t("privacy.enabled")}</span>
      </label>

      <label className="privacy-toggle">
        <input
          type="checkbox"
          checked={privacy.applyToLocal}
          disabled={!privacy.enabled}
          onChange={(e) => setPrivacy((p) => ({ ...p, applyToLocal: e.target.checked }))}
        />
        <span>{t("privacy.applyToLocal")}</span>
      </label>

      <p className="privacy-status">
        {t("privacy.status", {
          endpoint: localEndpoint ? t("privacy.local") : t("privacy.remote"),
          active: wouldApply ? t("privacy.active") : t("privacy.inactive"),
        })}
      </p>

      <h3>{t("privacy.multimodalTitle")}</h3>
      <p className="muted">{t("privacy.multimodalLead")}</p>
      <p className="privacy-status">
        {sidecar?.found
          ? t("privacy.sidecarFound", { path: sidecar.path || "—" })
          : t("privacy.sidecarMissing")}
      </p>
      <label className="privacy-field">
        <span>{t("privacy.multimodalBackend")}</span>
        <select
          value={privacy.multimodalBackend}
          disabled={!privacy.enabled}
          onChange={(e) =>
            setPrivacy((p) => ({
              ...p,
              multimodalBackend: e.target.value as MultimodalBackend,
            }))
          }
        >
          <option value="auto">{t("privacy.backendAuto")}</option>
          <option value="sidecar">{t("privacy.backendSidecar")}</option>
          <option value="off">{t("privacy.backendOff")}</option>
        </select>
      </label>
      <label className="privacy-field">
        <span>{t("privacy.maxSizeMb")}</span>
        <input
          type="number"
          min={1}
          max={100}
          value={privacy.multimodalMaxSizeMb}
          disabled={!privacy.enabled}
          onChange={(e) =>
            setPrivacy((p) => ({
              ...p,
              multimodalMaxSizeMb: Math.max(1, Number(e.target.value) || 10),
            }))
          }
        />
      </label>
      <label className="privacy-field">
        <span>{t("privacy.ocrTimeout")}</span>
        <input
          type="number"
          min={5}
          max={300}
          value={privacy.ocrTimeoutSeconds}
          disabled={!privacy.enabled}
          onChange={(e) =>
            setPrivacy((p) => ({
              ...p,
              ocrTimeoutSeconds: Math.max(5, Number(e.target.value) || 30),
            }))
          }
        />
      </label>

      <h3>{t("privacy.rulesTitle")}</h3>
      <p className="muted">{t("privacy.rulesLead")}</p>

      <div className="privacy-rules">
        {privacy.customRules.length === 0 && (
          <p className="muted">{t("privacy.rulesEmpty")}</p>
        )}
        {privacy.customRules.map((rule) => (
          <div key={rule.id} className="privacy-rule">
            <label>
              <input
                type="checkbox"
                checked={rule.enabled !== false}
                onChange={(e) => updateRule(rule.id, { enabled: e.target.checked })}
              />
              <span>{t("privacy.ruleEnabled")}</span>
            </label>
            <input
              type="text"
              value={rule.name}
              placeholder={t("privacy.ruleName")}
              onChange={(e) => updateRule(rule.id, { name: e.target.value })}
            />
            <select
              value={rule.ruleType}
              onChange={(e) =>
                updateRule(rule.id, {
                  ruleType: e.target.value === "regex" ? "regex" : "keyword",
                })
              }
            >
              <option value="keyword">{t("privacy.ruleKeyword")}</option>
              <option value="regex">{t("privacy.ruleRegex")}</option>
            </select>
            <input
              type="text"
              value={rule.pattern}
              placeholder={t("privacy.rulePattern")}
              onChange={(e) => updateRule(rule.id, { pattern: e.target.value })}
            />
            <label>
              <input
                type="checkbox"
                checked={!!rule.caseSensitive}
                onChange={(e) => updateRule(rule.id, { caseSensitive: e.target.checked })}
              />
              <span>{t("privacy.caseSensitive")}</span>
            </label>
            <label>
              <input
                type="checkbox"
                checked={!!rule.wholeWord}
                disabled={rule.ruleType === "regex"}
                onChange={(e) => updateRule(rule.id, { wholeWord: e.target.checked })}
              />
              <span>{t("privacy.wholeWord")}</span>
            </label>
            <button type="button" className="btn-secondary" onClick={() => removeRule(rule.id)}>
              {t("privacy.removeRule")}
            </button>
          </div>
        ))}
      </div>

      <div className="privacy-actions">
        <button type="button" className="btn-secondary" onClick={addRule}>
          {t("privacy.addRule")}
        </button>
        <button type="button" className="btn-primary" disabled={saving} onClick={() => void persist()}>
          {saving ? t("privacy.saving") : t("privacy.save")}
        </button>
      </div>
      {savedOk && <p className="ok">{t("privacy.saved")}</p>}

      <h3>{t("privacy.previewTitle")}</h3>
      <textarea
        className="privacy-preview-input"
        rows={4}
        value={previewText}
        onChange={(e) => setPreviewText(e.target.value)}
      />
      <button type="button" className="btn-secondary" disabled={previewing} onClick={() => void runPreview()}>
        {previewing ? t("privacy.previewing") : t("privacy.preview")}
      </button>
      {previewMeta && <p className="muted">{previewMeta}</p>}
      {previewResult != null && (
        <pre className="privacy-preview-out">{previewResult}</pre>
      )}

      {error && <p className="error">{error}</p>}
    </div>
  );
}
