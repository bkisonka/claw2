// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Vitaliy Bondar

import assert from "node:assert/strict";
import { deriveChatTitleFromRequest } from "./chat-title.js";

{
  const t = deriveChatTitleFromRequest("Что раскопать по санкциям сегодня?");
  assert.equal(t, "Что раскопать по санкциям сегодня?");
}

{
  const t = deriveChatTitleFromRequest(
    "Первая мысль. А вот второе предложение уже не должно попасть в заголовок."
  );
  assert.equal(t, "Первая мысль.");
}

{
  const long =
    "Очень длинная первая фраза без точки которая должна быть аккуратно обрезана по границе слова чтобы уместиться в лимит заголовка чата и не выглядеть обрубком";
  const t = deriveChatTitleFromRequest(long);
  assert.ok(t.endsWith("…"));
  assert.ok(t.length <= 56);
  assert.ok(!t.includes("обрубком"));
}

{
  assert.equal(deriveChatTitleFromRequest("   "), "Chat");
  assert.equal(deriveChatTitleFromRequest("See attached files."), "Chat");
}

console.log("chat-title.test.ts: ok");
