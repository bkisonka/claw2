// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Vitaliy Bondar

import { Capacitor, CapacitorHttp } from "@capacitor/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { embedTexts } from "./llm";
import { resetSettingsCache, saveSettings, type ProviderConfig } from "./settings";

vi.mock("@capacitor/core", () => ({
  Capacitor: { isNativePlatform: vi.fn() },
  CapacitorHttp: { request: vi.fn() },
}));

const active: ProviderConfig = {
  id: "active",
  name: "Active",
  baseURL: " chat.example.test/v1/ ",
  apiKey: " active-key ",
  model: "chat-model",
  routerModel: "",
  notes: "",
  vision: false,
};
const inactive = { ...active, id: "inactive", baseURL: "https://inactive.example.test/v1", apiKey: "inactive-key" };
const legacy = { baseURL: "https://legacy.example.test/v1", apiKey: "legacy-key", model: "legacy-model" };
const activeBase = "https://chat.example.test/v1";
const separateBase = "https://embed.example.test/v1";
const response = JSON.stringify({ data: [{ embedding: [0.2, 0.4] }] });

const fetchMock = vi.fn<typeof fetch>();
const isNativeMock = vi.mocked(Capacitor.isNativePlatform);
const nativeRequest = vi.mocked(CapacitorHttp.request);

beforeEach(() => {
  vi.stubGlobal("localStorage", { getItem: () => null, setItem: () => {} });
  vi.stubGlobal("fetch", fetchMock.mockReset());
  nativeRequest.mockReset();
  resetSettingsCache();
  saveSettings({ llm: legacy, providers: [inactive, active], activeProviderId: active.id });
});

afterEach(() => {
  resetSettingsCache();
  vi.unstubAllGlobals();
});

describe.each(["fetch", "native fallback"] as const)("embedTexts via %s", (transport) => {
  beforeEach(() => {
    const native = transport === "native fallback";
    isNativeMock.mockReturnValue(native);
    if (native) {
      fetchMock.mockRejectedValue(new TypeError("WebView fetch failed"));
    } else {
      fetchMock.mockResolvedValue(new Response(response));
    }
  });

  async function expectEmbeddingRequest(base: string, key?: string, model = "text-embedding-3-small") {
    const url = `${base}/embeddings`;
    const body = { model, input: ["test input"] };
    const headers = key
      ? { "Content-Type": "application/json", Authorization: `Bearer ${key}` }
      : { "Content-Type": "application/json" };
    nativeRequest.mockResolvedValue({ url, status: 200, headers: {}, data: response });

    expect(await embedTexts(body.input)).toEqual([[0.2, 0.4]]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(url, { method: "POST", headers, body: JSON.stringify(body) });
    if (transport === "native fallback") {
      expect(nativeRequest).toHaveBeenCalledTimes(1);
      expect(nativeRequest).toHaveBeenCalledWith(
        expect.objectContaining({ url, method: "POST", headers, data: body }),
      );
    } else {
      expect(nativeRequest).not.toHaveBeenCalled();
    }
  }

  it("defaults to the active provider URL and key, not the legacy or first provider", async () => {
    saveSettings({ memory: { embeddingBaseURL: "  ", embeddingApiKey: "  ", embeddingModel: "" } });
    await expectEmbeddingRequest(activeBase, "active-key");
  });

  it("prefers a dedicated embedding key even when the base URL is implicit", async () => {
    saveSettings({ memory: { embeddingApiKey: " embedding-key ", embeddingModel: "custom-embedding" } });
    await expectEmbeddingRequest(activeBase, "embedding-key", "custom-embedding");
  });

  it("falls back to the legacy connection when no provider is saved", async () => {
    saveSettings({ providers: [] });
    await expectEmbeddingRequest(legacy.baseURL, legacy.apiKey);
  });

  it("keeps the Ollama placeholder for a keyless implicit provider", async () => {
    saveSettings({ providers: [inactive, { ...active, apiKey: "" }] });
    await expectEmbeddingRequest(activeBase, "ollama");
  });

  it("sends only the dedicated key to a separately configured endpoint", async () => {
    saveSettings({ memory: { embeddingBaseURL: ` ${separateBase}/ `, embeddingApiKey: " embedding-key " } });
    await expectEmbeddingRequest(separateBase, "embedding-key");
  });

  it.each([separateBase, legacy.baseURL, "https://chat.example.test/other/v1", activeBase])(
    "omits Authorization when %s is explicitly configured without a key",
    async (base) => {
      saveSettings({ memory: { embeddingBaseURL: base, embeddingApiKey: "  " } });
      await expectEmbeddingRequest(base);
    },
  );
});
