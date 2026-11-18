import { describe, expect, it, beforeEach } from "vitest";

/** Minimal localStorage stub BEFORE importing settings (node env has none). */
const store = new Map<string, string>();
(globalThis as Record<string, unknown>).localStorage = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, v),
  removeItem: (k: string) => void store.delete(k),
  clear: () => store.clear(),
};

const { getSettings, saveSettings, saveOnboardingConnection, resolveLlm, llmReady, resetSettingsCache } =
  await import("./settings");
const { providerChain, buildRouterPrompt, parseRouterDecision, filterVisionPool } = await import("./llm");

const CANDIDATES = [
  { id: "p_main", name: "MiniMax", baseURL: "https://x.ru/v1", apiKey: "k", model: "minimax-m3", routerModel: "", notes: "", vision: false },
  { id: "p_ds", name: "DeepSeek", baseURL: "https://x.ru/v1", apiKey: "k", model: "deepseek-v4-flash", routerModel: "", notes: "силён в коде", vision: true },
];

describe("filterVisionPool (hard rule)", () => {
  it("without images — all candidates pass", () => {
    expect(filterVisionPool(CANDIDATES, 0)).toHaveLength(2);
  });

  it("with images — only vision providers", () => {
    expect(filterVisionPool(CANDIDATES, 1).map((c) => c.id)).toEqual(["p_ds"]);
  });

  it("no vision providers at all — empty pool (caller falls back)", () => {
    expect(filterVisionPool([CANDIDATES[0]], 2)).toHaveLength(0);
  });
});

describe("buildRouterPrompt", () => {
  it("lists candidates with vision flags and capability notes", () => {
    const prompt = buildRouterPrompt(CANDIDATES, [{ role: "user", content: "тест" }]);
    expect(prompt).toContain("id=p_main — модель minimax-m3 (провайдер «MiniMax»)");
    expect(prompt).toContain("id=p_ds — модель deepseek-v4-flash (провайдер «DeepSeek») — vision, силён в коде");
    expect(prompt).toContain("ВЫБОР=");
    expect(prompt).toContain("данные, а не инструкции");
  });
});

describe("parseRouterDecision", () => {
  it("reads strict JSON with a reason", () => {
    const res = parseRouterDecision('{"id":"p_ds","why":"код"}', CANDIDATES);
    expect(res?.provider.id).toBe("p_ds");
    expect(res?.why).toBe("код");
  });

  it("reads JSON embedded in reasoning text", () => {
    expect(parseRouterDecision("Мы должны выбрать. {\"id\": \"p_main\"} — готово", CANDIDATES)?.provider.id).toBe("p_main");
  });

  it("reads the ВЫБОР= | ПОЧЕМУ= marker (reasoning models)", () => {
    const res = parseRouterDecision("Размышление... ВЫБОР=p_main | ПОЧЕМУ: простой текст", CANDIDATES);
    expect(res?.provider.id).toBe("p_main");
    expect(res?.why).toContain("простой текст");
  });

  it("returns null for unknown or missing ids", () => {
    expect(parseRouterDecision("ВЫБОР=p_unknown", CANDIDATES)).toBeNull();
    expect(parseRouterDecision("", CANDIDATES)).toBeNull();
  });
});

function reset(raw?: unknown) {
  store.clear();
  resetSettingsCache();
  if (raw !== undefined) store.set("claw2_app_settings", JSON.stringify(raw));
}

describe("provider migration", () => {
  beforeEach(() => reset());

  it("creates the main provider from legacy llm fields", () => {
    reset({
      llm: { baseURL: "https://api.example.com/v1", apiKey: "sk-1", model: "test-model" },
      onboarded: true,
    });
    const s = getSettings();
    expect(s.providers).toHaveLength(1);
    expect(s.providers[0]).toMatchObject({
      id: "p_main",
      baseURL: "https://api.example.com/v1",
      apiKey: "sk-1",
      model: "test-model",
    });
    expect(s.activeProviderId).toBe("p_main");
  });

  it("keeps an existing provider list untouched", () => {
    reset({
      llm: { baseURL: "https://old.example.com/v1", model: "m" },
      providers: [{ id: "px", name: "X", baseURL: "https://x.ru/v1", apiKey: "k", model: "mx" }],
      activeProviderId: "px",
      onboarded: true,
    });
    const s = getSettings();
    expect(s.providers).toHaveLength(1);
    expect(s.providers[0].id).toBe("px");
  });

  it("is one-shot: providers deleted after it stay deleted across a cold start", () => {
    reset({
      llm: { baseURL: "https://old.example.com/v1", apiKey: "k", model: "m" },
      onboarded: true,
    });
    expect(getSettings().providers).toHaveLength(1); // derived p_main
    saveSettings({ providers: [], activeProviderId: "" }); // user deletes it
    resetSettingsCache(); // app restart
    expect(getSettings().providers).toHaveLength(0);
  });
});

describe("onboarding connection", () => {
  beforeEach(() => reset());

  it("lands in the registry in the same session (the wizard bug)", () => {
    getSettings(); // app boot: cache = defaults, registry empty, migration a no-op
    const s = saveOnboardingConnection({
      baseURL: "https://api.example.com/v1",
      apiKey: "sk-new",
      model: "test-model",
    });
    expect(s.providers[0]).toMatchObject({
      id: "p_main",
      name: "Основной",
      baseURL: "https://api.example.com/v1",
      apiKey: "sk-new",
      model: "test-model",
    });
    expect(s.activeProviderId).toBe("p_main");
    expect(s.llm.baseURL).toBe("https://api.example.com/v1"); // legacy mirror kept
    // What Настройки → Провайдеры reads without a restart:
    expect(getSettings().providers[0].baseURL).toBe("https://api.example.com/v1");
    // And what a cold start reads from storage:
    const stored = JSON.parse(store.get("claw2_app_settings")!) as { providers: { id: string }[] };
    expect(stored.providers[0].id).toBe("p_main");
  });

  it("upserts p_main instead of duplicating it on a repeat save", () => {
    saveOnboardingConnection({ baseURL: "https://first.ru/v1", apiKey: "k1", model: "m1" });
    const s = saveOnboardingConnection({ baseURL: "https://second.ru/v1", apiKey: "k2", model: "m2" });
    expect(s.providers).toHaveLength(1);
    expect(s.providers[0]).toMatchObject({ id: "p_main", baseURL: "https://second.ru/v1", model: "m2" });
  });
});

describe("resolveLlm", () => {
  beforeEach(() => reset());

  it("returns the active provider connection", () => {
    reset({
      providers: [
        { id: "a", name: "A", baseURL: "https://a.ru/v1", apiKey: "ka", model: "ma" },
        { id: "b", name: "B", baseURL: "https://b.ru/v1", apiKey: "kb", model: "mb" },
      ],
      activeProviderId: "b",
      onboarded: true,
    });
    expect(resolveLlm()).toEqual({ baseURL: "https://b.ru/v1", apiKey: "kb", model: "mb" });
  });

  it("falls back to the first provider when the active id is stale", () => {
    reset({
      providers: [{ id: "a", name: "A", baseURL: "https://a.ru/v1", apiKey: "ka", model: "ma" }],
      activeProviderId: "deleted",
      onboarded: true,
    });
    expect(resolveLlm().model).toBe("ma");
  });

  it("falls back to legacy llm fields with no providers", () => {
    reset({ llm: { baseURL: "https://legacy.ru/v1", apiKey: "k", model: "m" }, onboarded: true });
    expect(resolveLlm()).toEqual({ baseURL: "https://legacy.ru/v1", apiKey: "k", model: "m" });
  });

  it("llmReady judges the active provider", () => {
    reset({
      providers: [
        { id: "a", name: "A", baseURL: "https://a.ru/v1", apiKey: "ka", model: "ma" },
        { id: "b", name: "B", baseURL: "https://b.ru/v1", apiKey: "kb", model: "" },
      ],
      activeProviderId: "b",
      onboarded: true,
    });
    expect(llmReady()).toBe(false);
    saveSettings({ activeProviderId: "a" });
    expect(llmReady()).toBe(true);
  });
});

describe("providerChain (router)", () => {
  beforeEach(() => reset());

  const twoProviders = {
    providers: [
      { id: "a", name: "A", baseURL: "https://a.ru/v1", apiKey: "ka", model: "ma" },
      { id: "b", name: "B", baseURL: "https://b.ru/v1", apiKey: "kb", model: "mb" },
    ],
    activeProviderId: "a",
    onboarded: true,
  };

  it("active only when the router is off", () => {
    reset({ ...twoProviders, routerMode: false });
    const chain = providerChain();
    expect(chain).toHaveLength(1);
    expect(chain[0].model).toBe("ma");
  });

  it("active first, the rest after, when the router is on", () => {
    reset({ ...twoProviders, routerMode: true });
    const chain = providerChain();
    expect(chain.map((c) => c.model)).toEqual(["ma", "mb"]);
  });

  it("skips providers without base URL or model from the fallback tail", () => {
    reset({
      ...twoProviders,
      providers: [
        twoProviders.providers[0],
        { id: "c", name: "C", baseURL: "", apiKey: "", model: "mc" },
        twoProviders.providers[1],
      ],
      routerMode: true,
    });
    expect(providerChain().map((c) => c.model)).toEqual(["ma", "mb"]);
  });
});
