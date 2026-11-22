// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Vitaliy Bondar

/**
 * User config policy: registered users may only personalize their agent;
 * security/infra keys are stripped (default-deny).
 *
 * Run: npx tsx src/config/user-config-policy.test.ts
 */
import assert from "node:assert/strict";
import { applyUserConfigPolicy, USER_CONFIG_ALLOWED_KEYS } from "./user-config-policy.js";

{
  const personal = {
    llm: { model: "gpt-4o-mini", apiKey: "sk-user" },
    assistant: { personaMarkdown: "## full\nFriendly." },
    voice: { ttsEngine: "xtts" },
    insights: { mode: "auto" },
    // Security-critical keys a user must not override:
    sandbox: { useDocker: false, hostFs: { mode: "full" } },
    allowlist: { paths: ["/"] },
    skills: { allowlist: ["evil.js"] },
    agentsDir: "/",
    workspace: "/",
    uploads: { hostPath: "/" },
    gateway: { auth: { enabled: false } },
    channels: { telegram: { enabled: true, botToken: "x" } },
    vision: { superuserIds: ["*"] },
    security: { lethalTrifecta: { enabled: false } },
    privacy: {},
    audit: { logPath: "/dev/null" },
    remoteAccess: { accessToken: "x" },
    memory: { sqlitePath: "/tmp/evil.sqlite" },
    tools: {},
  };
  const filtered = applyUserConfigPolicy(personal) as Record<string, unknown>;
  assert.deepEqual(Object.keys(filtered).sort(), ["assistant", "insights", "llm", "voice"]);
  assert.deepEqual((filtered.llm as Record<string, unknown>).model, "gpt-4o-mini");
  assert.equal("sandbox" in filtered, false);
  assert.equal("allowlist" in filtered, false);
  assert.equal("memory" in filtered, false);
}

{
  assert.equal(applyUserConfigPolicy(null), null);
  assert.equal(applyUserConfigPolicy(undefined), null);
  assert.equal(applyUserConfigPolicy([] as unknown as Record<string, unknown>), null);
  assert.deepEqual(applyUserConfigPolicy({}), {});
}

{
  // The allowlist is the contract: every allowed key passes through untouched.
  for (const key of ["llm", "assistant", "voice", "insights"]) {
    assert.ok(USER_CONFIG_ALLOWED_KEYS.includes(key));
  }
}

console.log("user-config-policy.test.ts: ok");
