import type { CapacitorConfig } from "@capacitor/cli";

const config: CapacitorConfig = {
  appId: "app.claw2.mobile",
  appName: "Claw2",
  webDir: "dist",
  android: {
    // WebView origin is https://localhost: loopback secure context (getUserMedia OK),
    // allowed by the desktop gateway's CORS (resolveCorsAllowOrigin), and http(s)
    // server URLs both load with mixed content permitted for LAN gateways.
    allowMixedContent: true,
    // Android 15+: Capacitor insets the WebView below the status bar / around
    // cutouts instead of letting system indicators overlap the app header.
    adjustMarginsForEdgeToEdge: "auto",
  },
  plugins: {
    Keyboard: {
      // Android 15 (targetSdk 35) ignores windowSoftInputMode=adjustResize in
      // edge-to-edge mode: the keyboard would overlay the WebView and cover the
      // chat composer. Official @capacitor/keyboard workaround — it resizes the
      // WebView on ime() insets and accounts for adjustMarginsForEdgeToEdge
      // margins itself. No custom Java needed.
      resizeOnFullScreen: true,
    },
  },
};

export default config;
