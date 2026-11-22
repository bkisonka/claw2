// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Vitaliy Bondar

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { isPlaceholderChatTitle, resolveListTitle } from "./chatList";

describe("chat list title placeholders", () => {
  it("treats the localized New-chat placeholder and blanks as untitled", () => {
    assert.equal(isPlaceholderChatTitle("Новый чат"), true);
    assert.equal(isPlaceholderChatTitle("New chat"), true);
    assert.equal(isPlaceholderChatTitle("   "), true);
    assert.equal(isPlaceholderChatTitle(""), true);
    assert.equal(isPlaceholderChatTitle(undefined), true);
    assert.equal(isPlaceholderChatTitle("Санкции: обзор"), false);
  });

  it("lets the derived title replace a placeholder but never a real one", () => {
    assert.equal(resolveListTitle("Новый чат", "Санкции: обзор"), "Санкции: обзор");
    assert.equal(resolveListTitle("", "Санкции: обзор"), "Санкции: обзор");
    assert.equal(resolveListTitle("Моё название", "Санкции: обзор"), "Моё название");
    // A placeholder arrival must not clobber a real title or a placeholder.
    assert.equal(resolveListTitle("Моё название", "Новый чат"), "Моё название");
    assert.equal(resolveListTitle("Новый чат", "New chat"), "Новый чат");
  });
});
