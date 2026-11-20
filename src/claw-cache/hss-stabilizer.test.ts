/**
 * Юнит-тесты стабилизатора HSS (пункт 3 аудита).
 * Run: npx tsx src/claw-cache/hss-stabilizer.test.ts
 */
import assert from "node:assert/strict";
import {
  splitHssContextChunks,
  resolveHssPromptMode,
  getHssEntropyDeltaStabilizeMin,
  getHssContextChunkSize,
  getHssContextChunkMinLen,
  evolveHssAndGetState,
  releaseHssSession,
  type HssState,
} from "./hss-stabilizer.js";
import type { Claw2Config } from "../config/types.js";
import type OpenAI from "openai";

const config = {
  orchestrator: {
    hssEntropyDeltaStabilizeMin: 0.0015,
    hssContextChunkSize: 400,
    hssContextChunkMinLen: 600,
    hssFieldOntology: { enabled: false },
  },
} as unknown as Claw2Config;

const LONG = "а".repeat(1200);
const LONG2 = "б".repeat(1200);

function test(name: string, fn: () => void | Promise<void>) {
  return Promise.resolve()
    .then(fn)
    .then(() => console.log(`ok - ${name}`))
    .catch((e: unknown) => {
      console.error(`FAILED - ${name}`);
      throw e;
    });
}

async function main() {
  await test("splitHssContextChunks: short text stays one chunk", () => {
    assert.deepEqual(splitHssContextChunks("hello world", 400), ["hello world"]);
    assert.deepEqual(splitHssContextChunks("", 400), [""]);
  });

  await test("splitHssContextChunks: splits long text into ceil(len/size) chunks", () => {
    const chunks = splitHssContextChunks(LONG, 400);
    assert.equal(chunks.length, 3);
    assert.ok(chunks.every((c) => c.length <= 400));
    assert.equal(chunks.join("").length, 1200);
  });

  await test("splitHssContextChunks: exact boundary has no empty tail", () => {
    assert.deepEqual(splitHssContextChunks("x".repeat(400), 400), ["x".repeat(400)]);
    assert.equal(splitHssContextChunks("y".repeat(801), 400).length, 3);
  });

  await test("splitHssContextChunks: different long texts give different chunks", () => {
    assert.notDeepEqual(splitHssContextChunks(LONG, 400), splitHssContextChunks(LONG2, 400));
  });

  await test("thresholds: default and config override", () => {
    assert.equal(getHssEntropyDeltaStabilizeMin({} as Claw2Config), 0.0015);
    assert.equal(getHssEntropyDeltaStabilizeMin(config), 0.0015);
    const custom = { orchestrator: { hssEntropyDeltaStabilizeMin: 0.5 } } as unknown as Claw2Config;
    assert.equal(getHssEntropyDeltaStabilizeMin(custom), 0.5);
    assert.equal(getHssContextChunkSize(config), 400);
    assert.equal(getHssContextChunkMinLen(config), 600);
    assert.equal(getHssContextChunkSize({} as Claw2Config), 400);
  });

  await test("prompt mode: calibration turn forces stable", () => {
    const state = { effectiveDelta: 0.9, calibrationTurn: true } as unknown as HssState;
    assert.equal(resolveHssPromptMode(state, config), "stable");
  });

  await test("prompt mode: high delta -> stabilize, low delta -> stable", () => {
    const high = { effectiveDelta: 0.9 } as unknown as HssState;
    const low = { effectiveDelta: 0.0001 } as unknown as HssState;
    assert.equal(resolveHssPromptMode(high, config), "stabilize");
    assert.equal(resolveHssPromptMode(low, config), "stable");
  });

  const SESSION = "unit-test-session";
  const runTurn = (
    text: string,
    o: { config?: Claw2Config; evolveOpts?: Record<string, unknown> } = {}
  ) => evolveHssAndGetState(SESSION, "default", text, o.config ?? config, o.evolveOpts ?? {});

  await test("evolve: first turn is calibration with zero effectiveDelta", async () => {
    releaseHssSession(SESSION);
    const state = await runTurn("Привет, как дела?");
    assert.ok(state, "evolve should return state");
    assert.equal(state!.calibrationTurn, true);
    assert.equal(state!.effectiveDelta, 0);
    assert.equal(state!.status, "STABLE");
  });

  await test("evolve: second turn gives finite bounded metrics", async () => {
    releaseHssSession(SESSION);
    await runTurn("Первый ход для калибровки.");
    const state = await runTurn("Второй ход, обычный связный ответ про погоду и планы на завтра.");
    assert.ok(state);
    assert.equal(state!.calibrationTurn, false); // поле всегда присутствует; true только на калибровочном ходе
    assert.ok(Number.isFinite(state!.entropy));
    assert.ok(Number.isFinite(state!.coherence));
    assert.ok(Number.isFinite(state!.effectiveDelta));
    assert.ok(state!.coherence > 0 && state!.coherence <= 1, "coherence is purity in (0,1]");
    assert.ok(["STABLE", "FRAGMENTED"].includes(state!.status));
  });

  await test("evolve: reproducible within stochastic jitter in fresh node", async () => {
    releaseHssSession(SESSION);
    const run1: number[] = [];
    for (const t of ["текст один", "текст два", "текст три"]) {
      const s = await evolveHssAndGetState(SESSION, "default", t, config, {});
      run1.push(s!.effectiveDelta ?? 0);
    }
    releaseHssSession(SESSION);
    const run2: number[] = [];
    for (const t of ["текст один", "текст два", "текст три"]) {
      const s = await evolveHssAndGetState(SESSION, "default", t, config, {});
      run2.push(s!.effectiveDelta ?? 0);
    }
    // Ядро HSS полностью детерминировано: шум сидирован (mulberry32), джиттер
    // диагонали ξ больше не Math.random (hss.cjs, generateInnerXi) — сравнение
    // бит-в-бит.
    for (let i = 0; i < run1.length; i++) {
      assert.equal(run1[i], run2[i], `turn ${i}: ${run1[i]} vs ${run2[i]}`);
    }
  });

  await test("evolve: state reacts to text, not only to turn count", async () => {
    // Реактивность на текст входит через contextEmbedding: при включённой
    // field-онтологии эмбеддинг строит стабилизатор из LLM-клиента. Здесь это
    // детерминированный stub — разный текст → разный эмбеддинг → другой
    // гамильтониан (buildHamiltonianFromEmbedding) → другие метрики.
    const configField = {
      orchestrator: {
        hssEntropyDeltaStabilizeMin: 0.0015,
        hssContextChunkSize: 400,
        hssContextChunkMinLen: 600,
        hssFieldOntology: { enabled: true },
      },
      memory: { embeddingProvider: "http", embeddingModel: "test-embed" },
    } as unknown as Claw2Config;
    const fakeLlm = {
      embeddings: {
        async create({ input }: { input?: string }) {
          const len = input?.length ?? 0;
          const v = new Array(8).fill(0).map((_, i) => ((len + i * 7) % 13) / 13);
          return { data: [{ embedding: v }] };
        },
      },
    } as unknown as OpenAI;
    releaseHssSession(SESSION);
    await runTurn("Калибровка.", { config: configField });
    const s1 = await runTurn("Ответ про квантовую физику и запутанность частиц.", {
      config: configField,
      evolveOpts: { llmClient: fakeLlm },
    });
    releaseHssSession(SESSION);
    await runTurn("Калибровка.", { config: configField });
    const s2 = await runTurn("Ответ про приготовление борща и молодую свёклу.", {
      config: configField,
      evolveOpts: { llmClient: fakeLlm },
    });
    assert.ok(s1 && s2);
    const identical =
      s1.entropy === s2.entropy &&
      s1.coherence === s2.coherence &&
      s1.entropyDelta === s2.entropyDelta;
    assert.equal(identical, false, "state should differ for different texts");
  });

  await test("evolve: releaseHssSession forces fresh calibration", async () => {
    await runTurn("какой-то ход");
    await runTurn("ещё ход");
    releaseHssSession(SESSION);
    const state = await runTurn("новый ход после релиза");
    assert.equal(state!.calibrationTurn, true);
    releaseHssSession(SESSION);
  });

  console.log("hss-stabilizer.test.ts: ok");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
