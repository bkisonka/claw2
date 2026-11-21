// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Vitaliy Bondar

import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  base: "/",
  server: {
    host: "127.0.0.1",
    port: 5173,
    proxy: {
      // GET /chat → serve SPA (index.html); other /chat/* (list, POST, …) → gateway
      "/chat": {
        target: "http://localhost:3000",
        changeOrigin: true,
        bypass(req) {
          const url = req.url ?? "";
          if (
            req.method === "GET" &&
            (url === "/chat" || url === "/chat/" || url.startsWith("/chat/room"))
          ) {
            return "/index.html";
          }
        },
      },
      "/project": { target: "http://localhost:3000", changeOrigin: true },
      "/files": { target: "http://localhost:3000", changeOrigin: true },
      "/health": { target: "http://localhost:3000", changeOrigin: true },
      "/api": { target: "http://localhost:3000", changeOrigin: true },
    },
  },
});
