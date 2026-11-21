// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Vitaliy Bondar

/**
 * Run: npx tsx src/config/container-net.test.ts
 *
 * Container loopback mapping: URL rewriting rules, the container detection
 * flag, and the end-to-end loadConfig integration (operator writes
 * 127.0.0.1 — the gateway in a container uses host.docker.internal while
 * the stored YAML keeps the portable form).
 */
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  mapLoopbackToHostGateway,
  normalizeContainerServiceUrls,
  __setInContainerForTest,
} from "./container-net.js";
import { loadConfig } from "./load.js";

// 1. URL mapping rules.
{
  assert.equal(mapLoopbackToHostGateway("http://127.0.0.1:7330/v1"), "http://host.docker.internal:7330/v1");
  assert.equal(mapLoopbackToHostGateway("http://localhost:11434"), "http://host.docker.internal:11434/");
  assert.equal(mapLoopbackToHostGateway("http://[::1]:8000/api"), "http://host.docker.internal:8000/api");
  assert.equal(mapLoopbackToHostGateway("https://api.openai.com/v1"), null, "public host untouched");
  assert.equal(mapLoopbackToHostGateway("http://claw2-egress-sidecar:3128"), null, "docker service name untouched");
  assert.equal(mapLoopbackToHostGateway("not a url"), null);
  assert.equal(mapLoopbackToHostGateway(""), null);
  assert.equal(mapLoopbackToHostGateway("http://0.0.0.0:8080/"), "http://host.docker.internal:8080/");
}

// 2. normalizeContainerServiceUrls: user-facing fields rewritten, others untouched.
{
  __setInContainerForTest(true);
  const config = {
    llm: { baseURL: "http://127.0.0.1:7330/v1" },
    memory: {
      chroma: { url: "http://localhost:8000" },
      embeddingBaseURL: "http://127.0.0.1:4872/v1", // would be rewritten IF user-set;
    },
    tools: { sdUrl: "http://127.0.0.1:7860", searxng: { url: "http://localhost:8080" } },
    voice: { sttUrl: "http://localhost:9000/stt" },
  } as never;
  const changed = normalizeContainerServiceUrls(config);
  assert.equal(changed, 6, `expected 6 rewrites, got ${changed}`);
  assert.equal((config as never as { llm: { baseURL: string } }).llm.baseURL, "http://host.docker.internal:7330/v1");
  assert.equal(
    (config as never as { memory: { chroma: { url: string } } }).memory.chroma.url,
    "http://host.docker.internal:8000/"
  );
  __setInContainerForTest(false);
}

// 3. Not in container: normalize is a no-op (desktop keeps 127.0.0.1 working).
{
  __setInContainerForTest(false);
  const config = { llm: { baseURL: "http://127.0.0.1:7330/v1" } } as never;
  assert.equal(normalizeContainerServiceUrls(config), 0);
  assert.equal((config as never as { llm: { baseURL: string } }).llm.baseURL, "http://127.0.0.1:7330/v1");
}

// 4. End-to-end through loadConfig: written YAML keeps the portable form,
//    the loaded (effective) config gets the container-correct one.
{
  __setInContainerForTest(true);
  const dir = mkdtempSync(join(tmpdir(), "claw2-container-net-"));
  const path = join(dir, "claw2.yaml");
  writeFileSync(
    path,
    "llm:\n  provider: openai\n  model: m\n  baseURL: http://127.0.0.1:7330/v1\n"
  );
  const config = loadConfig(path);
  assert.equal(
    config.llm.baseURL,
    "http://host.docker.internal:7330/v1",
    "loadConfig must map loopback in container"
  );
  // The stored file is untouched:
  assert.match(
    (await import("node:fs")).readFileSync(path, "utf-8"),
    /127\.0\.0\.1:7330/,
    "stored YAML must keep the operator's portable form"
  );
  rmSync(dir, { recursive: true, force: true });
  __setInContainerForTest(false);
}

console.log("container-net.test.ts: ok");
