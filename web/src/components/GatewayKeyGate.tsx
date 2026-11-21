// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Vitaliy Bondar

import { useState, FormEvent } from "react";
import { apiBase, setGatewayKey } from "../config";
import { useT } from "../i18n";

/**
 * Personal deployments (gateway in key-auth mode): the web client ships
 * without a baked-in key, so the first visit asks for the gateway key
 * (CLAW2_GATEWAY_API_KEY from the server's .env) and keeps it in the
 * browser. Hosted multi-user deployments use the login page instead.
 */
export function GatewayKeyGate() {
  const [key, setKey] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const t = useT();

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    const trimmed = key.trim();
    if (!trimmed) {
      setError(t("keyGate.enterKey"));
      return;
    }
    setSubmitting(true);
    setError(null);
    // Verify before storing: the probe passes the auth gate only with a valid
    // key (404 then means "/api/me does not exist in key mode" — expected).
    try {
      const res = await fetch(`${apiBase}/api/me`, {
        headers: { "X-API-Key": trimmed, Authorization: `Bearer ${trimmed}` },
      });
      if (res.status === 401 || res.status === 403) {
        setError(t("keyGate.wrongKey"));
        setSubmitting(false);
        return;
      }
      setGatewayKey(trimmed);
      window.location.reload();
    } catch {
      setError(t("keyGate.unreachable"));
      setSubmitting(false);
    }
  };

  return (
    <div className="auth-page">
      <div className="auth-card">
        <h1 className="auth-title">{t("keyGate.title")}</h1>
        <p className="auth-footer">{t("keyGate.description")}</p>
        <form onSubmit={handleSubmit} className="auth-form">
          <label>
            <span>{t("keyGate.label")}</span>
            <input
              type="password"
              autoComplete="current-password"
              value={key}
              onChange={(e) => setKey(e.target.value)}
              placeholder={t("keyGate.placeholder")}
              autoFocus
            />
          </label>
          {error && (
            <p className="auth-error" role="alert">
              {error}
            </p>
          )}
          <button type="submit" className="auth-submit" disabled={submitting}>
            {submitting ? t("common.loading") : t("keyGate.submit")}
          </button>
        </form>
      </div>
    </div>
  );
}
