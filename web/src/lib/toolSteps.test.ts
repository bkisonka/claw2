// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Vitaliy Bondar

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ToolStep } from "../api/chat";
import { formatStepDuration, isStepRunning, stepMark, stepsTicker, tickerDuration, toolStepSubject, toolStepTitle, totalStepDuration, upsertToolStep } from "./toolSteps";

describe("tool steps (web step list)", () => {
  it("upsertToolStep adds a new step and completes the one with the same seq", () => {
    const start: ToolStep = { type: "start", seq: 0, name: "read", args: '{"path":"a.txt"}' };
    const second: ToolStep = { type: "start", seq: 1, name: "search", args: '{"query":"x"}' };
    const steps = upsertToolStep([], start);
    assert.deepEqual(steps, [start]);

    const withSecond = upsertToolStep(steps, second);
    assert.equal(withSecond.length, 2);

    const done = upsertToolStep(withSecond, { type: "end", seq: 0, name: "read", args: '{"path":"a.txt"}', ok: true, durationMs: 7 });
    assert.deepEqual(done[0], { type: "end", seq: 0, name: "read", args: '{"path":"a.txt"}', ok: true, durationMs: 7 });
    assert.equal(done[1], second);
    // The inputs are not modified.
    assert.equal(steps[0], start);
    assert.equal(isStepRunning(done[0]!), false);
    assert.equal(isStepRunning(done[1]!), true);
    // History steps carry no seq: each one is its own entry.
    const history: ToolStep = { name: "read", args: "{}", ok: true, durationMs: 1 };
    assert.equal(upsertToolStep(done, history).length, 3);
  });

  it("toolStepSubject picks the argument that says what the call is about", () => {
    const subject = (args: unknown) => toolStepSubject({ name: "x", args: JSON.stringify(args) });
    assert.equal(subject({ script: "chart.js", args: [] }), "chart.js");
    assert.equal(subject({ path: "output/report.csv", offset: 3, limit: 50 }), "output/report.csv");
    assert.equal(subject({ query: "claw2 agent loop" }), "claw2 agent loop");
    assert.equal(subject({ url: "https://example.test/a?b=1" }), "https://example.test/a?b=1");
    assert.equal(subject({ id: "OPENAI_API_KEY" }), "OPENAI_API_KEY");
    assert.equal(subject({ webhookUrl: "https://hook.test/x", body: "private message" }), "https://hook.test/x");
    assert.equal(subject({ text: "Buy milk" }), "Buy milk");
    assert.equal(subject({ text: "x".repeat(500), importance: "high" }), "high");
    assert.equal(subject({ items: [{ label: "a" }], title: "" }), "");
    // Numbers alone (offset, limit) do not say what a call is about.
    assert.equal(subject({ limit: 10 }), "");
    // Unreadable or missing arguments degrade gracefully.
    assert.equal(toolStepSubject({ name: "x", args: "" }), "");
    assert.equal(toolStepSubject({ name: "x", args: "{not json" }), "{not json");
    assert.equal(toolStepSubject({ name: "x", args: '"plain"' }), "plain");
    assert.equal(toolStepSubject({ name: "x", args: "42" }), "42");
    // Long values and line breaks are folded into one short line.
    assert.equal(toolStepSubject({ name: "x", args: JSON.stringify({ query: "a\n  b   c" }) }), "a b c");
    const long = toolStepSubject({ name: "x", args: JSON.stringify({ path: `output/${"very-long-name-".repeat(20)}.csv` }) });
    assert.equal(long.length, 72);
    assert.ok(long.endsWith("…"));
  });

  it("toolStepTitle is the tool with its subject", () => {
    assert.equal(toolStepTitle({ name: "web_fetch", args: '{"url":"https://x.test/"}' }), "web_fetch https://x.test/");
    assert.equal(toolStepTitle({ name: "sidebar_get", args: "{}" }), "sidebar_get");
  });

  it("stepsTicker joins the nearest steps into one line, newest last", () => {
    const steps = [
      { type: "end" as const, seq: 0, name: "run_agent", args: '{"script":"download-file.js"}', ok: true, durationMs: 924 },
      { type: "end" as const, seq: 1, name: "read", args: '{"path":"agents/output/a.ts"}', ok: true, durationMs: 4 },
      { type: "end" as const, seq: 2, name: "read", args: '{"path":"agents/output/b.ts"}', ok: false, durationMs: 1200 },
      { type: "start" as const, seq: 3, name: "search", args: '{"query":"claw2"}' },
    ];
    assert.equal(
      stepsTicker(steps),
      "run_agent download-file.js ✓924 ms → read agents/output/a.ts ✓4 ms → read agents/output/b.ts ✕1.2 s → search claw2 …"
    );
    // Only the nearest steps: the ticker stays short on a long turn.
    assert.equal(stepsTicker(steps, 2), "read agents/output/b.ts ✕1.2 s → search claw2 …");
    // A step cut short carries no duration, only its mark.
    assert.equal(stepsTicker([{ name: "read", args: '{"path":"a"}', ok: null }]), "read a –");
    // The marks match the list's statuses.
    assert.equal(stepMark({ type: "start", name: "x", args: "{}" }), "…");
    assert.equal(stepMark({ name: "x", args: "{}", ok: true }), "✓");
    assert.equal(stepMark({ name: "x", args: "{}", ok: false }), "✕");
    assert.equal(stepMark({ name: "x", args: "{}", ok: null }), "–");
    // The marquee slows down for a longer line, within its bounds.
    assert.equal(tickerDuration("x".repeat(30)), "8s");
    assert.equal(tickerDuration("x".repeat(3_000)), "45s");
    assert.equal(tickerDuration("x".repeat(300)), "10s");
  });

  it("durations are formatted and summed", () => {
    assert.equal(formatStepDuration(0), "0 ms");
    assert.equal(formatStepDuration(12.4), "12 ms");
    assert.equal(formatStepDuration(999), "999 ms");
    assert.equal(formatStepDuration(2340), "2.3 s");
    assert.equal(formatStepDuration(95_000), "95 s");
    assert.equal(formatStepDuration(null), null);
    assert.equal(formatStepDuration(undefined), null);
    assert.equal(formatStepDuration(-1), null);
    assert.equal(
      totalStepDuration([
        { name: "a", args: "{}", durationMs: 300 },
        { name: "b", args: "{}", durationMs: 1200 },
        { type: "start", name: "c", args: "{}" },
      ]),
      1500
    );
  });
});
