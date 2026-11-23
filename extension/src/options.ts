// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Vitaliy Bondar

const gatewayInput = document.getElementById("gateway") as HTMLInputElement;
const apikeyInput = document.getElementById("apikey") as HTMLInputElement;
const statusEl = document.getElementById("status") as HTMLDivElement;

async function load(): Promise<void> {
  const stored = await chrome.storage.local.get(["gatewayUrl", "apiKey"]);
  gatewayInput.value = String(stored.gatewayUrl ?? "http://127.0.0.1:8080");
  apikeyInput.value = String(stored.apiKey ?? "");
}

document.getElementById("save")?.addEventListener("click", () => {
  void (async () => {
    await chrome.storage.local.set({
      gatewayUrl: gatewayInput.value.replace(/\/+$/, ""),
      apiKey: apikeyInput.value.trim(),
    });
    statusEl.className = "ok";
    statusEl.textContent = "Saved.";
  })();
});

document.getElementById("test")?.addEventListener("click", () => {
  void (async () => {
    const base = gatewayInput.value.replace(/\/+$/, "");
    const key = apikeyInput.value.trim();
    statusEl.className = "";
    statusEl.textContent = "…";
    try {
      // /health answers plain "ok" unless JSON is requested explicitly.
      const res = await fetch(`${base}/health`, {
        headers: { "X-API-Key": key, Accept: "application/json" },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const text = await res.text();
      try {
        const data = JSON.parse(text) as { ok?: boolean };
        if (data.ok === false) throw new Error("gateway answered, but not ok");
      } catch (parseErr) {
        if (parseErr instanceof Error && parseErr.message.startsWith("gateway answered")) throw parseErr;
        if (text.trim() !== "ok") throw new Error("unexpected health answer");
      }
      statusEl.className = "ok";
      statusEl.textContent = "Connected.";
    } catch (err) {
      statusEl.className = "err";
      statusEl.textContent = `Failed: ${err instanceof Error ? err.message : String(err)}`;
    }
  })();
});

void load();
