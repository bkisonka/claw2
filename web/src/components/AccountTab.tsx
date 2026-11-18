import { useState, FormEvent } from "react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "../context/AuthContext";
import { useT } from "../i18n";

export function AccountTab() {
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const navigate = useNavigate();
  const { user, logout, changePassword } = useAuth();
  const t = useT();

  const handleChangePassword = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    setMessage(null);
    if (newPassword.length < 6) {
      setError(t("account.passwordMin"));
      return;
    }
    if (newPassword !== confirmPassword) {
      setError(t("auth.passwordsMismatch"));
      return;
    }
    setSubmitting(true);
    try {
      await changePassword(currentPassword, newPassword);
      setMessage(t("account.passwordChanged"));
      setCurrentPassword("");
      setNewPassword("");
      setConfirmPassword("");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  };

  const handleLogout = async () => {
    await logout();
    navigate("/login", { replace: true });
  };

  return (
    <div className="account-tab">
      <section className="account-section">
        <h3>{t("account.userData")}</h3>
        <p>
          {t("account.login")} <strong>{user?.login ?? "—"}</strong>
        </p>
        {user?.email && (
          <p>
            {t("account.email")} <strong>{user.email}</strong>
          </p>
        )}
      </section>

      <section className="account-section">
        <h3>{t("account.changePassword")}</h3>
        <form onSubmit={handleChangePassword} className="account-form">
          <label>
            <span>{t("account.currentPassword")}</span>
            <input
              type="password"
              value={currentPassword}
              onChange={(e) => setCurrentPassword(e.target.value)}
              autoComplete="current-password"
            />
          </label>
          <label>
            <span>{t("account.newPassword")}</span>
            <input
              type="password"
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
              autoComplete="new-password"
            />
          </label>
          <label>
            <span>{t("account.confirm")}</span>
            <input
              type="password"
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
              autoComplete="new-password"
            />
          </label>
          {error && <p className="auth-error" role="alert">{error}</p>}
          {message && <p className="account-message" role="status">{message}</p>}
          <button type="submit" disabled={submitting}>
            {submitting ? t("common.saving") : t("account.savePassword")}
          </button>
        </form>
      </section>

      <section className="account-section">
        <button type="button" className="account-logout" onClick={handleLogout}>
          {t("account.logout")}
        </button>
      </section>
    </div>
  );
}
