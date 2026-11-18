/**
 * Unit checks for session → .claw-cache export helpers.
 * Run: npx tsx src/claw-cache/session-export.test.ts
 */
import assert from "node:assert/strict";
import {
  sanitizeCacheId,
  unwrapExtContent,
  extractTriggersFromMessages,
  buildSessionClawCachePackInput,
  exportSessionToClawCacheBuffer,
} from "./session-export.js";

// sanitizeCacheId: ASCII only; fallback is also sanitized
assert.equal(sanitizeCacheId("ok_cache-1"), "ok_cache-1");
assert.equal(sanitizeCacheId("@@@", "My Cache 01"), "My-Cache-01");
assert.match(sanitizeCacheId("Привет мир!"), /^export-\d+$/);
assert.match(sanitizeCacheId("!!!", "кириллица"), /^export-\d+$/);

// unwrapExtContent
assert.equal(unwrapExtContent("plain"), "plain");
assert.equal(
  unwrapExtContent("<<<EXT>>> Source: x ---\nhello world\n<<</EXT>>>"),
  "hello world"
);

// "?" looks at the unfolded body, not at the EXT wrapper
{
  const triggers = extractTriggersFromMessages([
    { role: "user", content: "Первый пользовательский вопрос достаточно длинный?" },
    { role: "user", content: "Второй пользовательский вопрос тоже длинный текст?" },
    { role: "user", content: "Третий пользовательский вопрос для закрытия первого прохода?" },
    {
      role: "assistant",
      // "?" only in EXT metadata, not in the body → the first pass does not take
      content: "<<<EXT>>> Source: tool? ---\nNo question in unwrapped body here xx\n<<</EXT>>>",
    },
    {
      role: "assistant",
      content: "<<<EXT>>> Source: tool ---\nIs this a question in body?\n<<</EXT>>>",
    },
  ]);
  const phrases = triggers.phrases ?? [];
  assert.ok(phrases.some((p) => /question in body/i.test(p)), "unwrapped ? should match");
  // three user phrases close the first pass (MAX ≥3 is needed) - a phrase without "?" does not enter the body
  assert.ok(
    !phrases.some((p) => /No question in unwrapped/i.test(p)),
    "EXT metadata ? must not select phrase in first pass"
  );
}

{
  const pack = buildSessionClawCachePackInput({
    messages: [
      { role: "user", content: "Первый вопрос пользователя про тему?" },
      { role: "assistant", content: "Ответ ассистента с деталями." },
    ],
    sessionId: "sess_привет",
    cacheId: "@@@",
  });
  const id = pack.manifest?.cache_id ?? "";
  assert.match(id, /^[a-zA-Z0-9._-]+$/);
  assert.ok(!/[^\x00-\x7F]/.test(id));
  assert.equal(pack.dialogueJsonl?.split("\n").filter(Boolean).length, 2);
}

{
  await assert.rejects(
    () =>
      exportSessionToClawCacheBuffer({
        messages: [{ role: "user", content: "только одно сообщение" }],
      }),
    /at least 2/i
  );
}

{
  const { buffer, cacheId, turnCount, filename } = await exportSessionToClawCacheBuffer({
    messages: [
      { role: "user", content: "Расскажи про активационный кэш подробнее пожалуйста" },
      { role: "assistant", content: "Активационный кэш — это warmup из диалога сильной модели." },
    ],
    cacheId: "my-export-01",
  });
  assert.equal(cacheId, "my-export-01");
  assert.equal(turnCount, 2);
  assert.equal(filename, "my-export-01.claw-cache");
  assert.ok(buffer.length > 50);
}

console.log("session-export.test.ts: ok");
