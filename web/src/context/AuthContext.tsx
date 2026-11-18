import { createContext, useCallback, useContext, useEffect, useState } from "react";
import type { UserMe } from "../api/auth";
import { fetchMe, login as apiLogin, register as apiRegister, logout as apiLogout, changePassword as apiChangePassword } from "../api/auth";
import { getToken, setToken } from "../auth/storage";
import { apiBase } from "../config";
import { isSingleUserClient } from "../lib/singleUser";
import { t } from "../i18n";

export type AuthMode = "auth" | "no-auth" | "unknown";

interface AuthContextValue {
  user: UserMe | null;
  authMode: AuthMode;
  checked: boolean;
  login: (login: string, password: string) => Promise<void>;
  register: (login: string, email: string | null, password: string) => Promise<void>;
  logout: () => Promise<void>;
  changePassword: (currentPassword: string, newPassword: string) => Promise<void>;
  refreshUser: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<UserMe | null>(null);
  const [authMode, setAuthMode] = useState<AuthMode>("unknown");
  const [checked, setChecked] = useState(false);

  const refreshUser = useCallback(async () => {
    if (isSingleUserClient()) {
      setUser(null);
      setAuthMode("no-auth");
      setChecked(true);
      return;
    }
    try {
      const me = await fetchMe();
      if (me) {
        setUser(me);
        setAuthMode("auth");
      } else {
        setAuthMode("no-auth");
        setUser(null);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg === "auth_required") {
        setUser(null);
        setAuthMode("auth");
      } else {
        setAuthMode("no-auth");
        setUser(null);
      }
    } finally {
      setChecked(true);
    }
  }, []);

  useEffect(() => {
    if (isSingleUserClient()) {
      setToken(null);
      setUser(null);
      setAuthMode("no-auth");
      setChecked(true);
      return;
    }

    const token = getToken();
    if (token) {
      fetchMe()
        .then((me) => {
          if (me) {
            setUser(me);
            setAuthMode("auth");
          } else {
            setAuthMode("no-auth");
            setUser(null);
          }
        })
        .catch((err) => {
          const msg = err instanceof Error ? err.message : String(err);
          if (msg === "auth_required") {
            setToken(null);
            setUser(null);
            setAuthMode("auth");
          } else {
            setAuthMode("no-auth");
            setUser(null);
          }
        })
        .finally(() => setChecked(true));
    } else {
      fetch(`${apiBase}/api/me`, { method: "GET" })
        .then((res) => {
          if (res.status === 404) setAuthMode("no-auth");
          else setAuthMode("auth");
          setUser(null);
        })
        .catch(() => {
          setAuthMode("no-auth");
          setUser(null);
        })
        .finally(() => setChecked(true));
    }
  }, []);

  const login = useCallback(async (loginName: string, password: string) => {
    if (isSingleUserClient()) {
      setAuthMode("no-auth");
      return;
    }
    const data = await apiLogin(loginName, password);
    setToken(data.token);
    setUser(data.user);
    setAuthMode("auth");
  }, []);

  const register = useCallback(async (loginName: string, email: string | null, password: string) => {
    if (isSingleUserClient()) {
      setAuthMode("no-auth");
      return;
    }
    const data = await apiRegister(loginName, email, password);
    setToken(data.token);
    setUser(data.user);
    setAuthMode("auth");
  }, []);

  const logout = useCallback(async () => {
    if (isSingleUserClient()) {
      setToken(null);
      setUser(null);
      setAuthMode("no-auth");
      return;
    }
    await apiLogout();
    setToken(null);
    setUser(null);
  }, []);

  const changePassword = useCallback(async (currentPassword: string, newPassword: string) => {
    if (isSingleUserClient()) {
      throw new Error(t("auth.singleUserNoAccounts"));
    }
    await apiChangePassword(currentPassword, newPassword);
  }, []);

  const value: AuthContextValue = {
    user,
    authMode,
    checked,
    login,
    register,
    logout,
    changePassword,
    refreshUser,
  };

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}
