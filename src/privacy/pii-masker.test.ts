/**
 * Run: npx tsx src/privacy/pii-masker.test.ts
 */
import assert from "node:assert/strict";
import { PiiMasker, maskChatMessages } from "./pii-masker.js";
import { isValidInn, isValidSnils } from "./validators.js";
import { shouldApplyPrivacy } from "./should-apply.js";
import type { Claw2Config } from "../config/types.js";

{
  assert.equal(isValidInn("7707083893"), true);
  assert.equal(isValidInn("1234567890"), false);
  assert.equal(isValidSnils("112-233-445 95"), true);
}

{
  const masker = new PiiMasker();
  const src = "Пиши на test@example.com и звони +7 (999) 123-45-67";
  const masked = masker.maskText(src);
  assert.match(masked, /\[PII_EMAIL_1\]/);
  assert.match(masked, /\[PII_PHONE_1\]/);
  assert.equal(masker.unmaskText(masked), src);
  masker.clear();
  assert.equal(masker.tokenCount, 0);
}

{
  const masker = new PiiMasker([
    {
      id: "r1",
      name: "codename",
      ruleType: "keyword",
      pattern: "ProjectPhoenix",
      caseSensitive: true,
      enabled: true,
    },
  ]);
  const src = "Discuss ProjectPhoenix tomorrow";
  const masked = masker.maskText(src);
  assert.match(masked, /\[PII_USER_CODENAME_1\]/);
  assert.equal(masker.unmaskText(masked), src);
}

{
  const masker = new PiiMasker();
  const messages = maskChatMessages(
    [
      { role: "system", content: "You are helpful." },
      { role: "user", content: "My mail is a@b.co" },
    ],
    masker
  );
  assert.equal(messages[0]?.role, "system");
  assert.match(String((messages[1] as { content: string }).content), /\[PII_EMAIL_1\]/);
}

{
  const remote: Claw2Config = {
    llm: { provider: "openai", model: "gpt", baseURL: "https://api.openai.com/v1", apiKey: "x" },
    privacy: { enabled: true },
  };
  assert.equal(shouldApplyPrivacy(remote).apply, true);

  const local: Claw2Config = {
    llm: { provider: "openai", model: "gpt", baseURL: "http://127.0.0.1:11434/v1" },
    privacy: { enabled: true },
  };
  assert.equal(shouldApplyPrivacy(local).apply, false);
  assert.equal(shouldApplyPrivacy({ ...local, privacy: { enabled: true, applyToLocal: true } }).apply, true);

  const off: Claw2Config = {
    llm: { provider: "openai", model: "gpt", baseURL: "https://api.openai.com/v1", apiKey: "x" },
    privacy: { enabled: false },
  };
  assert.equal(shouldApplyPrivacy(off).apply, false);
}

console.log("privacy/pii-masker.test.ts: ok");
