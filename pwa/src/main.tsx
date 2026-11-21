// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Vitaliy Bondar

import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { Capacitor } from "@capacitor/core";
import App from "./App";
import "./index.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>
);

const native = Capacitor.isNativePlatform();

// Service worker only for the gateway-hosted /pwa/ build.
if (!native && "serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/pwa/sw.js", { scope: "/pwa/" }).catch(() => {});
  });
}

if (native) {
  document.body.classList.add("native-app");
  // Напоминания: канал + тап-обработчик; сверка статусов на старте и каждом
  // возврате приложения (пере-выдача/экспирация/дедупликация трея).
  import("./engine/notifications")
    .then(async ({ initNotifications, reconcileReminders }) => {
      await initNotifications().catch(() => {});
      await reconcileReminders().catch(() => {});
      const { App: CapApp } = await import("@capacitor/app");
      CapApp.addListener("appStateChange", (s) => {
        if (s.isActive) void reconcileReminders().catch(() => {});
      });
    })
    .catch(() => {});
  // Dark-only app: light status-bar icons; the bar itself never overlaps the
  // header because capacitor.config sets adjustMarginsForEdgeToEdge=auto.
  import("@capacitor/status-bar")
    .then(async ({ StatusBar, Style }) => {
      await StatusBar.setStyle({ style: Style.Dark });
      await StatusBar.setBackgroundColor({ color: "#1a1a1c" }).catch(() => {});
    })
    .catch(() => {});
}
