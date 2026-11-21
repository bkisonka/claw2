// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Vitaliy Bondar

import { useState, FormEvent } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useAuth } from "../context/AuthContext";
import { useT } from "../i18n";

export function RegisterPage() {
  const [login, setLogin] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const navigate = useNavigate();
  const { register: doRegister } = useAuth();
  const t = useT();

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    if (!login.trim()) {
      setError(t("auth.enterLoginOrEmail"));
      return;
    }
    if (password.length < 6) {
      setError(t("auth.passwordMin"));
      return;
    }
    if (password !== confirm) {
      setError(t("auth.passwordsMismatch"));
      return;
    }
    setSubmitting(true);
    try {
      await doRegister(login.trim(), email.trim() || null, password);
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
        <h1 className="auth-title">{t("auth.registerTitle")}</h1>
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
            <span>{t("auth.emailOptional")}</span>
            <input
              type="email"
              autoComplete="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="email@example.com"
            />
          </label>
          <label>
            <span>{t("auth.password")}</span>
            <input
              type="password"
              autoComplete="new-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder={t("auth.passwordMinPlaceholder")}
            />
          </label>
          <label>
            <span>{t("auth.confirmPassword")}</span>
            <input
              type="password"
              autoComplete="new-password"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              placeholder={t("auth.repeatPassword")}
            />
          </label>
          {error && <p className="auth-error" role="alert">{error}</p>}
          <button type="submit" className="auth-submit" disabled={submitting}>
            {submitting ? t("auth.registering") : t("auth.register")}
          </button>
        </form>
        <p className="auth-footer">
          {t("auth.haveAccount")} <Link to="/login">{t("auth.signIn")}</Link>
        </p>
      </div>
    </div>
  );
}
