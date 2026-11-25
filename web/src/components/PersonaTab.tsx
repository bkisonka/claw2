// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Vitaliy Bondar

import { useCallback, useEffect, useRef, useState, type CSSProperties } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { getAssistantPersona, putAssistantPersona } from "../api/assistantPersona";
import {
  getAssistantIdentity,
  putAssistantIdentity,
  type AssistantAvatar,
} from "../api/assistantIdentity";
import { useAssistantIdentity } from "../context/AssistantIdentityContext";
import { useT } from "../i18n";

/** Avatars are tiny: downscale any upload to a 256×256 cover crop before sending. */
const AVATAR_SIDE = 256;

async function fileToAvatar(file: File): Promise<AssistantAvatar | null> {
  try {
    const bitmap = await createImageBitmap(file);
    const side = Math.min(bitmap.width, bitmap.height);
    const canvas = document.createElement("canvas");
    canvas.width = AVATAR_SIDE;
    canvas.height = AVATAR_SIDE;
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    ctx.drawImage(
      bitmap,
      (bitmap.width - side) / 2,
      (bitmap.height - side) / 2,
      side,
      side,
      0,
      0,
      AVATAR_SIDE,
      AVATAR_SIDE
    );
    bitmap.close();
    const blob = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob(resolve, "image/webp", 0.85)
    );
    const fallback =
      blob ?? (await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.85)));
    if (!fallback) return null;
    const mimeType = fallback.type === "image/jpeg" ? "image/jpeg" : "image/webp";
    const buffer = new Uint8Array(await fallback.arrayBuffer());
    let binary = "";
    for (let i = 0; i < buffer.length; i++) binary += String.fromCharCode(buffer[i]!);
    return { kind: "image", mimeType, dataBase64: btoa(binary) };
  } catch {
    return null;
  }
}

const AVATAR_PRESETS = [
  "🐱", "🤖", "🦉", "🦊", "🐼", "🐰", "🐲", "👽", "🎩", "🧠", "⭐", "🚀", "🌸", "☕", "🎧", "📚",
];

export function PersonaTab() {
  const t = useT();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const welcome = searchParams.get("welcome") === "1" || searchParams.get("onboarding") === "1";
  const { setIdentity } = useAssistantIdentity();

  const [full, setFull] = useState("");
  const [compact, setCompact] = useState("");
  const [identityName, setIdentityName] = useState("");
  const [avatar, setAvatar] = useState<AssistantAvatar | null>(null);
  const [avatarSize, setAvatarSize] = useState(52);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [personaData, identityData] = await Promise.all([getAssistantPersona(), getAssistantIdentity()]);
      setFull(personaData.full ?? "");
      setCompact(personaData.compact ?? "");
      setIdentityName(identityData.name ?? "");
      setAvatarSize(identityData.avatarSize ?? 52);
      const loadedAvatar = identityData.avatar;
      // The gateway serves the image as a data URL; saving needs the base64 back.
      setAvatar(
        loadedAvatar.kind === "image"
          ? { kind: "image", mimeType: loadedAvatar.mimeType, dataBase64: loadedAvatar.dataUrl.slice(loadedAvatar.dataUrl.indexOf(",") + 1) }
          : { kind: "preset", value: loadedAvatar.value }
      );
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
      const identityPayload = await putAssistantIdentity({
        name: identityName.trim() || undefined,
        avatar: avatar ?? { kind: "preset", value: "🤖" },
        avatarSize,
      });
      setIdentity(identityPayload);
      await putAssistantPersona({ full, compact });
      setSaved(true);
      if (andContinue || welcome) finishWelcome(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  const onUploadChange = async (file: File | undefined) => {
    if (!file) return;
    const next = await fileToAvatar(file);
    if (!next) {
      setError(t("persona.avatarBadFile"));
      return;
    }
    setError(null);
    setSaved(false);
    setAvatar(next);
    if (fileInputRef.current) fileInputRef.current.value = "";
  };

  if (loading) {
    return <div className="persona-tab">{t("app.loading")}</div>;
  }

  const previewEmoji = avatar?.kind === "preset" ? avatar.value : null;

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
          <span className="settings-section-title-label">{t("persona.identityTitle")}</span>
        </h2>
        <p className="settings-hint">{t("persona.identityHint")}</p>

        <label>
          <span>{t("persona.nameLabel")}</span>
          <input
            className="persona-name"
            value={identityName}
            onChange={(e) => {
              setIdentityName(e.target.value);
              setSaved(false);
            }}
            maxLength={64}
            placeholder={t("persona.namePlaceholder")}
            spellCheck={false}
          />
        </label>

        <div className="persona-avatar-block">
          <span>{t("persona.avatarLabel")}</span>
          <div className="persona-avatar-row">
            <span
              className="assistant-avatar assistant-avatar--idle persona-avatar-preview"
              style={{ "--avatar-size": `${avatarSize}px` } as CSSProperties}
              aria-hidden
            >
              <span className="assistant-avatar-disc">
                {avatar?.kind === "image" ? (
                  <img
                    className="assistant-avatar-img"
                    src={`data:${avatar.mimeType};base64,${avatar.dataBase64}`}
                    alt=""
                  />
                ) : (
                  previewEmoji
                )}
              </span>
            </span>
            <div className="persona-avatar-actions">
              <button type="button" className="settings-btn-secondary" onClick={() => fileInputRef.current?.click()}>
                {t("persona.avatarUpload")}
              </button>
              <button
                type="button"
                className="settings-btn-secondary"
                onClick={() => {
                  setAvatar({ kind: "preset", value: "🤖" });
                  setSaved(false);
                }}
              >
                {t("persona.avatarReset")}
              </button>
              <input
                ref={fileInputRef}
                type="file"
                accept="image/png,image/jpeg,image/webp,image/gif"
                hidden
                onChange={(e) => void onUploadChange(e.target.files?.[0])}
              />
            </div>
          </div>
          <label className="persona-avatar-size">
            <span>{t("persona.sizeLabel")}</span>
            <input
              type="range"
              min={24}
              max={96}
              step={2}
              value={avatarSize}
              onChange={(e) => {
                setAvatarSize(Number(e.target.value));
                setSaved(false);
              }}
            />
            <span className="persona-avatar-size-value">{avatarSize}px</span>
          </label>
          <div className="persona-avatar-presets" role="listbox" aria-label={t("persona.avatarLabel")}>
            {AVATAR_PRESETS.map((emoji) => (
              <button
                key={emoji}
                type="button"
                role="option"
                aria-selected={avatar?.kind === "preset" && avatar.value === emoji}
                className={`persona-avatar-preset${avatar?.kind === "preset" && avatar.value === emoji ? " persona-avatar-preset--active" : ""}`}
                onClick={() => {
                  setAvatar({ kind: "preset", value: emoji });
                  setSaved(false);
                }}
              >
                {emoji}
              </button>
            ))}
          </div>
        </div>

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

        <div className="persona-actions settings-actions">
          <button type="button" disabled={saving || !full.trim()} onClick={() => void save(false)}>
            {saving ? t("persona.saving") : t("persona.save")}
          </button>
        </div>
      </section>
    </div>
  );
}
