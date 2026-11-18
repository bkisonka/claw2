/** Mirror of src/config/llm-ready isLikelyLocalLlmEndpoint for UI status. */
export function isLikelyLocalBaseUrl(baseURL: string): boolean {
  if (!baseURL?.trim()) return false;
  try {
    const u = new URL(baseURL.includes("://") ? baseURL : `http://${baseURL}`);
    const host = u.hostname;
    if (host !== "127.0.0.1" && host !== "localhost" && host !== "::1") return false;
    const port = u.port || (u.protocol === "https:" ? "443" : "80");
    return ["11434", "1234", "8080", "8000", "5000", "3000", "443", "80"].includes(port);
  } catch {
    return /127\.0\.0\.1|localhost/i.test(baseURL);
  }
}
