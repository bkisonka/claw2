// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Vitaliy Bondar

/**
 * Run: npx tsx src/security/origin.test.ts
 *
 * Out-of-band provenance: per-session taint ledger — mark/has/release,
 * persistence across compaction-style context changes, and the trifecta
 * init contract (ledger OR in-band marker scan).
 */
import assert from "node:assert/strict";
import {
  markUntrustedOrigin,
  hasUntrustedOrigin,
  releaseProvenance,
  resetProvenanceForTest,
  initTrifectaState,
} from "./origin.js";
import { hasUntrustedInText } from "./lethal-trifecta.js";
import { appendToSession, getSessionHistory } from "../gateway/sessions.js";

resetProvenanceForTest();

// 1. Basic mark/has/release lifecycle.
{
  markUntrustedOrigin("s1", { source: "web", untrusted: true });
  assert.equal(hasUntrustedOrigin("s1"), true);
  releaseProvenance("s1");
  assert.equal(hasUntrustedOrigin("s1"), false, "release must clear the ledger");
}

// 2. Ledger survives compaction-style context changes: nothing resets it
//    except an explicit release (the summary replacing history keeps taint).
{
  markUntrustedOrigin("s2");
  // ...history is compacted, summary written — no provenance API involved:
  assert.equal(hasUntrustedOrigin("s2"), true, "compaction must not clear taint");
}

// 3. Empty/undefined session ids are ignored (CLI turns without sessions).
{
  markUntrustedOrigin("");
  assert.equal(hasUntrustedOrigin(""), false);
}

// 3b. A trusted-origin tag must NOT taint (ledger records untrusted only).
{
  markUntrustedOrigin("s-trusted", { source: "user", untrusted: false });
  assert.equal(hasUntrustedOrigin("s-trusted"), false, "trusted tag must not taint");
  markUntrustedOrigin("s-trusted2", { source: "web", untrusted: true });
  assert.equal(hasUntrustedOrigin("s-trusted2"), true, "untrusted tag taints");
  releaseProvenance("s-trusted2");
}

// 4. initTrifectaState: ledger OR marker scan — either arms the trifecta.
{
  resetProvenanceForTest();
  const scan = (t: string) => hasUntrustedInText(t);

  // clean ledger + clean text → clean
  assert.deepEqual(initTrifectaState("s3", "hello", scan), {
    dataAccess: false,
    untrustedContent: false,
  });
  // marker in text without ledger (backstop) → armed
  assert.equal(initTrifectaState("s3", "quote: <<<EXT>>>x<<</EXT>>>", scan).untrustedContent, true);
  // tainted ledger + clean text → armed (provenance survives the turn gap)
  markUntrustedOrigin("s3");
  assert.equal(initTrifectaState("s3", "totally fresh user question", scan).untrustedContent, true);
  // no session id (CLI): scan only
  assert.equal(initTrifectaState(undefined, "plain", scan).untrustedContent, false);
  releaseProvenance("s3");
}

// 5. Message-level origin rides in session history; assistant inherits the
//    ledger state at append time (strictest-label rule).
{
  resetProvenanceForTest();
  const sid = "s-origin-msg";
  appendToSession(sid, "user", "look at this page", { source: "browser-page", untrusted: true });
  markUntrustedOrigin(sid);
  appendToSession(
    sid,
    "assistant",
    "the page says…",
    hasUntrustedOrigin(sid) ? { source: "derived", untrusted: true } : undefined
  );
  const [u, a] = getSessionHistory(sid);
  assert.equal(u.origin?.untrusted, true);
  assert.equal(a.origin?.untrusted, true, "assistant reply must inherit untrusted origin");
  // trusted flow: no marks, no tags
  const sid2 = "s-clean-msg";
  appendToSession(sid2, "user", "hello");
  appendToSession(sid2, "assistant", "hi there");
  const [u2, a2] = getSessionHistory(sid2);
  assert.equal(u2.origin, undefined);
  assert.equal(a2.origin, undefined);
  releaseProvenance(sid);
  releaseProvenance(sid2);
}

console.log("origin.test.ts: ok");
