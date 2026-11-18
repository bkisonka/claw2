import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// CLAW2_APP_TARGET=capacitor → assets from "/" (served by the Android WebView locally);
// default → "/pwa/" for the gateway-hosted web build.
const capacitorBuild = process.env.CLAW2_APP_TARGET === "capacitor";

export default defineConfig({
  plugins: [react()],
  base: capacitorBuild ? "/" : "/pwa/",
  build: {
    outDir: "dist",
    manifest: true,
  },
  server: {
    port: 5174,
  },
  test: {
    alias: [
      // pdfjs v6's modern build breaks in Node (hash helper); tests run the
      // legacy build instead — the app itself keeps the modern one.
      { find: /^pdfjs-dist$/, replacement: "pdfjs-dist/legacy/build/pdf.mjs" },
    ],
  },
});
