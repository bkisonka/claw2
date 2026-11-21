// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Vitaliy Bondar

import { useState, FormEvent } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useAuth } from "../context/AuthContext";
import { useT } from "../i18n";

export function LoginPage() {
  const [login, setLogin] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const navigate = useNavigate();
  const { login: doLogin } = useAuth();
  const t = useT();

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    if (!login.trim()) {
      setError(t("auth.enterLogin"));
      return;
    }
    if (!password) {
      setError(t("auth.enterPassword"));
      return;
    }
    setSubmitting(true);
    try {
      await doLogin(login.trim(), password);
      navigate("/chat", { replace: true });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="auth-page">
      <div className="auth-card">
        <h1 className="auth-title">{t("auth.loginTitle")}</h1>
        <form onSubmit={handleSubmit} className="auth-form">
          <label>
            <span>{t("auth.loginLabel")}</span>
            <input
              type="text"
              autoComplete="username"
              value={login}
              onChange={(e) => setLogin(e.target.value)}
              placeholder={t("auth.loginPlaceholder")}
            />
          </label>
          <label>
            <span>{t("auth.password")}</span>
            <input
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder={t("auth.passwordPlaceholder")}
            />
          </label>
          {error && <p className="auth-error" role="alert">{error}</p>}
          <button type="submit" className="auth-submit" disabled={submitting}>
            {submitting ? t("auth.signingIn") : t("auth.signIn")}
          </button>
        </form>
        <p className="auth-footer">
          {t("auth.noAccount")} <Link to="/register">{t("auth.registerLink")}</Link>
        </p>
      </div>
    </div>
  );
}
