// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Vitaliy Bondar

import { useEffect, useState } from "react";
import { Routes, Route, Navigate } from "react-router-dom";
import { useAuth } from "./context/AuthContext";
import { LoginPage } from "./pages/LoginPage";
import { RegisterPage } from "./pages/RegisterPage";
import { AuthenticatedArea } from "./pages/AuthenticatedArea";
import { isSingleUserClient } from "./lib/singleUser";
import { apiBase, apiKey, clearGatewayKey } from "./config";
import { GatewayKeyGate } from "./components/GatewayKeyGate";
import { useT } from "./i18n";

function RootRedirect() {
  const { user, authMode, checked } = useAuth();
  const t = useT();
  if (!checked) {
    return (
      <div className="auth-loading" style={{ padding: "2rem", textAlign: "center" }}>
        {t("app.loading")}
      </div>
    );
  }
  if (isSingleUserClient() || authMode === "no-auth") return <Navigate to="/chat" replace />;
  if (user) return <Navigate to="/chat" replace />;
  if (authMode === "auth") return <Navigate to="/login" replace />;
  return <Navigate to="/chat" replace />;
}

function AuthOnly({ children }: { children: React.ReactNode }) {
  if (isSingleUserClient()) return <Navigate to="/chat" replace />;
  return <>{children}</>;
}

export default function App() {
  // Personal deployment (single-user build): ask for the gateway key when
  // none is stored, and re-ask when the stored key has been rejected by the
  // gateway (rotated on the server) — otherwise every API call 401s silently.
  const [keyInvalid, setKeyInvalid] = useState(false);
  useEffect(() => {
    if (!isSingleUserClient() || !apiKey) return;
    let cancelled = false;
    // Probe with a route that EXISTS in key mode: /api/me answers 404 there
    // (registration-only) and painted the console red on every load.
    fetch(`${apiBase}/chat/list`, {
      headers: { "X-API-Key": apiKey, Authorization: `Bearer ${apiKey}` },
    })
      .then((res) => {
        if (!cancelled && (res.status === 401 || res.status === 403)) {
          clearGatewayKey();
          setKeyInvalid(true);
        }
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);
  if (isSingleUserClient() && (!apiKey || keyInvalid)) return <GatewayKeyGate />;
  return (
    <Routes>
      <Route path="/" element={<RootRedirect />} />
      <Route
        path="/login"
        element={
          <AuthOnly>
            <LoginPage />
          </AuthOnly>
        }
      />
      <Route
        path="/register"
        element={
          <AuthOnly>
            <RegisterPage />
          </AuthOnly>
        }
      />
      {/* One layout for chat+cabinet+gallery — otherwise leaving during a stream
          unmounts AuthenticatedArea and aborts the in-progress reply. */}
      <Route element={<AuthenticatedArea />}>
        <Route path="chat/*" element={null} />
        <Route path="cabinet/*" element={null} />
        <Route path="gallery/*" element={null} />
        <Route path="documents/*" element={null} />
        <Route path="calls/*" element={null} />
      </Route>
    </Routes>
  );
}
