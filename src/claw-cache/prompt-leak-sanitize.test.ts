// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Vitaliy Bondar

/**
 * Run: npx tsx src/claw-cache/prompt-leak-sanitize.test.ts
 */
import assert from "node:assert/strict";
import {
  sanitizeForChroniclePrompt,
  stripInternalPromptLeak,
} from "./prompt-leak-sanitize.js";

assert.equal(
  sanitizeForChroniclePrompt("<<<EXT>>>\nSource: webchat\n---\nhello\n<<</EXT>>>"),
  "hello"
);

const dump = `[User's HSS context] important to recall earlier conclusions:

[1] (importance=0.35, source=auto, sim=0.791) <<>> Source: webchat --- логи нужно смотреть
[2] (importance=0.35, source=auto, sim=0.738) Source: webchat --- Тогда поищи причины
[Recap] Резюме диалога:
Тест маскирования.
Действие: Ответить пользователю — он бросил идею.

Да, можно встроить ассистента в страницу — это как раз то, о чём мы говорили про Polar.`;

const cleaned = stripInternalPromptLeak(dump);
assert.ok(cleaned.includes("Polar"), cleaned);
assert.ok(!cleaned.includes("importance="), cleaned);
assert.ok(!cleaned.includes("Действие:"), cleaned);
assert.ok(!cleaned.includes("[Recap]"), cleaned);

assert.equal(
  stripInternalPromptLeak("Обычный ответ без мета."),
  "Обычный ответ без мета."
);

console.log("prompt-leak-sanitize.test.ts: ok");
