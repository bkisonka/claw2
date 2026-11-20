import { Routes, Route, Navigate } from "react-router-dom";
import { useAuth } from "./context/AuthContext";
import { LoginPage } from "./pages/LoginPage";
import { RegisterPage } from "./pages/RegisterPage";
import { AuthenticatedArea } from "./pages/AuthenticatedArea";
import { isSingleUserClient } from "./lib/singleUser";
import { apiKey } from "./config";
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
  // Personal deployment (single-user build, no baked-in key): ask for the
  // gateway key before rendering anything — every API call would 401 anyway.
  if (isSingleUserClient() && !apiKey) return <GatewayKeyGate />;
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
