// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Vitaliy Bondar

import { defineConfig } from "vitest/config";

/**
 * The only overrides are the wall-clock budgets. The gateway test files stand
 * up HTTP servers and SQLite databases in beforeEach, and the batch runs the
 * files in parallel workers: on a slow CI runner the default 10 s hook
 * timeout tripped three of them at once (run 45419588217, chat-rename-flags
 * and chat-terminal), with an unrelated titling test failing on top. The
 * tests themselves are fast; the budgets only absorb runner slowness.
 */
export default defineConfig({
  test: {
    hookTimeout: 30_000,
    testTimeout: 30_000,
  },
});
