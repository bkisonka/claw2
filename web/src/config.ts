const envUrl = typeof import.meta.env.VITE_API_URL === "string" ? import.meta.env.VITE_API_URL.trim() : "";
const base = envUrl ? envUrl.replace(/\/$/, "") : "";

export const apiBase = base;
export const apiKey = typeof import.meta.env.VITE_API_KEY === "string" ? import.meta.env.VITE_API_KEY : undefined;
