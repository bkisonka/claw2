// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Vitaliy Bondar

import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { getConfig, putConfig, type Config } from "../api/config";
import { getVoiceCapabilities, type VoiceCapabilities } from "../api/voice";
import {
  connectionMap,
  fetchConnectionsStatus,
  type ConnectionCheck,
  type ConnectionsStatus,
} from "../api/connections";
import { fetchSipStatus, type SipStatus } from "../api/calls";
import {
  closeRemoteHttps,
  fetchRemoteAccessStatus,
  issueRemoteAccessCert,
  openRemoteHttps,
  updateRemoteAccessDdns,
  type RemoteAccessStatus,
} from "../api/remoteAccess";
import { useI18n } from "../i18n";
import { isSingleUserClient } from "../lib/singleUser";
import type { DesktopPaths } from "../desktop";
import { IconClose } from "./icons";

const MASK = "***";

type ConnTranslate = (key: Parameters<ReturnType<typeof useI18n>["t"]>[0], vars?: Record<string, string | number>) => string;

function localizeConnectionError(
  error: string | undefined,
  t: ConnTranslate
): string | undefined {
  if (!error) return undefined;
  if (!error.startsWith("conn:")) return error;
  const parts = error.split(":");
  if (parts.length < 3 || parts[0] !== "conn") return error;
  const [, , code] = parts;
  const arg = parts.length > 3 ? parts.slice(3).join(":") : undefined;
  // Gateway codes are snake_case (no_listener); i18n keys are camelCase.
  const camel = code.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
  const key = `settings.connLlm.${camel}`;
  try {
    return arg ? t(key as never, { arg }) : t(key as never);
  } catch {
    return error;
  }
}

function ConnectionIndicator({
  check,
  loading,
}: {
  check?: ConnectionCheck;
  loading?: boolean;
}) {
  const { t } = useI18n();
  if (loading && !check) {
    return (
      <span className="conn-status conn-status--pending" title={t("settings.connChecking")}>
        <span className="conn-dot" aria-hidden />
        <span className="conn-status-text">{t("settings.connChecking")}</span>
      </span>
    );
  }
  if (!check) return null;
  const status = check.status;
  // Structured gateway codes (conn:<id>:<code>[:<arg>]) render localized
  // human text ("LLM не подключена", "неверный API-ключ (401)", …);
  // unrecognized strings show as-is.
  const localizedError = localizeConnectionError(check.error, t);
  const title =
    status === "ok"
      ? check.detail || t("settings.connOk")
      : status === "off"
        ? check.error || t("settings.connOff")
        : localizedError || t("settings.connError");
  return (
    <span
      className={`conn-status conn-status--${status}`}
      title={title}
      role="status"
      aria-label={title}
    >
      <span className="conn-dot" aria-hidden />
      {status === "error" && localizedError ? (
        <span className="conn-status-text">{localizedError}</span>
      ) : null}
    </span>
  );
}

function SubTitle({
  children,
  connId,
  checks,
  loading,
}: {
  children: ReactNode;
  connId?: string;
  checks: Record<string, ConnectionCheck>;
  loading?: boolean;
}) {
  return (
    <h3 className="settings-section-title settings-section-title--sub">
      <span className="settings-section-title-label">{children}</span>
      {connId ? <ConnectionIndicator check={checks[connId]} loading={loading} /> : null}
    </h3>
  );
}
function setIn(c: Config, path: string[], value: unknown): Config {
  if (path.length === 0) return c;
  const key = path[0];
  if (path.length === 1) {
    return { ...(c || {}), [key]: value } as Config;
  }
  const rest = path.slice(1);
  const child = (c as Record<string, unknown>)?.[key];
  const next =
    child != null && typeof child === "object" && !Array.isArray(child)
      ? (setIn(child as Config, rest, value) as Record<string, unknown>)
      : (setIn({} as Config, rest, value) as Record<string, unknown>);
  return { ...(c || {}), [key]: next } as Config;
}

/** "?" hint — portal above scroll/overflow (Electron title is unreliable). */
function Hint({ text }: { text: string }) {
  const tipId = useId();
  const anchorRef = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);

  const place = useCallback(() => {
    const el = anchorRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const pad = 8;
    const maxW = Math.min(360, window.innerWidth - 16);
    let left = r.left;
    if (left + maxW > window.innerWidth - 8) left = Math.max(8, window.innerWidth - maxW - 8);
    // below the icon; if not enough room — above (--above class shifts by -100%)
    let top = r.bottom + pad;
    if (window.innerHeight - r.bottom < 140 && r.top > 140) {
      top = r.top - pad;
    }
    setPos({ top, left });
  }, []);

  const show = useCallback(() => {
    place();
    setOpen(true);
  }, [place]);

  const hide = useCallback(() => setOpen(false), []);

  useEffect(() => {
    if (!open) return;
    const onScroll = () => place();
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", onScroll);
    return () => {
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", onScroll);
    };
  }, [open, place]);

  if (!text) return null;

  const above =
    pos != null &&
    anchorRef.current != null &&
    pos.top < anchorRef.current.getBoundingClientRect().top;

  return (
    <>
      <button
        ref={anchorRef}
        type="button"
        className="settings-help"
        aria-label={text}
        aria-describedby={open ? tipId : undefined}
        onMouseEnter={show}
        onMouseLeave={hide}
        onFocus={show}
        onBlur={hide}
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          if (open) hide();
          else show();
        }}
        onMouseDown={(e) => {
          // do not trigger toggle/summary
          e.preventDefault();
          e.stopPropagation();
        }}
      >
        ?
      </button>
      {open && pos
        ? createPortal(
            <div
              id={tipId}
              role="tooltip"
              className={above ? "settings-help-popup settings-help-popup--above" : "settings-help-popup"}
              style={{ top: pos.top, left: pos.left }}
              onMouseEnter={show}
              onMouseLeave={hide}
            >
              {text}
            </div>,
            document.body
          )
        : null}
    </>
  );
}

function LabelText({ label, hint }: { label: string; hint?: string }) {
  return (
    <span className="settings-label-text">
      <span className="settings-label-caption">{label}</span>
      {hint ? <Hint text={hint} /> : null}
    </span>
  );
}

function SelectField({
  label,
  value,
  onChange,
  hint,
  children,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <label>
      <LabelText label={label} hint={hint} />
      <select value={value} onChange={(e) => onChange(e.target.value)}>
        {children}
      </select>
    </label>
  );
}

function Input({
  label,
  value,
  onChange,
  type = "text",
  placeholder,
  hint,
}: {
  label: string;
  value: string | number;
  onChange: (v: string) => void;
  type?: string;
  placeholder?: string;
  hint?: string;
}) {
  const v = value === undefined || value === null ? "" : String(value);
  return (
    <label>
      <LabelText label={label} hint={hint} />
      <input
        type={type}
        value={v}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
      />
    </label>
  );
}

function Toggle({
  label,
  checked,
  onChange,
  hint,
}: {
  label: string;
  checked: boolean;
  onChange: (v: boolean) => void;
  hint?: string;
}) {
  return (
    <label className="settings-toggle">
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
      />
      <LabelText label={label} hint={hint} />
    </label>
  );
}

function BrowserSearchEngineAdd({
  onAdd,
  labels,
}: {
  onAdd: (eng: { id: string; name: string; urlTemplate: string }) => void;
  labels: { name: string; url: string; add: string; urlHint: string };
}) {
  const [name, setName] = useState("");
  const [urlTemplate, setUrlTemplate] = useState("");
  const slug = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 32);
  const canAdd = Boolean(slug && urlTemplate.includes("{query}"));
  return (
    <div className="settings-browser-engines-add">
      <Input label={labels.name} value={name} onChange={setName} placeholder="Bing" />
      <Input
        label={labels.url}
        value={urlTemplate}
        onChange={setUrlTemplate}
        placeholder="https://www.bing.com/search?q={query}"
        hint={labels.urlHint}
      />
      <button
        type="button"
        className="settings-btn-secondary"
        disabled={!canAdd}
        onClick={() => {
          if (!canAdd) return;
          onAdd({ id: slug, name: name.trim(), urlTemplate: urlTemplate.trim() });
          setName("");
          setUrlTemplate("");
        }}
      >
        {labels.add}
      </button>
    </div>
  );
}

function SettingsFold({
  title,
  connId,
  checks,
  loading,
  children,
  defaultOpen,
  hint,
}: {
  title: string;
  connId?: string;
  checks?: Record<string, ConnectionCheck>;
  loading?: boolean;
  children: ReactNode;
  defaultOpen?: boolean;
  hint?: string;
}) {
  return (
    <details className="settings-fold" open={defaultOpen || undefined}>
      <summary className="settings-fold-summary">
        <span className="settings-fold-summary-label">
          {title}
          {hint ? <Hint text={hint} /> : null}
        </span>
        {connId && checks ? (
          <ConnectionIndicator check={checks[connId]} loading={loading} />
        ) : null}
      </summary>
      <div className="settings-fold-body settings-section">{children}</div>
    </details>
  );
}

/** @deprecated alias — same as SettingsFold */
function AdvancedBlock({ title, children }: { title: string; children: ReactNode }) {
  return <SettingsFold title={title}>{children}</SettingsFold>;
}

export function Settings() {
  const { locale, setLocale, t } = useI18n();
  const isDesktop = isSingleUserClient();
  const [config, setConfig] = useState<Config | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<{ type: "success" | "error"; text: string } | null>(null);
  const [voiceCaps, setVoiceCaps] = useState<VoiceCapabilities | null>(null);
  const [connStatus, setConnStatus] = useState<ConnectionsStatus | null>(null);
  const [connLoading, setConnLoading] = useState(false);
  const [sipStatus, setSipStatus] = useState<SipStatus | null>(null);
  const [memoryAdvanced, setMemoryAdvanced] = useState(false);
  const [desktopPaths, setDesktopPaths] = useState<DesktopPaths | null>(null);
  const [pathCopied, setPathCopied] = useState<string | null>(null);
  const [remoteStatus, setRemoteStatus] = useState<RemoteAccessStatus | null>(null);
  const [remoteBusy, setRemoteBusy] = useState<"ddns" | "cert" | "https" | null>(null);
  const [openAtLogin, setOpenAtLoginState] = useState<boolean | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const c = await getConfig();
      setConfig(c as Config);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  const loadConnections = useCallback(async () => {
    setConnLoading(true);
    try {
      const status = await fetchConnectionsStatus();
      setConnStatus(status);
    } catch {
      setConnStatus(null);
    } finally {
      setConnLoading(false);
    }
    try {
      setSipStatus(await fetchSipStatus());
    } catch {
      setSipStatus(null);
    }
  }, []);

  const loadRemoteStatus = useCallback(async () => {
    try {
      setRemoteStatus(await fetchRemoteAccessStatus());
    } catch {
      setRemoteStatus(null);
    }
  }, []);

  useEffect(() => {
    load();
    getVoiceCapabilities().then(setVoiceCaps).catch(() => setVoiceCaps(null));
    void loadRemoteStatus();
  }, [load, loadRemoteStatus]);

  useEffect(() => {
    if (!isDesktop || !window.claw2Desktop?.getPaths) return;
    void window.claw2Desktop
      .getPaths()
      .then(setDesktopPaths)
      .catch(() => setDesktopPaths(null));
    if (window.claw2Desktop.getOpenAtLogin) {
      void window.claw2Desktop
        .getOpenAtLogin()
        .then(setOpenAtLoginState)
        .catch(() => setOpenAtLoginState(null));
    }
  }, [isDesktop]);

  useEffect(() => {
    if (loading || !config) return;
    void loadConnections();
    // only after the first config load
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loading]);

  const update = useCallback((path: string[], value: unknown) => {
    setConfig((prev) => (prev ? setIn(prev, path, value) : prev));
  }, []);

  const save = useCallback(async () => {
    if (!config) return;
    setSaving(true);
    setToast(null);
    try {
      const result = await putConfig(config);
      setToast({
        type: "success",
        text:
          result._source === "db"
            ? t("settings.savedAccount")
            : t("settings.savedApplied"),
      });
      // Let SIP/gateway apply config, then re-check
      setTimeout(() => void loadConnections(), 800);
    } catch (e) {
      setToast({ type: "error", text: e instanceof Error ? e.message : String(e) });
    } finally {
      setSaving(false);
    }
  }, [config, t, loadConnections]);

  /** Remote actions read gateway in-memory config — persist draft first. */
  const persistConfigQuiet = useCallback(async () => {
    if (!config) throw new Error("No config");
    await putConfig(config);
  }, [config]);

  const copyPath = useCallback(async (value: string) => {
    try {
      await navigator.clipboard.writeText(value);
      setPathCopied(value);
      setTimeout(() => setPathCopied(null), 1500);
    } catch {
      setToast({ type: "error", text: t("settings.logsCopyFailed") });
    }
  }, [t]);

  const openPath = useCallback(
    async (value: string) => {
      if (!window.claw2Desktop?.openPath) return;
      const res = await window.claw2Desktop.openPath(value);
      if (!res.ok) {
        setToast({ type: "error", text: res.error || t("settings.logsOpenFailed") });
      }
    },
    [t]
  );

  if (loading) {
    return (
      <div className="settings-root">
        <div className="settings">
          <p className="settings-placeholder">{t("settings.loading")}</p>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="settings-root">
        <div className="settings">
          <p className="settings-placeholder">{t("common.error", { error })}</p>
        </div>
        <div className="settings-actions">
          <button type="button" onClick={load}>{t("common.retry")}</button>
        </div>
      </div>
    );
  }

  if (!config) return null;

  const checks = connectionMap(connStatus);

  const llm = config.llm as Record<string, unknown> | undefined;
  const gateway = config.gateway as Record<string, unknown> | undefined;
  const auth = gateway?.auth as Record<string, unknown> | undefined;
  const vision = config.vision as Record<string, unknown> | undefined;
  const voiceService = config.voice as Record<string, unknown> | undefined;
  const sip = config.sip as Record<string, unknown> | undefined;
  const sipRealtime = sip?.realtime as Record<string, unknown> | undefined;
  const realtimeProviderRaw = typeof sipRealtime?.provider === "string" ? sipRealtime.provider : "off";
  const realtimeProvider =
    realtimeProviderRaw === "pipeline" ||
    realtimeProviderRaw === "yandex" ||
    realtimeProviderRaw === "openai" ||
    realtimeProviderRaw === "xai" ||
    realtimeProviderRaw === "off"
      ? realtimeProviderRaw
      : "off";
  const realtimeActive = realtimeProvider === "yandex" || realtimeProvider === "openai" || realtimeProvider === "xai";
  const updateSipRealtime = (patch: Record<string, unknown>) => {
    update(["sip"], {
      ...(sip ?? {}),
      realtime: { ...(sipRealtime ?? {}), ...patch },
    });
  };
  const channels = config.channels as Record<string, unknown> | undefined;
  const telegram = channels?.telegram as Record<string, unknown> | undefined;
  const tgVoice = telegram?.voice as Record<string, unknown> | undefined;
  const vk = channels?.vk as Record<string, unknown> | undefined;
  const vkVoice = vk?.voice as Record<string, unknown> | undefined;
  const memory = config.memory as Record<string, unknown> | undefined;
  const chroma = memory?.chroma as Record<string, unknown> | undefined;
  const sandbox = config.sandbox as Record<string, unknown> | undefined;
  const tools = config.tools as Record<string, unknown> | undefined;
  const webFetch = tools?.webFetch as Record<string, unknown> | undefined;
  const coding = config.coding as Record<string, unknown> | undefined;
  const remoteAccess = config.remoteAccess as Record<string, unknown> | undefined;
  const remoteDdns = remoteAccess?.ddns as Record<string, unknown> | undefined;
  const remoteTls = remoteAccess?.tls as Record<string, unknown> | undefined;

  const runRemoteDdns = async () => {
    setRemoteBusy("ddns");
    try {
      await persistConfigQuiet();
      const r = await updateRemoteAccessDdns();
      if (r.ok) {
        setToast({
          type: "success",
          text: `${t("settings.remoteDdnsOk")}${r.ip ? `: ${r.ip}` : ""}${r.fqdn ? ` (${r.fqdn})` : ""}`,
        });
      } else {
        setToast({ type: "error", text: r.error || t("settings.remoteDdnsErr") });
      }
      await loadRemoteStatus();
    } catch (e) {
      setToast({ type: "error", text: e instanceof Error ? e.message : String(e) });
    } finally {
      setRemoteBusy(null);
    }
  };

  const runRemoteCert = async () => {
    setRemoteBusy("cert");
    try {
      await persistConfigQuiet();
      const r = await issueRemoteAccessCert();
      if (r.ok) {
        setToast({
          type: "success",
          text: `${t("settings.remoteCertOk")}${r.fqdn ? `: ${r.fqdn}` : ""}`,
        });
      } else {
        setToast({ type: "error", text: r.error || t("settings.remoteCertErr") });
      }
      await loadRemoteStatus();
    } catch (e) {
      setToast({ type: "error", text: e instanceof Error ? e.message : String(e) });
    } finally {
      setRemoteBusy(null);
    }
  };

  const runRemoteHttpsOpen = async () => {
    setRemoteBusy("https");
    try {
      await persistConfigQuiet();
      const r = await openRemoteHttps();
      if (r.ok) {
        setToast({
          type: "success",
          text: `${t("settings.remoteHttpsOpen")}${r.url ? `: ${r.url}` : ""}`,
        });
      } else {
        setToast({ type: "error", text: r.error || t("settings.remoteHttpsClosed") });
      }
      await loadRemoteStatus();
    } catch (e) {
      setToast({ type: "error", text: e instanceof Error ? e.message : String(e) });
    } finally {
      setRemoteBusy(null);
    }
  };

  const runRemoteHttpsClose = async () => {
    setRemoteBusy("https");
    try {
      const r = await closeRemoteHttps();
      if (r.ok) {
        setToast({ type: "success", text: t("settings.remoteHttpsClosed") });
      } else {
        setToast({ type: "error", text: r.error || t("settings.remoteHttpsClosed") });
      }
      await loadRemoteStatus();
    } catch (e) {
      setToast({ type: "error", text: e instanceof Error ? e.message : String(e) });
    } finally {
      setRemoteBusy(null);
    }
  };

  const languageSection = (
    <SettingsFold title={t("settings.language")}>
      <SelectField
        label={t("settings.language")}
        value={locale}
        onChange={(v) => setLocale(v as "en" | "ru")}
        hint={t("settings.languageHint")}
      >
        <option value="en">English</option>
        <option value="ru">Русский</option>
      </SelectField>
    </SettingsFold>
  );

  const llmSection = (
    <SettingsFold title={t("settings.llm")} connId="llm" checks={checks} loading={connLoading}>
      <Input
        label={t("settings.provider")}
        value={(llm?.provider as string) ?? ""}
        onChange={(v) => update(["llm", "provider"], v || undefined)}
        hint={t("settings.providerHint")}
      />
      <Input
        label={t("settings.model")}
        value={(llm?.model as string) ?? ""}
        onChange={(v) => update(["llm", "model"], v || undefined)}
        hint={t("settings.modelHint")}
      />
      <Input
        label={t("settings.baseUrl")}
        value={(llm?.baseURL as string) ?? ""}
        onChange={(v) => update(["llm", "baseURL"], v || undefined)}
        placeholder={t("settings.baseUrlHint")}
        hint={t("settings.baseUrlHint")}
      />
      <Input
        label={t("settings.apiKey")}
        type="password"
        value={(llm?.apiKey as string) ?? ""}
        onChange={(v) => update(["llm", "apiKey"], v || undefined)}
        placeholder={llm?.apiKey === MASK ? MASK : ""}
        hint={t("settings.apiKeyHint")}
      />
      <Toggle
        label={t("settings.enableThinking")}
        checked={!!llm?.enableThinking}
        onChange={(v) => update(["llm", "enableThinking"], v)}
        hint={t("settings.enableThinkingHint")}
      />
      <SelectField
        label={t("settings.systemPromptMode")}
        value={(llm?.systemPromptMode as string) ?? "full"}
        onChange={(v) => update(["llm", "systemPromptMode"], v)}
        hint={t("settings.systemPromptModeHint")}
      >
        <option value="full">full</option>
        <option value="compact">compact</option>
      </SelectField>
      <Input
        label={t("settings.maxTokens")}
        value={llm?.maxTokens != null ? String(llm.maxTokens as number) : ""}
        onChange={(v) => {
          const trimmed = v.trim();
          if (!trimmed) {
            update(["llm", "maxTokens"], undefined);
            return;
          }
          if (!/^\d+$/.test(trimmed)) return;
          const n = Number(trimmed);
          if (Number.isFinite(n) && n > 0) update(["llm", "maxTokens"], n);
        }}
        placeholder="2048"
        hint={t("settings.maxTokensHint")}
      />
    </SettingsFold>
  );

  const voiceSection = (
    <SettingsFold title={t("settings.voice")} hint={t("settings.voiceHint")}>
      <SubTitle connId="voiceStt" checks={checks} loading={connLoading}>
        {t("settings.sttTitle")}
      </SubTitle>
      <Toggle
        label={t("settings.sttLocal")}
        checked={voiceService?.sttLocal !== false}
        onChange={(v) =>
          update(["voice"], {
            ...(voiceService ?? {}),
            sttLocal: v,
          })
        }
        hint={t("settings.sttLocalHint")}
      />
      <Input
        label={t("settings.baseUrl")}
        value={(voiceService?.sttUrl as string) ?? ""}
        onChange={(v) =>
          update(["voice"], {
            ...(voiceService ?? {}),
            sttUrl: v || undefined,
          })
        }
        placeholder={
          voiceService?.sttLocal === false
            ? "https://api.openai.com/v1"
            : "http://127.0.0.1:9000/stt"
        }
        hint={t("settings.sttBaseUrlHint")}
      />
      <Input
        label={t("settings.sttModel")}
        value={(voiceService?.sttModel as string) ?? ""}
        onChange={(v) =>
          update(["voice"], {
            ...(voiceService ?? {}),
            sttModel: v || undefined,
          })
        }
        placeholder="whisper-1"
        hint={t("settings.sttModelHint")}
      />
      <Input
        label={t("settings.sttApiKey")}
        type="password"
        value={(voiceService?.sttApiKey as string) ?? ""}
        onChange={(v) =>
          update(["voice"], {
            ...(voiceService ?? {}),
            sttApiKey: v || undefined,
          })
        }
        placeholder={voiceService?.sttApiKey === MASK ? MASK : ""}
        hint={t("settings.sttApiKeyHint")}
      />

      <SubTitle connId="voiceTts" checks={checks} loading={connLoading}>
        {t("settings.ttsTitle")}
      </SubTitle>
      <Toggle
        label={t("settings.ttsLocal")}
        checked={voiceService?.ttsLocal !== false}
        onChange={(v) =>
          update(["voice"], {
            ...(voiceService ?? {}),
            ttsLocal: v,
          })
        }
        hint={t("settings.ttsLocalHint")}
      />
      <Input
        label={t("settings.baseUrl")}
        value={(voiceService?.ttsUrl as string) ?? ""}
        onChange={(v) =>
          update(["voice"], {
            ...(voiceService ?? {}),
            ttsUrl: v || undefined,
          })
        }
        placeholder={
          voiceService?.ttsLocal === false
            ? "https://api.openai.com/v1"
            : "http://127.0.0.1:9000/tts"
        }
        hint={t("settings.ttsBaseUrlHint")}
      />
      <Input
        label={t("settings.ttsModel")}
        value={(voiceService?.ttsModel as string) ?? ""}
        onChange={(v) =>
          update(["voice"], {
            ...(voiceService ?? {}),
            ttsModel: v || undefined,
          })
        }
        placeholder="tts-1"
        hint={t("settings.ttsModelHint")}
      />
      <Input
        label={t("settings.ttsApiKey")}
        type="password"
        value={(voiceService?.ttsApiKey as string) ?? ""}
        onChange={(v) =>
          update(["voice"], {
            ...(voiceService ?? {}),
            ttsApiKey: v || undefined,
          })
        }
        placeholder={voiceService?.ttsApiKey === MASK ? MASK : ""}
        hint={t("settings.ttsApiKeyHint")}
      />
      <Input
        label={t("settings.ttsVoiceId")}
        value={(voiceService?.ttsVoice as string) ?? ""}
        onChange={(v) =>
          update(["voice"], {
            ...(voiceService ?? {}),
            ttsVoice: v.trim() || undefined,
          })
        }
        placeholder={t("settings.ttsVoicePlaceholder")}
        hint={t("settings.ttsVoiceHint")}
      />
      {voiceService?.ttsLocal !== false && (
        <>
          {voiceCaps && !voiceCaps.cudaAvailable && (voiceService?.ttsEngine as string) === "moss" && (
            <p className="settings-hint settings-hint-warn">{t("settings.voiceCudaWarn")}</p>
          )}
          <SelectField
            label={t("settings.ttsEngine")}
            value={(voiceService?.ttsEngine as string) === "moss" ? "moss" : "silero"}
            onChange={(v) =>
              update(["voice"], {
                ...(voiceService ?? {}),
                ttsEngine: v === "moss" ? "moss" : "silero",
              })
            }
            hint={t("settings.voiceTtsHint")}
          >
            <option value="silero">{t("settings.ttsSilero")}</option>
            <option value="moss">{t("settings.ttsMoss")}</option>
          </SelectField>
          {voiceCaps && !voiceCaps.mossAvailable && (
            <p className="settings-hint">{t("settings.mossUnavailable")}</p>
          )}
        </>
      )}
    </SettingsFold>
  );

  const sipSection = (
    <SettingsFold
      title={t("settings.sip")}
      connId="sip"
      checks={checks}
      loading={connLoading}
      hint={t("settings.sipHint")}
    >
      <Toggle
        label={t("settings.sipEnable")}
        checked={sip?.enabled === true}
        onChange={(v) => update(["sip"], { ...(sip ?? {}), enabled: v })}
        hint={t("settings.sipEnableHint")}
      />
      <Input
        label={t("settings.sipServer")}
        value={(sip?.server as string) ?? ""}
        onChange={(v) => update(["sip"], { ...(sip ?? {}), server: v || undefined })}
        placeholder="sip.ats.example.ru"
        hint={t("settings.sipServerHint")}
      />
      <Input
        label={t("settings.sipPort")}
        type="text"
        value={sip?.port != null ? String(sip.port) : ""}
        onChange={(v) => {
          const n = parseInt(v, 10);
          update(["sip"], {
            ...(sip ?? {}),
            port: Number.isFinite(n) && n > 0 ? n : undefined,
          });
        }}
        placeholder="5060"
        hint={t("settings.sipPortHint")}
      />
      <Input
        label={t("settings.sipDomain")}
        value={(sip?.domain as string) ?? ""}
        onChange={(v) => update(["sip"], { ...(sip ?? {}), domain: v || undefined })}
        placeholder={t("settings.sipDomainHint")}
        hint={t("settings.sipDomainHint")}
      />
      <Input
        label={t("settings.sipUser")}
        value={(sip?.user as string) ?? ""}
        onChange={(v) => update(["sip"], { ...(sip ?? {}), user: v || undefined })}
        hint={t("settings.sipUserHint")}
      />
      <Input
        label={t("settings.sipPassword")}
        type="password"
        value={(sip?.password as string) ?? ""}
        onChange={(v) => update(["sip"], { ...(sip ?? {}), password: v || undefined })}
        placeholder={sip?.password === MASK ? MASK : ""}
        hint={t("settings.sipPasswordHint")}
      />
      <Input
        label={t("settings.sipDisplayName")}
        value={(sip?.displayName as string) ?? ""}
        onChange={(v) => update(["sip"], { ...(sip ?? {}), displayName: v || undefined })}
        hint={t("settings.sipDisplayNameHint")}
      />
      <Input
        label={t("settings.sipLocalPort")}
        type="text"
        value={sip?.localPort != null ? String(sip.localPort) : ""}
        onChange={(v) => {
          const n = parseInt(v, 10);
          update(["sip"], {
            ...(sip ?? {}),
            localPort: Number.isFinite(n) && n > 0 ? n : undefined,
          });
        }}
        placeholder="5061"
        hint={t("settings.sipLocalPortHint")}
      />
      <Input
        label={t("settings.sipPublicAddress")}
        value={(sip?.publicAddress as string) ?? ""}
        onChange={(v) => update(["sip"], { ...(sip ?? {}), publicAddress: v || undefined })}
        placeholder={t("settings.sipPublicAddressHint")}
        hint={t("settings.sipPublicAddressHint")}
      />
      <Input
        label={t("settings.sipOperatorUri")}
        value={(sip?.operatorUri as string) ?? ""}
        onChange={(v) => update(["sip"], { ...(sip ?? {}), operatorUri: v || undefined })}
        placeholder="sip:100@domain"
        hint={t("settings.sipOperatorUriHint")}
      />
      <Toggle
        label={t("settings.sipAutoAnswer")}
        checked={sip?.autoAnswer === true}
        onChange={(v) => update(["sip"], { ...(sip ?? {}), autoAnswer: v })}
        hint={t("settings.sipAutoAnswerHint")}
      />
      <SubTitle checks={checks}>
        <LabelText label={t("settings.sipRealtime")} hint={t("settings.sipRealtimeHint")} />
      </SubTitle>
      <SelectField
        label={t("settings.sipRealtimeProvider")}
        value={realtimeProvider}
        onChange={(v) => {
          updateSipRealtime({
            provider:
              v === "pipeline" || v === "yandex" || v === "openai" || v === "xai" || v === "off"
                ? v
                : "off",
          });
        }}
        hint={t("settings.sipRealtimeGeoHint")}
      >
        <option value="off">{t("settings.sipRealtimeProviderOff")}</option>
        <option value="pipeline">{t("settings.sipRealtimeProviderPipeline")}</option>
        <option value="yandex">{t("settings.sipRealtimeProviderYandex")}</option>
        <option value="openai">{t("settings.sipRealtimeProviderOpenai")}</option>
        <option value="xai">{t("settings.sipRealtimeProviderXai")}</option>
      </SelectField>
      {realtimeActive && (
        <>
          <Input
            label={t("settings.sipRealtimeApiKey")}
            type="password"
            value={(sipRealtime?.apiKey as string) ?? ""}
            onChange={(v) => updateSipRealtime({ apiKey: v || undefined })}
            placeholder={sipRealtime?.apiKey === MASK ? MASK : ""}
            hint={t("settings.sipRealtimeApiKeyHint")}
          />
          <Toggle
            label={t("settings.sipRealtimeUseLlmKey")}
            checked={sipRealtime?.useLlmApiKey === true}
            onChange={(v) => updateSipRealtime({ useLlmApiKey: v })}
            hint={t("settings.sipRealtimeUseLlmKeyHint")}
          />
          {realtimeProvider === "yandex" && (
            <>
              <Input
                label={t("settings.sipRealtimeFolderId")}
                value={(sipRealtime?.folderId as string) ?? ""}
                onChange={(v) => updateSipRealtime({ folderId: v || undefined })}
                placeholder="b1g…"
                hint={t("settings.sipRealtimeFolderIdHint")}
              />
              <Input
                label={t("settings.sipRealtimeIamToken")}
                type="password"
                value={(sipRealtime?.iamToken as string) ?? ""}
                onChange={(v) => updateSipRealtime({ iamToken: v || undefined })}
                placeholder={sipRealtime?.iamToken === MASK ? MASK : ""}
                hint={t("settings.sipRealtimeIamTokenHint")}
              />
            </>
          )}
          <Input
            label={t("settings.sipRealtimeModel")}
            value={(sipRealtime?.model as string) ?? ""}
            onChange={(v) => updateSipRealtime({ model: v || undefined })}
            placeholder={
              realtimeProvider === "yandex"
                ? "speech-realtime-260528"
                : realtimeProvider === "xai"
                  ? "grok-voice"
                  : "gpt-realtime"
            }
            hint={t("settings.sipRealtimeModelHint")}
          />
          <Input
            label={t("settings.sipRealtimeVoice")}
            value={(sipRealtime?.voice as string) ?? ""}
            onChange={(v) => updateSipRealtime({ voice: v || undefined })}
            placeholder={
              realtimeProvider === "yandex" ? "alena" : realtimeProvider === "xai" ? "Ara" : "alloy"
            }
            hint={t("settings.sipRealtimeVoiceHint")}
          />
          <Input
            label={t("settings.sipRealtimeSampleRate")}
            type="text"
            value={sipRealtime?.sampleRate != null ? String(sipRealtime.sampleRate) : ""}
            onChange={(v) => {
              const n = parseInt(v, 10);
              updateSipRealtime({
                sampleRate: Number.isFinite(n) && n > 0 ? n : undefined,
              });
            }}
            placeholder="24000"
            hint={t("settings.sipRealtimeSampleRateHint")}
          />
          <Input
            label={t("settings.sipRealtimeBaseUrl")}
            value={(sipRealtime?.baseURL as string) ?? ""}
            onChange={(v) => updateSipRealtime({ baseURL: v || undefined })}
            placeholder={
              realtimeProvider === "yandex"
                ? "wss://ai.api.cloud.yandex.net/v1/realtime"
                : realtimeProvider === "xai"
                  ? "wss://api.x.ai/v1/realtime"
                  : "wss://api.openai.com/v1/realtime"
            }
            hint={t("settings.sipRealtimeBaseUrlHint")}
          />
        </>
      )}
      <SubTitle checks={checks}>
        <LabelText label={t("settings.sipMedia")} hint={t("settings.sipMediaHint")} />
      </SubTitle>
      <SelectField
        label={t("settings.sipMediaBackend")}
        value={
          sip?.mediaBackend === "node" || sip?.mediaBackend === "sidecar" || sip?.mediaBackend === "auto"
            ? (sip.mediaBackend as string)
            : "auto"
        }
        onChange={(v) => {
          update(["sip"], {
            ...(sip ?? {}),
            mediaBackend: v === "node" || v === "sidecar" || v === "auto" ? v : "auto",
          });
        }}
        hint={t("settings.sipMediaHint")}
      >
        <option value="auto">{t("settings.sipMediaAuto")}</option>
        <option value="node">{t("settings.sipMediaNode")}</option>
        <option value="sidecar">{t("settings.sipMediaSidecar")}</option>
      </SelectField>
      <Input
        label={t("settings.sipMediaPath")}
        value={(sip?.sidecarPath as string) ?? ""}
        onChange={(v) => update(["sip"], { ...(sip ?? {}), sidecarPath: v || undefined })}
        placeholder="~/.claw2/sip-media-sidecar/run-sidecar.sh"
        hint={t("settings.sipMediaPathHint")}
      />
      <p className="settings-hint">
        {t("settings.sipMediaStatus")}:{" "}
        {sipStatus?.mediaBackend?.status === "running"
          ? t("settings.sipMediaStatusRunning")
          : sipStatus?.mediaBackend?.status === "not_found"
            ? t("settings.sipMediaStatusNotFound")
            : sipStatus?.mediaBackend?.status === "fallback"
              ? t("settings.sipMediaStatusFallback")
              : t("settings.sipMediaStatusNode")}
        {sipStatus?.mediaBackend?.reason ? ` — ${sipStatus.mediaBackend.reason}` : ""}
      </p>
      <button type="button" className="settings-secondary-btn" onClick={() => void loadConnections()}>
        {t("settings.sipMediaRefresh")}
      </button>
    </SettingsFold>
  );

  const memoryBackend = (memory?.backend as string) ?? "sqlite";
  const memoryIsSimple =
    (memoryBackend === "sqlite" || !memory?.backend) &&
    (memory?.embeddingProvider === "local" ||
      (!memory?.embeddingProvider && memoryBackend !== "chroma"));
  const showMemoryAdvanced =
    memoryAdvanced || !memoryIsSimple || memoryBackend === "chroma";

  const memorySection = (
    <SettingsFold
      title={t("settings.memory")}
      connId="memory"
      checks={checks}
      loading={connLoading}
      hint={t("settings.memoryHint")}
    >
      <Toggle
        label={t("settings.memoryEnable")}
        checked={!!memory?.enabled}
        onChange={(v) => update(["memory", "enabled"], v)}
        hint={t("settings.memoryEnableHint")}
      />
      <Input
        label={t("settings.embeddingModel")}
        value={(memory?.embeddingModel as string) ?? ""}
        onChange={(v) => update(["memory", "embeddingModel"], v || undefined)}
        placeholder="Xenova/bge-small-en-v1.5"
        hint={memoryIsSimple ? t("settings.embeddingLocalHint") : t("settings.embeddingModelHint")}
      />
      <Input
        label={t("settings.maxChunks")}
        type="number"
        value={(memory?.maxChunks as number) ?? 500}
        onChange={(v) => update(["memory", "maxChunks"], v ? Number(v) : undefined)}
        hint={t("settings.maxChunksHint")}
      />
      <Input
        label={t("settings.maxRecallChunks")}
        type="number"
        value={(memory?.maxRecallChunks as number) ?? 5}
        onChange={(v) => update(["memory", "maxRecallChunks"], v ? Number(v) : undefined)}
        hint={t("settings.maxRecallChunksHint")}
      />
      <Toggle
        label={t("settings.memoryAdvanced")}
        checked={showMemoryAdvanced}
        onChange={(v) => setMemoryAdvanced(v)}
        hint={t("settings.memoryAdvancedHint")}
      />
      {showMemoryAdvanced && (
        <>
          <SelectField
            label={t("settings.backend")}
            value={memoryBackend}
            onChange={(v) => update(["memory", "backend"], v)}
            hint={t("settings.backendHint")}
          >
            <option value="sqlite">sqlite</option>
            <option value="chroma">chroma</option>
            <option value="memory">memory</option>
          </SelectField>
          {(memoryBackend === "sqlite" || !memory?.backend) && (
            <Input
              label={t("settings.sqlitePath")}
              value={(memory?.sqlitePath as string) ?? ""}
              onChange={(v) => update(["memory", "sqlitePath"], v || undefined)}
              placeholder=".claw2/data/memory.sqlite"
              hint={t("settings.sqlitePathHint")}
            />
          )}
          {memoryBackend === "chroma" && (
            <>
              <Input
                label={t("settings.chromaUrl")}
                value={(chroma?.url as string) ?? ""}
                onChange={(v) =>
                  update(["memory", "chroma"], {
                    ...(chroma ?? ({} as Record<string, unknown>)),
                    url: v || undefined,
                  })
                }
                placeholder="http://127.0.0.1:8000"
                hint={t("settings.chromaUrlHint")}
              />
              <Input
                label={t("settings.chromaCollection")}
                value={(chroma?.collectionName as string) ?? ""}
                onChange={(v) =>
                  update(["memory", "chroma"], {
                    ...(chroma ?? ({} as Record<string, unknown>)),
                    collectionName: v || undefined,
                  })
                }
                hint={t("settings.chromaCollectionHint")}
              />
            </>
          )}
          <SelectField
            label={t("settings.embeddingProvider")}
            value={
              (memory?.embeddingProvider as string) ||
              (memoryBackend === "sqlite" ? "local" : "http")
            }
            onChange={(v) => update(["memory", "embeddingProvider"], v)}
            hint={t("settings.embeddingProviderHint")}
          >
            <option value="local">local</option>
            <option value="http">http</option>
          </SelectField>
          {(memory?.embeddingProvider === "http" || memoryBackend === "chroma") && (
            <>
              <Input
                label={t("settings.embeddingBaseUrl")}
                value={(memory?.embeddingBaseURL as string) ?? ""}
                onChange={(v) => update(["memory", "embeddingBaseURL"], v || undefined)}
                placeholder="http://127.0.0.1:11434/v1"
                hint={t("settings.embeddingBaseUrlHint")}
              />
              <Input
                label={t("settings.embeddingApiKey")}
                type="password"
                value={(memory?.embeddingApiKey as string) ?? ""}
                onChange={(v) => update(["memory", "embeddingApiKey"], v || undefined)}
                placeholder={memory?.embeddingApiKey === MASK ? MASK : "ollama"}
                hint={t("settings.embeddingApiKeyHint")}
              />
            </>
          )}
        </>
      )}
    </SettingsFold>
  );

  const insights = config.insights as Record<string, unknown> | undefined;
  const insightsSection = (
    <SettingsFold
      title={t("settings.insights")}
      hint={t("settings.insightsHint")}
    >
      <SelectField
        label={t("settings.insightsMode")}
        value={(insights?.mode as string) || (insights?.enabled === false ? "off" : "ask")}
        onChange={(v) => {
          const mode = v === "off" || v === "auto" || v === "ask" ? v : "ask";
          update(["insights"], {
            ...(insights ?? {}),
            enabled: mode !== "off",
            mode,
          });
        }}
        hint={t("settings.insightsModeHint")}
      >
        <option value="off">{t("settings.insightsModeOff")}</option>
        <option value="ask">{t("settings.insightsModeAsk")}</option>
        <option value="auto">{t("settings.insightsModeAuto")}</option>
      </SelectField>
    </SettingsFold>
  );

  const toolsMainSection = (
    <SettingsFold title={t("settings.tools")}>
      <SubTitle connId="search" checks={checks} loading={connLoading}>
        {t("settings.webSearch")}
      </SubTitle>
      <SelectField
        label={t("settings.searchProvider")}
        value={((tools?.search as { provider?: string })?.provider ?? "auto") as string}
        onChange={(v) =>
          update(["tools", "search"], {
            ...((tools?.search as Record<string, unknown>) ?? {}),
            provider: v || "auto",
          })
        }
        hint={t("settings.searchProviderHint")}
      >
        <option value="auto">{t("settings.searchProviderAuto")}</option>
        <option value="searxng">{t("settings.searchProviderSearxng")}</option>
        <option value="tavily">{t("settings.searchProviderTavily")}</option>
        <option value="other">{t("settings.searchProviderOther")}</option>
      </SelectField>
      <Toggle
        label={t("settings.useLlmInWeb")}
        checked={(tools?.search as { useLlmInWeb?: boolean })?.useLlmInWeb === true}
        onChange={(v) =>
          update(["tools", "search"], {
            ...((tools?.search as Record<string, unknown>) ?? {}),
            useLlmInWeb: v,
          })
        }
        hint={t("settings.useLlmInWebHint")}
      />
      <SubTitle checks={checks}>{t("settings.browserSearchEngines")}</SubTitle>
      <p className="settings-hint">{t("settings.browserSearchEnginesHint")}</p>
      {(() => {
        const BUILTIN = [
          {
            id: "ddg",
            name: "DuckDuckGo",
            urlTemplate: "https://html.duckduckgo.com/html/?q={query}",
          },
          {
            id: "google",
            name: "Google",
            urlTemplate: "https://www.google.com/search?q={query}&gbv=1",
          },
          {
            id: "yandex",
            name: "Yandex",
            urlTemplate: "https://yandex.ru/search/touch/?text={query}",
          },
        ] as const;
        type Eng = { id: string; name: string; urlTemplate: string; enabled?: boolean };
        const raw = (tools?.search as { browserEngines?: Eng[] } | undefined)?.browserEngines;
        const byId = new Map<string, Eng>();
        for (const b of BUILTIN) byId.set(b.id, { ...b, enabled: true });
        if (Array.isArray(raw)) {
          for (const e of raw) {
            if (!e?.id || !e?.name || !e?.urlTemplate?.includes("{query}")) continue;
            byId.set(e.id, {
              id: e.id,
              name: e.name,
              urlTemplate: e.urlTemplate,
              enabled: e.enabled !== false,
            });
          }
        }
        const builtins = BUILTIN.map((b) => byId.get(b.id)!);
        const customs = [...byId.values()].filter((e) => !BUILTIN.some((b) => b.id === e.id));
        const persist = (next: Eng[]) =>
          update(["tools", "search"], {
            ...((tools?.search as Record<string, unknown>) ?? {}),
            browserEngines: next.map((e) => ({
              id: e.id,
              name: e.name,
              urlTemplate: e.urlTemplate,
              enabled: e.enabled !== false,
            })),
          });
        const allCurrent = [...builtins, ...customs];
        return (
          <>
            {builtins.map((e) => (
              <Toggle
                key={e.id}
                label={e.name}
                checked={e.enabled !== false}
                onChange={(v) =>
                  persist(allCurrent.map((x) => (x.id === e.id ? { ...x, enabled: v } : x)))
                }
              />
            ))}
            {customs.map((e) => (
              <div key={e.id} className="settings-path-row">
                <Toggle
                  label={`${e.name} (${e.id})`}
                  checked={e.enabled !== false}
                  onChange={(v) =>
                    persist(allCurrent.map((x) => (x.id === e.id ? { ...x, enabled: v } : x)))
                  }
                  hint={e.urlTemplate}
                />
                <button
                  type="button"
                  className="settings-linkish"
                  onClick={() => persist(allCurrent.filter((x) => x.id !== e.id))}
                >
                  {t("settings.browserSearchEngineRemove")}
                </button>
              </div>
            ))}
            <BrowserSearchEngineAdd
              onAdd={(eng) => {
                if (allCurrent.some((x) => x.id === eng.id)) return;
                persist([...allCurrent, { ...eng, enabled: true }]);
              }}
              labels={{
                name: t("settings.browserSearchEngineName"),
                url: t("settings.browserSearchEngineUrl"),
                add: t("settings.browserSearchEngineAdd"),
                urlHint: t("settings.browserSearchEngineUrlHint"),
              }}
            />
          </>
        );
      })()}
      <Input
        label={t("settings.searxngUrl")}
        value={(tools?.searxng as { url?: string })?.url ?? ""}
        onChange={(v) =>
          update(["tools", "searxng"], {
            ...((tools?.searxng as Record<string, unknown>) ?? {}),
            url: v || undefined,
          })
        }
        placeholder={t("settings.searxngUrlPlaceholder")}
        hint={t("settings.searxngUrlHint")}
      />
      <Input
        label={t("settings.searxngKey")}
        type="password"
        value={(tools?.searxng as { apiKey?: string })?.apiKey ?? ""}
        onChange={(v) =>
          update(["tools", "searxng"], {
            ...((tools?.searxng as Record<string, unknown>) ?? {}),
            apiKey: v || undefined,
          })
        }
        placeholder={tools?.searxng && (tools.searxng as { apiKey?: string }).apiKey === MASK ? MASK : t("settings.searxngKeyPlaceholder")}
        hint={t("settings.searxngKeyHint")}
      />
      <Toggle
        label={t("settings.searxngEnable")}
        checked={(tools?.searxng as { enabled?: boolean })?.enabled !== false}
        onChange={(v) =>
          update(["tools", "searxng"], {
            ...((tools?.searxng as Record<string, unknown>) ?? {}),
            enabled: v,
          })
        }
        hint={t("settings.searxngEnableHint")}
      />
      <Input
        label={t("settings.otherUrl")}
        value={(tools?.other as { url?: string })?.url ?? ""}
        onChange={(v) =>
          update(["tools", "other"], {
            ...((tools?.other as Record<string, unknown>) ?? {}),
            url: v || undefined,
          })
        }
        placeholder={t("settings.otherUrlPlaceholder")}
        hint={t("settings.otherUrlHint")}
      />
      <Input
        label={t("settings.otherKey")}
        type="password"
        value={(tools?.other as { apiKey?: string })?.apiKey ?? ""}
        onChange={(v) =>
          update(["tools", "other"], {
            ...((tools?.other as Record<string, unknown>) ?? {}),
            apiKey: v || undefined,
          })
        }
        placeholder={tools?.other && (tools.other as { apiKey?: string }).apiKey === MASK ? MASK : t("settings.otherKeyPlaceholder")}
        hint={t("settings.otherKeyHint")}
      />
      <Toggle
        label={t("settings.otherEnable")}
        checked={(tools?.other as { enabled?: boolean })?.enabled !== false}
        onChange={(v) =>
          update(["tools", "other"], {
            ...((tools?.other as Record<string, unknown>) ?? {}),
            enabled: v,
          })
        }
        hint={t("settings.otherEnableHint")}
      />
      <Input
        label={t("settings.tavilyKey")}
        type="password"
        value={(tools?.tavily as { apiKey?: string })?.apiKey ?? ""}
        onChange={(v) =>
          update(["tools", "tavily"], {
            ...((tools?.tavily as Record<string, unknown>) ?? {}),
            apiKey: v || undefined,
          })
        }
        placeholder={t("settings.tavilyKeyPlaceholder")}
        hint={t("settings.tavilyKeyHint")}
      />
      <Toggle
        label={t("settings.tavilyEnable")}
        checked={(tools?.tavily as { enabled?: boolean })?.enabled !== false}
        onChange={(v) =>
          update(["tools", "tavily"], {
            ...((tools?.tavily as Record<string, unknown>) ?? {}),
            enabled: v,
          })
        }
        hint={t("settings.tavilyEnableHint")}
      />
      <SelectField
        label={t("settings.tavilyDepth")}
        value={(tools?.tavily as { searchDepth?: string })?.searchDepth ?? "basic"}
        onChange={(v) =>
          update(["tools", "tavily"], {
            ...((tools?.tavily as Record<string, unknown>) ?? {}),
            searchDepth: v || undefined,
          })
        }
        hint={t("settings.tavilyDepthHint")}
      >
        <option value="basic">{t("settings.tavilyBasic")}</option>
        <option value="advanced">{t("settings.tavilyAdvanced")}</option>
        <option value="fast">{t("settings.tavilyFast")}</option>
        <option value="ultra-fast">{t("settings.tavilyUltraFast")}</option>
      </SelectField>
      <SubTitle connId="images" checks={checks} loading={connLoading}>
        <LabelText label={t("settings.sdTitle")} hint={t("settings.sdHint")} />
      </SubTitle>
      <Input
        label={t("settings.sdUrl")}
        value={(tools?.sdUrl as string) ?? ""}
        onChange={(v) => update(["tools", "sdUrl"], v || undefined)}
        placeholder="http://127.0.0.1:11434/v1"
        hint={t("settings.sdUrlHint")}
      />
      <Input
        label={t("settings.sdModel")}
        value={(tools?.sdModel as string) ?? ""}
        onChange={(v) => update(["tools", "sdModel"], v || undefined)}
        placeholder="x/z-image-turbo"
        hint={t("settings.sdModelHint")}
      />
      <Input
        label={t("settings.sdApiKey")}
        type="password"
        value={(tools?.sdApiKey as string) ?? ""}
        onChange={(v) => update(["tools", "sdApiKey"], v || undefined)}
        placeholder={tools?.sdApiKey === MASK ? MASK : "ollama"}
        hint={t("settings.sdApiKeyHint")}
      />
      <SelectField
        label={t("settings.sdApi")}
        value={(tools?.sdApi as string) ?? "auto"}
        onChange={(v) =>
          update(
            ["tools", "sdApi"],
            v === "auto" ? "auto" : v === "openai" ? "openai" : "txt2img"
          )
        }
        hint={t("settings.sdApiHint")}
      >
        <option value="auto">{t("settings.sdApiAuto")}</option>
        <option value="openai">{t("settings.sdApiOpenai")}</option>
        <option value="txt2img">{t("settings.sdApiTxt2img")}</option>
      </SelectField>
      <Toggle
        label={t("settings.sdEnable")}
        checked={tools?.sdEnabled !== false}
        onChange={(v) => update(["tools", "sdEnabled"], v)}
        hint={t("settings.sdEnableHint")}
      />
    </SettingsFold>
  );

  const visionSection = (
    <SettingsFold title={t("settings.vision")} connId="vision" checks={checks} loading={connLoading}>
      <Toggle
        label={t("settings.visionEnable")}
        checked={!!vision?.enabled}
        onChange={(v) =>
          update(["vision"], { ...(vision ?? {}), enabled: v } as Record<string, unknown>)
        }
        hint={t("settings.visionEnableHint")}
      />
      <Input
        label={t("settings.visionUrl")}
        value={(vision?.recognizeUrl as string) ?? ""}
        onChange={(v) =>
          update(["vision"], {
            ...(vision ?? {}),
            recognizeUrl: v || undefined,
          } as Record<string, unknown>)
        }
        placeholder="http://127.0.0.1:9000/recognize"
        hint={t("settings.visionUrlHint")}
      />
    </SettingsFold>
  );

  const telegramSection = (
    <SettingsFold title={t("settings.telegram")}>
      <Toggle
        label={t("settings.enableBot")}
        checked={!!telegram?.enabled}
        onChange={(v) => update(["channels", "telegram", "enabled"], v)}
        hint={t("settings.enableBotHint")}
      />
      <Input
        label={t("settings.botToken")}
        type="password"
        value={(telegram?.botToken as string) ?? ""}
        onChange={(v) => update(["channels", "telegram", "botToken"], v || undefined)}
        placeholder={telegram?.botToken === MASK ? MASK : ""}
        hint={t("settings.botTokenHint")}
      />
      <Input
        label={t("settings.proxyUrl")}
        value={(telegram?.proxyUrl as string) ?? ""}
        onChange={(v) => update(["channels", "telegram", "proxyUrl"], v || undefined)}
        placeholder="socks5h://127.0.0.1:20170"
        hint={t("settings.proxyUrlHint")}
      />
      <h3>{t("settings.voiceSttTts")}</h3>
      <Input
        label={t("settings.sttUrl")}
        value={(tgVoice?.sttUrl as string) ?? ""}
        onChange={(v) =>
          update(["channels", "telegram", "voice"], {
            ...(tgVoice ?? ({} as Record<string, unknown>)),
            sttUrl: v || undefined,
          })
        }
        hint={t("settings.sttUrlHint")}
      />
      <Input
        label={t("settings.ttsUrl")}
        value={(tgVoice?.ttsUrl as string) ?? ""}
        onChange={(v) =>
          update(["channels", "telegram", "voice"], {
            ...(tgVoice ?? ({} as Record<string, unknown>)),
            ttsUrl: v || undefined,
          })
        }
        hint={t("settings.ttsUrlHint")}
      />
      <Toggle
        label={t("settings.replyWithVoice")}
        checked={!!tgVoice?.replyWithVoice}
        onChange={(v) =>
          update(["channels", "telegram", "voice"], {
            ...(tgVoice ?? ({} as Record<string, unknown>)),
            replyWithVoice: v,
          })
        }
        hint={t("settings.replyWithVoiceHint")}
      />
      <Input
        label={t("settings.ttsMaxChars")}
        type="number"
        value={(tgVoice?.ttsMaxChars as number) ?? 500}
        onChange={(v) =>
          update(["channels", "telegram", "voice"], {
            ...(tgVoice ?? ({} as Record<string, unknown>)),
            ttsMaxChars: v ? Number(v) : undefined,
          })
        }
        hint={t("settings.ttsMaxCharsHint")}
      />
    </SettingsFold>
  );

  const vkSection = (
    <SettingsFold title={t("settings.vk")}>
      <Toggle
        label={t("settings.enableBot")}
        checked={!!vk?.enabled}
        onChange={(v) => update(["channels", "vk", "enabled"], v)}
        hint={t("settings.enableBotHint")}
      />
      <Input
        label={t("settings.vkToken")}
        type="password"
        value={(vk?.accessToken as string) ?? ""}
        onChange={(v) => update(["channels", "vk", "accessToken"], v || undefined)}
        placeholder={vk?.accessToken === MASK ? MASK : ""}
        hint={t("settings.vkTokenHint")}
      />
      <Input
        label={t("settings.vkGroupId")}
        type="number"
        value={(vk?.groupId as number) ?? 0}
        onChange={(v) => update(["channels", "vk", "groupId"], v ? Number(v) : undefined)}
        hint={t("settings.vkGroupIdHint")}
      />
      <h3>{t("settings.voiceSttTts")}</h3>
      <Input
        label={t("settings.sttUrl")}
        value={(vkVoice?.sttUrl as string) ?? ""}
        onChange={(v) =>
          update(["channels", "vk", "voice"], {
            ...(vkVoice ?? ({} as Record<string, unknown>)),
            sttUrl: v || undefined,
          })
        }
        hint={t("settings.sttUrlHint")}
      />
      <Input
        label={t("settings.ttsUrl")}
        value={(vkVoice?.ttsUrl as string) ?? ""}
        onChange={(v) =>
          update(["channels", "vk", "voice"], {
            ...(vkVoice ?? ({} as Record<string, unknown>)),
            ttsUrl: v || undefined,
          })
        }
        hint={t("settings.ttsUrlHint")}
      />
      <Toggle
        label={t("settings.replyWithVoice")}
        checked={!!vkVoice?.replyWithVoice}
        onChange={(v) =>
          update(["channels", "vk", "voice"], {
            ...(vkVoice ?? ({} as Record<string, unknown>)),
            replyWithVoice: v,
          })
        }
        hint={t("settings.replyWithVoiceHint")}
      />
      <Input
        label={t("settings.ttsMaxChars")}
        type="number"
        value={(vkVoice?.ttsMaxChars as number) ?? 1000}
        onChange={(v) =>
          update(["channels", "vk", "voice"], {
            ...(vkVoice ?? ({} as Record<string, unknown>)),
            ttsMaxChars: v ? Number(v) : undefined,
          })
        }
        hint={t("settings.ttsMaxCharsHint")}
      />
    </SettingsFold>
  );

  const hostFsMode =
    ((sandbox?.hostFs as { mode?: string } | undefined)?.mode as string) || "default";
  const hostFsWarnMode = hostFsMode === "allowlist" || hostFsMode === "full";

  const sandboxSection = (
    <SettingsFold title={t("settings.sandbox")} hint={t("settings.sandboxHint")}>
      <Toggle
        label={t("settings.useDocker")}
        checked={isDesktop ? sandbox?.useDocker === true : sandbox?.useDocker !== false}
        onChange={(v) => update(["sandbox", "useDocker"], v)}
        hint={t("settings.useDockerHint")}
      />
      <Input
        label={t("settings.dockerImage")}
        value={(sandbox?.image as string) ?? ""}
        onChange={(v) => update(["sandbox", "image"], v || undefined)}
        hint={t("settings.dockerImageHint")}
      />
      <Input
        label={t("settings.timeoutMs")}
        type="number"
        value={(sandbox?.timeoutMs as number) ?? 60000}
        onChange={(v) => update(["sandbox", "timeoutMs"], v ? Number(v) : undefined)}
        hint={t("settings.timeoutMsHint")}
      />
      <Toggle
        label={t("settings.elevatedAllowed")}
        checked={!!sandbox?.elevatedAllowed}
        onChange={(v) => update(["sandbox", "elevatedAllowed"], v)}
        hint={t("settings.elevatedAllowedHint")}
      />
      <SelectField
        label={t("settings.hostFsMode")}
        value={hostFsMode}
        onChange={(v) => {
          const mode = v as "default" | "allowlist" | "full";
          const prev = (sandbox?.hostFs as Record<string, unknown> | undefined) ?? {};
          if (mode === "default") {
            update(["sandbox", "hostFs"], undefined);
            return;
          }
          update(["sandbox", "hostFs"], { ...prev, mode });
        }}
        hint={hostFsWarnMode ? t("settings.hostFsWarn") : t("settings.hostFsHint")}
      >
        <option value="default">{t("settings.hostFsModeDefault")}</option>
        <option value="allowlist">{t("settings.hostFsModeAllowlist")}</option>
        <option value="full">{t("settings.hostFsModeFull")}</option>
      </SelectField>
      {hostFsMode === "allowlist" && (
        <>
          <label>
            <LabelText label={t("settings.hostFsRead")} hint={t("settings.hostFsReadHint")} />
            <textarea
              rows={3}
              value={(((sandbox?.hostFs as { read?: string[] })?.read) ?? []).join("\n")}
              onChange={(e) => {
                const lines = e.target.value
                  .split("\n")
                  .map((s) => s.trim())
                  .filter(Boolean);
                const prev = (sandbox?.hostFs as Record<string, unknown> | undefined) ?? {
                  mode: "allowlist",
                };
                update(["sandbox", "hostFs"], {
                  ...prev,
                  mode: "allowlist",
                  read: lines.length ? lines : undefined,
                });
              }}
              placeholder={t("settings.hostFsPathsPlaceholder")}
            />
          </label>
          <label>
            <LabelText label={t("settings.hostFsWrite")} hint={t("settings.hostFsWriteHint")} />
            <textarea
              rows={3}
              value={(((sandbox?.hostFs as { write?: string[] })?.write) ?? []).join("\n")}
              onChange={(e) => {
                const lines = e.target.value
                  .split("\n")
                  .map((s) => s.trim())
                  .filter(Boolean);
                const prev = (sandbox?.hostFs as Record<string, unknown> | undefined) ?? {
                  mode: "allowlist",
                };
                update(["sandbox", "hostFs"], {
                  ...prev,
                  mode: "allowlist",
                  write: lines.length ? lines : undefined,
                });
              }}
              placeholder={t("settings.hostFsPathsPlaceholder")}
            />
          </label>
        </>
      )}
    </SettingsFold>
  );

  const webFetchSection = (
    <SettingsFold title={t("settings.webFetch")}>
      <Input
        label={t("settings.timeoutMs")}
        type="number"
        value={(webFetch?.timeoutMs as number) ?? 15000}
        onChange={(v) =>
          update(["tools", "webFetch"], {
            ...(webFetch ?? ({} as Record<string, unknown>)),
            timeoutMs: v ? Number(v) : undefined,
          })
        }
        hint={t("settings.webFetchTimeoutHint")}
      />
      <Input
        label={t("settings.maxBodyBytes")}
        type="number"
        value={(webFetch?.maxBodyBytes as number) ?? 1000000}
        onChange={(v) =>
          update(["tools", "webFetch"], {
            ...(webFetch ?? ({} as Record<string, unknown>)),
            maxBodyBytes: v ? Number(v) : undefined,
          })
        }
        hint={t("settings.maxBodyBytesHint")}
      />
      <Input
        label={t("settings.maxContextChars")}
        type="number"
        value={(webFetch?.maxContextChars as number) ?? 8000}
        onChange={(v) =>
          update(["tools", "webFetch"], {
            ...(webFetch ?? ({} as Record<string, unknown>)),
            maxContextChars: v ? Number(v) : undefined,
          })
        }
        hint={t("settings.maxContextCharsHint")}
      />
    </SettingsFold>
  );

  const gatewaySection = (
    <SettingsFold title={t("settings.gateway")}>
      <Input
        label={t("settings.port")}
        type="number"
        value={(gateway?.port as number) ?? 3000}
        onChange={(v) => update(["gateway", "port"], v ? Number(v) : undefined)}
        hint={t("settings.portHint")}
      />
      {!isDesktop && (
        <Toggle
          label={t("settings.enableApiAuth")}
          checked={!!auth?.enabled}
          onChange={(v) =>
            update(["gateway", "auth"], { ...(auth as Record<string, unknown>), enabled: v })
          }
          hint={t("settings.enableApiAuthHint")}
        />
      )}
    </SettingsFold>
  );

  const codingSection = (
    <SettingsFold title={t("settings.coding")} hint={t("settings.codingHint")}>
      <Input
        label={t("settings.maxSubagents")}
        type="number"
        value={(coding?.maxSubagents as number) ?? 3}
        onChange={(v) => {
          const n = v ? Number(v) : 3;
          update(["coding", "maxSubagents"], Number.isFinite(n) ? Math.max(1, Math.floor(n)) : 3);
        }}
        hint={t("settings.codingTokenWarning")}
      />
    </SettingsFold>
  );

  const formatTs = (ts?: number) => {
    if (!ts) return "—";
    try {
      return new Date(ts).toLocaleString(locale === "ru" ? "ru-RU" : "en-US");
    } catch {
      return String(ts);
    }
  };

  const remoteAccessSection = (
    <SettingsFold
      title={t("settings.remoteAccess")}
      hint={t("settings.remoteAccessHint")}
    >
      <Input
        label={t("settings.remoteCompanionToken")}
        type="password"
        value={(remoteAccess?.accessToken as string) ?? ""}
        onChange={(v) =>
          update(["remoteAccess"], {
            ...(remoteAccess ?? {}),
            accessToken: v || undefined,
          })
        }
        placeholder={remoteAccess?.accessToken === MASK ? MASK : ""}
        hint={t("settings.remoteCompanionTokenHint")}
      />
      <div className="settings-actions" style={{ position: "static", background: "transparent", padding: "0 0 0.5rem" }}>
        <button
          type="button"
          className="settings-reload"
          onClick={() => {
            const bytes = new Uint8Array(24);
            crypto.getRandomValues(bytes);
            const token = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
            update(["remoteAccess"], {
              ...(remoteAccess ?? {}),
              accessToken: token,
            });
          }}
        >
          {t("settings.remoteCompanionTokenGenerate")}
        </button>
        <button
          type="button"
          className="settings-reload"
          disabled={!remoteAccess?.accessToken || remoteAccess.accessToken === MASK}
          onClick={() => {
            const token = String(remoteAccess?.accessToken ?? "");
            if (!token || token === MASK) return;
            void navigator.clipboard?.writeText(token).catch(() => {});
          }}
        >
          {t("settings.remoteCompanionTokenCopy")}
        </button>
      </div>
      <Toggle
        label={t("settings.remoteDdnsEnable")}
        checked={!!remoteDdns?.enabled}
        onChange={(v) =>
          update(["remoteAccess"], {
            ...(remoteAccess ?? {}),
            ddns: { ...(remoteDdns ?? {}), provider: "duckdns", enabled: v },
          })
        }
        hint={t("settings.remoteDdnsEnableHint")}
      />
      <Input
        label={t("settings.remoteDomain")}
        value={(remoteDdns?.domain as string) ?? ""}
        onChange={(v) =>
          update(["remoteAccess"], {
            ...(remoteAccess ?? {}),
            ddns: { ...(remoteDdns ?? {}), provider: "duckdns", domain: v || undefined },
          })
        }
        placeholder={t("settings.remoteDomainHint")}
        hint={t("settings.remoteDomainHint")}
      />
      <Input
        label={t("settings.remoteToken")}
        type="password"
        value={(remoteDdns?.token as string) ?? ""}
        onChange={(v) =>
          update(["remoteAccess"], {
            ...(remoteAccess ?? {}),
            ddns: { ...(remoteDdns ?? {}), provider: "duckdns", token: v || undefined },
          })
        }
        placeholder={remoteDdns?.token === MASK ? MASK : ""}
        hint={t("settings.remoteTokenHint")}
      />
      <Input
        label={t("settings.remoteInterval")}
        type="number"
        value={(remoteDdns?.updateIntervalMinutes as number) ?? 30}
        onChange={(v) =>
          update(["remoteAccess"], {
            ...(remoteAccess ?? {}),
            ddns: {
              ...(remoteDdns ?? {}),
              provider: "duckdns",
              updateIntervalMinutes: v ? Math.max(5, Number(v)) : 30,
            },
          })
        }
        hint={t("settings.remoteIntervalHint")}
      />
      <Toggle
        label={t("settings.remoteTlsEnable")}
        checked={!!remoteTls?.enabled}
        onChange={(v) =>
          update(["remoteAccess"], {
            ...(remoteAccess ?? {}),
            tls: { ...(remoteTls ?? {}), enabled: v },
          })
        }
        hint={t("settings.remoteTlsEnableHint")}
      />
      <Input
        label={t("settings.remoteEmail")}
        value={(remoteTls?.email as string) ?? ""}
        onChange={(v) =>
          update(["remoteAccess"], {
            ...(remoteAccess ?? {}),
            tls: { ...(remoteTls ?? {}), email: v || undefined },
          })
        }
        placeholder={t("settings.remoteEmailHint")}
        hint={t("settings.remoteEmailHint")}
      />
      <Toggle
        label={t("settings.remoteStaging")}
        checked={!!remoteTls?.staging}
        onChange={(v) =>
          update(["remoteAccess"], {
            ...(remoteAccess ?? {}),
            tls: { ...(remoteTls ?? {}), staging: v },
          })
        }
        hint={t("settings.remoteStagingHint")}
      />
      <Toggle
        label={t("settings.remoteListenEnable")}
        checked={!!remoteTls?.listenEnabled}
        onChange={(v) =>
          update(["remoteAccess"], {
            ...(remoteAccess ?? {}),
            tls: { ...(remoteTls ?? {}), listenEnabled: v },
          })
        }
        hint={t("settings.remoteListenEnableHint")}
      />
      <Input
        label={t("settings.remoteListenPort")}
        type="number"
        value={(remoteTls?.listenPort as number) ?? 443}
        onChange={(v) => {
          const n = v ? Number(v) : 443;
          update(["remoteAccess"], {
            ...(remoteAccess ?? {}),
            tls: {
              ...(remoteTls ?? {}),
              listenPort: Number.isFinite(n) && n > 0 ? Math.min(65535, Math.floor(n)) : 443,
            },
          });
        }}
        hint={t("settings.remoteListenPortHint")}
      />
      <Toggle
        label={t("settings.remoteUpnp")}
        checked={remoteTls?.upnp !== false}
        onChange={(v) =>
          update(["remoteAccess"], {
            ...(remoteAccess ?? {}),
            tls: { ...(remoteTls ?? {}), upnp: v },
          })
        }
        hint={t("settings.remoteUpnpHint")}
      />
      <Toggle
        label={t("settings.remoteOpenOnTray")}
        checked={!!remoteTls?.openOnTrayHide}
        onChange={(v) =>
          update(["remoteAccess"], {
            ...(remoteAccess ?? {}),
            tls: { ...(remoteTls ?? {}), openOnTrayHide: v },
          })
        }
        hint={t("settings.remoteOpenOnTrayHint")}
      />
      <div className="settings-remote-actions">
        <button
          type="button"
          className="settings-btn-secondary"
          disabled={remoteBusy != null}
          onClick={() => void runRemoteDdns()}
        >
          {remoteBusy === "ddns" ? t("settings.remoteBusyDdns") : t("settings.remoteUpdateDdns")}
        </button>
        <button
          type="button"
          className="settings-btn-secondary"
          disabled={remoteBusy != null}
          onClick={() => void runRemoteCert()}
        >
          {remoteBusy === "cert" ? t("settings.remoteBusyCert") : t("settings.remoteIssueCert")}
        </button>
        <button
          type="button"
          className="settings-btn-secondary"
          disabled={remoteBusy != null}
          onClick={() => void runRemoteHttpsOpen()}
        >
          {t("settings.remoteOpenHttps")}
        </button>
        <button
          type="button"
          className="settings-btn-secondary"
          disabled={remoteBusy != null}
          onClick={() => void runRemoteHttpsClose()}
        >
          {t("settings.remoteCloseHttps")}
        </button>
        <button
          type="button"
          className="settings-btn-secondary"
          disabled={remoteBusy != null}
          onClick={() => void loadRemoteStatus()}
        >
          {t("settings.remoteRefreshStatus")}
        </button>
      </div>
      {remoteStatus ? (
        <div className="settings-remote-status">
          <p className="settings-hint">
            <strong>{t("settings.remoteStatus")}</strong>
            {remoteStatus.fqdn ? `: ${remoteStatus.fqdn}` : ""}
          </p>
          <p className="settings-hint">
            {remoteStatus.ddns.lastOkAt
              ? `${t("settings.remoteDdnsOk")} (${formatTs(remoteStatus.ddns.lastOkAt)}${
                  remoteStatus.ddns.lastIp ? `, IP ${remoteStatus.ddns.lastIp}` : ""
                })`
              : remoteStatus.ddns.lastError
                ? `${t("settings.remoteDdnsErr")}: ${remoteStatus.ddns.lastError}`
                : t("settings.remoteDdnsErr")}
          </p>
          <p className="settings-hint">
            {remoteStatus.cert.hasCert
              ? `${t("settings.remoteCertOk")}${
                  remoteStatus.cert.expiresAt
                    ? ` — ${t("settings.remoteExpires")} ${formatTs(remoteStatus.cert.expiresAt)}`
                    : ""
                }`
              : remoteStatus.cert.lastError
                ? `${t("settings.remoteCertErr")}: ${remoteStatus.cert.lastError}`
                : t("settings.remoteCertMissing")}
          </p>
          <p className="settings-hint">
            {remoteStatus.https?.listening
              ? `${t("settings.remoteHttpsOpen")}${
                  remoteStatus.https.url
                    ? `: ${remoteStatus.https.url}`
                    : remoteStatus.https.port
                      ? ` (:${remoteStatus.https.port})`
                      : ""
                }`
              : t("settings.remoteHttpsClosed")}
            {remoteStatus.https?.lastError ? ` — ${remoteStatus.https.lastError}` : ""}
          </p>
          <p className="settings-hint">
            {remoteStatus.upnp?.enabled === false
              ? t("settings.remoteUpnpOff")
              : remoteStatus.upnp?.mapped
                ? `${t("settings.remoteUpnpOk")}${
                    remoteStatus.upnp.externalPort
                      ? ` (:${remoteStatus.upnp.externalPort} → ${remoteStatus.upnp.localIp ?? "?"})`
                      : ""
                  }${remoteStatus.upnp.externalIp ? `, WAN ${remoteStatus.upnp.externalIp}` : ""}`
                : remoteStatus.upnp?.lastError
                  ? `${t("settings.remoteUpnpErr")}: ${remoteStatus.upnp.lastError}`
                  : t("settings.remoteUpnpErr")}
          </p>
          {remoteStatus.cert.fullchainPath ? (
            <p className="settings-hint">
              <code>{remoteStatus.cert.fullchainPath}</code>
            </p>
          ) : null}
          {remoteStatus.note ? <p className="settings-hint">{remoteStatus.note}</p> : null}
        </div>
      ) : (
        <p className="settings-hint">{t("settings.remoteSaveFirst")}</p>
      )}
    </SettingsFold>
  );

  const desktopPathsSection =
    isDesktop && desktopPaths ? (
      <SettingsFold title={t("settings.logsAndPaths")} hint={t("settings.logsHint")}>
        <h3 className="settings-section-title settings-section-title--sub">
          <span className="settings-section-title-label">
            <LabelText
              label={t("settings.backgroundMode")}
              hint={t("settings.backgroundModeHint")}
            />
          </span>
        </h3>
        {window.claw2Desktop?.setOpenAtLogin && openAtLogin != null ? (
          <Toggle
            label={t("settings.openAtLogin")}
            checked={openAtLogin}
            onChange={(v) => {
              void window.claw2Desktop?.setOpenAtLogin?.(v).then((next) => {
                setOpenAtLoginState(next);
              });
            }}
            hint={t("settings.openAtLoginHint")}
          />
        ) : null}
        {window.claw2Desktop?.hideToTray ? (
          <button
            type="button"
            className="settings-btn-secondary"
            onClick={() => void window.claw2Desktop?.hideToTray?.()}
          >
            {t("settings.hideToTray")}
          </button>
        ) : null}
        {(
          [
            ["runtimeLog", desktopPaths.runtimeLog],
            ["logsDir", desktopPaths.logsDir],
            ["configPath", desktopPaths.configPath],
            ["stateDir", desktopPaths.stateDir],
            ["userData", desktopPaths.userData],
          ] as const
        ).map(([key, value]) => (
          <div key={key} className="settings-path-row">
            <div className="settings-path-meta">
              <span className="settings-path-label">{t(`settings.path.${key}`)}</span>
              <code className="settings-path-value" title={value}>
                {value}
              </code>
            </div>
            <div className="settings-path-actions">
              <button type="button" className="settings-btn-secondary" onClick={() => void copyPath(value)}>
                {pathCopied === value ? t("settings.copied") : t("settings.copyPath")}
              </button>
              {window.claw2Desktop?.openPath ? (
                <button type="button" className="settings-btn-secondary" onClick={() => void openPath(value)}>
                  {t("settings.openPath")}
                </button>
              ) : null}
            </div>
          </div>
        ))}
      </SettingsFold>
    ) : null;

  const advancedContent = (
    <>
      {telegramSection}
      {vkSection}
      {sandboxSection}
      {webFetchSection}
      {gatewaySection}
      {codingSection}
    </>
  );

  return (
    <div className="settings-root">
      <form className="settings" onSubmit={(e) => e.preventDefault()} autoComplete="off" aria-label={t("settings.aria")}>
        {languageSection}
        {llmSection}
        {voiceSection}
        {sipSection}
        {memorySection}
        {insightsSection}
        {toolsMainSection}
        {visionSection}
        {remoteAccessSection}
        {desktopPathsSection}
        {isDesktop ? (
          <AdvancedBlock title={t("settings.advanced")}>{advancedContent}</AdvancedBlock>
        ) : (
          advancedContent
        )}
      </form>

      <div className="settings-actions">
        <button type="button" onClick={save} disabled={saving}>
          {saving ? t("common.saving") : t("settings.saveConfig")}
        </button>
        <button
          type="button"
          className="settings-btn-secondary"
          onClick={() => void loadConnections()}
          disabled={connLoading}
        >
          {connLoading ? t("settings.connChecking") : t("settings.connRefresh")}
        </button>
      </div>

      {toast && (
        <div className={`settings-toast ${toast.type}`} role="alert">
          <span className="settings-toast-text">{toast.text}</span>
          <button
            type="button"
            className="settings-toast-close"
            onClick={() => setToast(null)}
            aria-label={t("common.close")}
          >
            <IconClose size={14} />
          </button>
        </div>
      )}
    </div>
  );
}
