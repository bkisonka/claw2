const envUrl = typeof import.meta.env.VITE_API_URL === "string" ? import.meta.env.VITE_API_URL.trim() : "";
const base = envUrl ? envUrl.replace(/\/$/, "") : "";

export const apiBase = base;

/**
 * Gateway API key for personal (key-auth) deployments. Sources, in order:
 *  - build time: VITE_API_KEY (baked into the bundle);
 *  - runtime: localStorage — the first-visit key prompt (GatewayKeyGate)
 *    stores it there; evaluated again on the reload that follows.
 * Hosted multi-user deployments do not use an API key (JWT instead).
 */
const KEY_STORAGE = "claw2_gateway_key";
const buildKey = typeof import.meta.env.VITE_API_KEY === "string" ? import.meta.env.VITE_API_KEY.trim() : "";
export const apiKey =
  buildKey ||
  (typeof localStorage !== "undefined" ? localStorage.getItem(KEY_STORAGE)?.trim() || "" : "") ||
  undefined;

/** Store the key entered at first visit; takes effect after a reload. */
export function setGatewayKey(key: string): void {
  localStorage.setItem(KEY_STORAGE, key.trim());
}
